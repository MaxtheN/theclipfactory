"""Self-serve Connect Instagram: Composio Connect Link, polling and verified binding (offline)."""

import json
import logging
import re
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from clip_factory.app import create_app
from clip_factory.autonomy_runtime import ConnectionSettings
from clip_factory.composio import ComposioClient

KEY = "offline-secret-key-value"
REDIRECT = "https://connect.composio.dev/link/lk_test"


@pytest.fixture
def client(tmp_path):
    app = create_app(tmp_path, token="local-test")
    runtime = app.state.autonomy_runtime
    runtime.resource_check = lambda *_: None
    saved = {}
    runtime.secrets = SimpleNamespace(get=lambda: saved.get("key"), set=lambda value: saved.update(key=value))
    opened = []
    runtime.open_url = lambda url: opened.append(url) or True
    with TestClient(app, base_url="http://127.0.0.1", headers={"X-Clip-Token": "local-test"}) as session:
        runtime.configure(ConnectionSettings(auth_config_id="ac_exact", api_key=KEY))
        app.state.store.put("profiles", {"id": "profile"})
        yield session, runtime, opened


def provider(runtime, *, status="INITIATED", link_status=201, account_type="BUSINESS", owner=None, calls=None):
    """Composio stand-in. `status` may be changed between polls through the returned dict."""
    state = {"status": status, "user_id": None}
    calls = [] if calls is None else calls

    def handle(request):
        calls.append(request)
        assert request.headers["x-api-key"] == KEY
        assert request.url.host == "backend.composio.dev"
        path = request.url.path
        if request.method == "POST" and path == "/api/v3/connected_accounts/link":
            body = json.loads(request.content)
            assert body["auth_config_id"] == "ac_exact"
            state["user_id"] = body["user_id"]
            if link_status != 201:
                return httpx.Response(link_status, json={"error": {"message": f"key {KEY} lacks write", "slug": "APIKey_InsufficientPermissions"}})
            return httpx.Response(201, json={"connected_account_id": "ca_new", "redirect_url": REDIRECT,
                "link_token": "lt_secret_token", "expires_at": "2099-01-01T00:00:00Z"})
        if request.method == "GET" and path == "/api/v3/connected_accounts/ca_new":
            return httpx.Response(200, json={"id": "ca_new", "user_id": owner or state["user_id"],
                "status": state["status"], "toolkit": {"slug": "instagram"}, "auth_config": {"id": "ac_exact"},
                "state": {"access_token": "provider-token-must-not-leak"}})
        if request.method == "GET" and path == "/api/v3.1/tools/INSTAGRAM_GET_USER_INFO":
            return httpx.Response(200, json={"slug": "INSTAGRAM_GET_USER_INFO", "version": "20261112_00",
                "toolkit": {"slug": "instagram"}, "input_parameters": {
                    "ig_user_id": {"type": "string"}, "fields": {"type": "string"}}})
        if request.method == "POST" and path == "/api/v3.1/tools/execute/INSTAGRAM_GET_USER_INFO":
            body = json.loads(request.content)
            assert (body["connected_account_id"], body["user_id"]) == ("ca_new", state["user_id"])
            return httpx.Response(200, json={"successful": True, "error": None, "data": {
                "id": "900", "user_id": "321", "username": "new_creator", "account_type": account_type}})
        pytest.fail(f"Unexpected provider request: {request.method} {path}")

    adapter = ComposioClient(KEY, transport=httpx.MockTransport(handle))
    runtime.client = lambda: adapter
    return state, calls


def test_install_user_id_is_random_stable_and_never_personal(client):
    _session, runtime, _ = client
    first = runtime.composio_user_id()
    assert re.fullmatch(r"gf-install-[0-9a-f]{32}", first)
    assert runtime.composio_user_id() == first  # Persisted locally, stable per install.


def test_signed_in_user_id_is_a_hash_of_the_cloud_user_never_the_email(client):
    _session, runtime, _ = client
    runtime.store.put("config", {"id": "cloud_link", "user_id": "5b1c-uuid", "email": "person@example.com"})
    derived = runtime.composio_user_id()
    assert re.fullmatch(r"gf-user-[0-9a-f]{32}", derived)
    assert "5b1c" not in derived and "person" not in derived
    assert runtime.composio_user_id() == derived


def test_connect_creates_link_for_derived_user_and_opens_system_browser(client, caplog):
    session, runtime, opened = client
    state, _calls = provider(runtime)
    with caplog.at_level(logging.DEBUG):
        response = session.post("/api/automation/connect/instagram", json={"profile_id": "profile"})
    assert response.status_code == 201, response.text
    body = response.json()
    assert body == {"request_id": "ca_new", "status": "pending", "redirect_url": REDIRECT,
        "expires_at": "2099-01-01T00:00:00Z", "opened": True}
    assert opened == [REDIRECT]
    assert state["user_id"] == runtime.composio_user_id()
    intent = runtime.store.get("connection_intents", "ca_new")
    assert (intent["profile_id"], intent["user_id"], intent["auth_config_id"]) == ("profile", state["user_id"], "ac_exact")
    for secret in (KEY, "lt_secret_token"):
        assert secret not in response.text and secret not in json.dumps(intent) and secret not in caplog.text
    assert runtime.store.all("connected_accounts") == []


def test_connect_requires_profile_and_settings(client):
    session, runtime, _ = client
    provider(runtime)
    assert session.post("/api/automation/connect/instagram", json={"profile_id": "missing"}).status_code == 404
    runtime.store.put("automation_settings", {"id": "local"})
    assert session.post("/api/automation/connect/instagram", json={"profile_id": "profile"}).status_code == 409


@pytest.mark.parametrize("code", [401, 403])
def test_key_without_connection_management_gets_clear_403_and_no_intent(client, code, caplog):
    session, runtime, opened = client
    provider(runtime, link_status=code)
    with caplog.at_level(logging.DEBUG):
        response = session.post("/api/automation/connect/instagram", json={"profile_id": "profile"})
    assert response.status_code == 403
    assert response.json()["detail"] == "Your Composio key needs connected-account management permission."
    assert KEY not in response.text and KEY not in caplog.text
    assert runtime.store.all("connection_intents") == [] and opened == []


def test_other_provider_errors_are_not_reported_as_permission(client):
    session, runtime, _ = client
    provider(runtime, link_status=404)
    response = session.post("/api/automation/connect/instagram", json={"profile_id": "profile"})
    assert response.status_code == 400 and "connected-account management" not in response.json()["detail"]


def test_poll_pending_then_active_binds_after_identity_verification(client):
    session, runtime, _ = client
    state, calls = provider(runtime)
    session.post("/api/automation/connect/instagram", json={"profile_id": "profile"})
    for pending in ("INITIALIZING", "INITIATED"):
        state["status"] = pending
        polled = session.get("/api/automation/connect/ca_new").json()
        assert polled["status"] == "pending"
        assert runtime.store.all("connected_accounts") == []
    state["status"] = "ACTIVE"
    response = session.get("/api/automation/connect/ca_new")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "connected"
    assert body["account"] == {"id": "ca_new", "display_name": "new_creator", "instagram_user_id": "321", "profile_id": "profile"}
    record = runtime.store.get("connected_accounts", "ca_new")
    assert (record["user_id"], record["auth_config_id"], record["status"]) == (state["user_id"], "ac_exact", "active")
    assert any(r.url.path == "/api/v3.1/tools/execute/INSTAGRAM_GET_USER_INFO" for r in calls)
    assert "provider-token-must-not-leak" not in response.text and KEY not in response.text
    # Terminal: later polls answer locally without provider IO.
    before = len(calls)
    assert session.get("/api/automation/connect/ca_new").json()["status"] == "connected"
    assert len(calls) == before


@pytest.mark.parametrize(("status", "expected"), [
    ("FAILED", "failed"), ("REVOKED", "failed"), ("INACTIVE", "failed"), ("EXPIRED", "expired"),
])
def test_failed_and_expired_states_are_explicit_and_terminal(client, status, expected):
    session, runtime, _ = client
    state, _calls = provider(runtime)
    session.post("/api/automation/connect/instagram", json={"profile_id": "profile"})
    state["status"] = status
    body = session.get("/api/automation/connect/ca_new").json()
    assert body["status"] == expected and body["message"]
    state["status"] = "ACTIVE"  # A terminal request never binds later.
    assert session.get("/api/automation/connect/ca_new").json()["status"] == expected
    assert runtime.store.all("connected_accounts") == []


def test_link_past_its_expiry_is_reported_expired(client):
    session, runtime, _ = client
    provider(runtime)
    session.post("/api/automation/connect/instagram", json={"profile_id": "profile"})
    intent = runtime.store.get("connection_intents", "ca_new")
    runtime.store.put("connection_intents", {**intent, "expires_at": "2000-01-01T00:00:00Z"})
    assert session.get("/api/automation/connect/ca_new").json()["status"] == "expired"


def test_personal_account_fails_identity_and_never_binds(client):
    session, runtime, _ = client
    state, _ = provider(runtime, account_type="PERSONAL")
    session.post("/api/automation/connect/instagram", json={"profile_id": "profile"})
    state["status"] = "ACTIVE"
    body = session.get("/api/automation/connect/ca_new").json()
    assert body["status"] == "failed" and "Business or Creator" in body["message"]
    assert runtime.store.all("connected_accounts") == []


def test_foreign_owner_never_binds(client):
    session, runtime, _ = client
    state, _ = provider(runtime, owner="someone-else")
    session.post("/api/automation/connect/instagram", json={"profile_id": "profile"})
    state["status"] = "ACTIVE"
    response = session.get("/api/automation/connect/ca_new")
    assert response.status_code == 400
    assert runtime.store.all("connected_accounts") == []


def test_unknown_request_and_unsafe_ids_are_rejected(client):
    session, runtime, _ = client
    provider(runtime)
    assert session.get("/api/automation/connect/ca_unknown").status_code == 404
    assert session.get("/api/automation/connect/bad.id").status_code == 422
    assert session.get("/api/automation/connect/ca_new", headers={"X-Clip-Token": "wrong"}).status_code == 401
