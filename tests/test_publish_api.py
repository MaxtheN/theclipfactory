"""Approve & post HTTP contract against a fake posting server; nothing is published."""

import hashlib

import pytest
from fastapi.testclient import TestClient

from clip_factory.app import create_app
from clip_factory.posting_server import PostingServerError
from tests.test_publisher import CREATOR, FakeLearning, FakeServer, holding_gate, passing_gate, zernio_id

ACCT = zernio_id("acct-1")


class AccountServer(FakeServer):
    """Adds the posting server's account routes to the publisher fake."""

    def __init__(self, store):
        super().__init__(store)
        self.remote = [{"id": ACCT, "platform": "instagram", "displayName": "Brand IG", "username": "brand",
                        "connected": True}]
        self.connects, self.disconnected = [], []

    def accounts(self):
        self.calls.append("accounts")
        return [dict(a) for a in self.remote]

    def connect(self, platform, redirect_url):
        self.calls.append("connect")
        self.connects.append((platform, redirect_url))
        return f"https://zernio.example/oauth/{platform}"

    def disconnect(self, account_id):
        self.calls.append("disconnect")
        if account_id not in {a["id"] for a in self.remote}:
            raise PostingServerError(404, "not_found", "Account not found.")
        self.disconnected.append(account_id)
        self.remote = [a for a in self.remote if a["id"] != account_id]


@pytest.fixture
def api(tmp_path):
    app = create_app(tmp_path, token="local-test")
    app.state.autonomy_runtime.resource_check = lambda *_: None
    store = app.state.store
    (tmp_path / "clips").mkdir(exist_ok=True)
    path = tmp_path / "clips" / "c.mp4"
    path.write_bytes(b"approved")
    sha = hashlib.sha256(b"approved").hexdigest()
    store.put("profiles", {"id": "prof-1", "name": "Brand"})
    store.put("profiles", {"id": "prof-2", "name": "Other"})
    store.put("clips", {"id": "clip-1", "path": "clips/c.mp4", "sha256": sha, "approved": True,
                        "campaign_id": "camp-1", "profile_id": "prof-1", "hook": "Hook", "caption": "Caption"})
    store.put("connected_accounts", {"id": ACCT, "profile_id": "prof-1", "provider": "zernio",
                                     "platform": "instagram", "zernio_account_id": ACCT, "status": "active",
                                     "publishing_permitted": True, "display_name": "Brand IG",
                                     "verified_at": "2026-11-14T00:00:00+00:00"})
    server = AccountServer(store)
    publisher = app.state.publisher
    publisher.server_factory = lambda: server
    app.state.posting_accounts.server_factory = lambda: server
    app.state.posting_accounts.open_url = lambda url: True
    publisher.gate = passing_gate
    publisher.learning = FakeLearning(store)
    publisher.start_worker = False
    with TestClient(app, base_url="http://127.0.0.1", headers={"X-Clip-Token": "local-test"}) as session:
        assert session.patch("/api/settings", json={"publishing_enabled": True}).status_code == 200
        yield session, app, server, sha


def send(session, sha, **extra):
    return session.post("/api/clips/clip-1/post", json={"account_id": ACCT, "caption": "Hi", "sha256": sha, **extra})


def test_routes_require_local_token(api):
    session, *_ = api
    for method, url in (("get", "/api/clips/clip-1/quality"), ("post", "/api/clips/clip-1/post"),
                        ("get", "/api/publish-attempts"), ("post", "/api/campaigns/camp-1/post-batch"),
                        ("get", "/api/posting/accounts"), ("post", "/api/posting/connect"),
                        ("put", f"/api/posting/accounts/{ACCT}/permission"),
                        ("delete", f"/api/posting/accounts/{ACCT}")):
        assert getattr(session, method)(url, headers={"X-Clip-Token": "wrong"}).status_code == 401


def test_publishing_setting_and_cloud_gate_posting(api):
    session, app, server, sha = api
    targets = session.get("/api/clips/clip-1/post-targets").json()
    assert targets["publishing_enabled"] is True and targets["default_caption"] == "Caption"
    assert targets["accounts"] == [{"id": ACCT, "display_name": "Brand IG",
                                    "verified_at": "2026-11-14T00:00:00+00:00", "platform": "instagram",
                                    "platform_label": "Instagram", "publishing_permitted": True}]
    session.patch("/api/settings", json={"publishing_enabled": False})
    assert session.get("/api/clips/clip-1/post-targets").json()["publishing_enabled"] is False
    response = send(session, sha)
    assert response.status_code == 403 and "publishing" in response.json()["detail"].lower()
    session.patch("/api/settings", json={"publishing_enabled": True})
    app.state.publisher.server_factory = lambda: None
    response = send(session, sha)
    assert response.status_code == 409 and "cloud" in response.json()["detail"].lower()
    app.state.publisher.server_factory = lambda: server
    server.signed_in = False
    response = send(session, sha)
    assert response.status_code == 409 and "Sign in" in response.json()["detail"]
    assert server.created == []


def test_post_then_reconcile_and_quality_hold_detail(api):
    session, app, server, sha = api
    publisher = app.state.publisher
    publisher.gate = holding_gate
    held = send(session, sha)
    assert held.status_code == 409 and held.json()["detail"].startswith("Quality gate is on hold")
    assert session.get("/api/clips/clip-1/quality?refresh=true").json()["verdict"] == "hold"
    publisher.gate = passing_gate
    assert session.get("/api/clips/clip-1/quality?refresh=true").json()["verdict"] == "pass"
    assert send(session, "b" * 64).status_code == 409
    response = send(session, sha)
    assert response.status_code == 202
    attempt = response.json()
    publisher.run(attempt["id"])
    done = session.get(f"/api/publish-attempts/{attempt['id']}").json()
    assert done["state"] == "mapped" and done["permalink"].startswith("https://example.social/p/")
    assert done["platform"] == "instagram" and done["zernio_post_id"]
    assert session.post(f"/api/publish-attempts/{attempt['id']}/reconcile").json()["state"] == "mapped"
    assert session.post(f"/api/publish-attempts/{attempt['id']}/resume").status_code == 409
    assert session.get("/api/publish-attempts", params={"clip_id": "clip-1"}).json()[0]["id"] == attempt["id"]
    assert len(server.created) == 1


def test_permission_off_refuses_posting(api):
    session, _app, server, sha = api
    off = session.put(f"/api/posting/accounts/{ACCT}/permission", json={"publishing_permitted": False})
    assert off.status_code == 200 and off.json()["publishing_permitted"] is False
    response = send(session, sha)
    assert response.status_code == 403 and server.created == []


def test_archived_campaign_and_batch_validation(api):
    session, app, _server, sha = api
    app.state.store.put("campaigns", {"id": "camp-1", "archived_at": "2026-11-14T00:00:00+00:00",
                                      "name": "C", "video_ids": []})
    response = send(session, sha)
    assert response.status_code == 409 and "archived" in response.json()["detail"]
    batch = session.post("/api/campaigns/camp-1/post-batch", json={"account_ids": [ACCT], "clip_ids": ["clip-1"]})
    assert batch.status_code == 422 and batch.json()["detail"]["problems"][0]["code"] == "campaign_archived"
    too_many = session.post("/api/campaigns/camp-1/post-batch",
                            json={"account_ids": ["a", "b", "c", "d"], "clip_ids": ["clip-1"]})
    assert too_many.status_code == 422


def test_post_package_cover_frames_and_schedule_endpoints(api, tmp_path):
    from datetime import UTC, datetime, timedelta

    from clip_factory.post_package import Covers

    session, app, server, sha = api
    publisher = app.state.publisher
    app.state.store.patch("clips", "clip-1", duration=12.0, craft={"cover": {"mode": "best_frame", "time": 3.0}})

    def extract(_clip, time_ms, output):
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"\xff\xd8" + str(time_ms).encode())

    publisher.covers = Covers(tmp_path, extract=extract)
    view = session.get("/api/clips/clip-1/post-package").json()
    assert view["limits"] == {"caption_chars": 2200, "hashtags": 30, "mentions": 20, "collaborators": 3,
                              "collaborators_supported": True, "cover_bytes": 8 * 1024 * 1024}
    assert len(view["candidates"]) == 6 and any(c["auto"] and c["time_ms"] == 3000 for c in view["candidates"])
    frame = session.get(view["candidates"][0]["url"])
    assert frame.status_code == 200 and frame.headers["content-type"] == "image/jpeg"
    assert session.get("/api/clips/clip-1/cover-frames/99000").status_code == 422
    collab = send(session, sha, collaborators=list("abcd"))
    assert collab.status_code == 422 and "collaborator" in collab.json()["detail"].lower()

    when = (datetime.now(UTC) + timedelta(hours=3)).isoformat()
    made = session.post("/api/clips/clip-1/schedule-post", json={
        "account_ids": [ACCT], "captions": {ACCT: "Later #reel"}, "sha256": sha, "publish_at": when,
        "timezone": "Europe/London", "cover_time_ms": 6000, "share_to_feed": False})
    assert made.status_code == 201, made.text
    row = made.json()
    assert row["attempts"][0]["state"] == "scheduled"
    assert row["attempts"][0]["package"]["cover"]["source"] == "chosen_frame"
    assert row["attempts"][0]["package"]["share_to_feed"] is False
    targets = session.get("/api/clips/clip-1/post-targets").json()
    assert targets["schedules"][0]["id"] == row["id"]
    # The legacy direct-Meta schedule runner ignores this lane; archive guard still sees it.
    assert app.state.store.get("schedules", row["id"])["lane"] == "instagram_post"
    bad = session.post(f"/api/post-schedules/{row['id']}/decision", json={"action": "explode"})
    assert bad.status_code == 422
    cancelled = session.post(f"/api/post-schedules/{row['id']}/decision", json={"action": "cancel"}).json()
    assert cancelled["status"] == "cancelled" and cancelled["attempts"][0]["state"] == "cancelled"
    assert session.get("/api/post-schedules", params={"clip_id": "clip-1"}).json()[0]["status"] == "cancelled"
    assert server.created == [] and server.uploads == []


def test_legacy_direct_meta_runner_ignores_post_lane_schedules(api):
    import time

    _session, app, _server, _sha = api
    app.state.store.put("schedules", {"id": "s-lane", "lane": "instagram_post", "clip_id": "clip-1",
                                      "status": "scheduled", "publish_at": "2026-01-01T00:00:00+00:00",
                                      "attempt_ids": [], "overdue_at": None})
    time.sleep(2.6)  # the legacy runner wakes every 2 s inside the app lifespan
    row = app.state.store.get("schedules", "s-lane")
    assert row["status"] == "scheduled" and "error" not in row and "job_id" not in row


# ---------------------------------------------------------------- connected posting accounts

def test_connect_binds_the_one_new_account_and_callback_needs_no_token(api):
    session, app, server, _sha = api
    started = session.post("/api/posting/connect", json={"platform": "tiktok", "profile_id": "prof-1"})
    assert started.status_code == 201, started.text
    body = started.json()
    assert body["status"] == "pending" and body["opened"] is True
    assert body["auth_url"] == "https://zernio.example/oauth/tiktok"
    platform, redirect = server.connects[0]
    assert platform == "tiktok" and redirect.endswith(f"/api/posting/connected/{body['request_id']}")
    status = session.get(f"/api/posting/connect/{body['request_id']}").json()
    assert status["status"] == "pending" and status["account"] is None
    new = zernio_id("tiktok-1")
    server.remote.append({"id": new, "platform": "tiktok", "displayName": "Brand TT", "connected": True})
    # The system browser returns here without the local session token.
    callback = session.get(f"/api/posting/connected/{body['request_id']}", headers={"X-Clip-Token": ""})
    assert callback.status_code == 200 and "Account connected." in callback.text
    account = app.state.store.get("connected_accounts", new)
    assert account["profile_id"] == "prof-1" and account["status"] == "active"
    assert account["publishing_permitted"] is False  # binding never grants permission
    assert session.get(f"/api/posting/connected/{body['request_id']}", headers={"X-Clip-Token": ""}).status_code == 404
    assert session.get("/api/posting/connected/unknown-request", headers={"X-Clip-Token": ""}).status_code == 404
    done = session.get(f"/api/posting/connect/{body['request_id']}").json()
    assert done["status"] == "connected" and done["account"]["id"] == new
    assert session.post("/api/posting/connect", json={"platform": "myspace", "profile_id": "prof-1"}).status_code == 422


def test_two_new_accounts_are_ambiguous_and_need_an_explicit_binding(api):
    session, app, server, _sha = api
    body = session.post("/api/posting/connect", json={"platform": "youtube", "profile_id": "prof-1"}).json()
    first, second = zernio_id("yt-1"), zernio_id("yt-2")
    server.remote += [{"id": first, "platform": "youtube", "connected": True},
                      {"id": second, "platform": "youtube", "connected": True}]
    assert session.get(f"/api/posting/connect/{body['request_id']}").json()["status"] == "ambiguous"
    listed = {a["id"]: a for a in session.get("/api/posting/accounts").json()}
    assert listed[first]["status"] == "unbound" and listed[first]["platform_label"] == "YouTube"
    refused = session.put(f"/api/posting/accounts/{first}/permission", json={"publishing_permitted": True})
    assert refused.status_code == 409
    bound = session.put(f"/api/posting/accounts/{first}/binding", json={"profile_id": "prof-1"})
    assert bound.status_code == 200 and bound.json()["status"] == "active"
    again = session.put(f"/api/posting/accounts/{first}/binding", json={"profile_id": "prof-2"})
    assert again.status_code == 409
    allowed = session.put(f"/api/posting/accounts/{first}/permission", json={"publishing_permitted": True})
    assert allowed.status_code == 200 and allowed.json()["publishing_permitted"] is True
    assert session.put("/api/posting/accounts/not-an-id/binding", json={"profile_id": "prof-1"}).status_code == 422


def test_disconnect_revokes_upstream_and_reconnect_needs_binding_again(api):
    session, app, server, sha = api
    removed = session.delete(f"/api/posting/accounts/{ACCT}")
    assert removed.status_code == 200
    assert removed.json() == {"id": ACCT, "status": "disconnected", "provider_access_revoked": True}
    assert server.disconnected == [ACCT]
    account = app.state.store.get("connected_accounts", ACCT)
    assert account["status"] == "disconnected" and account["publishing_permitted"] is False
    assert send(session, sha).status_code == 422  # no longer an active account
    # Connected again upstream: it comes back unbound, without permission.
    server.remote.append({"id": ACCT, "platform": "instagram", "displayName": "Brand IG", "connected": True})
    synced = {a["id"]: a for a in session.post("/api/posting/accounts/sync").json()}
    assert synced[ACCT]["status"] == "unbound" and synced[ACCT]["profile_id"] is None
    assert synced[ACCT]["publishing_permitted"] is False
    # Removed upstream: the local record is marked disconnected.
    server.remote = []
    assert session.get("/api/posting/accounts?refresh=true").json()[0]["status"] == "disconnected"


def test_tiktok_creator_info_is_read_through_the_server(api):
    session, app, server, _sha = api
    tiktok = zernio_id("tiktok-2")
    app.state.store.put("connected_accounts", {"id": tiktok, "profile_id": "prof-1", "provider": "zernio",
                                               "platform": "tiktok", "zernio_account_id": tiktok,
                                               "status": "active", "publishing_permitted": True})
    info = session.get(f"/api/posting/accounts/{tiktok}/tiktok-creator-info")
    assert info.status_code == 200 and info.json() == CREATOR
    assert session.get(f"/api/posting/accounts/{ACCT}/tiktok-creator-info").status_code == 400
    app.state.posting_accounts.server_factory = lambda: None
    assert session.get(f"/api/posting/accounts/{tiktok}/tiktok-creator-info").status_code == 409


def test_connect_without_cloud_is_a_clear_conflict(api):
    session, app, _server, _sha = api
    app.state.posting_accounts.server_factory = lambda: None
    response = session.post("/api/posting/connect", json={"platform": "instagram", "profile_id": "prof-1"})
    assert response.status_code == 409 and "cloud" in response.json()["detail"].lower()
