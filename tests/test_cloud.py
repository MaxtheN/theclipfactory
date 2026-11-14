"""Offline contract tests for the optional Supabase cloud account. No live network calls."""

import base64
import json
import sqlite3

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from clip_factory import cloud
from clip_factory.cloud import (
    CONFIRM_EMAIL,
    CloudAccount,
    CloudConfig,
    CloudError,
    CloudSecrets,
    SupabaseClient,
)
from clip_factory.cloud_api import install
from clip_factory.store import Store

URL = "https://project.supabase.co"
KEY = "sb_publishable_test-key"
PASSWORD = "correct-horse-battery"
UID = "11111111-1111-1111-1111-111111111111"
WS = "22222222-2222-2222-2222-222222222222"


@pytest.fixture
def keychain(monkeypatch):
    saved = {}

    class Native:
        __module__ = "keyring.backends.macOS"
        priority = 1

        def set_password(self, service, name, value):
            saved[(service, name)] = value

        def get_password(self, service, name):
            return saved.get((service, name))

        def delete_password(self, service, name):
            saved.pop((service, name), None)

    monkeypatch.setattr("clip_factory.meta.keyring.get_keyring", lambda: Native())
    return saved


class Fake:
    """Minimal GoTrue/PostgREST double with refresh-token rotation."""

    def __init__(self):
        self.calls, self.workspaces, self.events = [], [], []
        self.generation = 0
        self.valid_access = set()
        self.confirm_email = False
        self.expire_next_rest = False

    def session(self):
        self.generation += 1
        access, refresh = f"access-{self.generation}", f"refresh-{self.generation}"
        self.valid_access.add(access)
        self.current_refresh = refresh
        return {
            "access_token": access,
            "refresh_token": refresh,
            "token_type": "bearer",
            "user": {"id": UID, "email": "ana@example.com"},
        }

    def __call__(self, request: httpx.Request):
        self.calls.append(request)
        assert request.headers["apikey"] == KEY
        path, params = request.url.path, request.url.params
        body = json.loads(request.content) if request.content else None
        if path == "/auth/v1/signup":
            if self.confirm_email:
                return httpx.Response(
                    200, json={"id": UID, "email": body["email"], "confirmation_sent_at": "x"}
                )
            return httpx.Response(200, json=self.session())
        if path == "/auth/v1/token" and params["grant_type"] == "password":
            if body["password"] != PASSWORD:
                return httpx.Response(
                    400, json={"error_code": "invalid_credentials", "msg": "Invalid login credentials"}
                )
            return httpx.Response(200, json=self.session())
        if path == "/auth/v1/token" and params["grant_type"] == "refresh_token":
            if body["refresh_token"] != self.current_refresh:
                return httpx.Response(400, json={"error_code": "refresh_token_not_found"})
            return httpx.Response(200, json=self.session())
        if path == "/auth/v1/logout":
            return httpx.Response(204)
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        if self.expire_next_rest:
            self.expire_next_rest = False
            self.valid_access.discard(token)
        if token not in self.valid_access:
            return httpx.Response(401, json={"message": "JWT expired"})
        if path == "/rest/v1/gf_workspaces" and request.method == "GET":
            assert params["owner_id"] == f"eq.{UID}"
            return httpx.Response(200, json=[w for w in self.workspaces if w["owner_id"] == UID][:1])
        if path == "/rest/v1/gf_workspaces" and request.method == "POST":
            assert request.headers["prefer"] == "return=representation"
            row = {"id": WS, "owner_id": body["owner_id"], "name": body["name"]}
            self.workspaces.append(row)
            return httpx.Response(201, json=[{"id": row["id"], "name": row["name"]}])
        if path == "/rest/v1/gf_events" and request.method == "POST":
            self.events.append(body)
            return httpx.Response(201)
        return httpx.Response(404)


@pytest.fixture
def fake():
    return Fake()


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path)


@pytest.fixture
def account(store, fake, keychain):
    client = SupabaseClient(CloudConfig(URL, KEY), transport=httpx.MockTransport(fake))
    return CloudAccount(store, client, CloudSecrets())


def sqlite_dump(store) -> str:
    with sqlite3.connect(store.path) as db:
        return json.dumps(db.execute("SELECT kind, id, data FROM records").fetchall())


def test_sign_up_links_workspace_and_keeps_secrets_out_of_sqlite(account, fake, store, keychain):
    result = account.sign_up("Ana@Example.com", PASSWORD, "Founder stories")
    assert result == {"configured": True, "signed_in": True, "email": "ana@example.com", "workspace_id": WS}
    assert keychain == {("growth-factory-supabase", "refresh-token"): "refresh-1"}
    dump = sqlite_dump(store)
    assert PASSWORD not in dump and "refresh-" not in dump and "access-" not in dump
    link = store.get("config", "cloud_link")
    assert set(link) == {"id", "user_id", "email", "workspace_id", "linked_event_at"}
    assert list(store.get("config", "cloud_link_events")["linked"]) == [f"{UID}:{WS}"]
    assert fake.workspaces[0]["name"] == "Founder stories"
    assert fake.events == [
        {
            "workspace_id": WS,
            "kind": "profiles",
            "record_id": WS,
            "event_type": "created",
            "data": {"action": "workspace_linked", "client": "desktop"},
        }
    ]
    assert account.client.session.access_token == "access-1"  # memory only


def test_sign_in_finds_existing_workspace_and_appends_event_once(account, fake, store):
    account.sign_up("ana@example.com", PASSWORD)
    account.sign_out()
    fake.workspaces[0]["name"] = "kept"
    account.sign_in("ana@example.com", PASSWORD)
    posts = [c for c in fake.calls if c.url.path == "/rest/v1/gf_workspaces" and c.method == "POST"]
    assert len(posts) == 1 and len(fake.workspaces) == 1
    assert len(fake.events) == 1  # same user + workspace already linked on this device
    account.sign_in("ana@example.com", PASSWORD)
    assert len(fake.events) == 1
    assert store.get("config", "cloud_link")["linked_event_at"]


def test_refresh_rotation_persists_immediately_and_401_retries_once(account, fake, keychain):
    account.sign_in("ana@example.com", PASSWORD)
    fake.expire_next_rest = True
    assert account.client.find_workspace(UID)["id"] == WS
    assert keychain[("growth-factory-supabase", "refresh-token")] == "refresh-2"
    assert account.client.session.access_token == "access-2"
    refreshes = [c for c in fake.calls if c.url.params.get("grant_type") == "refresh_token"]
    assert len(refreshes) == 1


def test_refresh_after_restart_uses_keychain_and_reused_token_signs_out(store, fake, keychain):
    first = CloudAccount(
        store, SupabaseClient(CloudConfig(URL, KEY), transport=httpx.MockTransport(fake)), CloudSecrets()
    )
    first.sign_in("ana@example.com", PASSWORD)
    restarted = SupabaseClient(CloudConfig(URL, KEY), transport=httpx.MockTransport(fake))
    CloudAccount(store, restarted, CloudSecrets())
    assert restarted.session is None
    restarted.find_workspace(UID)  # refreshes from Keychain because no access token is in memory
    assert keychain[("growth-factory-supabase", "refresh-token")] == "refresh-2"
    fake.current_refresh = "rotated-elsewhere"
    restarted.session = None
    with pytest.raises(CloudError) as error:
        restarted.find_workspace(UID)
    assert error.value.status == 401 and "Sign in again" in error.value.message
    assert keychain == {}


def test_password_never_persisted_or_in_errors(account, store, keychain):
    with pytest.raises(CloudError) as error:
        account.sign_in("ana@example.com", "wrong-password-1")
    assert error.value.status == 401 and "wrong-password" not in str(error.value)
    assert keychain == {} and store.get("config", "cloud_link") is None
    with pytest.raises(CloudError) as short:
        account.sign_in("ana@example.com", "short")
    assert short.value.status == 400 and "short" not in short.value.message


def test_signup_without_session_asks_for_confirmation(account, fake, store, keychain):
    fake.confirm_email = True
    result = account.sign_up("ana@example.com", PASSWORD)
    assert result["signed_in"] is False and result["confirmation_required"] is True
    assert result["message"] == CONFIRM_EMAIL
    assert keychain == {} and store.get("config", "cloud_link") is None and fake.workspaces == []


def test_sign_out_clears_keychain_and_link(account, store, keychain, fake):
    account.sign_in("ana@example.com", PASSWORD)
    assert account.sign_out()["signed_in"] is False
    assert keychain == {} and store.get("config", "cloud_link") is None
    assert account.client.session is None
    assert any(c.url.path == "/auth/v1/logout" for c in fake.calls)


def _jwt(role):
    def part(data):
        return base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")

    return f"{part({'alg': 'HS256'})}.{part({'role': role})}.signature"


@pytest.mark.parametrize("key", ["sb_secret_abc", _jwt("service_role")])
def test_loader_rejects_secret_and_service_role_keys(tmp_path, key):
    path = tmp_path / "cloud.json"
    path.write_text(json.dumps({"url": URL, "publishable_key": KEY}))
    with pytest.raises(CloudError) as error:
        cloud.load(path, {"CLIP_SUPABASE_PUBLISHABLE_KEY": key})
    assert key not in error.value.message
    path.write_text(json.dumps({"url": URL, "publishable_key": key}))
    with pytest.raises(CloudError):
        cloud.load(path, {})


def test_loader_file_env_override_and_missing(tmp_path):
    path = tmp_path / "cloud.json"
    assert cloud.load(path, {}) is None
    path.write_text(json.dumps({"url": URL + "/", "publishable_key": KEY}))
    assert cloud.load(path, {}) == CloudConfig(URL, KEY)
    assert (
        cloud.load(path, {"CLIP_SUPABASE_URL": "https://other.supabase.co"}).url
        == "https://other.supabase.co"
    )
    assert cloud.load(path, {"CLIP_SUPABASE_PUBLISHABLE_KEY": _jwt("anon")}).publishable_key == _jwt("anon")
    with pytest.raises(CloudError):
        cloud.load(path, {"CLIP_SUPABASE_URL": "http://project.supabase.co"})
    assert KEY not in repr(CloudConfig(URL, KEY))


def test_bundled_config_is_publishable_only():
    data = json.loads(cloud.CONFIG_PATH.read_text())
    assert set(data) == {"url", "publishable_key"}
    assert data["publishable_key"].startswith("sb_publishable_")
    assert cloud.load(environ={}) is not None


def make_app(factory):
    app = FastAPI()
    install(app, factory)
    return TestClient(app)


def test_api_not_configured_returns_409():
    client = make_app(lambda: None)
    assert client.get("/api/cloud/status").json() == {
        "configured": False,
        "signed_in": False,
        "email": None,
        "workspace_id": None,
    }
    for path in ["/api/cloud/sign-in", "/api/cloud/sign-up"]:
        assert client.post(path, json={"email": "a@b.co", "password": PASSWORD}).status_code == 409
    assert client.post("/api/cloud/sign-out").status_code == 409


def test_api_secret_key_config_reports_unconfigured():
    def factory():
        raise CloudError(
            "Refusing a Supabase secret/service-role key; the app needs the publishable key.", 409
        )

    client = make_app(factory)
    status = client.get("/api/cloud/status").json()
    assert status["configured"] is False and "secret" in status["message"]
    assert (
        client.post("/api/cloud/sign-in", json={"email": "a@b.co", "password": PASSWORD}).status_code == 409
    )


def test_api_flow_and_safe_errors(account, store):
    client = make_app(lambda: account)
    assert client.get("/api/cloud/status").json()["signed_in"] is False
    bad = client.post("/api/cloud/sign-in", json={"email": "ana@example.com", "password": "wrong-password-1"})
    assert bad.status_code == 401 and "wrong-password" not in bad.text
    short = client.post("/api/cloud/sign-up", json={"email": "ana@example.com", "password": "short"})
    assert short.status_code == 400 and 'short"' not in short.text
    ok = client.post("/api/cloud/sign-up", json={"email": "ana@example.com", "password": PASSWORD})
    assert ok.status_code == 200 and ok.json()["workspace_id"] == WS
    assert PASSWORD not in ok.text and "refresh-" not in ok.text and "access-" not in ok.text
    assert client.get("/api/cloud/status").json()["email"] == "ana@example.com"
    assert client.post("/api/cloud/sign-out").json()["signed_in"] is False


def test_api_network_failure_is_safe_502(store, keychain):
    def boom(request):
        raise httpx.ConnectError("secret detail", request=request)

    failing = CloudAccount(
        store, SupabaseClient(CloudConfig(URL, KEY), transport=httpx.MockTransport(boom)), CloudSecrets()
    )
    response = make_app(lambda: failing).post(
        "/api/cloud/sign-in", json={"email": "ana@example.com", "password": PASSWORD}
    )
    assert response.status_code == 502 and "secret detail" not in response.text
