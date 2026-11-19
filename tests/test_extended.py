"""Extended local workflows: real media, ordinary scheduler ticks, offline Graph reads.

No model installation, network access, paid writes, or production test helpers.
"""

import json
import shutil
import subprocess
import sys
import textwrap
import threading
import time
import wave
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pytest
from fastapi.testclient import TestClient

from clip_factory.ads import AdsClient
from clip_factory.app import create_app
from clip_factory.jobs import WorkError
from clip_factory.meta import MetaClient, SecureTokenStore
from clip_factory.store import Store

TOKEN = "extended-native-user-token"
PAGE_TOKEN = "extended-page-token"
PUBLIC_URL = "https://cdn.creator.com/clip.mp4"


def wait_until(read, predicate, *, timeout=10):
    deadline = time.monotonic() + timeout
    value = None
    while time.monotonic() < deadline:
        value = read()
        if predicate(value):
            return value
        time.sleep(0.02)
    pytest.fail(f"Bounded wait expired; last value: {value!r}")


def wait_job(client, identifier, timeout=20):
    return wait_until(lambda: client.app.state.store.get("jobs", identifier),
                      lambda row: row and row["status"] in {"completed", "failed", "cancelled"},
                      timeout=timeout)


@pytest.fixture
def offline(monkeypatch):
    state = {"ig_id": "30", "currency": "USD", "container_status": "FINISHED", "write_failure": False}
    saved, requests, specs = {}, [], []

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

    def handler(request):
        requests.append(request)
        assert request.url.host == "graph.facebook.com"
        assert TOKEN not in str(request.url) and PAGE_TOKEN not in str(request.url)
        assert "access_token" not in request.url.params
        path = request.url.path
        if path.endswith("/me/accounts"):
            assert request.method == "GET"
            assert request.headers["Authorization"] == f"Bearer {TOKEN}"
            return httpx.Response(200, json={"data": [{"id": "20", "access_token": PAGE_TOKEN,
                "instagram_business_account": {"id": state["ig_id"], "username": "creator"}}]})
        if path.endswith("/me/adaccounts"):
            assert request.method == "GET"
            assert request.headers["Authorization"] == f"Bearer {TOKEN}"
            return httpx.Response(200, json={"data": [{"id": "act_10", "name": "Live mocked account",
                "currency": state["currency"], "account_status": 1}]})
        if path.endswith("/act_10/insights"):
            assert request.method == "GET"
            return httpx.Response(200, json={"data": [{"ad_id": "60", "spend": "1.25", "clicks": "4",
                "date_start": "2026-11-01", "date_stop": "2026-11-01",
                "actions": [{"action_type": "link_click", "value": "4"}]}]})
        assert request.headers["Authorization"] == f"Bearer {PAGE_TOKEN}"
        if request.method == "POST":
            assert path in {"/v22.0/30/media", "/v22.0/30/media_publish"}, "No paid writes are allowed"
            if state["write_failure"]:
                return httpx.Response(503, json={"error": {"code": 2, "message": TOKEN}})
            body = parse_qs(request.content.decode())
            if path.endswith("/media_publish"):
                assert body == {"creation_id": ["40"]}
                return httpx.Response(200, json={"id": "50"})
            assert body["media_type"] == ["REELS"] and body["video_url"] == [PUBLIC_URL]
            return httpx.Response(200, json={"id": "40"})
        assert request.method == "GET"
        if path.endswith("/40"):
            return httpx.Response(200, json={"status_code": state["container_status"]})
        if path.endswith("/media"):
            return httpx.Response(200, json={"data": [{"id": "50", "media_type": "VIDEO",
                "media_product_type": "REELS"}]})
        pytest.fail(f"Unexpected mocked Graph route: {path}")

    class FakeMeta(MetaClient):
        def __init__(self, token, version):
            super().__init__(token, version, transport=httpx.MockTransport(handler))

    class FakeAds(AdsClient):
        """Real read-only adapter validation over a fake Graph transport."""

        def __init__(self, token, version):
            super().__init__(token, version, transport=httpx.MockTransport(handler))

        def preflight(self, spec, *, cancel_check=None):
            specs.append(spec.copy())
            return super().preflight(spec, cancel_check=cancel_check)

        def create_experiment(self, *args, **kwargs):
            raise AssertionError("App must never attempt paid creation")

        def set_experiment_status(self, *args, **kwargs):
            raise AssertionError("App must never attempt paid activation or pause")

    return state, saved, requests, specs, FakeMeta, FakeAds


@pytest.fixture
def app_factory(tmp_path, monkeypatch, offline):
    for key in ("CLIP_META_APP_ID", "CLIP_META_APP_SECRET", "CLIP_META_REDIRECT_URI"):
        monkeypatch.delenv(key, raising=False)

    def no_install(*args, **kwargs):
        raise AssertionError("Extended tests must not install runtimes or download weights")

    monkeypatch.setattr("clip_factory.models.Models.download", no_install)
    monkeypatch.setattr("clip_factory.models.Models.setup", no_install)
    *_, meta_factory, ads_factory = offline

    @contextmanager
    def start():
        app = create_app(tmp_path / "library", token="test-session")
        app.state.token_store = SecureTokenStore()
        app.state.meta_factory = meta_factory
        app.state.ads_factory = ads_factory
        with TestClient(app, base_url="http://127.0.0.1", headers={"X-Clip-Token": "test-session"}) as client:
            yield client
        assert not app.state.jobs.thread.is_alive()
        assert not app.state.scheduler.is_alive()

    return start


@pytest.fixture
def client(app_factory):
    with app_factory() as active:
        yield active


def seed_clip(client, *, approved=True, **extra):
    (client.app.state.root / "clips" / "extended.mp4").write_bytes(b"local clip")
    row = {"id": "extended", "video_id": "source", "name": "Actual clip", "objective": "traffic",
           "caption": "Reviewed caption", "hook": "Reviewed hook", "approved": approved, "start": 0, "end": 1,
           "status": "ready", "instagram_media_id": None, "published_at": None,
           "path": "clips/extended.mp4", **extra}
    return client.app.state.store.put("clips", row)


def connect(client):
    response = client.post("/api/instagram/connect", json={"access_token": TOKEN})
    assert response.status_code == 200, response.text
    assert TOKEN not in response.text and PAGE_TOKEN not in response.text
    return response.json()


def settings(client, **values):
    response = client.put("/api/settings", json=values)
    assert response.status_code == 200, response.text


def authorized(client):
    seed_clip(client)
    connect(client)
    settings(client, publishing_enabled=True)


def schedule(client, at=None):
    response = client.post("/api/clips/extended/schedule", json={"public_video_url": PUBLIC_URL,
        "publish_at": (at or datetime.now(UTC) + timedelta(seconds=0.3)).isoformat()})
    assert response.status_code == 201, response.text
    return response.json()


def schedule_terminal(client, identifier):
    return wait_until(lambda: client.app.state.store.get("schedules", identifier),
                      lambda row: row and row["status"] != "scheduled", timeout=8)


def worker_barrier(client):
    entered, release = threading.Event(), threading.Event()

    def block(_):
        entered.set()
        if not release.wait(6):
            raise WorkError("Test barrier expired")
        return True

    client.app.state.jobs.submit("test-barrier", block)
    assert entered.wait(2)
    return release


def paid_body(**overrides):
    return {"ad_account_id": "act_10", "clip_id": "extended", "destination_url": "https://creator.com/offer",
            "lifetime_budget_minor": 1250, "duration_days": 7, "name": "Reviewed candidate", **overrides}


def paid_authorized(client):
    seed_clip(client, instagram_media_id="50", instagram_account_id="30")
    connect(client)
    settings(client, ads_enabled=True, total_budget=12.50)


def test_real_cover_generation_get_and_download(client, tmp_path):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("FFmpeg/ffprobe not installed")
    sample = tmp_path / "sample.mp4"
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
                    "color=c=green:s=160x90:r=10:d=0.6", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(sample)],
                   check=True, capture_output=True, timeout=20)
    with sample.open("rb") as file:
        upload = client.post("/api/videos", files={"file": ("sample.mp4", file, "video/mp4")})
    assert upload.status_code == 201
    render = client.post(f"/api/videos/{upload.json()['id']}/render", json={"start": 0, "end": 0.4})
    assert render.status_code == 202
    job = wait_job(client, render.json()["id"], timeout=30)
    assert job["status"] == "completed", job
    identifier = job["result"]["clip_id"]
    inline = client.get(f"/api/clips/{identifier}/cover")
    attachment = client.get(f"/api/clips/{identifier}/cover/download")
    assert inline.status_code == attachment.status_code == 200
    assert inline.headers["content-type"] == "image/jpeg"
    assert inline.content[:2] == b"\xff\xd8" and inline.content[-2:] == b"\xff\xd9"
    assert attachment.content == inline.content
    assert "attachment" in attachment.headers["content-disposition"]
    assert "cover.jpg" in attachment.headers["content-disposition"]
    stored = client.app.state.store.get("clips", identifier)
    cover = (client.app.state.root / stored["path"]).with_suffix(".jpg")
    dimensions = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height",
                                 "-of", "json", str(cover)], check=True, capture_output=True, timeout=10)
    assert json.loads(dimensions.stdout)["streams"][0] == {"width": 540, "height": 960}
    assert client.delete(f"/api/clips/{identifier}").status_code == 200
    assert not cover.exists()
    assert client.get(f"/api/clips/{identifier}/cover").status_code == 404


def test_cover_absent_and_path_escape_are_not_served(client, tmp_path):
    seed_clip(client)
    assert client.get("/api/clips/extended/cover").status_code == 404
    outside = tmp_path / "private.mp4"
    outside.write_bytes(b"not library media")
    outside.with_suffix(".jpg").write_bytes(b"private cover")
    client.app.state.store.patch("clips", "extended", path=str(outside))
    assert client.get("/api/clips/extended/cover").status_code == 404
    assert client.get("/api/clips/extended/download").status_code == 404


@pytest.mark.usefixtures("mac_host")
def test_inference_job_returns_only_injected_local_output(client, monkeypatch):
    calls = []
    monkeypatch.setattr(client.app.state.models, "require", lambda model, kind: calls.append((model, kind)))

    def run(identifier, model, action, **payload):
        assert client.app.state.store.get("jobs", identifier)["status"] == "running"
        assert (model, action, payload) == ("qwen-small", "generate", {"prompt": "Source grounded hook"})
        return {"output": "Test runtime output, not a performance prediction"}

    monkeypatch.setattr(client.app.state.models, "run", run)
    response = client.post("/api/inference", json={"prompt": "Source grounded hook"})
    assert response.status_code == 202
    job = wait_job(client, response.json()["id"])
    assert job["status"] == "completed" and job["result"]["output"].startswith("Test runtime output")
    assert calls == [("qwen-small", "llm")]
    assert client.get("/api/clips").json() == []


def test_narration_job_real_wav_download_and_no_destination_injection(client, monkeypatch, tmp_path):
    calls, destinations = [], []
    monkeypatch.setattr(client.app.state.models, "require", lambda model, kind: calls.append((model, kind)))

    def run(identifier, model, action, **payload):
        assert (model, action) == ("kokoro", "narrate")
        assert payload["text"] == "../untrusted text is not a file destination"
        output = Path(payload["output_path"])
        assert output.parent == client.app.state.root / "narrations"
        assert output.suffix == ".wav" and len(output.stem) == 32
        destinations.append(output)
        with wave.open(str(output), "wb") as file:
            file.setnchannels(1)
            file.setsampwidth(2)
            file.setframerate(16000)
            file.writeframes(b"\0\0" * 160)
        return {"output_path": str(tmp_path / "ignored-evil-output.wav")}

    monkeypatch.setattr(client.app.state.models, "run", run)
    invalid = client.post("/api/narrations", json={"text": "words", "output_path": "../../outside.wav"})
    assert invalid.status_code == 422 and calls == []
    response = client.post("/api/narrations", json={"text": "../untrusted text is not a file destination"})
    assert response.status_code == 202
    job = wait_job(client, response.json()["id"])
    assert job["status"] == "completed", job
    assert calls == [("kokoro", "tts")]
    assert "path" not in job["result"] and "output_path" not in job["result"]
    downloaded = client.get(job["result"]["download_url"])
    assert downloaded.status_code == 200 and downloaded.headers["content-type"] == "audio/wav"
    assert downloaded.content == destinations[0].read_bytes()
    assert downloaded.content.startswith(b"RIFF") and downloaded.content[8:12] == b"WAVE"
    assert "narration.wav" in downloaded.headers["content-disposition"]
    stored = client.app.state.store.get("narrations", job["result"]["narration_id"])
    assert not Path(stored["path"]).is_absolute()
    assert client.get("/api/narrations/missing/download").status_code == 404
    outside = tmp_path / "outside.wav"
    outside.write_bytes(b"private")
    client.app.state.store.put("narrations", {"id": "escape", "path": str(outside)})
    assert client.get("/api/narrations/escape/download").status_code == 404


def test_narration_failure_does_not_publish_fake_download(client, monkeypatch):
    monkeypatch.setattr(client.app.state.models, "require", lambda *args: None)

    def fail(*args, **kwargs):
        raise WorkError("Local speech model unavailable; no audio generated.")

    monkeypatch.setattr(client.app.state.models, "run", fail)
    response = client.post("/api/narrations", json={"text": "actual words"})
    assert response.status_code == 202
    job = wait_job(client, response.json()["id"])
    assert job["status"] == "failed" and job["result"] is None
    assert client.app.state.store.all("narrations") == []


def test_schedules_timezone_persistence_restart_list_and_cancel(app_factory, offline):
    *_, requests, _, _, _ = offline
    at = datetime.now(timezone(timedelta(hours=5, minutes=30))) + timedelta(hours=1)
    with app_factory() as client:
        authorized(client)
        row = schedule(client, at)
        assert datetime.fromisoformat(row["publish_at"]) == at
        assert datetime.fromisoformat(row["publish_at"]).utcoffset() == timedelta(0)
        assert "running" in row["note"]
        assert client.get("/api/schedules").json() == [row]
        assert Store(client.app.state.root).get("schedules", row["id"]) == row
        before = len(requests)
    with app_factory() as restarted:
        assert restarted.get("/api/schedules").json() == [row]
        assert restarted.app.state.store.all("jobs") == []
        cancelled = restarted.delete(f"/api/schedules/{row['id']}")
        assert cancelled.status_code == 200 and cancelled.json()["status"] == "cancelled"
        assert restarted.delete(f"/api/schedules/{row['id']}").status_code == 409
        assert restarted.delete("/api/schedules/missing").status_code == 404
        assert len(requests) == before


@pytest.mark.parametrize("timestamp", ["not a time", "2099-01-01T12:00:00", "2000-01-01T00:00:00+00:00"])
def test_schedule_requires_future_timezone_and_authorization(client, offline, timestamp):
    authorized(client)
    before = len(offline[2])
    response = client.post("/api/clips/extended/schedule", json={"public_video_url": PUBLIC_URL,
                                                               "publish_at": timestamp})
    assert response.status_code == 422
    assert client.get("/api/schedules").json() == [] and len(offline[2]) == before


def test_schedule_gates_and_duplicate_durable_attempt(client):
    seed_clip(client, approved=False)
    future = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    body = {"public_video_url": PUBLIC_URL, "publish_at": future}
    assert client.post("/api/clips/extended/schedule", json=body).status_code == 409
    connect(client)
    settings(client, publishing_enabled=True)
    assert client.post("/api/clips/extended/schedule", json=body).status_code == 409
    client.put("/api/clips/extended", json={"approved": True})
    assert client.post("/api/clips/extended/schedule", json={**body, "public_video_url": "https://127.0.0.1/a"}).status_code == 400
    row = schedule(client, datetime.now(UTC) + timedelta(hours=1))
    assert client.post("/api/clips/extended/schedule", json=body).status_code == 409
    assert client.delete(f"/api/schedules/{row['id']}").status_code == 200
    client.app.state.store.patch("clips", "extended", publish_attempt="durable-attempt")
    assert client.post("/api/clips/extended/schedule", json=body).status_code == 409


def test_normal_scheduler_due_publish_authorized_once(client, offline):
    authorized(client)
    row = schedule(client)
    submitted = schedule_terminal(client, row["id"])
    assert submitted["status"] == "submitted", submitted
    job = wait_job(client, submitted["job_id"])
    assert job["status"] == "completed", job
    clip = Store(client.app.state.root).get("clips", "extended")
    assert clip["instagram_media_id"] == "50" and clip["instagram_account_id"] == "30"
    assert clip["instagram_container_id"] == "40"
    assert clip["publish_attempt"] == job["id"]
    assert len([request for request in offline[2] if request.method == "POST"]) == 2
    assert client.delete(f"/api/schedules/{row['id']}").status_code == 409
    assert client.post("/api/clips/extended/publish", json={"public_video_url": PUBLIC_URL}).status_code == 409
    body = {"public_video_url": PUBLIC_URL, "publish_at": (datetime.now(UTC) + timedelta(hours=1)).isoformat()}
    assert client.post("/api/clips/extended/schedule", json=body).status_code == 409


def test_overdue_schedule_recovers_after_clean_restart(app_factory, offline):
    with app_factory() as client:
        authorized(client)
        row = schedule(client, datetime.now(UTC) + timedelta(hours=1))
        root = client.app.state.root
    # An app can be closed when its scheduled time arrives. Preserve the durable API-created row.
    Store(root).patch("schedules", row["id"], publish_at=(datetime.now(UTC) - timedelta(seconds=1)).isoformat())
    with app_factory() as restarted:
        submitted = schedule_terminal(restarted, row["id"])
        assert submitted["status"] == "submitted", submitted
        assert wait_job(restarted, submitted["job_id"])["status"] == "completed"
    assert len([request for request in offline[2] if request.method == "POST"]) == 2


@pytest.mark.parametrize("change", ["disabled", "account", "approval", "cancelled"])
def test_scheduler_revalidates_changes_before_any_external_write(client, offline, change):
    authorized(client)
    row = schedule(client)
    if change == "disabled":
        settings(client, publishing_enabled=False)
    elif change == "account":
        offline[0]["ig_id"] = "31"
        connect(client)
    elif change == "approval":
        assert client.put("/api/clips/extended", json={"approved": False}).status_code == 200
    else:
        assert client.delete(f"/api/schedules/{row['id']}").status_code == 200
    before = len(offline[2])
    if change == "cancelled":
        # Wait beyond an ordinary tick, not by replacing/accelerating scheduler internals.
        time.sleep(2.2)
        stopped = client.app.state.store.get("schedules", row["id"])
    else:
        stopped = schedule_terminal(client, row["id"])
    assert stopped["status"] == ("cancelled" if change == "cancelled" else "failed")
    assert len(offline[2]) == before
    assert client.app.state.store.all("jobs") == []
    assert not client.app.state.store.get("clips", "extended").get("publish_attempt")


def test_reconciliation_reads_only_and_never_clears_retry_marker(client, offline):
    seed_clip(client, publish_attempt="ambiguous-original-job", instagram_container_id="40",
              status="publish_needs_reconciliation")
    connect(client)
    offline[0]["container_status"] = "PUBLISHED"
    before = len(offline[2])
    response = client.post("/api/clips/extended/reconcile")
    assert response.status_code == 202
    job = wait_job(client, response.json()["id"])
    assert job["status"] == "completed", job
    assert job["result"]["status_code"] == "PUBLISHED"
    assert "Read-only" in job["result"]["note"]
    assert all(request.method == "GET" for request in offline[2][before:])
    clip = Store(client.app.state.root).get("clips", "extended")
    assert clip["external_stage"] == "PUBLISHED"
    assert clip["publish_attempt"] == "ambiguous-original-job"
    assert clip["status"] == "publish_needs_reconciliation" and clip["instagram_media_id"] is None
    settings(client, publishing_enabled=True)
    assert client.post("/api/clips/extended/publish", json={"public_video_url": PUBLIC_URL}).status_code == 409


def test_reconcile_without_known_container_fails_before_network(client, offline):
    seed_clip(client, publish_attempt="ambiguous")
    assert client.post("/api/clips/extended/reconcile").status_code == 409
    assert offline[2] == [] and client.app.state.store.all("jobs") == []


def test_paid_accounts_and_sync_read_only_cache_provenance(client, offline):
    assert client.get("/api/ads/accounts").status_code == 400
    assert client.post("/api/ads/sync", json={"ad_account_id": "act_10"}).status_code == 409
    assert client.get("/api/ads/insights").json()["rows"] == []
    connect(client)
    accounts = client.get("/api/ads/accounts")
    assert accounts.status_code == 200
    assert accounts.json()["accounts"][0]["currency"] == "USD"
    assert accounts.json()["supported"] is False
    response = client.post("/api/ads/sync", json={"ad_account_id": "act_10"})
    assert response.status_code == 202
    assert wait_job(client, response.json()["id"])["status"] == "completed"
    persisted = Store(client.app.state.root).get("paid", "act_10")
    assert persisted["instagram_account_id"] == "30" and persisted["updated_at"]
    before = len(offline[2])
    read = client.get("/api/ads/insights").json()
    assert read["rows"] == persisted["rows"] and read["rows"][0]["spend"] == "1.25"
    assert "not automatically mapped" in read["attribution"]
    assert len(offline[2]) == before, "Cached reads must not contact Meta"
    assert all(request.method == "GET" for request in offline[2])
    assert client.get("/api/analytics").json()["videos"] == []
    assert client.get("/api/instagram/status").json()["ads_available"] is False
    offline[0]["ig_id"] = "31"
    connect(client)
    assert client.get("/api/ads/insights").json()["rows"] == []
    assert Store(client.app.state.root).get("paid", "act_10") == persisted
    assert ("clip-factory", "instagram:30") not in offline[1]
    assert client.delete("/api/instagram/connect").status_code == 200
    assert client.get("/api/ads/insights").json()["rows"] == []


@pytest.mark.parametrize("body", [{"ad_account_id": "../../10"}, {"ad_account_id": "act_10", "extra": TOKEN}])
def test_paid_sync_invalid_ids_and_fields_do_not_reach_graph(client, offline, body):
    assert client.post("/api/ads/sync", json=body).status_code == 422
    assert TOKEN not in client.post("/api/ads/sync", json=body).text
    assert offline[2] == []


def test_paid_preflight_exact_usd_minor_unit_cap_and_no_creation(client, offline):
    paid_authorized(client)
    response = client.post("/api/ads/preflight", json=paid_body())
    assert response.status_code == 202, response.text
    job = wait_job(client, response.json()["id"])
    assert job["status"] == "completed", job
    result = job["result"]
    assert result["stage"] == "preflight_only"
    assert result["can_create"] is False and result["can_activate"] is False
    assert result["currency"] == "USD" and result["currency_exponent"] == 2
    assert result["spec"]["lifetime_budget_minor"] == 1250
    assert offline[3] == [{"ad_account_id": "act_10", "instagram_account_id": "30", "page_id": "20",
        "instagram_media_id": "50", "name": "Reviewed candidate", "destination_url": "https://creator.com/offer",
        "country": "US", "lifetime_budget_minor": 1250, "duration_days": 7}]
    assert "No resources" in result["verification_gap"]
    assert all(request.method == "GET" for request in offline[2])
    assert client.get("/api/instagram/status").json()["ads_available"] is False
    stats = client.get("/api/analytics").json()["videos"][0]
    assert all(value is None for value in stats["paid"].values()), "Preflight is not observed spend"


@pytest.mark.parametrize("change", ["disabled", "zero", "over-budget", "wrong-account", "unpublished"])
def test_paid_preflight_budget_and_provenance_gates_before_network(client, offline, change):
    paid_authorized(client)
    body = paid_body()
    if change == "disabled":
        settings(client, ads_enabled=False, total_budget=100)
    elif change == "zero":
        settings(client, ads_enabled=True, total_budget=0)
    elif change == "over-budget":
        body["lifetime_budget_minor"] = 1251
    elif change == "wrong-account":
        client.app.state.store.patch("clips", "extended", instagram_account_id="31")
    else:
        client.app.state.store.patch("clips", "extended", instagram_media_id=None)
    before = len(offline[2])
    assert client.post("/api/ads/preflight", json=body).status_code == 409
    assert len(offline[2]) == before and offline[3] == []
    assert client.app.state.store.all("jobs") == []


@pytest.mark.parametrize("fields", [{"lifetime_budget_minor": 0}, {"lifetime_budget_minor": 1.5},
                                   {"lifetime_budget_minor": 2147483648}, {"duration_days": 0},
                                   {"duration_days": 91}, {"currency": "USD"}])
def test_paid_preflight_schema_minor_units_and_duration(client, offline, fields):
    paid_authorized(client)
    before = len(offline[2])
    assert client.post("/api/ads/preflight", json=paid_body(**fields)).status_code == 422
    assert len(offline[2]) == before


def test_paid_preflight_unsupported_live_currency_fails_without_writes(client, offline):
    paid_authorized(client)
    offline[0]["currency"] = "JPY"
    response = client.post("/api/ads/preflight", json=paid_body())
    assert response.status_code == 202
    job = wait_job(client, response.json()["id"])
    assert job["status"] == "failed" and "USD" in job["error"]
    assert job["result"] is None
    assert all(request.method == "GET" for request in offline[2])


@pytest.mark.parametrize("route,body", [("/api/ads/sync", {"ad_account_id": "act_10"}),
                                      ("/api/ads/preflight", paid_body())])
def test_queued_paid_reads_stop_on_account_change(client, offline, route, body):
    paid_authorized(client)
    release = worker_barrier(client)
    try:
        response = client.post(route, json=body)
        assert response.status_code == 202
        offline[0]["ig_id"] = "31"
        connect(client)
        before = len(offline[2])
    finally:
        release.set()
    job = wait_job(client, response.json()["id"])
    assert job["status"] == "failed" and "changed" in job["error"].lower()
    assert len(offline[2]) == before and offline[3] == []
    assert client.app.state.store.all("paid") == []


def test_worker_shares_store_lock_and_bounded_concurrent_stress(client, tmp_path):
    assert client.app.state.jobs.lock is client.app.state.store.lock
    # Isolate the deadlock regression in a killable process; even a broken lock ordering
    # cannot strand pytest teardown, background producers, or the application's worker.
    script = textwrap.dedent('''
        import sys, threading, time
        from pathlib import Path
        from clip_factory.jobs import Jobs
        from clip_factory.store import Store

        store = Store(Path(sys.argv[1]))
        jobs = Jobs(store)
        assert jobs.lock is store.lock
        start = threading.Event()
        errors, identifiers = [], []

        def operation(identifier):
            jobs.check(identifier)
            jobs.update(identifier, message="real operation")
            return {"id": identifier}

        def producer(index):
            try:
                assert start.wait(2)
                for number in range(16):
                    with store.lock:
                        item = jobs.submit("stress", operation, producer=index)
                        identifiers.append(item["id"])
                        store.patch("jobs", item["id"], stress_index=number)
                    if number % 2 == 0:
                        jobs.cancel(item["id"])
                    jobs.busy("producer", index)
            except BaseException as exc:
                errors.append(repr(exc))

        producers = [threading.Thread(target=producer, args=(i,), daemon=True) for i in range(4)]
        try:
            for thread in producers:
                thread.start()
            start.set()
            for thread in producers:
                thread.join(timeout=5)
            assert not any(thread.is_alive() for thread in producers), "submit/cancel lock deadlock"
            assert not errors, errors
            assert len(identifiers) == len(set(identifiers)) == 64
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if all(row["status"] in {"completed", "cancelled"} for row in store.all("jobs")):
                    break
                time.sleep(0.01)
            assert all(row["status"] in {"completed", "cancelled"} for row in store.all("jobs"))
            assert not jobs.busy("producer", 0)
        finally:
            jobs.close()
        assert not jobs.thread.is_alive()
        print("64 durable terminal jobs; shared-lock worker cleanly stopped")
    ''')
    result = subprocess.run([sys.executable, "-c", script, str(tmp_path / "stress")],
                            cwd=Path(__file__).resolve().parents[1], timeout=20,
                            check=True, capture_output=True, text=True)
    assert "64 durable terminal jobs" in result.stdout
