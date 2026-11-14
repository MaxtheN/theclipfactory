"""Synchronous Facebook Login adapter; never logs credentials or retries writes.

Use as a context manager (or call close). Network methods raise MetaError with a
safe message, code, http_status, and retryable flag suitable for local API errors.
Tokens returned by OAuth must go directly to SecureTokenStore, never the browser.
"""

from __future__ import annotations

import hmac
import ipaddress
import logging
import math
import re
import secrets
import time
from collections.abc import Callable, Iterator
from contextvars import ContextVar
from typing import Any, ClassVar, Self
from urllib.parse import urlencode, urlsplit

import httpx
import keyring

_sensitive_io: ContextVar[bool] = ContextVar("meta_sensitive_io", default=False)


class _CredentialLogFilter(logging.Filter):
    """Suppress library request/debug records only in this adapter's IO context.

    HTTPX logs full URLs at INFO, including the documented OAuth exchange query.
    ContextVars prevent suppression of unrelated requests in concurrent workers.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        return not _sensitive_io.get()


for _logger_name in (
    "httpx",
    "httpcore.connection",
    "httpcore.http11",
    "httpcore.http2",
    "httpcore.proxy",
    "httpcore.socks",
):
    logging.getLogger(_logger_name).addFilter(_CredentialLogFilter())


class MetaError(RuntimeError):
    """Credential-safe error; upstream bodies/URLs/exception text are never included."""

    def __init__(
        self,
        message: str,
        *,
        code: int | str | None = None,
        http_status: int | None = None,
        retryable: bool = False,
    ):
        super().__init__(message)
        self.code = code
        self.http_status = http_status
        self.retryable = retryable


def _version(value: str) -> str:
    if not re.fullmatch(r"v\d+\.\d+", value):
        raise MetaError("Invalid Graph API version.")
    return value


def _id(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]+", value):
        raise MetaError("Meta object IDs must contain digits only.")
    return value


def validate_public_video_url(value: str) -> str:
    """Validate syntax without fetching/resolving an asset that Meta will fetch.

    Private literal IPs and local/reserved names are blocked. DNS rebinding and
    remote redirect destinations cannot be established without dereferencing;
    callers should use a trusted public HTTPS object-storage/CDN origin.
    """
    try:
        if not isinstance(value, str) or any(c.isspace() or ord(c) < 32 for c in value):
            raise ValueError
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower().rstrip(".")
        if (
            parsed.scheme != "https"
            or not host
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
            or parsed.port not in (None, 443)
        ):
            raise ValueError
        if "%" in host or "\\" in value:
            raise ValueError
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            host = host.encode("idna").decode("ascii")
            # Reject single-label, local/reserved names and ambiguous numeric IP forms.
            if (
                "." not in host
                or host.endswith(
                    (
                        ".localhost",
                        ".local",
                        ".internal",
                        ".lan",
                        ".home",
                        ".test",
                        ".invalid",
                        ".example",
                        ".arpa",
                    )
                )
                or host == "localhost"
                or re.fullmatch(r"[0-9.]+", host)
                or any(label.startswith("0x") for label in host.split("."))
                or len(host) > 253
            ):
                raise ValueError
            if any(
                not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in host.split(".")
            ):
                raise ValueError
        else:
            mapped = getattr(address, "ipv4_mapped", None)
            if (
                not address.is_global
                or address.is_multicast
                or address.is_reserved
                or (mapped is not None and (not mapped.is_global or mapped.is_multicast))
            ):
                raise ValueError
        return value
    except (ValueError, UnicodeError):
        raise MetaError(
            "Video URL must be public HTTPS (port 443), not a local/private host or file."
        ) from None


class MetaClient:
    """Instagram API with Facebook Login, using verified Page-linked accounts.

    discover_account(account_id=None) -> {id, username, name, page_id}
    validate_token() -> {valid: True, account: {...}} (no tokens)
    publish_reel(..., poll_callback=None, cancel_check=None) -> {id, container_id}
      callback receives {container_id, status_code, attempt}; cancel_check() is bool.
    fetch_insights(account_id) -> media rows with metrics: numeric or None.
    fetch_paid_insights(ad_account_id) -> real read-only ad-level daily rows.
    """

    POLL_INTERVAL = 5.0
    POLL_TIMEOUT = 600.0
    MAX_POLL_ATTEMPTS = 120
    MAX_PAGES = 100
    METRICS = ("views", "reach", "saved", "shares", "likes", "comments", "total_interactions")
    _TRANSIENT_CODES: ClassVar[set[int]] = {1, 2, 4, 17, 32, 341, 613, 80000, 80001, 80002, 80004, 80006}

    def __init__(
        self, access_token: str, graph_version: str = "v22.0", transport: httpx.BaseTransport | None = None
    ):
        if (
            not isinstance(access_token, str)
            or not access_token.strip()
            or any(ord(c) < 33 or ord(c) > 126 for c in access_token)
        ):
            raise MetaError("Supply a valid Facebook access token.")
        self._token = access_token
        self._base = f"https://graph.facebook.com/{_version(graph_version)}"
        self._http = httpx.Client(
            transport=transport,
            timeout=httpx.Timeout(30, connect=10, pool=10),
            follow_redirects=False,
            trust_env=False,
        )
        self._accounts: dict[str, tuple[dict[str, Any], str]] = {}

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    def _request(
        self,
        method: str,
        path: str,
        *,
        token: str | None = None,
        params: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        retry_safe: bool = True,
        authenticated: bool = True,
    ) -> dict:
        safe_get = method == "GET" and retry_safe
        for attempt in range(3 if safe_get else 1):
            try:
                log_context = _sensitive_io.set(True)
                try:
                    response = self._http.request(
                        method,
                        f"{self._base}/{path}",
                        params=params,
                        data=data,
                        headers={"Authorization": f"Bearer {token or self._token}"} if authenticated else {},
                    )
                finally:
                    _sensitive_io.reset(log_context)
            except httpx.TransportError:
                if safe_get and attempt < 2:
                    time.sleep(0.5 * (2**attempt))
                    continue
                message = (
                    "Meta request failed; check connectivity and try again."
                    if method == "GET"
                    else "Meta write outcome is unknown. Check Meta before retrying; do not republish blindly."
                )
                raise MetaError(message, code="network", retryable=safe_get) from None
            try:
                payload = response.json()
            except ValueError:
                payload = None
            error = payload.get("error") if isinstance(payload, dict) else None
            code = error.get("code") if isinstance(error, dict) else None
            # Only numeric error codes cross the boundary; upstream strings may contain credentials.
            code = code if type(code) is int else None
            transient = (
                response.status_code in {429, 500, 502, 503, 504}
                or code in self._TRANSIENT_CODES
                or (isinstance(error, dict) and error.get("is_transient") is True)
            )
            if response.is_success and isinstance(payload, dict) and not error:
                return payload
            if safe_get and transient and attempt < 2:
                try:
                    delay = float(response.headers.get("Retry-After", "0"))
                except ValueError:
                    delay = 0
                delay = delay if math.isfinite(delay) else 0
                time.sleep(min(5.0, max(0.5 * 2**attempt, delay)))
                continue
            if code == 190:
                message = "Facebook token expired or invalid. Reconnect using Facebook Login."
            elif code in {10, 200} or response.status_code == 403:
                message = "Meta permission denied. Check Page access, granted scopes, and app review."
            elif transient:
                message = "Meta is rate limited or temporarily unavailable. Try later."
            else:
                message = "Meta rejected the request. Check account, API version, permissions, and input."
            if method != "GET":
                message += " Write was not retried; reconcile with Meta before resubmitting."
            raise MetaError(
                message, code=code, http_status=response.status_code, retryable=transient and safe_get
            )
        raise AssertionError("unreachable")

    def _pages(self, path: str, params: dict, *, token: str | None = None) -> Iterator[dict]:
        seen: set[str] = set()
        for _ in range(self.MAX_PAGES):
            payload = self._request("GET", path, params=params, token=token)
            rows = payload.get("data")
            if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                raise MetaError("Meta returned an invalid data collection.")
            yield from rows
            paging = payload.get("paging") or {}
            if not isinstance(paging, dict) or not paging.get("next"):
                return
            cursors = paging.get("cursors") or {}
            cursor = cursors.get("after") if isinstance(cursors, dict) else None
            if not isinstance(cursor, str) or not cursor or cursor in seen:
                raise MetaError("Meta returned invalid pagination.")
            seen.add(cursor)
            # Never follow paging.next URLs (may contain tokens or point elsewhere).
            params = {**params, "after": cursor}
        raise MetaError("Meta pagination limit reached; narrow the requested data range.")

    def discover_account(self, account_id: str | None = None) -> dict:
        """Prove ownership via /me/accounts; Page tokens may use /me's linked account.

        Without an ID, multiple linked accounts require explicit selection. This
        method never accepts an arbitrary IG ID merely because Graph can read it.
        """
        if account_id is not None:
            _id(account_id)
        fields = "id,name,access_token,instagram_business_account{id,username,name}"
        try:
            pages = list(self._pages("me/accounts", {"fields": fields, "limit": 100}))
        except MetaError as exc:
            if exc.code != 100:
                raise
            # A Page access token has no /accounts edge; only its own linked IG is valid.
            page = self._request(
                "GET", "me", params={"fields": "id,name,instagram_business_account{id,username,name}"}
            )
            pages = [{**page, "access_token": self._token}]
        accounts = {}
        for page in pages:
            ig = page.get("instagram_business_account")
            page_token = page.get("access_token")
            if (
                not isinstance(ig, dict)
                or not isinstance(page_token, str)
                or not page_token
                or any(ord(c) < 33 or ord(c) > 126 for c in page_token)
            ):
                continue
            ig_id, page_id = ig.get("id"), page.get("id")
            if not isinstance(ig_id, str) or not isinstance(page_id, str):
                raise MetaError("Meta returned an invalid linked account.")
            _id(ig_id)
            _id(page_id)
            account = {
                "id": ig_id,
                "username": ig.get("username"),
                "name": ig.get("name"),
                "page_id": page_id,
            }
            accounts[ig_id] = (account, page_token)
        self._accounts = accounts
        if account_id is None:
            if len(accounts) != 1:
                raise MetaError(
                    "No unique linked Instagram account. Link a professional account to an accessible "
                    "Facebook Page, or select an account ID when multiple Pages are available."
                )
            account_id = next(iter(accounts))
        if account_id not in accounts:
            raise MetaError(
                "Instagram account is not linked to a Facebook Page accessible with this token.",
                code="ownership",
            )
        return dict(accounts[account_id][0])

    def validate_token(self) -> dict:
        """Perform live ownership discovery, not a token-format check; returns no credentials."""
        return {"valid": True, "account": self.discover_account()}

    def _account_token(self, account_id: str) -> str:
        _id(account_id)
        # Revalidate ownership for every top-level operation (including a previously discovered account).
        self.discover_account(account_id)
        return self._accounts[account_id][1]

    def publish_reel(
        self,
        account_id: str,
        public_video_url: str,
        caption: str,
        poll_callback: Callable[[dict], None] | None = None,
        cancel_check: Callable[[], bool] | None = None,
    ) -> dict:
        """Create, await processing, then publish once. Cancellation cannot undo a completed write."""
        validate_public_video_url(public_video_url)
        if not isinstance(caption, str) or len(caption) > 2200:
            raise MetaError("Caption must be text of at most 2200 characters.")

        def check_cancel() -> None:
            if cancel_check and cancel_check():
                raise MetaError(
                    "Publishing cancelled; an already-created container may remain on Meta.", code="cancelled"
                )

        check_cancel()
        token = self._account_token(account_id)
        check_cancel()
        result = self._request(
            "POST",
            f"{account_id}/media",
            token=token,
            data={"media_type": "REELS", "video_url": public_video_url, "caption": caption},
        )
        container_id = _id(result.get("id"))
        if poll_callback:
            poll_callback({"container_id": container_id, "status_code": "CREATED", "attempt": 0})
        deadline = time.monotonic() + self.POLL_TIMEOUT
        for attempt in range(1, self.MAX_POLL_ATTEMPTS + 1):
            check_cancel()
            if time.monotonic() >= deadline:
                break
            status = self._request("GET", container_id, token=token, params={"fields": "status_code"})
            state = status.get("status_code")
            if not isinstance(state, str) or state not in {
                "FINISHED",
                "IN_PROGRESS",
                "ERROR",
                "EXPIRED",
                "PUBLISHED",
            }:
                raise MetaError("Meta returned an unknown container status; publishing stopped.")
            if poll_callback:
                poll_callback({"container_id": container_id, "status_code": state, "attempt": attempt})
            if state in {"ERROR", "EXPIRED"}:
                raise MetaError(
                    "Meta could not process the Reel or its container expired. Check asset hosting and format.",
                    code=state,
                )
            if state == "PUBLISHED":
                raise MetaError(
                    "Container is already published. Reconcile media from Meta; do not republish.", code=state
                )
            if state == "FINISHED":
                check_cancel()
                published = self._request(
                    "POST", f"{account_id}/media_publish", token=token, data={"creation_id": container_id}
                )
                return {"id": _id(published.get("id")), "container_id": container_id}
            if attempt < self.MAX_POLL_ATTEMPTS:
                time.sleep(min(self.POLL_INTERVAL, max(0, deadline - time.monotonic())))
        raise MetaError(
            "Meta processing timed out. Check the existing container before attempting another publish.",
            code="processing_timeout",
        )

    def fetch_insights(self, account_id: str) -> list[dict]:
        """Actual media and per-media insights; unsupported/empty metrics stay None.

        Auth, permission, network and exhausted rate-limit errors propagate. Metric
        parameter failures (Graph code 100) affect only that individual metric.
        Never substitutes public like counts or deprecated plays for views.
        """
        token = self._account_token(account_id)
        rows = []
        for media in self._pages(
            f"{account_id}/media",
            {"fields": "id,caption,timestamp,media_type,media_product_type,permalink", "limit": 100},
            token=token,
        ):
            media_id = _id(media.get("id"))
            metrics: dict[str, int | float | None] = dict.fromkeys(self.METRICS)
            for metric in self.METRICS:
                try:
                    response = self._request(
                        "GET", f"{media_id}/insights", token=token, params={"metric": metric}
                    )
                except MetaError as exc:
                    if exc.code == 100:
                        continue
                    raise
                entries = response.get("data")
                if not isinstance(entries, list):
                    raise MetaError("Meta returned an invalid insights collection.")
                for entry in entries:
                    if not isinstance(entry, dict) or entry.get("name") != metric:
                        continue
                    values = entry.get("values") or []
                    value = (
                        values[0].get("value")
                        if isinstance(values, list) and values and isinstance(values[0], dict)
                        else None
                    )
                    if value is None and isinstance(entry.get("total_value"), dict):
                        value = entry["total_value"].get("value")
                    if type(value) is int or (type(value) is float and math.isfinite(value)):
                        metrics[metric] = value
            rows.append(
                {
                    "id": media_id,
                    "caption": media.get("caption"),
                    "timestamp": media.get("timestamp"),
                    "media_type": media.get("media_type"),
                    "media_product_type": media.get("media_product_type"),
                    "permalink": media.get("permalink"),
                    "metrics": metrics,
                }
            )
        return rows

    def fetch_paid_insights(self, ad_account_id: str) -> list[dict]:
        """Read-only ad-level last-30-day daily insights; ads_read and ad-account access required.

        Returns Meta rows unchanged (numeric strings/actions retain their meaning).
        These are NOT attributed to organic clips. No campaign creation or mutation.
        """
        account_id = _id(ad_account_id.removeprefix("act_"))
        return list(
            self._pages(
                f"act_{account_id}/insights",
                {
                    "fields": "ad_id,ad_name,impressions,reach,clicks,spend,actions,date_start,date_stop",
                    "level": "ad",
                    "date_preset": "last_30d",
                    "time_increment": 1,
                    "limit": 100,
                },
            )
        )


class SecureTokenStore:
    """OS-native keyring only. set_token/get_token/delete_token(account_id, ...) namespace by IG ID.

    Headless hosts must configure an unlocked native secret service. There is no
    file, environment, memory, or plaintext fallback. Methods raise safe MetaError.
    """

    SERVICE = "clip-factory"
    _NATIVE: ClassVar[set[str]] = {
        "keyring.backends.macOS",
        "keyring.backends.Windows",
        "keyring.backends.SecretService",
        "keyring.backends.kwallet",
    }

    @staticmethod
    def _backend():
        try:
            backend = keyring.get_keyring()
            if type(backend).__module__ not in SecureTokenStore._NATIVE or backend.priority <= 0:
                raise RuntimeError
            return backend
        except Exception:  # noqa: BLE001 - native backend failures must not leak credentials
            raise MetaError(
                "Native OS keychain unavailable. Enable/unlock macOS Keychain, Windows Credential "
                "Manager, or Linux Secret Service/KWallet; plaintext fallback is forbidden."
            ) from None

    @staticmethod
    def _name(account_id: str) -> str:
        return f"instagram:{_id(account_id)}"

    def set_token(self, account_id: str, access_token: str) -> None:
        name = self._name(account_id)
        if not isinstance(access_token, str) or not access_token.strip():
            raise MetaError("Cannot store an empty token.")
        backend = self._backend()
        try:
            backend.set_password(self.SERVICE, name, access_token)
        except Exception:  # noqa: BLE001 - native backend failures must not leak credentials
            raise MetaError(
                "Cannot save token to OS keychain. Unlock it and allow Clip Factory access."
            ) from None

    def get_token(self, account_id: str) -> str | None:
        name = self._name(account_id)
        backend = self._backend()
        try:
            return backend.get_password(self.SERVICE, name)
        except Exception:  # noqa: BLE001 - native backend failures must not leak credentials
            raise MetaError(
                "Cannot read token from OS keychain. Unlock it and allow Clip Factory access."
            ) from None

    def delete_token(self, account_id: str) -> None:
        name = self._name(account_id)
        backend = self._backend()
        try:
            if backend.get_password(self.SERVICE, name) is not None:
                backend.delete_password(self.SERVICE, name)
        except Exception:  # noqa: BLE001 - native backend failures must not leak credentials
            raise MetaError("Cannot delete token from OS keychain. Unlock it and retry disconnect.") from None


class MetaOAuth:
    """Facebook Login helper. Keep this instance/server-side state scoped to the local session.

    authorization_url() -> (url, state). verify_state(state) consumes state once.
    exchange_code(code, state) -> token string (server/keychain only); verifies state.
    State expires in 10 minutes. Do not verify separately before exchange_code.
    """

    SCOPES = (
        "pages_show_list",
        "pages_read_engagement",
        "instagram_basic",
        "instagram_content_publish",
        "instagram_manage_insights",
    )

    def __init__(
        self,
        app_id: str,
        app_secret: str,
        redirect_uri: str,
        graph_version: str = "v22.0",
        transport: httpx.BaseTransport | None = None,
    ):
        _id(app_id)
        if not app_secret or not isinstance(app_secret, str):
            raise MetaError("Configure the Meta app secret on the local server.")
        try:
            uri = urlsplit(redirect_uri)
            if uri.scheme != "https" or not uri.hostname or uri.username or uri.password or uri.fragment:
                raise ValueError
        except ValueError:
            raise MetaError("Configure an exact HTTPS redirect URI registered in the Meta app.") from None
        self._app_id, self._secret, self._redirect = app_id, app_secret, redirect_uri
        self._version = _version(graph_version)
        self._transport = transport
        self._states: dict[str, float] = {}

    def authorization_url(self) -> tuple[str, str]:
        now = time.monotonic()
        self._states = {s: expiry for s, expiry in self._states.items() if expiry > now}
        if len(self._states) >= 32:
            raise MetaError("Too many pending Facebook Login attempts. Wait or complete a pending login.")
        state = secrets.token_urlsafe(32)
        self._states[state] = now + 600
        url = f"https://www.facebook.com/{self._version}/dialog/oauth?" + urlencode(
            {
                "client_id": self._app_id,
                "redirect_uri": self._redirect,
                "scope": ",".join(self.SCOPES),
                "response_type": "code",
                "state": state,
            }
        )
        return url, state

    def verify_state(self, state: str) -> bool:
        """Constant-time comparison, one-use consumption; false for absent/expired state."""
        if not isinstance(state, str):
            return False
        for expected in list(self._states):
            if hmac.compare_digest(expected.encode(), state.encode()):
                return self._states.pop(expected) > time.monotonic()
        return False

    def exchange_code(self, code: str, state: str) -> str:
        if not self.verify_state(state):
            raise MetaError("Facebook Login state is invalid or expired. Restart connection.")
        if not isinstance(code, str) or not code:
            raise MetaError("Facebook Login did not return an authorization code.")
        # Official Facebook Login reference documents GET for this exchange, not POST.
        # No access token is sent; the app secret/code must never be logged with this URL.
        # Codes are single-use, so even this GET must not be retried.
        with MetaClient("oauth-code-exchange", self._version, self._transport) as client:
            result = client._request(
                "GET",
                "oauth/access_token",
                retry_safe=False,
                authenticated=False,
                params={
                    "client_id": self._app_id,
                    "client_secret": self._secret,
                    "redirect_uri": self._redirect,
                    "code": code,
                },
            )
        token = result.get("access_token")
        if not isinstance(token, str) or not token:
            raise MetaError("Facebook Login returned no access token. Restart connection.")
        return token
