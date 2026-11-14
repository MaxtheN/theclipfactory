"""Offline local API/runtime contracts; no provider grants or public effects."""
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from clip_factory.app import create_app
from clip_factory.autonomy_runtime import ConnectionSettings
from clip_factory.meta import MetaError


@pytest.fixture
def client(tmp_path, monkeypatch):
    app = create_app(tmp_path, token="local-test")
    app.state.autonomy_runtime.resource_check = lambda *_: None
    saved = {}
    app.state.autonomy_runtime.secrets = SimpleNamespace(
        get=lambda: saved.get("key"), set=lambda value: saved.update(key=value)
    )
    with TestClient(app, base_url="http://127.0.0.1", headers={"X-Clip-Token": "local-test"}) as session:
        yield session, saved
    assert not app.state.autonomy_runtime.thread.is_alive()


def test_new_endpoints_are_authenticated_and_have_no_publish_or_spend(client):
    session, _ = client
    for endpoint in ("/api/automation/state", "/api/automation/accounts", "/api/automation/settings"):
        assert session.get(endpoint, headers={"X-Clip-Token": "wrong"}).status_code == 401
    state = session.get("/api/automation/state").json()
    assert state["publishing_policy"] == "human_approval"
    assert state["paid_spending_enabled"] is False
    assert session.post("/api/automation/publish").status_code == 404
    assert session.post("/api/automation/settings", json={"ads_enabled": True}).status_code == 405


def test_key_stays_out_of_store_responses_and_validation_errors(client):
    session, secrets = client
    secret = "private-key-do-not-log"
    response = session.put("/api/automation/settings", json={"auth_config_id": "ac_test", "api_key": secret})
    assert response.status_code == 200 and secrets["key"] == secret
    assert secret not in response.text
    assert secret not in session.app.state.store.path.read_bytes().decode(errors="ignore")
    invalid = session.put("/api/automation/settings", json={"auth_config_id": "ac_test", "api_key": secret, "ads_enabled": True})
    assert invalid.status_code == 422 and secret not in invalid.text
    assert secret not in repr(ConnectionSettings(auth_config_id="ac_test", api_key=secret))


def test_rejected_config_switch_does_not_replace_secret(client):
    session, secrets = client
    runtime = session.app.state.autonomy_runtime
    runtime.configure(ConnectionSettings(auth_config_id="ac_original", api_key="old"))
    runtime.store.put("learning_policies", {"id": "active", "enabled": True})
    response = session.put("/api/automation/settings", json={"auth_config_id": "ac_other", "api_key": "new"})
    assert response.status_code == 409 and secrets["key"] == "old"


def test_verify_uses_exact_server_intent_and_real_account_identity(client):
    session, _ = client
    runtime = session.app.state.autonomy_runtime
    runtime.store.put("profiles", {"id": "profile"})
    runtime.configure(ConnectionSettings(auth_config_id="ac_test", api_key="secret"))
    calls = []

    class Provider:
        def initiate_connection(self, auth_config_id, user_id):
            calls.append((auth_config_id, user_id))
            return {"connected_account_id": "ca_exact", "redirect_url": "https://connect.composio.dev/link", "expires_at": None}

        def read_account(self, account, user, auth):
            assert (account, user, auth) == ("ca_exact", "growth-factory-profile", "ac_test")
            return {"status": "ACTIVE"}

        def account_identity(self, account, user):
            assert account == "ca_exact" and user == "growth-factory-profile"
            return {"instagram_user_id": "123", "username": "creator"}

    runtime.client = Provider
    assert session.post("/api/automation/connections/ca_foreign/verify").status_code == 404
    start = session.post("/api/automation/connections", json={"profile_id": "profile"})
    assert start.status_code == 201
    verified = session.post("/api/automation/connections/ca_exact/verify")
    assert verified.status_code == 200
    assert verified.json()["display_name"] == "creator"
    assert verified.json()["instagram_user_id"] == "123"
    assert len(calls) == 1


def test_provider_failure_does_not_create_local_binding(client):
    session, _ = client
    runtime = session.app.state.autonomy_runtime
    runtime.store.put("profiles", {"id": "p"})
    runtime.store.put("connection_intents", {"id": "ca", "profile_id": "p", "user_id": "u", "auth_config_id": "ac"})
    def denied(*args):
        raise MetaError("Wrong account or expired grant.")
    runtime.client = lambda: SimpleNamespace(read_account=denied)
    assert session.post("/api/automation/connections/ca/verify").status_code == 400
    assert session.get("/api/automation/accounts").json() == []


def test_check_due_never_fast_forwards_and_disconnect_preserves_evidence(client):
    session, _ = client
    store = session.app.state.store
    store.put("connected_accounts", {"id": "ca", "status": "active"})
    store.put("learning_policies", {"id": "policy", "account_id": "ca", "enabled": True})
    store.put("learning_snapshots", {"id": "evidence", "metrics": {"views": None}})
    assert session.post("/api/automation/check").status_code == 202
    response = session.delete("/api/automation/accounts/ca")
    assert response.json()["provider_access_revoked"] is False
    assert store.get("learning_policies", "policy")["enabled"] is False
    assert store.get("learning_snapshots", "evidence")["metrics"]["views"] is None


def test_runtime_producer_passes_actual_changed_fields_and_experiment_id(client):
    session, _ = client
    runtime = session.app.state.autonomy_runtime
    calls = []
    runtime.render = lambda campaign, body, **context: calls.append((campaign, body.model_dump(), context)) or {"id": "job"}
    result = runtime.produce({"id": "experiment", "campaign_id": "campaign", "render_request": {
        "campaign_id": "campaign", "profile_id": "profile", "video_id": "source", "start": 0, "end": 15,
        "hook": "Actual revised opening", "parent_clip_id": "parent", "change_reason": "Test one opening",
        "changed_variable": "hook", "expected_strategy_version_id": "base", "opening_treatment": "text_overlay"}})
    assert result["status"] == "queued" and result["job_id"] == "job"
    assert calls[0][1]["hook"] == "Actual revised opening" and calls[0][2] == {"experiment_id": "experiment"}


def test_runtime_model_receives_bounded_valid_evidence_with_snapshot(client):
    session, _ = client
    runtime, app = session.app.state.autonomy_runtime, session.app
    prompts = []
    def infer(job, model, action, **payload):
        prompts.append(payload["prompt"])
        return {"output": json.dumps({"status": "insufficient_evidence", "rationale": "No comparison.", "limitations": "No causal evidence."})}
    app.state.models.run = infer
    context = {"snapshot": {"id": "snapshot", "metrics": {"views": None}}, "policy": {"profile_id": "p"},
        "profile": {"id": "p", "objective": "discovery"}, "publication": {"id": "post"},
        "clip": {"id": "clip", "start": 500, "end": 515},
        "source": {"id": "source", "duration": 5000, "transcript": {"segments": [{"start": 0, "end": 1, "text": "x" * 60000}, {"start": 498, "end": 503, "text": "Opening thought."}, {"start": 503, "end": 515, "text": "Selected point."}]}},
        "strategy": {"directions": {"p": {"framing": "fit"}}}}
    result = runtime.analyze(context)
    assert result["status"] == "insufficient_evidence"
    evidence = json.loads(prompts[0].split("Evidence:\n", 1)[1])
    assert evidence["snapshot"]["id"] == "snapshot"
    assert evidence["source"]["timed_cues"] == [{"start": 498, "end": 503, "text": "Opening thought."}, {"start": 503, "end": 515, "text": "Selected point."}]


def _track_fixture(session):
    """A real domain policy/publication boundary, with provider IO replaced only at its seam."""
    app, store = session.app, session.app.state.store
    store.put("profiles", {"id": "profile", "objective": "engagement"})
    store.put("connected_accounts", {"id": "ca_exact", "profile_id": "profile", "user_id": "external-user",
        "instagram_user_id": "123", "auth_config_id": "ac_test", "provider": "composio", "toolkit": "instagram", "status": "active"})
    store.put("videos", {"id": "source", "duration": 120})
    store.put("campaigns", {"id": "campaign", "profile_ids": ["profile"], "video_ids": ["source"], "active_strategy_id": "base"})
    store.put("strategy_versions", {"id": "base", "campaign_id": "campaign", "status": "approved", "directions": {"profile": {"framing": "fit", "caption_style": "standard"}}})
    store.put("clips", {"id": "clip", "campaign_id": "campaign", "profile_id": "profile", "video_id": "source", "strategy_version_id": "base", "approved": True, "sha256": "a" * 64})
    policy = app.state.learning.configure_policy({"campaign_id": "campaign", "profile_id": "profile", "account_id": "ca_exact", "enabled": False})
    body = {"policy_id": policy["id"], "clip_id": "clip", "account_id": "ca_exact", "media_id": "999", "sha256": "a" * 64, "confirmed_clip_mapping": True}
    return store, body


def test_track_publication_uses_provider_timestamp_exact_owner_and_human_mapping(client):
    from datetime import datetime, timedelta

    session, _ = client
    store, body = _track_fixture(session)
    calls = []
    published = "2026-11-01T18:20:30+00:00"

    def media_identity(account, user, media, *, instagram_user_id):
        calls.append((account, user, media, instagram_user_id))
        return {"media_id": media, "instagram_user_id": instagram_user_id, "published_at": published, "owner_verified": True}

    session.app.state.autonomy_runtime.client = lambda: SimpleNamespace(media_identity=media_identity)
    response = session.post("/api/automation/publications", json=body)
    assert response.status_code == 201, response.text
    result = response.json()
    as_utc = datetime.fromisoformat
    assert as_utc(result["published_at"]) == as_utc(published)
    assert as_utc(result["next_due_at"]) == as_utc(published) + timedelta(days=3)
    assert calls == [("ca_exact", "external-user", "999", "123")]
    assert result["clip_id"] == "clip" and result["sha256"] == "a" * 64
    assert result["account_id"] == "ca_exact"
    assert result["mapping_source"] == "User confirms exact clip; provider verifies account, media identity and timestamp."
    assert store.get("learning_publications", result["id"]) == result


def test_track_publication_owner_rejection_never_saves_a_mapping(client):
    session, _ = client
    store, body = _track_fixture(session)
    calls = []

    def wrong_owner(account, user, media, *, instagram_user_id):
        calls.append((account, user, media, instagram_user_id))
        raise MetaError("Media ownership could not be verified for this Instagram account.")

    session.app.state.autonomy_runtime.client = lambda: SimpleNamespace(media_identity=wrong_owner)
    response = session.post("/api/automation/publications", json=body)
    assert response.status_code == 400
    assert calls == [("ca_exact", "external-user", "999", "123")]
    assert store.all("learning_publications") == []


def test_track_publication_foreign_policy_is_rejected_before_provider_io(client):
    session, _ = client
    store, body = _track_fixture(session)
    store.put("learning_policies", {"id": "foreign-policy", "profile_id": "foreign-profile", "account_id": "foreign-account", "enabled": False})
    session.app.state.autonomy_runtime.client = lambda: pytest.fail("Foreign policy must fail before any provider request")
    response = session.post("/api/automation/publications", json={**body, "policy_id": "foreign-policy"})
    assert response.status_code == 422
    assert store.all("learning_publications") == []


@pytest.mark.parametrize("change", ["missing_confirmation", "false_confirmation", "manual_timestamp"])
def test_track_publication_requires_explicit_mapping_and_refuses_user_timestamps(client, change):
    session, _ = client
    store, body = _track_fixture(session)
    if change == "missing_confirmation":
        body.pop("confirmed_clip_mapping")
    elif change == "false_confirmation":
        body["confirmed_clip_mapping"] = False
    else:
        body["published_at"] = "2020-01-01T00:00:00Z"
    session.app.state.autonomy_runtime.client = lambda: pytest.fail("Invalid mapping request must fail before provider IO")
    assert session.post("/api/automation/publications", json=body).status_code == 422
    assert store.all("learning_publications") == []


def test_import_account_uses_exact_configuration_user_profile_and_refuses_rebinding(client):
    session, _ = client
    runtime, store = session.app.state.autonomy_runtime, session.app.state.store
    runtime.configure(ConnectionSettings(auth_config_id="ac_exact", api_key="test-key"))
    store.put("profiles", {"id": "profile"})
    store.put("profiles", {"id": "other-profile"})
    calls = []

    class Provider:
        def read_account(self, account, user, config):
            calls.append(("read", account, user, config))
            assert (account, user, config) == ("ca_imported", "explicit-user", "ac_exact")
            return {"status": "ACTIVE"}

        def account_identity(self, account, user):
            calls.append(("identity", account, user))
            assert (account, user) == ("ca_imported", "explicit-user")
            return {"instagram_user_id": "321", "username": "my_creator"}

    runtime.client = Provider
    body = {"profile_id": "profile", "connected_account_id": "ca_imported", "user_id": "explicit-user"}
    response = session.post("/api/automation/accounts/import", json=body)
    assert response.status_code == 201, response.text
    record = response.json()
    assert (record["id"], record["profile_id"], record["user_id"], record["auth_config_id"], record["instagram_user_id"]) == ("ca_imported", "profile", "explicit-user", "ac_exact", "321")
    assert calls == [("read", "ca_imported", "explicit-user", "ac_exact"), ("identity", "ca_imported", "explicit-user")]
    for changes in ({"profile_id": "other-profile"}, {"user_id": "another-user"}):
        assert session.post("/api/automation/accounts/import", json={**body, **changes}).status_code == 409
    assert len(calls) == 2  # Refused before another provider read.
    assert store.get("connected_accounts", "ca_imported") == record


def test_import_account_foreign_provider_user_never_creates_local_binding(client):
    session, _ = client
    runtime, store = session.app.state.autonomy_runtime, session.app.state.store
    runtime.configure(ConnectionSettings(auth_config_id="ac_exact", api_key="test-key"))
    store.put("profiles", {"id": "profile"})
    calls = []

    def foreign(account, user, config):
        calls.append((account, user, config))
        raise MetaError("Verify an active Instagram connection owned by this user.")

    runtime.client = lambda: SimpleNamespace(read_account=foreign)
    response = session.post("/api/automation/accounts/import", json={"profile_id": "profile", "connected_account_id": "ca_foreign", "user_id": "wrong-user"})
    assert response.status_code == 400
    assert calls == [("ca_foreign", "wrong-user", "ac_exact")]
    assert store.all("connected_accounts") == []


def _automatic_import_fixture(session, *, account_changes=None):
    """Use the actual adapter with injected HTTP so provider-owner validation is exercised."""
    import httpx

    from clip_factory.composio import ComposioClient

    runtime, store = session.app.state.autonomy_runtime, session.app.state.store
    runtime.configure(ConnectionSettings(auth_config_id="ac_exact", api_key="offline-test-key"))
    store.put("profiles", {"id": "profile"})
    account = {"id": "ca_selected", "user_id": "authoritative-owner", "status": "ACTIVE",
        "toolkit": {"slug": "instagram"}, "auth_config": {"id": "ac_exact"},
        "state": {"access_token": "provider-state-must-not-leak"}, **(account_changes or {})}
    calls = []

    def provider(request):
        calls.append(request)
        assert request.headers["x-api-key"] == "offline-test-key"
        assert request.url.host == "backend.composio.dev"
        if request.method == "GET" and request.url.path == "/api/v3/connected_accounts/ca_selected":
            return httpx.Response(200, json=account)
        if request.method == "GET" and request.url.path == "/api/v3.1/tools/INSTAGRAM_GET_USER_INFO":
            return httpx.Response(200, json={"slug": "INSTAGRAM_GET_USER_INFO", "version": "20261112_00",
                "toolkit": {"slug": "instagram"}, "input_parameters": {
                    "ig_user_id": {"type": "string"}, "fields": {"type": "string"}}})
        if request.method == "POST" and request.url.path == "/api/v3.1/tools/execute/INSTAGRAM_GET_USER_INFO":
            body = json.loads(request.content)
            assert body["connected_account_id"] == "ca_selected"
            assert body["user_id"] == "authoritative-owner"
            return httpx.Response(200, json={"successful": True, "error": None, "data": {
                "id": "900", "user_id": "321", "username": "my_creator", "account_type": "BUSINESS"}})
        pytest.fail(f"Unexpected provider request during exact-account import: {request.method} {request.url.path}")

    adapter = ComposioClient("offline-test-key", transport=httpx.MockTransport(provider))
    runtime.client = lambda: adapter
    return store, calls


def test_import_account_discovers_authoritative_owner_without_a_manual_user_id(client):
    session, _ = client
    store, calls = _automatic_import_fixture(session)
    response = session.post("/api/automation/accounts/import", json={
        "profile_id": "profile", "connected_account_id": "ca_selected"})
    assert response.status_code == 201, response.text
    record = response.json()
    assert (record["id"], record["profile_id"], record["user_id"], record["auth_config_id"], record["instagram_user_id"]) == (
        "ca_selected", "profile", "authoritative-owner", "ac_exact", "321")
    assert record["user_id"] != "growth-factory-profile"  # Never guess from our profile ID.
    assert calls[0].url.path == "/api/v3/connected_accounts/ca_selected"
    assert all("/connected_accounts/" not in str(request.url) or request.url.path.endswith("ca_selected") for request in calls)
    assert len([request for request in calls if request.method == "POST"]) == 1
    assert "provider-state-must-not-leak" not in response.text
    assert store.get("connected_accounts", "ca_selected") == record


@pytest.mark.parametrize("change", [
    {"auth_config": {"id": "ac_foreign"}},
    {"user_id": None},
    {"user_id": ""},
    {"user_id": "unsafe\nowner"},
])
def test_auto_import_foreign_config_or_missing_unsafe_owner_never_binds(client, change):
    session, _ = client
    store, calls = _automatic_import_fixture(session, account_changes=change)
    response = session.post("/api/automation/accounts/import", json={
        "profile_id": "profile", "connected_account_id": "ca_selected"})
    assert response.status_code == 400, response.text
    assert store.all("connected_accounts") == []
    assert len(calls) == 1 and calls[0].url.path == "/api/v3/connected_accounts/ca_selected"
    assert "provider-state-must-not-leak" not in response.text
    assert "offline-test-key" not in response.text


def test_auto_import_does_not_replace_an_existing_different_workspace_binding(client):
    session, _ = client
    store, calls = _automatic_import_fixture(session)
    original = {"id": "ca_selected", "profile_id": "another-profile", "user_id": "authoritative-owner", "status": "active"}
    store.put("connected_accounts", original)
    response = session.post("/api/automation/accounts/import", json={
        "profile_id": "profile", "connected_account_id": "ca_selected"})
    assert response.status_code == 409
    assert store.get("connected_accounts", "ca_selected") == original
    assert len(calls) == 1  # Owner may be verified; no profile/tool call or overwrite follows.
