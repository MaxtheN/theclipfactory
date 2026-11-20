"""Client for the Growth Factory posting server (Supabase Edge Function ``posting`` in front of Zernio).

The desktop app never holds a Zernio key. Every call carries the signed-in cloud session and the
linked workspace (``X-GF-Workspace``); the server scopes accounts, uploads and posts to that workspace.
See docs/posting-server.md for the routes and error codes.

A write whose outcome is not known (timeout, lost connection, or a server-side 5xx after the request
was sent) raises ``PostingServerError`` with ``uncertain=True``. Callers must then read the post back
(``find_posts`` by external id) instead of sending it again under a new idempotency key.
"""

from __future__ import annotations

import re
from pathlib import Path

import httpx

from .cloud import CloudError

PLATFORMS = ("tiktok", "instagram", "youtube", "facebook", "linkedin", "twitter", "threads")
PLATFORM_LABELS = {"tiktok": "TikTok", "instagram": "Instagram", "youtube": "YouTube", "facebook": "Facebook",
                   "linkedin": "LinkedIn", "twitter": "X", "threads": "Threads"}
# Instagram Reels accept at most 300 MB, the smallest video limit among the supported platforms.
MAX_VIDEO_BYTES = 300 * 1024 * 1024
ZERNIO_ID = re.compile(r"^[0-9a-f]{24}$")
IDEMPOTENCY_KEY = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_MAX_RESPONSE = 4 * 1024 * 1024


class PostingServerError(Exception):
    """Credential-safe: carries only the server's short code and message, never tokens or bodies."""

    def __init__(self, status: int, code: str, message: str, *, uncertain: bool = False,
                 retry_after: str | None = None, details: dict | None = None):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message
        self.uncertain, self.retry_after = uncertain, retry_after
        self.details = details or {}


def _error(response: httpx.Response, *, write: bool) -> PostingServerError:
    try:
        body = response.json()
    except ValueError:
        body = {}
    detail = body.get("error") if isinstance(body, dict) else None
    detail = detail if isinstance(detail, dict) else {}
    code = detail.get("code") if isinstance(detail.get("code"), str) else "posting_error"
    message = detail.get("message") if isinstance(detail.get("message"), str) else "The posting server refused the request."
    status = response.status_code
    # A 5xx after a write was sent may mean the post exists upstream (e.g. Zernio created it, then the
    # server failed to record it). Only a read can tell.
    uncertain = write and status >= 500
    # Plan refusals (402) name the limit and usage for the Upgrade Prompt.
    details = {key: detail[key] for key in ("limit", "plan") if isinstance(detail.get(key), str)}
    details.update({key: detail[key] for key in ("usage", "max")
                    if isinstance(detail.get(key), int) and not isinstance(detail.get(key), bool)})
    return PostingServerError(status, code, message[:500], uncertain=uncertain,
                              retry_after=response.headers.get("Retry-After"), details=details)


class PostingServerClient:
    def __init__(self, account, *, transport=None, timeout: float = 60, upload_timeout: float = 900):
        self.account = account
        self._transport, self._timeout, self._upload_timeout = transport, timeout, upload_timeout
        self.base_url = account.client.config.url.rstrip("/") + "/functions/v1/posting"

    # ------------------------------------------------------------------ session
    def workspace_id(self) -> str:
        """The linked cloud workspace; the session must belong to the linked user."""
        link = self.account.link() or {}
        if not self.account.status().get("signed_in") or not link.get("user_id"):
            raise PostingServerError(401, "sign_in_required", "Sign in to Growth Factory cloud to post.")
        client = self.account.client
        try:
            if client.session is None:
                client.refresh()
        except CloudError as error:
            raise PostingServerError(401, "sign_in_required", error.message) from None
        if client.session is None or client.session.user_id != link["user_id"]:
            raise PostingServerError(401, "sign_in_required",
                                     "Cloud session does not match the linked account. Sign in again.")
        workspace = link.get("workspace_id")
        if not isinstance(workspace, str) or not _UUID.fullmatch(workspace):
            raise PostingServerError(401, "sign_in_required", "Sign in again to link a cloud workspace.")
        return workspace

    def _http(self, timeout: float) -> httpx.Client:
        return httpx.Client(transport=self._transport, timeout=httpx.Timeout(timeout), trust_env=False,
                            follow_redirects=False)

    def _request(self, method: str, path: str, *, body=None, params=None, idempotency_key=None,
                 write: bool = False) -> dict:
        workspace = self.workspace_id()
        client = self.account.client
        headers = {"Accept": "application/json", "X-GF-Workspace": workspace}
        if idempotency_key is not None:
            if not IDEMPOTENCY_KEY.fullmatch(idempotency_key):
                raise PostingServerError(400, "idempotency_key_required", "Invalid idempotency key.")
            headers["Idempotency-Key"] = idempotency_key

        def send():
            merged = {**headers, "apikey": client.config.publishable_key,
                      "Authorization": f"Bearer {client.session.access_token}"}
            with self._http(self._timeout) as http:
                response = http.request(method, self.base_url + path, json=body, params=params, headers=merged)
                response.read()
                return response

        try:
            response = send()
            if response.status_code == 401:
                # Expired access token: refresh once. The server rejects before doing anything, so a
                # resend is safe even for writes (and the idempotency key protects it regardless).
                client.refresh()
                response = send()
        except CloudError as error:
            raise PostingServerError(401, "sign_in_required", error.message) from None
        except httpx.TimeoutException:
            raise PostingServerError(504, "timeout", "The posting server timed out.", uncertain=write) from None
        except httpx.HTTPError:
            raise PostingServerError(502, "network", "Cannot reach the posting server. Check your connection.",
                                     uncertain=write) from None
        if len(response.content) > _MAX_RESPONSE:
            raise PostingServerError(502, "invalid_response", "The posting server sent an oversized reply.",
                                     uncertain=write)
        if not response.is_success:
            raise _error(response, write=write)
        try:
            data = response.json()
        except ValueError:
            raise PostingServerError(502, "invalid_response", "The posting server sent an invalid reply.",
                                     uncertain=write) from None
        if not isinstance(data, dict):
            raise PostingServerError(502, "invalid_response", "The posting server sent an invalid reply.",
                                     uncertain=write)
        data["_status"] = response.status_code
        return data

    # ------------------------------------------------------------------ accounts
    def accounts(self) -> list[dict]:
        data = self._request("GET", "/accounts")
        rows = data.get("accounts")
        return [a for a in rows if isinstance(a, dict) and isinstance(a.get("id"), str)
                and ZERNIO_ID.fullmatch(a["id"]) and a.get("platform") in PLATFORMS] if isinstance(rows, list) else []

    def connect(self, platform: str, redirect_url: str) -> str:
        data = self._request("POST", "/connect", body={"platform": platform, "redirectUrl": redirect_url})
        url = data.get("authUrl")
        if not isinstance(url, str) or not url.startswith("https://"):
            raise PostingServerError(502, "invalid_response", "The posting server returned no sign-in link.")
        return url

    def disconnect(self, account_id: str) -> dict:
        return self._request("DELETE", f"/accounts/{_zernio_id(account_id)}")

    def creator_info(self, account_id: str) -> dict:
        return self._request("GET", f"/accounts/{_zernio_id(account_id)}/tiktok-creator-info")

    # ------------------------------------------------------------------ media
    def presign(self, filename: str, content_type: str, size: int) -> dict:
        data = self._request("POST", "/uploads", body={"filename": filename, "contentType": content_type,
                                                       "size": size})
        if not all(isinstance(data.get(k), str) and data[k].startswith("https://") for k in ("uploadUrl", "publicUrl")):
            raise PostingServerError(502, "invalid_response", "The posting server returned no upload URL.")
        return data

    def upload(self, path: Path, content_type: str, *, filename: str | None = None) -> str:
        """Presign, then PUT the exact bytes. Returns the public media URL. Re-uploading is harmless
        (nothing is published by an upload), so failures here are never uncertain."""
        size = path.stat().st_size
        target = self.presign(filename or path.name, content_type, size)
        try:
            with path.open("rb") as handle, self._http(self._upload_timeout) as http:
                response = http.put(target["uploadUrl"], content=handle,
                                    headers={"Content-Type": content_type, "Content-Length": str(size)})
        except httpx.TimeoutException:
            raise PostingServerError(504, "upload_timeout", "Uploading the video timed out.") from None
        except httpx.HTTPError:
            raise PostingServerError(502, "upload_failed", "Uploading the video failed. Check your connection.") from None
        if not response.is_success:
            raise PostingServerError(502, "upload_rejected", "Media storage refused the upload.")
        return target["publicUrl"]

    # ------------------------------------------------------------------ posts
    def create_post(self, payload: dict, idempotency_key: str) -> dict:
        data = self._request("POST", "/posts", body=payload, idempotency_key=idempotency_key, write=True)
        post = data.get("post")
        if not isinstance(post, dict) or not isinstance(post.get("id"), str) or not ZERNIO_ID.fullmatch(post["id"]):
            raise PostingServerError(502, "invalid_response", "The posting server returned no post.", uncertain=True)
        return {"replayed": data.get("replayed") is True, "post": post}

    def get_post(self, post_id: str) -> dict:
        data = self._request("GET", f"/posts/{_zernio_id(post_id)}")
        if not isinstance(data.get("post"), dict):
            raise PostingServerError(502, "invalid_response", "The posting server returned no post.")
        return data

    def find_posts(self, external_id: str) -> list[dict]:
        data = self._request("GET", "/posts", params={"externalId": external_id})
        posts = data.get("posts")
        if not isinstance(posts, list):
            raise PostingServerError(502, "invalid_response", "The posting server returned no post list.")
        return [p for p in posts if isinstance(p, dict) and isinstance(p.get("id"), str)
                and ZERNIO_ID.fullmatch(p["id"])]

    def cancel_post(self, post_id: str) -> dict:
        return self._request("DELETE", f"/posts/{_zernio_id(post_id)}", write=True)

    def analytics(self, post_id: str) -> dict:
        return self._request("GET", f"/posts/{_zernio_id(post_id)}/analytics")


def _zernio_id(value: str) -> str:
    if not isinstance(value, str) or not ZERNIO_ID.fullmatch(value):
        raise PostingServerError(400, "invalid_id", "Invalid posting account or post ID.")
    return value


def platform_entry(post: dict, account_id: str) -> dict | None:
    """The post's entry for one connected account (a post may target several)."""
    for entry in post.get("platforms") or []:
        if isinstance(entry, dict) and entry.get("accountId") == account_id:
            return entry
    entries = [e for e in post.get("platforms") or [] if isinstance(e, dict)]
    return entries[0] if len(entries) == 1 and not entries[0].get("accountId") else None


# Zernio reports metrics a platform does not provide as 0. Only these are real for each platform;
# anything else is recorded as unavailable (None), never as a zero.
REPORTED_METRICS = {
    "instagram": {"impressions", "reach", "likes", "comments", "shares", "saves", "views"},
    "facebook": {"impressions", "likes", "comments", "shares", "clicks", "views"},
    "linkedin": {"impressions", "reach", "likes", "comments", "shares"},
    "tiktok": {"likes", "comments", "shares", "views"},
    "youtube": {"likes", "comments", "views"},
    "twitter": {"impressions", "likes", "comments", "shares", "saves", "clicks", "views"},
    "threads": {"likes", "comments", "shares", "views"},
}
# Zernio name -> the name the learning loop already uses (Composio's Instagram insights).
METRIC_NAMES = {"views": "views", "reach": "reach", "impressions": "impressions", "likes": "likes",
                "comments": "comments", "shares": "shares", "saves": "saved", "clicks": "clicks"}


def _count(value):
    if type(value) is bool or not isinstance(value, (int, float)) or value < 0:
        return None
    return float(value)


def parse_analytics(reply: dict, platform: str) -> dict:
    """``GET /posts/:id/analytics`` -> {status, metrics, published_at, url}. ``status`` is ``syncing``
    (try later), ``unavailable`` (the platform reports nothing yet) or ``ready``."""
    if reply.get("status") == "syncing":
        return {"status": "syncing", "metrics": {}, "published_at": None, "url": None}
    body = reply.get("analytics") if isinstance(reply.get("analytics"), dict) else {}
    # Single-post reads are documented as one post object; tolerate the list shape too.
    if isinstance(body.get("posts"), list) and body["posts"] and isinstance(body["posts"][0], dict):
        body = body["posts"][0]
    values = body.get("analytics") if isinstance(body.get("analytics"), dict) else {}
    sync = [e.get("syncStatus") for e in body.get("platforms") or []
            if isinstance(e, dict) and e.get("platform") in (None, platform)]
    if not values or (sync and all(s in {"pending", "unavailable"} for s in sync)):
        state = "syncing" if "pending" in sync else "unavailable"
        return {"status": state, "metrics": {}, "published_at": body.get("publishedAt"), "url": None}
    reported = REPORTED_METRICS.get(platform, set())
    metrics = {name: (_count(values.get(source)) if source in reported else None)
               for source, name in METRIC_NAMES.items()}
    return {"status": "ready", "metrics": metrics, "published_at": body.get("publishedAt"),
            "url": body.get("platformPostUrl")}
