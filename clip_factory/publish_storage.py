"""Public hosting of the exact approved MP4 so Instagram can fetch it.

Uploads to the Supabase Storage bucket ``gf-publish`` at ``<user_id>/<sha256>.mp4`` with
the signed-in user's own session (never a service key). The object name carries the
content hash, so an existing object at that name is the same approved bytes; it is still
verified by public ``HEAD`` (status, type and exact length) before Instagram sees the URL.
Errors are credential-safe: no tokens, keys or upstream bodies.
"""

from __future__ import annotations

import re
from pathlib import Path

import httpx

from .cloud import CloudAccount, CloudError

BUCKET = "gf-publish"
# Supabase free tier: 50 MB global per-object upload limit (also the bucket file_size_limit).
MAX_BYTES = 50 * 1024 * 1024
# Instagram Reel cover_url: JPEG, at most 8 MB (Graph API IG User Media reference).
COVER_MAX_BYTES = 8 * 1024 * 1024
_SHA = re.compile(r"^[0-9a-f]{64}$")
_UUID = re.compile(r"^[0-9a-f-]{36}$")


class PublishStorageError(RuntimeError):
    def __init__(self, message: str, code: str = "storage_error", status: int = 502):
        super().__init__(message)
        self.message, self.code, self.status = message, code, status


class PublishStorage:
    def __init__(self, account: CloudAccount, *, transport=None, timeout: float = 120):
        self.account, self._transport, self._timeout = account, transport, timeout

    # -- identity -------------------------------------------------------------------------
    def user_id(self) -> str:
        """The signed-in cloud user; the session must belong to the linked user."""
        link = self.account.link() or {}
        status = self.account.status()
        if not status.get("signed_in") or not link.get("user_id"):
            raise PublishStorageError("Sign in to Growth Factory cloud to post.", "sign_in_required", 409)
        client = self.account.client
        try:
            if client.session is None:
                client.refresh()
        except CloudError as error:
            raise PublishStorageError(error.message, "sign_in_required", 409) from None
        if client.session is None or client.session.user_id != link["user_id"]:
            raise PublishStorageError("Cloud session does not match the linked account. Sign in again.",
                                      "sign_in_required", 409)
        if not _UUID.fullmatch(link["user_id"]):
            raise PublishStorageError("Cloud account ID is not a valid user ID.", "sign_in_required", 409)
        return link["user_id"]

    def object_path(self, user_id: str, sha256: str) -> str:
        if not _SHA.fullmatch(sha256 or "") or not _UUID.fullmatch(user_id or ""):
            raise PublishStorageError("Invalid clip hash or user for hosting.", "invalid_object", 422)
        return f"{user_id}/{sha256}.mp4"

    def cover_path(self, user_id: str, sha256: str) -> str:
        """Reel cover still, content-addressed like the video: ``<uid>/<sha256 of the jpg>.jpg``."""
        if not _SHA.fullmatch(sha256 or "") or not _UUID.fullmatch(user_id or ""):
            raise PublishStorageError("Invalid cover hash or user for hosting.", "invalid_object", 422)
        return f"{user_id}/{sha256}.jpg"

    def public_url(self, path: str) -> str:
        return f"{self.account.client.config.url}/storage/v1/object/public/{BUCKET}/{path}"

    # -- HTTP -----------------------------------------------------------------------------
    def _client(self):
        return httpx.Client(transport=self._transport, timeout=httpx.Timeout(self._timeout, connect=10),
                            trust_env=False, follow_redirects=False)

    def _authed(self, method: str, url: str, *, headers=None, **kwargs) -> httpx.Response:
        client = self.account.client
        extra = dict(headers or {})

        def send():
            merged = {"apikey": client.config.publishable_key,
                      "Authorization": f"Bearer {client.session.access_token}", **extra}
            with self._client() as http:
                return http.request(method, url, headers=merged, **kwargs)

        try:
            if client.session is None:
                client.refresh()
            response = send()
            expired = response.status_code == 401 or (
                response.status_code in {400, 403} and "jwt" in response.text.lower()[:400])
            if expired:
                client.refresh()
                body = kwargs.get("content")
                if hasattr(body, "seek"):
                    body.seek(0)
                response = send()
            return response
        except CloudError as error:
            raise PublishStorageError(error.message, "sign_in_required", 409) from None
        except httpx.TimeoutException:
            raise PublishStorageError("Upload timed out. Check status before retrying.", "timeout", 504) from None
        except httpx.HTTPError:
            raise PublishStorageError("Cannot reach cloud storage. Check status before retrying.", "network",
                                      502) from None

    # -- operations -----------------------------------------------------------------------
    def verify_public(self, url: str, size: int, content_type: str = "video/mp4") -> bool:
        """Anonymous HEAD exactly as Instagram will fetch it: 200, expected type, exact length."""
        try:
            with self._client() as http:
                response = http.head(url)
        except httpx.HTTPError:
            return False
        length = response.headers.get("content-length")
        return (response.status_code == 200
                and response.headers.get("content-type", "").split(";")[0].strip() == content_type
                and length is not None and length.isdigit() and int(length) == size)

    def upload(self, path: Path, sha256: str) -> dict:
        size = path.stat().st_size
        if size > MAX_BYTES:
            raise PublishStorageError(
                f"This clip is {size / 1048576:.1f} MB; cloud hosting accepts at most 50 MB per file "
                "(Supabase free tier). Render a shorter or lower-bitrate version.", "too_large", 413)
        if size <= 0:
            raise PublishStorageError("The clip file is empty.", "invalid_object", 422)
        user = self.user_id()
        name = self.object_path(user, sha256)
        url = self.public_url(name)
        endpoint = f"{self.account.client.config.url}/storage/v1/object/{BUCKET}/{name}"
        with path.open("rb") as handle:
            response = self._authed("POST", endpoint, content=handle,
                                    headers={"Content-Type": "video/mp4", "x-upsert": "false",
                                             "Cache-Control": "max-age=3600"})
        exists = response.status_code in {400, 409} and (
            "exist" in response.text.lower()[:400] or "duplicate" in response.text.lower()[:400])
        if response.status_code == 413 or "maximum allowed size" in response.text.lower()[:400]:
            raise PublishStorageError("Cloud storage refused the file size (50 MB limit).", "too_large", 413)
        if response.status_code == 404 and "bucket" in response.text.lower()[:400]:
            raise PublishStorageError("The gf-publish bucket does not exist. Apply the storage migration first.",
                                      "bucket_missing", 409)
        if not response.is_success and not exists:
            raise PublishStorageError("Cloud storage rejected the upload. Check the storage migration and sign-in.",
                                      "upload_rejected", 502)
        if not self.verify_public(url, size):
            raise PublishStorageError("The uploaded clip is not publicly readable with the exact size. "
                                      "Check that the gf-publish bucket is public.", "not_public", 502)
        return {"url": url, "object": name, "bytes": size, "reused": exists}

    def upload_cover(self, path: Path, sha256: str) -> dict:
        """Upload the chosen cover JPEG (needs migration 202611140003 for image/jpeg + .jpg names)."""
        size = path.stat().st_size
        if not 0 < size <= COVER_MAX_BYTES:
            raise PublishStorageError("The cover image must be a JPEG of at most 8 MB.", "too_large", 413)
        name = self.cover_path(self.user_id(), sha256)
        url = self.public_url(name)
        endpoint = f"{self.account.client.config.url}/storage/v1/object/{BUCKET}/{name}"
        with path.open("rb") as handle:
            response = self._authed("POST", endpoint, content=handle,
                                    headers={"Content-Type": "image/jpeg", "x-upsert": "false",
                                             "Cache-Control": "max-age=3600"})
        exists = response.status_code in {400, 409} and (
            "exist" in response.text.lower()[:400] or "duplicate" in response.text.lower()[:400])
        if not response.is_success and not exists:
            raise PublishStorageError("Cloud storage rejected the cover image. Apply the cover migration "
                                      "(202611140003) or post with the frame-offset cover.", "upload_rejected", 502)
        if not self.verify_public(url, size, "image/jpeg"):
            raise PublishStorageError("The cover image is not publicly readable with the exact size.",
                                      "not_public", 502)
        return {"url": url, "object": name, "bytes": size, "reused": exists}

    def delete(self, name: str) -> bool:
        if not re.fullmatch(r"[0-9a-f-]{36}/[0-9a-f]{64}\.(?:mp4|jpg)", name or ""):
            return False
        response = self._authed("DELETE", f"{self.account.client.config.url}/storage/v1/object/{BUCKET}",
                                json={"prefixes": [name]})
        return response.is_success
