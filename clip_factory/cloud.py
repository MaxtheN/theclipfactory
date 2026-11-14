"""Optional Growth Factory cloud account (Supabase email + password).

Local SQLite stays the system of record. Only a non-secret link record
({"id": "cloud_link", user_id, email, workspace_id, linked_event_at}) is stored
locally; the refresh token lives in the native Keychain, the access token only in
memory, and the password is never stored. Every Supabase call goes through this
module (the page CSP only allows same-origin requests).
"""

from __future__ import annotations

import base64
import json
import os
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from .meta import MetaError, SecureTokenStore
from .store import now

CONFIG_PATH = Path(__file__).with_name("cloud_config.json")
LINK_KIND, LINK_ID, EVENTS_ID = "config", "cloud_link", "cloud_link_events"
DEFAULT_WORKSPACE = "Growth Factory workspace"
CONFIRM_EMAIL = "Check your email to confirm your account, then sign in."
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_MAX_RESPONSE = 256 * 1024


class CloudError(RuntimeError):
    """Credential-safe error: never contains tokens, passwords, keys or upstream bodies."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.message, self.status = message, status


@dataclass(frozen=True)
class CloudConfig:
    url: str
    publishable_key: str = field(repr=False)


def _jwt_role(key: str) -> str | None:
    parts = key.split(".")
    if len(parts) != 3:
        return None
    try:
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload))
    except (ValueError, UnicodeError):
        return None
    return claims.get("role") if isinstance(claims, dict) else None


def validate_config(url: str, key: str) -> CloudConfig:
    url, key = (url or "").strip().rstrip("/"), (key or "").strip()
    if key.startswith("sb_secret_") or _jwt_role(key) == "service_role":
        raise CloudError(
            "Refusing a Supabase secret/service-role key; the app needs the publishable key.", 409
        )
    parts = urlsplit(url)
    local = parts.hostname in {"127.0.0.1", "localhost"}
    if parts.scheme != "https" and not (local and parts.scheme == "http"):
        raise CloudError("Supabase URL must use https.", 409)
    if not parts.hostname or parts.path or parts.query or parts.fragment or parts.username:
        raise CloudError("Supabase URL must be the bare project URL.", 409)
    if not key or len(key) > 4096 or any(c.isspace() for c in key):
        raise CloudError("Supabase publishable key is missing or malformed.", 409)
    return CloudConfig(url, key)


def load(path: Path | None = None, environ=None) -> CloudConfig | None:
    """Bundled cloud_config.json with CLIP_SUPABASE_URL / CLIP_SUPABASE_PUBLISHABLE_KEY overrides.

    Returns None when nothing is configured; raises CloudError for invalid or secret keys.
    """
    environ = os.environ if environ is None else environ
    data = {}
    try:
        data = json.loads((path or CONFIG_PATH).read_text("utf-8"))
    except FileNotFoundError:
        pass
    except (OSError, ValueError):
        raise CloudError("Bundled cloud configuration is unreadable.", 409) from None
    if not isinstance(data, dict):
        raise CloudError("Bundled cloud configuration is unreadable.", 409)
    url = environ.get("CLIP_SUPABASE_URL") or data.get("url") or ""
    key = environ.get("CLIP_SUPABASE_PUBLISHABLE_KEY") or data.get("publishable_key") or ""
    if not isinstance(url, str) or not isinstance(key, str):
        raise CloudError("Bundled cloud configuration is unreadable.", 409)
    if not url and not key:
        return None
    return validate_config(url, key)


class CloudSecrets:
    """Refresh token in the native Keychain only; no file/environment fallback."""

    SERVICE, ACCOUNT = "growth-factory-supabase", "refresh-token"

    @staticmethod
    def _backend():
        try:
            return SecureTokenStore._backend()
        except MetaError:
            raise CloudError("Native Keychain unavailable. Unlock it and retry.", 503) from None

    def get(self) -> str | None:
        backend = self._backend()
        try:
            return backend.get_password(self.SERVICE, self.ACCOUNT)
        except Exception:  # noqa: BLE001 - keychain errors must not expose provider details
            raise CloudError("Cannot read the cloud session from the native Keychain.", 503) from None

    def set(self, value: str) -> None:
        if not isinstance(value, str) or not value.strip():
            raise CloudError("Supabase returned an invalid session.", 502)
        backend = self._backend()
        try:
            backend.set_password(self.SERVICE, self.ACCOUNT, value)
        except Exception:  # noqa: BLE001 - keychain errors must not expose provider details
            raise CloudError("Cannot save the cloud session to the native Keychain.", 503) from None

    def delete(self) -> None:
        backend = self._backend()
        try:
            if backend.get_password(self.SERVICE, self.ACCOUNT) is not None:
                backend.delete_password(self.SERVICE, self.ACCOUNT)
        except Exception:  # noqa: BLE001 - keychain errors must not expose provider details
            raise CloudError("Cannot remove the cloud session from the native Keychain.", 503) from None


@dataclass
class AuthSession:
    user_id: str
    email: str
    access_token: str = field(repr=False)


def _auth_error(response: httpx.Response, *, password_grant=False) -> CloudError:
    try:
        body = response.json()
    except ValueError:
        body = {}
    body = body if isinstance(body, dict) else {}
    code = str(body.get("error_code") or body.get("code") or body.get("error") or "")
    text = str(body.get("msg") or body.get("error_description") or body.get("message") or "").lower()
    status = response.status_code
    if status == 429 or "rate_limit" in code:
        return CloudError("Too many attempts. Wait a minute and retry.", 429)
    if code == "email_not_confirmed" or "not confirmed" in text:
        return CloudError(CONFIRM_EMAIL, 403)
    if code in {"user_already_exists", "email_exists"} or "already registered" in text:
        return CloudError("An account with this email already exists. Sign in instead.", 409)
    if code == "weak_password" or "password should" in text:
        return CloudError("Choose a stronger password (at least 8 characters).", 400)
    if code == "signup_disabled" or "signups not allowed" in text:
        return CloudError("New account creation is currently disabled.", 403)
    if code in {"email_address_invalid", "validation_failed"}:
        return CloudError("Enter a valid email address.", 400)
    if password_grant and status in {400, 401}:
        return CloudError("Email or password is incorrect.", 401)
    if status in {400, 401, 403}:
        return CloudError("Your cloud session expired. Sign in again.", 401)
    return CloudError("Growth Factory cloud request failed. Retry in a moment.", 502)


class SupabaseClient:
    """GoTrue + PostgREST over httpx with a publishable key and an in-memory access token."""

    def __init__(self, config: CloudConfig, transport=None, *, timeout: float = 10, tokens=None):
        self.config, self._transport, self._timeout = config, transport, timeout
        self.tokens = tokens  # object with get()/set()/delete(); CloudAccount supplies CloudSecrets
        self.session: AuthSession | None = None
        self._lock = threading.RLock()

    def _send(self, method, path, *, json_body=None, params=None, bearer=None, prefer=None):
        headers = {"apikey": self.config.publishable_key, "Accept": "application/json"}
        if bearer:
            headers["Authorization"] = f"Bearer {bearer}"
        if prefer:
            headers["Prefer"] = prefer
        try:
            with httpx.Client(
                base_url=self.config.url,
                transport=self._transport,
                timeout=httpx.Timeout(self._timeout),
                trust_env=False,
                follow_redirects=False,
            ) as client:
                response = client.request(method, path, json=json_body, params=params, headers=headers)
                response.read()
        except httpx.TimeoutException:
            raise CloudError(
                "Growth Factory cloud timed out. Check your connection and retry.", 504
            ) from None
        except httpx.HTTPError:
            raise CloudError(
                "Cannot reach Growth Factory cloud. Check your connection and retry.", 502
            ) from None
        if len(response.content) > _MAX_RESPONSE:
            raise CloudError("Growth Factory cloud returned an oversized response.", 502)
        return response

    @staticmethod
    def _json(response):
        try:
            return response.json()
        except ValueError:
            raise CloudError("Growth Factory cloud returned an invalid response.", 502) from None

    def _adopt(self, body) -> AuthSession:
        user = body.get("user") if isinstance(body, dict) else None
        access, refresh = (body or {}).get("access_token"), (body or {}).get("refresh_token")
        if not (isinstance(user, dict) and isinstance(user.get("id"), str) and access and refresh):
            raise CloudError("Supabase returned an invalid session.", 502)
        if self.tokens is not None:
            self.tokens.set(refresh)  # persist (rotated) refresh token before anything else
        self.session = AuthSession(user["id"], str(user.get("email") or ""), access)
        return self.session

    def sign_up(self, email: str, password: str) -> AuthSession | None:
        """Returns a session, or None when email confirmation is required (no session issued)."""
        response = self._send("POST", "/auth/v1/signup", json_body={"email": email, "password": password})
        if not response.is_success:
            raise _auth_error(response)
        body = self._json(response)
        if isinstance(body, dict) and body.get("access_token"):
            return self._adopt(body)
        return None

    def sign_in_password(self, email: str, password: str) -> AuthSession:
        response = self._send(
            "POST",
            "/auth/v1/token",
            params={"grant_type": "password"},
            json_body={"email": email, "password": password},
        )
        if not response.is_success:
            raise _auth_error(response, password_grant=True)
        return self._adopt(self._json(response))

    def refresh(self) -> AuthSession:
        with self._lock:
            token = self.tokens.get() if self.tokens is not None else None
            if not token:
                self.session = None
                raise CloudError("Your cloud session expired. Sign in again.", 401)
            response = self._send(
                "POST",
                "/auth/v1/token",
                params={"grant_type": "refresh_token"},
                json_body={"refresh_token": token},
            )
            if response.status_code in {400, 401, 403}:
                self.session = None
                self.tokens.delete()
                raise CloudError("Your cloud session expired. Sign in again.", 401)
            if not response.is_success:
                raise _auth_error(response)
            return self._adopt(self._json(response))

    def logout(self) -> None:
        """Best-effort revoke of this device's session; local state is cleared by the caller."""
        session, self.session = self.session, None
        if session is None:
            return
        try:
            self._send("POST", "/auth/v1/logout", params={"scope": "local"}, bearer=session.access_token)
        except CloudError:
            pass

    def _authed(self, method, path, **kwargs):
        if self.session is None:
            self.refresh()
        response = self._send(method, path, bearer=self.session.access_token, **kwargs)
        if response.status_code == 401:
            self.refresh()
            response = self._send(method, path, bearer=self.session.access_token, **kwargs)
        if response.status_code == 401:
            raise CloudError("Your cloud session expired. Sign in again.", 401)
        if not response.is_success:
            raise CloudError("Growth Factory cloud rejected the workspace request.", 502)
        return self._json(response) if response.content else None

    def find_workspace(self, owner_id: str) -> dict | None:
        rows = self._authed(
            "GET",
            "/rest/v1/gf_workspaces",
            params={
                "select": "id,name",
                "owner_id": f"eq.{owner_id}",
                "order": "created_at.asc",
                "limit": "1",
            },
        )
        if not isinstance(rows, list):
            raise CloudError("Growth Factory cloud returned an invalid response.", 502)
        return rows[0] if rows else None

    def insert_workspace(self, owner_id: str, name: str) -> dict:
        rows = self._authed(
            "POST",
            "/rest/v1/gf_workspaces",
            params={"select": "id,name"},
            json_body={"owner_id": owner_id, "name": name},
            prefer="return=representation",
        )
        if not (isinstance(rows, list) and rows and isinstance(rows[0].get("id"), str)):
            raise CloudError("Growth Factory cloud returned an invalid response.", 502)
        return rows[0]

    def append_event(self, workspace_id: str, *, kind: str, record_id: str, event_type: str, data: dict):
        self._authed(
            "POST",
            "/rest/v1/gf_events",
            json_body={
                "workspace_id": workspace_id,
                "kind": kind,
                "record_id": record_id,
                "event_type": event_type,
                "data": data,
            },
            prefer="return=minimal",
        )


def _credentials(email, password) -> tuple[str, str]:
    email = email.strip().lower() if isinstance(email, str) else ""
    if not (3 <= len(email) <= 254 and _EMAIL.match(email)):
        raise CloudError("Enter a valid email address.", 400)
    if not isinstance(password, str) or not 8 <= len(password) <= 72:
        raise CloudError("Use a password between 8 and 72 characters.", 400)
    return email, password


class CloudAccount:
    def __init__(self, store, client: SupabaseClient, secrets: CloudSecrets):
        self.store, self.client, self.secrets = store, client, secrets
        client.tokens = secrets
        self._lock = threading.Lock()

    def link(self) -> dict | None:
        return self.store.get(LINK_KIND, LINK_ID)

    def status(self, message: str | None = None) -> dict:
        link = self.link()
        signed_in = bool(link and link.get("user_id"))
        if signed_in:
            try:
                signed_in = bool(self.secrets.get())
            except CloudError:
                pass  # locked keychain: keep the link; the next cloud call will report it
        result = {
            "configured": True,
            "signed_in": signed_in,
            "email": link.get("email") if signed_in else None,
            "workspace_id": link.get("workspace_id") if signed_in else None,
        }
        if message:
            result["message"] = message
        return result

    def sign_up(self, email, password, workspace_name: str | None = None) -> dict:
        email, password = _credentials(email, password)
        name = self._name(workspace_name)
        with self._lock:
            session = self.client.sign_up(email, password)
            if session is None:
                return {**self.status(CONFIRM_EMAIL), "confirmation_required": True}
            return self._link(session, name)

    def sign_in(self, email, password, workspace_name: str | None = None) -> dict:
        email, password = _credentials(email, password)
        name = self._name(workspace_name)
        with self._lock:
            return self._link(self.client.sign_in_password(email, password), name)

    def sign_out(self) -> dict:
        with self._lock:
            self.client.logout()
            self.secrets.delete()
            self.store.delete(LINK_KIND, LINK_ID)
        return self.status()

    @staticmethod
    def _name(value) -> str:
        name = (value or "").strip() if isinstance(value, str) else ""
        name = name or DEFAULT_WORKSPACE
        if len(name) > 120:
            raise CloudError("Use a workspace name of at most 120 characters.", 400)
        return name

    def _link(self, session: AuthSession, name: str) -> dict:
        workspace = self.client.find_workspace(session.user_id) or self.client.insert_workspace(
            session.user_id, name
        )
        # Non-secret per-device ledger so the link event is appended once per user+workspace,
        # even across sign-out/sign-in.
        ledger = self.store.get(LINK_KIND, EVENTS_ID) or {"id": EVENTS_ID, "linked": {}}
        marker = f"{session.user_id}:{workspace['id']}"
        linked_at = ledger["linked"].get(marker)
        if not linked_at:
            self.client.append_event(
                workspace["id"],
                kind="profiles",
                record_id=workspace["id"],
                event_type="created",
                data={"action": "workspace_linked", "client": "desktop"},
            )
            linked_at = now()
            ledger["linked"][marker] = linked_at
        record = {
            "id": LINK_ID,
            "user_id": session.user_id,
            "email": session.email,
            "workspace_id": workspace["id"],
            "linked_event_at": linked_at,
        }
        self.store.put_many([(LINK_KIND, ledger), (LINK_KIND, record)])
        return self.status()


def default_account(store) -> CloudAccount | None:
    """Factory for cloud_api.install: None when no cloud project is configured."""
    config = load()
    if config is None:
        return None
    return CloudAccount(store, SupabaseClient(config), CloudSecrets())
