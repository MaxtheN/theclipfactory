"""Authenticated real TestClient coverage with isolated storage and offline Meta."""

import json
import shutil
import subprocess
import threading
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from clip_factory import media
from clip_factory.app import create_app, parse_candidates
from clip_factory.jobs import WorkError
from clip_factory.meta import MetaClient, SecureTokenStore
from clip_factory.store import Store

SESSION = "test-session"
USER_TOKEN = "test-user-token-secret"
PAGE_TOKEN = "test-page-token-secret"
PUBLIC_URL = "https://cdn.creator.com/actual.mp4"


@pytest.fixture
def client(tmp_path, monkeypatch):
    for name in ("CLIP_META_APP_ID", "CLIP_META_APP_SECRET", "CLIP_META_REDIRECT_URI"):
        monkeypatch.delenv(name, raising=False)
    app = create_app(tmp_path, token=SESSION)

    # No ordinary test may accidentally contact Graph or Hugging Face.
    def no_network(*args, **kwargs):
        pytest.fail("External network is forbidden")

    app.state.meta_factory = no_network
    monkeypatch.setattr("clip_factory.models.Models.download", no_network)
    with TestClient(app, base_url="http://127.0.0.1", headers={"X-Clip-Token": SESSION}) as active:
        yield active
    assert not app.state.jobs.thread.is_alive()


def wait_job(client, identifier, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get("/api/jobs")
        assert response.status_code == 200
        job = next((row for row in response.json() if row["id"] == identifier), None)
        if job and job["status"] in {"completed", "failed", "cancelled"}:
            return job
        time.sleep(0.02)
    pytest.fail(f"Job did not terminate: {job}")


def seed_clip(client, *, approved=False, **extra):
    root = client.app.state.root
    (root / "clips" / "testclip.mp4").write_bytes(b"local-media")
    clip = {
        "id": "testclip",
        "video_id": "source",
        "name": "Actual clip",
        "objective": "sales",
        "start": 0,
        "end": 1,
        "hook": "Actual hook",
        "caption": "Actual caption",
        "approved": approved,
        "status": "ready",
        "instagram_media_id": None,
        "published_at": None,
        "path": "clips/testclip.mp4",
        **extra,
    }
    client.app.state.store.put("clips", clip)
    return clip


def upload_mock(client, monkeypatch, **info):
    monkeypatch.setattr(
        media, "probe", lambda _: {"duration": 5, "width": 320, "height": 180, "has_audio": False, **info}
    )
    response = client.post("/api/videos", files={"file": ("../../source.mp4", b"video", "video/mp4")})
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture
def graph(client, monkeypatch):
    saved, calls, published = {}, [], []
    controls = {"account": "30", "deny": False, "write_error": False}

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
    client.app.state.token_store = SecureTokenStore()

    def handler(request):
        calls.append(request)
        assert request.url.host == "graph.facebook.com"
        assert "access_token" not in request.url.params
        path = request.url.path
        if path.endswith("/accounts"):
            assert request.headers["Authorization"] == f"Bearer {USER_TOKEN}"
            if controls["deny"]:
                return httpx.Response(400, json={"error": {"code": 190, "message": USER_TOKEN}})
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "20",
                            "access_token": PAGE_TOKEN,
                            "instagram_business_account": {"id": controls["account"], "username": "creator"},
                        }
                    ]
                },
            )
        assert request.headers["Authorization"] == f"Bearer {PAGE_TOKEN}"
        if request.method == "POST":
            # External writes must always have a durable local attempt already recorded.
            assert client.app.state.store.get("clips", "testclip").get("publish_attempt")
            if controls["write_error"]:
                return httpx.Response(503, json={"error": {"code": 2, "message": PAGE_TOKEN}})
            if path.endswith("/media_publish"):
                published.append(request)
                return httpx.Response(200, json={"id": "50"})
            return httpx.Response(200, json={"id": "40"})
        if path.endswith("/40"):
            return httpx.Response(200, json={"status_code": "FINISHED"})
        if path.endswith("/media"):
            return httpx.Response(200, json={"data": [{"id": "50", "media_type": "VIDEO"}]})
        if path.endswith("/insights"):
            metric = request.url.params["metric"]
            data = [{"name": metric, "values": [{"value": 0}]}] if metric == "saved" else []
            return httpx.Response(200, json={"data": data})
        pytest.fail(f"Unexpected Graph request: {request.method} {path}")

    client.app.state.meta_factory = lambda token, version: MetaClient(
        token, version, transport=httpx.MockTransport(handler)
    )
    return controls, calls, saved, published


def connect(client):
    response = client.post("/api/instagram/connect", json={"access_token": USER_TOKEN})
    assert response.status_code == 200, response.text
    assert response.json()["connected"] is True
    assert response.json()["ads_available"] is False
    assert USER_TOKEN not in response.text and PAGE_TOKEN not in response.text
    return response.json()


def enable_publish(client):
    response = client.put("/api/settings", json={"publishing_enabled": True})
    assert response.status_code == 200


def block_worker(client):
    entered, release = threading.Event(), threading.Event()

    def operation(_):
        entered.set()
        assert release.wait(5), "Test must release queued-job barrier"
        return {"barrier": "released"}

    client.app.state.jobs.submit("test-barrier", operation)
    assert entered.wait(2)
    return release


def test_auth_required_and_bootstrap_cookie(client):
    client.headers.pop("X-Clip-Token")
    assert client.get("/api/settings").status_code == 401
    assert client.get("/?boot=wrong", follow_redirects=False).status_code == 401
    response = client.get(f"/?boot={SESSION}", follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"] == "/"
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert client.get("/api/settings").status_code == 200
    assert client.get("/api/settings", headers={"X-Clip-Token": "wrong"}).status_code == 401


@pytest.mark.parametrize(
    "headers",
    [
        {"Host": "evil.example"},
        {"Origin": "https://evil.example"},
        {"Origin": "http://localhost"},
        {"Origin": "null"},
    ],
)
def test_host_and_origin_rejection_even_with_valid_token(client, headers):
    assert client.put("/api/settings", json={"brand": "bad"}, headers=headers).status_code == 403
    assert client.get("/api/settings").json()["brand"] == ""


def test_same_origin_and_security_headers(client):
    response = client.get("/api/settings", headers={"Origin": "http://127.0.0.1"})
    assert response.status_code == 200
    for name, expected in {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
    }.items():
        assert response.headers[name] == expected


def test_cross_site_fetch_without_origin_rejected(client):
    # A cross-site navigation has no Origin header; Fetch Metadata still identifies it.
    response = client.get("/api/settings", headers={"Sec-Fetch-Site": "cross-site"})
    assert response.status_code == 403


def test_unicode_bootstrap_is_invalid_not_server_error(client, monkeypatch):
    monkeypatch.setattr(client._transport, "raise_server_exceptions", False)
    response = client.get("/?boot=%C3%A9", follow_redirects=False)
    assert response.status_code == 401


@pytest.mark.parametrize(
    "body",
    [
        {"objective": "viral"},
        {"daily_budget": -1},
        {"total_budget": 10000001},
        {"daily_budget": "NaN"},
        {"total_budget": "Infinity"},
        {"daily_budget": 1000001},
        {"ads_enabled": True, "unexpected": "field"},
        {"objective": "custom", "custom_event": "  "},
    ],
)
def test_invalid_settings_do_not_persist(client, body):
    assert client.put("/api/settings", json=body).status_code == 422
    assert client.get("/api/settings").json()["objective"] == "discovery"


@pytest.mark.parametrize(
    "objective", ["discovery", "awareness", "engagement", "followers", "traffic", "leads", "sales", "custom"]
)
def test_objectives_and_budgets_persist_without_authorizing_ads(client, objective):
    response = client.put(
        "/api/settings",
        json={
            "objective": objective,
            "custom_event": "qualified demo",
            "daily_budget": 12.5,
            "total_budget": 90,
            "ads_enabled": True,
        },
    )
    assert response.status_code == 200
    assert client.get("/api/settings").json() == response.json()
    assert Store(client.app.state.root).get("config", "settings")["value"] == response.json()
    status = client.get("/api/instagram/status").json()
    assert status["ads_available"] is False
    assert not status["connected"]


@pytest.mark.parametrize(
    "body",
    [
        {"access_token": USER_TOKEN, "account_id": "../../30"},
        {"access_token": USER_TOKEN, "extra_secret": PAGE_TOKEN},
        {"access_token": ""},
        {"access_token": USER_TOKEN * 500},
    ],
)
def test_token_validation_never_echoes_credentials(client, body):
    response = client.post("/api/instagram/connect", json=body)
    assert response.status_code == 422
    assert USER_TOKEN not in response.text and PAGE_TOKEN not in response.text
    assert client.app.state.store.get("config", "instagram") is None


def test_upload_mock_probe_public_redaction_and_media(client, monkeypatch):
    video = upload_mock(client, monkeypatch)
    assert video["name"] == "source.mp4"
    assert "path" not in video
    assert video["has_audio"] is False  # Public capability metadata enables accurate Whisper preflight.
    assert client.get("/api/videos").json() == [video]
    assert client.get(f"/api/videos/{video['id']}/media").content == b"video"
    stored = client.app.state.store.get("videos", video["id"])
    assert stored["path"].startswith("videos/")
    assert client.delete(f"/api/videos/{video['id']}").status_code == 200
    assert not (client.app.state.root / stored["path"]).exists()


def test_invalid_upload_cleans_file_and_library(client, monkeypatch):
    def invalid(_):
        raise WorkError("This file is not a readable video.")

    monkeypatch.setattr(media, "probe", invalid)
    assert client.post("/api/videos", files={"file": ("bad.mp4", b"bad")}).status_code == 400
    assert client.post("/api/videos", files={"file": ("bad.txt", b"bad")}).status_code == 422
    assert client.get("/api/videos").json() == []
    assert not list((client.app.state.root / "videos").iterdir())


def test_actual_upload_and_manual_render_without_models(client, tmp_path):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("FFmpeg/ffprobe not installed")
    sample = tmp_path / "sample.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=160x90:r=10:d=0.6",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(sample),
        ],
        capture_output=True,
        check=True,
        timeout=20,
    )
    with sample.open("rb") as file:
        uploaded = client.post("/api/videos", files={"file": ("sample.mp4", file, "video/mp4")})
    assert uploaded.status_code == 201, uploaded.text
    video = uploaded.json()
    assert video["duration"] == pytest.approx(0.6, abs=0.1)
    response = client.post(
        f"/api/videos/{video['id']}/render", json={"start": 0.1, "end": 0.4, "subtitles": True}
    )
    assert response.status_code == 202, response.text
    final = wait_job(client, response.json()["id"])
    assert final["status"] == "completed", final
    assert "without invented captions" in final["result"]["warning"]
    clips = client.get("/api/clips").json()
    assert len(clips) == 1 and clips[0]["approved"] is False
    assert "path" not in clips[0]
    assert clips[0]["video_id"] == video["id"]
    assert (clips[0]["width"], clips[0]["height"]) == (1080, 1920)
    assert client.get(f"/api/clips/{clips[0]['id']}/download").status_code == 200
    assert client.delete(f"/api/videos/{video['id']}").status_code == 409
    assert client.delete(f"/api/clips/{clips[0]['id']}").status_code == 200
    assert client.delete(f"/api/videos/{video['id']}").status_code == 200
    assert client.app.state.store.all("jobs")[0]["kind"] == "render"
    assert all(not row["installed"] for row in client.get("/api/models").json())


@pytest.mark.parametrize(
    "body",
    [{"start": 2, "end": 1}, {"start": 0, "end": 6}, {"start": -1, "end": 1}, {"start": "NaN", "end": 1}],
)
def test_invalid_render_never_enqueues(client, monkeypatch, body):
    video = upload_mock(client, monkeypatch)
    assert client.post(f"/api/videos/{video['id']}/render", json=body).status_code == 422
    assert client.get("/api/jobs").json() == []


def test_license_consent_and_missing_models_never_simulate(client):
    assert client.post("/api/models/qwen-small/download", json={"accept_license": False}).status_code == 422
    assert client.post("/api/models/unknown/download", json={"accept_license": True}).status_code == 400
    assert client.post("/api/inference", json={"prompt": "Create a clip"}).status_code == 400
    assert client.post("/api/narrations", json={"text": "Say this"}).status_code == 400
    assert client.get("/api/jobs").json() == []
    assert client.get("/api/clips").json() == []
    assert all(not row["installed"] for row in client.get("/api/models").json())


def test_auto_mode_missing_model_fails_truthfully(client, monkeypatch):
    client.put("/api/settings", json={"autonomy": "auto"})
    video = upload_mock(client, monkeypatch)
    job = client.get("/api/jobs").json()[0]
    final = wait_job(client, job["id"])
    assert final["status"] == "failed"
    assert "Download and accept" in final["error"]
    assert client.get("/api/clips").json() == []
    assert client.app.state.store.get("videos", video["id"])["analysis"] is None


def test_manual_events_are_separate_unknown_is_not_zero(client):
    clip = seed_clip(client)
    assert (
        client.post("/api/analytics/events", json={"clip_id": clip["id"], "event": "custom"}).status_code
        == 422
    )
    client.put("/api/settings", json={"custom_event": "qualified demo"})
    response = client.post(
        "/api/analytics/events", json={"clip_id": clip["id"], "event": "custom", "value": 0, "revenue": 12.5}
    )
    assert response.status_code == 201
    assert response.json()["event_name"] == "qualified demo"
    assert "not causal proof" in response.json()["attribution"]
    stats = client.get("/api/analytics").json()
    assert stats["events"][0]["source"] == "manual"
    assert all(value is None for value in stats["videos"][0]["organic"].values())
    assert all(value is None for value in stats["videos"][0]["paid"].values())
    assert stats["summary"]["observed_clips"] == 0
    assert (
        client.post(
            "/api/analytics/events",
            json={"clip_id": clip["id"], "event": "purchase", "occurred_at": "not-a-date"},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/analytics/events", json={"clip_id": clip["id"], "event": "purchase", "revenue": "NaN"}
        ).status_code
        == 422
    )
    assert (
        client.post("/api/analytics/events", json={"clip_id": "missing", "event": "lead"}).status_code == 404
    )


def test_native_connection_no_credentials_in_database_or_responses(client, graph):
    _, _, saved, _ = graph
    status = connect(client)
    assert status["account"]["id"] == "30"
    assert saved == {("clip-factory", "instagram:30"): USER_TOKEN}
    # Query JSON and scan SQLite/WAL; only mocked native Keychain may contain the secret.
    assert USER_TOKEN not in json.dumps(client.app.state.store.all("config"))
    for path in client.app.state.root.glob("factory.sqlite3*"):
        assert USER_TOKEN.encode() not in path.read_bytes()
        assert PAGE_TOKEN.encode() not in path.read_bytes()
    assert client.delete("/api/instagram/connect").json()["connected"] is False
    assert saved == {}


def test_meta_errors_redacted_at_api_boundary(client, graph):
    controls, _, _, _ = graph
    controls["deny"] = True
    response = client.post("/api/instagram/connect", json={"access_token": USER_TOKEN})
    assert response.status_code == 400
    assert USER_TOKEN not in response.text and PAGE_TOKEN not in response.text
    assert client.app.state.store.get("config", "instagram") is None


def test_publish_gates_revalidates_and_prevents_duplicate(client, graph):
    _, calls, _, published = graph
    seed_clip(client)
    body = {"public_video_url": PUBLIC_URL}
    assert client.post("/api/clips/testclip/publish", json=body).status_code == 409
    assert calls == []
    connect(client)
    client.put("/api/clips/testclip", json={"approved": True})
    assert client.post("/api/clips/testclip/publish", json=body).status_code == 409
    enable_publish(client)
    assert (
        client.post(
            "/api/clips/testclip/publish", json={"public_video_url": "https://127.0.0.1/x"}
        ).status_code
        == 400
    )
    before = len(calls)
    response = client.post("/api/clips/testclip/publish", json=body)
    assert response.status_code == 202, response.text
    final = wait_job(client, response.json()["id"])
    assert final["status"] == "completed", final
    assert any(r.url.path.endswith("/accounts") for r in calls[before:])
    assert len(published) == 1
    stored = Store(client.app.state.root).get("clips", "testclip")
    assert stored["publish_attempt"] == final["id"]
    assert stored["instagram_media_id"] == "50" and stored["instagram_account_id"] == "30"
    assert client.post("/api/clips/testclip/publish", json=body).status_code == 409
    assert len(published) == 1


@pytest.mark.parametrize("deny,write_error", [(True, False), (False, True)])
def test_failed_publish_keeps_durable_marker_and_no_retry(client, graph, deny, write_error):
    controls, calls, _, published = graph
    seed_clip(client, approved=True)
    connect(client)
    enable_publish(client)
    controls.update(deny=deny, write_error=write_error)
    response = client.post("/api/clips/testclip/publish", json={"public_video_url": PUBLIC_URL})
    assert response.status_code == 202
    final = wait_job(client, response.json()["id"])
    assert final["status"] == "failed"
    assert USER_TOKEN not in str(final) and PAGE_TOKEN not in str(final)
    stored = Store(client.app.state.root).get("clips", "testclip")
    assert stored["publish_attempt"] == final["id"]
    assert stored["status"] == "publish_needs_reconciliation"
    assert stored["instagram_media_id"] is None
    before = len(calls)
    assert (
        client.post("/api/clips/testclip/publish", json={"public_video_url": PUBLIC_URL}).status_code == 409
    )
    assert len(calls) == before and not published


@pytest.mark.parametrize("change", ["disable", "account", "cancel"])
def test_queued_publish_rechecks_authorization_before_external_write(client, graph, change):
    controls, calls, saved, published = graph
    seed_clip(client, approved=True)
    connect(client)
    enable_publish(client)
    release = block_worker(client)
    try:
        response = client.post("/api/clips/testclip/publish", json={"public_video_url": PUBLIC_URL})
        assert response.status_code == 202
        identifier = response.json()["id"]
        assert client.put("/api/clips/testclip", json={"approved": False}).status_code == 409
        assert client.delete("/api/instagram/connect").status_code == 409
        if change == "disable":
            client.put("/api/settings", json={"publishing_enabled": False})
        elif change == "account":
            controls["account"] = "31"
            connect(client)
            assert ("clip-factory", "instagram:30") not in saved
        else:
            assert client.post(f"/api/jobs/{identifier}/cancel").status_code == 200
        before = len(calls)
    finally:
        release.set()
    final = wait_job(client, identifier)
    assert final["status"] == ("cancelled" if change == "cancel" else "failed")
    assert len(calls) == before and not published
    assert not client.app.state.store.get("clips", "testclip").get("publish_attempt")


def test_insights_account_provenance_survives_switch(client, graph):
    controls, _, _, _ = graph
    seed_clip(client, approved=True, instagram_media_id="50", instagram_account_id="30")
    connect(client)
    response = client.post("/api/instagram/sync")
    assert response.status_code == 202
    assert wait_job(client, response.json()["id"])["status"] == "completed"
    row = client.get("/api/analytics").json()["videos"][0]
    assert row["organic"]["saved"] == 0 and row["organic"]["views"] is None
    assert row["source"] == "Meta media insights"
    controls["account"] = "31"
    connect(client)
    # Historical observations still match the clip's publishing account, not today's connection.
    assert client.get("/api/analytics").json()["videos"][0]["organic"]["saved"] == 0
    response = client.post("/api/instagram/sync")
    assert wait_job(client, response.json()["id"])["status"] == "completed"
    row = client.get("/api/analytics").json()["videos"][0]
    assert all(value is None for value in row["organic"].values())
    assert row["source"] == "No platform observations"


def test_queued_sync_account_switch_must_not_misattribute(client, graph):
    controls, calls, _, _ = graph
    connect(client)
    release = block_worker(client)
    try:
        response = client.post("/api/instagram/sync")
        assert response.status_code == 202
        controls["account"] = "31"
        connect(client)
        before = len(calls)
    finally:
        release.set()
    final = wait_job(client, response.json()["id"])
    assert final["status"] == "failed"
    assert len(calls) == before, "Old-account sync must stop before using the new account's credentials"
    assert client.app.state.store.all("insights") == []


def test_candidate_parser_grounds_ranges_and_objective():
    output = (
        "<think>private reasoning</think>```json\n"
        + json.dumps(
            {
                "candidates": [
                    {"start": 0, "end": 2, "hook": "Actual", "caption": "Review", "objective": "engagement"},
                    {"start": 4, "end": 3},
                    {"start": 0, "end": 20},
                ]
            }
        )
        + "\n```"
    )
    candidates = parse_candidates(output, 5, "sales")
    assert len(candidates) == 1 and candidates[0]["objective"] == "sales"
    for bad in ('{"candidates": []}', '{"candidates":[{"start":NaN,"end":1}]}', "not json"):
        with pytest.raises(WorkError, match="no valid clip ranges"):
            parse_candidates(bad, 5, "discovery")


def test_parallel_model_downloads_do_not_block_runtime_and_keep_model_locks(client, monkeypatch):
    release = threading.Event()
    identifiers = ["qwen-small", "qwen-large", "whisper-turbo"]
    entered = {identifier: threading.Event() for identifier in identifiers}

    def transfer(self, job_id, identifier):
        entered[identifier].set()
        assert release.wait(5)
        self.jobs.check(job_id)
        return {"model_id": identifier}

    monkeypatch.setattr("clip_factory.models.Models.download", transfer)
    monkeypatch.setattr("clip_factory.models.Models.setup", lambda *_: {"runtime": "test-only"})
    monkeypatch.setattr("clip_factory.app.shutil.disk_usage", lambda _: type("Disk", (), {"free": 10**12})())
    jobs = []
    try:
        for identifier in identifiers:
            response = client.post(f"/api/models/{identifier}/download", json={"accept_license": True})
            assert response.status_code == 202
            jobs.append(response.json())
        assert all(event.wait(2) for event in entered.values())
        assert all(job["lane"] == "download" for job in jobs)
        assert (
            client.post("/api/models/qwen-small/download", json={"accept_license": True}).status_code == 409
        )
        assert client.delete("/api/models/qwen-small").status_code == 409
        runtime = client.post("/api/runtime/setup")
        assert runtime.status_code == 202
        assert runtime.json()["lane"] == "heavy"
        assert wait_job(client, runtime.json()["id"])["status"] == "completed"
    finally:
        release.set()
    assert all(wait_job(client, job["id"])["status"] == "completed" for job in jobs)


def test_health_is_authenticated_and_does_not_probe_models(client, monkeypatch):
    monkeypatch.setattr(client.app.state.models, "ready", lambda: pytest.fail("Health imported the runtime"))
    monkeypatch.setattr(client.app.state.models, "item", lambda _: pytest.fail("Health inspected weights"))
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ready"}
    assert client.get("/api/health", headers={"X-Clip-Token": ""}).status_code == 401
    assert client.get("/api/health", headers={"Origin": "https://other.example"}).status_code == 403


def test_system_uses_a_single_runtime_snapshot(client, monkeypatch):
    from unittest.mock import Mock

    ready = Mock(return_value=True)
    monkeypatch.setattr(client.app.state.models, "ready", ready)
    monkeypatch.setattr(client.app.state.models, "item", lambda _: {"installed": True})
    response = client.get("/api/system")
    assert response.status_code == 200
    assert response.json()["model_runtime"] is True
    assert response.json()["whisper"] is True
    ready.assert_called_once()
