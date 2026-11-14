"""Approve & post HTTP contract with mocked provider/storage; nothing is published."""

import hashlib

import pytest
from fastapi.testclient import TestClient

from clip_factory.app import create_app
from tests.test_publisher import FakeClient, FakeLearning, FakeStorage, holding_gate, passing_gate


@pytest.fixture
def api(tmp_path):
    app = create_app(tmp_path, token="local-test")
    app.state.autonomy_runtime.resource_check = lambda *_: None
    store = app.state.store
    (tmp_path / "clips").mkdir(exist_ok=True)
    path = tmp_path / "clips" / "c.mp4"
    path.write_bytes(b"approved")
    sha = hashlib.sha256(b"approved").hexdigest()
    store.put("clips", {"id": "clip-1", "path": "clips/c.mp4", "sha256": sha, "approved": True,
                        "campaign_id": "camp-1", "profile_id": "prof-1", "hook": "Hook", "caption": "Caption"})
    store.put("connected_accounts", {"id": "acct-1", "profile_id": "prof-1", "user_id": "gf-user",
                                     "provider": "composio", "toolkit": "instagram", "status": "active",
                                     "instagram_user_id": "1784", "verified_at": "2026-11-14T00:00:00+00:00"})
    publisher = app.state.publisher
    fakes = {"client": FakeClient(store), "storage": FakeStorage(store)}
    publisher.client_factory = lambda: fakes["client"]
    publisher.gate = passing_gate
    publisher.learning = FakeLearning(store)
    publisher.start_worker = False
    with TestClient(app, base_url="http://127.0.0.1", headers={"X-Clip-Token": "local-test"}) as session:
        yield session, app, fakes, sha


def test_routes_require_local_token(api):
    session, *_ = api
    for method, url in (("get", "/api/clips/clip-1/quality"), ("post", "/api/clips/clip-1/post"),
                        ("get", "/api/publish-attempts"), ("post", "/api/campaigns/camp-1/post-batch")):
        assert getattr(session, method)(url, headers={"X-Clip-Token": "wrong"}).status_code == 401


def test_sign_in_required_when_cloud_unavailable(api):
    session, app, fakes, sha = api
    app.state.publisher.storage_factory = lambda: None
    targets = session.get("/api/clips/clip-1/post-targets").json()
    assert targets["signed_in"] is False and targets["accounts"][0]["id"] == "acct-1"
    assert targets["default_caption"] == "Caption"
    response = session.post("/api/clips/clip-1/post", json={"account_id": "acct-1", "caption": "Hi", "sha256": sha})
    assert response.status_code == 409 and "cloud" in response.json()["detail"].lower()
    fakes["storage"].signed_in = False
    app.state.publisher.storage_factory = lambda: fakes["storage"]
    response = session.post("/api/clips/clip-1/post", json={"account_id": "acct-1", "caption": "Hi", "sha256": sha})
    assert response.status_code == 409 and "Sign in" in response.json()["detail"]


def test_post_then_reconcile_and_quality_hold_detail(api):
    session, app, fakes, sha = api
    publisher = app.state.publisher
    publisher.storage_factory = lambda: fakes["storage"]
    publisher.gate = holding_gate
    held = session.post("/api/clips/clip-1/post", json={"account_id": "acct-1", "caption": "Hi", "sha256": sha})
    assert held.status_code == 409 and held.json()["detail"].startswith("Quality gate is on hold")
    assert session.get("/api/clips/clip-1/quality?refresh=true").json()["verdict"] == "hold"
    publisher.gate = passing_gate
    assert session.get("/api/clips/clip-1/quality?refresh=true").json()["verdict"] == "pass"
    stale = session.post("/api/clips/clip-1/post", json={"account_id": "acct-1", "caption": "Hi", "sha256": "b" * 64})
    assert stale.status_code == 409
    response = session.post("/api/clips/clip-1/post", json={"account_id": "acct-1", "caption": "Hi", "sha256": sha})
    assert response.status_code == 202
    attempt = response.json()
    publisher.run(attempt["id"])
    done = session.get(f"/api/publish-attempts/{attempt['id']}").json()
    assert done["state"] == "mapped" and done["permalink"].startswith("https://www.instagram.com/reel/")
    assert session.post(f"/api/publish-attempts/{attempt['id']}/reconcile").json()["state"] == "mapped"
    assert session.post(f"/api/publish-attempts/{attempt['id']}/resume").status_code == 409
    assert session.get("/api/publish-attempts", params={"clip_id": "clip-1"}).json()[0]["id"] == attempt["id"]


def test_archived_campaign_and_batch_validation(api):
    session, app, fakes, sha = api
    app.state.publisher.storage_factory = lambda: fakes["storage"]
    app.state.store.put("campaigns", {"id": "camp-1", "archived_at": "2026-11-14T00:00:00+00:00",
                                      "name": "C", "video_ids": []})
    response = session.post("/api/clips/clip-1/post", json={"account_id": "acct-1", "caption": "Hi", "sha256": sha})
    assert response.status_code == 409 and "archived" in response.json()["detail"]
    batch = session.post("/api/campaigns/camp-1/post-batch", json={"account_ids": ["acct-1"], "clip_ids": ["clip-1"]})
    assert batch.status_code == 422 and batch.json()["detail"]["problems"][0]["code"] == "campaign_archived"
    too_many = session.post("/api/campaigns/camp-1/post-batch",
                            json={"account_ids": ["a", "b", "c", "d"], "clip_ids": ["clip-1"]})
    assert too_many.status_code == 422


def test_readiness_runs_only_the_read_only_quota_tool(api):
    session, _app, fakes, _ = api
    result = session.get("/api/publish/accounts/acct-1/readiness").json()
    assert result["status"] == "ready" and result["quota_total"] == 50
    assert fakes["client"].slugs() == ["INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT"]


def test_post_package_cover_frames_and_schedule_endpoints(api, tmp_path):
    from datetime import UTC, datetime, timedelta

    from clip_factory.post_package import Covers

    session, app, fakes, sha = api
    publisher = app.state.publisher
    publisher.storage_factory = lambda: fakes["storage"]
    app.state.store.patch("clips", "clip-1", duration=12.0, craft={"cover": {"mode": "best_frame", "time": 3.0}})

    def extract(_clip, time_ms, output):
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"\xff\xd8" + str(time_ms).encode())

    publisher.covers = Covers(tmp_path, extract=extract)
    view = session.get("/api/clips/clip-1/post-package").json()
    assert view["limits"] == {"caption_chars": 2200, "hashtags": 30, "mentions": 20, "collaborators": 3,
                              "collaborators_supported": False, "cover_bytes": 8 * 1024 * 1024}
    assert len(view["candidates"]) == 6 and any(c["auto"] and c["time_ms"] == 3000 for c in view["candidates"])
    frame = session.get(view["candidates"][0]["url"])
    assert frame.status_code == 200 and frame.headers["content-type"] == "image/jpeg"
    assert session.get("/api/clips/clip-1/cover-frames/99000").status_code == 422
    collab = session.post("/api/clips/clip-1/post", json={"account_id": "acct-1", "caption": "Hi", "sha256": sha,
                                                         "collaborators": ["friend"]})
    assert collab.status_code == 422 and "collaborator" in collab.json()["detail"].lower()

    when = (datetime.now(UTC) + timedelta(hours=3)).isoformat()
    made = session.post("/api/clips/clip-1/schedule-post", json={
        "account_ids": ["acct-1"], "captions": {"acct-1": "Later #reel"}, "sha256": sha, "publish_at": when,
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
    assert fakes["client"].calls == []


def test_legacy_direct_meta_runner_ignores_post_lane_schedules(api):
    import time

    session, app, fakes, sha = api
    app.state.store.put("schedules", {"id": "s-lane", "lane": "instagram_post", "clip_id": "clip-1",
                                      "status": "scheduled", "publish_at": "2026-01-01T00:00:00+00:00",
                                      "attempt_ids": [], "overdue_at": None})
    time.sleep(2.6)  # the legacy runner wakes every 2 s inside the app lifespan
    row = app.state.store.get("schedules", "s-lane")
    assert row["status"] == "scheduled" and "error" not in row and "job_id" not in row
