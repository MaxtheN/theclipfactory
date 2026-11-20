"""Connected posting accounts (Zernio, through the posting server) and their local workspace bindings.

A remote account becomes a local ``connected_accounts`` record (``provider: zernio``). It is bound to
exactly one workspace profile, either automatically when this app started the connection for that
profile and exactly one new account of that platform appeared, or explicitly. Posting permission is
separate and starts off: the person turns it on per account.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from .posting_server import PLATFORM_LABELS, PLATFORMS, ZERNIO_ID, PostingServerError
from .publisher import PROVIDER, PublishError, _from_server
from .store import new_id, now

ACCOUNTS = "connected_accounts"
INTENTS = "posting_connect_intents"
INTENT_MINUTES = 30


def view(account: dict) -> dict:
    return {k: account.get(k) for k in ("id", "provider", "platform", "zernio_account_id", "profile_id",
                                        "display_name", "username", "avatar_url", "status",
                                        "publishing_permitted", "verified_at", "updated_at")} | {
        "platform_label": PLATFORM_LABELS.get(account.get("platform"), account.get("platform"))}


class PostingAccounts:
    def __init__(self, store, *, server_factory: Callable, engine=None,
                 open_url: Callable[[str], bool] | None = None, clock: Callable[[], datetime] | None = None):
        self.store, self.server_factory, self.engine = store, server_factory, engine
        self.open_url = open_url or (lambda url: False)
        self.clock = clock or (lambda: datetime.now(UTC))

    def _server(self):
        server = self.server_factory()
        if server is None:
            raise PublishError(409, "Growth Factory cloud is not configured; connecting accounts needs it.",
                               "cloud_not_configured")
        return server

    def _call(self, action):
        try:
            return action()
        except PostingServerError as error:
            raise _from_server(error) from None

    def list(self, profile_id: str | None = None) -> list[dict]:
        rows = [a for a in self.store.all(ACCOUNTS) if a.get("provider") == PROVIDER]
        return [view(a) for a in rows if profile_id is None or a.get("profile_id") in (profile_id, None)]

    def get(self, identifier: str) -> dict:
        account = self.store.get(ACCOUNTS, identifier)
        if not account or account.get("provider") != PROVIDER:
            raise PublishError(404, "Connected account not found.", "not_found")
        return account

    # ------------------------------------------------------------------ sync
    def _open_intents(self) -> list[dict]:
        stamp = self.clock()
        return sorted((i for i in self.store.all(INTENTS) if i.get("status") == "pending"
                       and datetime.fromisoformat(i["expires_at"]) > stamp), key=lambda i: i["created_at"])

    def sync(self) -> list[dict]:
        """Read the workspace's accounts from the posting server and update the local records."""
        self._refresh()
        return self.list()

    def _refresh(self) -> list[dict]:
        remote = self._call(lambda: self._server().accounts())
        stamp, seen, updates = now(), set(), []
        for item in remote:
            seen.add(item["id"])
            local = self.store.get(ACCOUNTS, item["id"])
            details = {"display_name": item.get("displayName") or item.get("username") or
                       PLATFORM_LABELS.get(item["platform"], item["platform"]),
                       "username": item.get("username"), "avatar_url": item.get("avatarUrl"), "updated_at": stamp}
            if local:
                if local.get("provider") != PROVIDER:
                    continue
                if local.get("status") == "disconnected":
                    # Disconnected here but present again upstream: it was reconnected. Bind it again
                    # before it can be used; posting permission stays off.
                    updates.append({**local, **details, "status": "unbound", "profile_id": None,
                                    "publishing_permitted": False})
                    continue
                status = ("needs_reconnect" if item.get("connected") is False
                          else "active" if local.get("profile_id") else "unbound")
                updates.append({**local, **details, "status": status})
                continue
            updates.append({"id": item["id"], "provider": PROVIDER, "platform": item["platform"],
                            "zernio_account_id": item["id"], "profile_id": None, "status": "unbound",
                            "publishing_permitted": False, "verified_at": stamp, "created_at": stamp, **details})
        for local in self.store.all(ACCOUNTS):
            if (local.get("provider") == PROVIDER and local["id"] not in seen
                    and local.get("status") in {"active", "unbound", "needs_reconnect"}):
                updates.append({**local, "status": "disconnected", "publishing_permitted": False,
                                "updated_at": stamp, "disconnected_reason": "Removed from the posting service."})
        updates = [(ACCOUNTS, row) for row in updates]
        if updates:
            self.store.put_many(updates)
        self._bind_intents()
        return remote

    def _bind_intents(self):
        """An account that appeared after this app started a connection for a profile is bound to it,
        but only when exactly one new account of that platform appeared (otherwise bind explicitly)."""
        for intent in self._open_intents():
            known = set(intent.get("known_account_ids") or [])
            fresh = [a for a in self.store.all(ACCOUNTS) if a.get("provider") == PROVIDER
                     and a.get("platform") == intent["platform"] and a["id"] not in known
                     and a.get("status") == "unbound" and not a.get("profile_id")]
            if len(fresh) == 1:
                account = {**fresh[0], "profile_id": intent["profile_id"], "status": "active",
                           "bound_at": now(), "bound_by": "connect"}
                self.store.put_many([(ACCOUNTS, account),
                                     (INTENTS, {**intent, "status": "connected", "account_id": account["id"]})])
            elif len(fresh) > 1:
                self.store.put(INTENTS, {**intent, "status": "ambiguous"})

    # ------------------------------------------------------------------ connect
    def connect(self, platform: str, profile_id: str, callback_url: Callable[[str], str]) -> dict:
        if platform not in PLATFORMS:
            raise PublishError(422, "Choose a supported platform.", "unsupported_platform")
        if not self.store.get("profiles", profile_id):
            raise PublishError(404, "Workspace profile not found.", "not_found")
        known = [a["id"] for a in self._refresh() if a.get("platform") == platform]
        stamp = self.clock()
        identifier = new_id()
        intent = {"id": identifier, "platform": platform, "profile_id": profile_id, "known_account_ids": known,
                  "status": "pending", "created_at": stamp.isoformat(),
                  "expires_at": (stamp + timedelta(minutes=INTENT_MINUTES)).isoformat()}
        self.store.put(INTENTS, intent)
        url = self._call(lambda: self._server().connect(platform, callback_url(identifier)))
        try:
            opened = bool(self.open_url(url))
        except Exception:  # noqa: BLE001 - a missing browser must not fail the request
            opened = False
        return {"request_id": identifier, "platform": platform, "status": "pending", "opened": opened,
                "auth_url": url}

    def connect_status(self, request_id: str, *, refresh: bool = True) -> dict:
        intent = self.store.get(INTENTS, request_id)
        if not intent:
            raise PublishError(404, "Connection request not found.", "not_found")
        if refresh and intent["status"] == "pending":
            self.sync()
            intent = self.store.get(INTENTS, request_id)
        status = intent["status"]
        if status == "pending" and datetime.fromisoformat(intent["expires_at"]) <= self.clock():
            status = "expired"
        account = self.store.get(ACCOUNTS, intent.get("account_id") or "")
        return {"request_id": request_id, "platform": intent["platform"], "status": status,
                "account": view(account) if account else None}

    def is_pending(self, request_id: str) -> bool:
        intent = self.store.get(INTENTS, request_id)
        return bool(intent and intent.get("status") == "pending"
                    and datetime.fromisoformat(intent["expires_at"]) > self.clock())

    # ------------------------------------------------------------------ binding and permission
    def bind(self, identifier: str, profile_id: str) -> dict:
        account = self.get(identifier)
        if not self.store.get("profiles", profile_id):
            raise PublishError(404, "Workspace profile not found.", "not_found")
        if account.get("status") not in {"unbound", "active"}:
            raise PublishError(409, "Reconnect this account before binding it.", "account_unavailable")
        if account.get("profile_id") and account["profile_id"] != profile_id:
            raise PublishError(409, "This account is bound to another workspace profile.", "account_bound")
        row = {**account, "profile_id": profile_id, "status": "active", "bound_at": account.get("bound_at") or now(),
               "bound_by": account.get("bound_by") or "explicit", "updated_at": now()}
        self.store.put(ACCOUNTS, row)
        return view(row)

    def set_permission(self, identifier: str, permitted: bool) -> dict:
        account = self.get(identifier)
        if permitted and (account.get("status") != "active" or not account.get("profile_id")):
            raise PublishError(409, "Bind this account to a workspace profile before allowing posting.",
                               "account_unbound")
        row = {**account, "publishing_permitted": bool(permitted), "updated_at": now(),
               "permission_changed_at": now()}
        self.store.put(ACCOUNTS, row)
        return view(row)

    def disconnect(self, identifier: str) -> dict:
        account = self.get(identifier)
        revoked = False
        if account.get("status") != "disconnected" and ZERNIO_ID.fullmatch(account.get("zernio_account_id") or ""):
            try:
                self._server().disconnect(account["zernio_account_id"])
                revoked = True
            except PostingServerError as error:
                if error.status != 404:
                    raise _from_server(error) from None
        # Keep the record (history and learning evidence) and stop all work for it right away.
        updates = [(ACCOUNTS, {**account, "status": "disconnected", "publishing_permitted": False,
                               "updated_at": now()})]
        if self.engine is not None:
            for policy in self.engine.list_policies():
                if policy["account_id"] == identifier and policy.get("enabled"):
                    updates.append(("learning_policies", {**policy, "enabled": False}))
        self.store.put_many(updates)
        return {"id": identifier, "status": "disconnected", "provider_access_revoked": revoked}
