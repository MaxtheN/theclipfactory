"""Authenticated team APIs, serialized local jobs, and a real silent-media smoke."""

import copy
import json
import shutil
import subprocess
import threading
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from test_app import PUBLIC_URL, SESSION, USER_TOKEN, upload_mock, wait_job
from test_app import client as authenticated_client_fixture
from test_app import graph as offline_graph_fixture
from test_team import ScriptedModels, script

from clip_factory import media
from clip_factory.app import create_app

# Reuse isolated, authenticated offline fixtures without importing shadowed parameter names.
client = authenticated_client_fixture
graph = offline_graph_fixture


@pytest.fixture
def scripted(client, monkeypatch):
    models = ScriptedModels([])
    monkeypatch.setattr(client.app.state.models, "require", models.require)
    monkeypatch.setattr(client.app.state.models, "run", models.run)
    return models


def install_mock_render(client, monkeypatch):
    """Honor the engine callback's atomic _team metadata contract."""
    store = client.app.state.store
    calls = []

    def render(job, video, candidate):
        calls.append(copy.deepcopy(candidate))
        identifier = f"draft-{len(calls)}"
        store.put(
            "clips",
            {
                "id": identifier,
                "video_id": video["id"],
                "path": f"clips/{identifier}.mp4",
                "approved": False,
                "status": "ready",
                "instagram_media_id": None,
                **{k: v for k, v in candidate.items() if k != "_team"},
                **candidate["_team"],
            },
        )
        return {"clip_id": identifier}

    monkeypatch.setattr(client.app.state.team, "render", render)
    monkeypatch.setattr(client.app.state.team, "frames", lambda *_: [])
    return calls


def submit(client, video, **body):
    response = client.post(f"/api/videos/{video['id']}/team", json={"model_id": "qwen-small", **body})
    assert response.status_code == 202, response.text
    return response.json()


def terminal_run(client, submission):
    job = wait_job(client, submission["job"]["id"], timeout=20)
    assert job["status"] == "completed", job
    response = client.get(f"/api/team/runs/{submission['run']['id']}")
    assert response.status_code == 200
    run = response.json()
    assert run["status"] == "needs_review"
    assert all(task["status"] not in {"queued", "running"} for task in run["tasks"])
    return run


@pytest.mark.parametrize("budget", [-1, 3, 2.0, "2", True, None])
def test_revision_budget_is_strict_and_at_most_two(client, monkeypatch, scripted, budget):
    video = upload_mock(client, monkeypatch)
    response = client.post(f"/api/videos/{video['id']}/team", json={"revision_budget": budget})
    assert response.status_code == 422
    assert not scripted.calls and not client.app.state.store.all("team_runs")


@pytest.mark.parametrize("verdict,review", [("revise", "fail"), ("unknown", "unknown")])
def test_unresolved_critic_blocks_approval_publish_and_schedule(
    client, monkeypatch, scripted, graph, verdict, review
):
    video = upload_mock(client, monkeypatch)
    scripted.outputs = script(f"source:{video['id']}", verdict=verdict)
    renders = install_mock_render(client, monkeypatch)
    run = terminal_run(client, submit(client, video, revision_budget=0))
    clip_id = run["clip_ids"][0]
    assert renders[0]["_team"]["team_review_status"] == review
    assert client.get("/api/clips").json()[0]["approved"] is False
    assert client.put(f"/api/clips/{clip_id}", json={"approved": True}).status_code == 409
    # Enable all other release prerequisites so these tests isolate the critique gate.
    assert client.put("/api/settings", json={"publishing_enabled": True}).status_code == 200
    assert client.post("/api/instagram/connect", json={"access_token": USER_TOKEN}).status_code == 200
    client.app.state.store.patch("clips", clip_id, approved=True)
    assert (
        client.post(f"/api/clips/{clip_id}/publish", json={"public_video_url": PUBLIC_URL}).status_code == 409
    )
    at = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    assert (
        client.post(
            f"/api/clips/{clip_id}/schedule", json={"public_video_url": PUBLIC_URL, "publish_at": at}
        ).status_code
        == 409
    )
    _, requests, _, published = graph
    assert not published and not any(request.method == "POST" for request in requests)
    assert not client.app.state.store.all("schedules")
    assert not client.app.state.store.get("clips", clip_id).get("publish_attempt")


def test_team_api_and_media_require_token_and_same_origin(client, monkeypatch, scripted):
    video = upload_mock(client, monkeypatch)
    scripted.outputs = script(f"source:{video['id']}")
    install_mock_render(client, monkeypatch)
    run = terminal_run(client, submit(client, video))
    clip_id = run["clip_ids"][0]
    endpoints = [
        ("GET", "/api/team/runs"),
        ("GET", f"/api/team/runs/{run['id']}"),
        ("GET", f"/api/team/comparisons?video_id={video['id']}"),
        ("POST", f"/api/team/runs/{run['id']}/cancel"),
        ("POST", f"/api/videos/{video['id']}/team"),
        ("GET", f"/api/clips/{clip_id}/media"),
        ("GET", f"/api/clips/{clip_id}/cover"),
    ]
    for method, path in endpoints:
        assert client.request(method, path, headers={"X-Clip-Token": "wrong"}).status_code == 401
        assert client.request(method, path, headers={"Origin": "https://evil.example"}).status_code == 403
    client.headers.pop("X-Clip-Token")
    assert client.get("/api/team/runs").status_code == 401


@pytest.fixture
def worker_block(client):
    entered, release = threading.Event(), threading.Event()

    def block(job):
        entered.set()
        assert release.wait(8), "Test must release the heavy worker within its bounded deadline"
        client.app.state.jobs.check(job)
        return {"test_blocker": True}

    job = client.app.state.jobs.submit("test-blocker", block)
    assert entered.wait(3)
    try:
        yield release
    finally:
        release.set()
        wait_job(client, job["id"], timeout=10)


def test_queued_cancel_persists_in_get_and_restart_without_calls(client, monkeypatch, scripted, worker_block):
    video = upload_mock(client, monkeypatch)
    queued = submit(client, video)
    run_id = queued["run"]["id"]
    assert queued["run"]["status"] == "queued"
    assert client.delete("/api/models/qwen-small").status_code == 409
    response = client.post(f"/api/team/runs/{run_id}/cancel")
    assert response.status_code == 200 and response.json()["status"] == "cancelled"
    saved = client.get(f"/api/team/runs/{run_id}").json()
    assert saved["status"] == "cancelled"
    assert all(task["status"] == "cancelled" for task in saved["tasks"])
    assert client.app.state.store.get("jobs", queued["job"]["id"])["status"] == "cancelled"
    worker_block.set()
    assert not scripted.calls
    # Recovery reads a new Store connection, not an in-memory cached ledger.
    app = create_app(client.app.state.root, token=SESSION)
    with TestClient(app, base_url="http://127.0.0.1", headers={"X-Clip-Token": SESSION}) as restarted:
        assert restarted.get(f"/api/team/runs/{run_id}").json()["status"] == "cancelled"
    assert not app.state.jobs.thread.is_alive()


def test_queued_settings_snapshot_stays_consistent_after_user_changes(
    client, monkeypatch, scripted, worker_block
):
    video = upload_mock(client, monkeypatch)
    assert (
        client.put(
            "/api/settings", json={"brand": "Original brand", "objective": "sales", "language": "en"}
        ).status_code
        == 200
    )
    scripted.outputs = script(f"source:{video['id']}")
    install_mock_render(client, monkeypatch)
    queued = submit(client, video)
    assert queued["run"]["revision_budget"] == 2
    assert (
        client.put(
            "/api/settings",
            json={
                "brand": "Changed brand",
                "objective": "traffic",
                "language": "fr",
                "production_strategy": "baseline",
            },
        ).status_code
        == 200
    )
    worker_block.set()
    run = terminal_run(client, queued)
    assert run["objective"] == "sales" and run["mode"] == "team"
    assert run["context"]["settings"] == {
        "brand": "Original brand",
        "objective": "sales",
        "language": "en",
        "custom_event": "",
    }
    assert scripted.calls[0]["data"]["context"]["settings"] == run["context"]["settings"]
    assert scripted.calls[2]["data"]["brand"] == "Original brand"
    assert scripted.calls[2]["data"]["objective"] == "sales"
    assert scripted.calls[3]["data"]["objective"] == "sales"
    assert client.get("/api/settings").json()["objective"] == "traffic"
    assert client.get("/api/clips").json()[0]["objective"] == "sales"


def test_one_heavy_worker_serializes_team_models_and_model_delete_is_safe(client, monkeypatch, scripted):
    first = upload_mock(client, monkeypatch)
    second = upload_mock(client, monkeypatch)
    install_mock_render(client, monkeypatch)
    scripted.outputs = script(f"source:{first['id']}", objective="discovery") + script(
        f"source:{second['id']}", objective="discovery"
    )
    entered, release = threading.Event(), threading.Event()
    threads = []
    original_run = client.app.state.models.run

    def blocked_run(*args, **kwargs):
        threads.append(threading.current_thread().ident)
        if len(threads) == 1:
            entered.set()
            assert release.wait(8)
        return original_run(*args, **kwargs)

    monkeypatch.setattr(client.app.state.models, "run", blocked_run)
    first_run = submit(client, first)
    try:
        assert entered.wait(3)
        second_run = submit(client, second)
        assert client.get(f"/api/team/runs/{second_run['run']['id']}").json()["status"] == "queued"
        assert not scripted.calls  # The only active model call is blocked before accepting output.
        assert client.delete("/api/models/qwen-small").status_code == 409
        assert client.post(f"/api/videos/{first['id']}/team", json={}).status_code == 409
    finally:
        release.set()
    terminal_run(client, first_run)
    terminal_run(client, second_run)
    assert len(threads) == 10 and len(set(threads)) == 1
    assert threads[0] == client.app.state.jobs.thread.ident
    assert client.delete("/api/models/qwen-small").status_code == 200


def test_restart_marks_bound_active_ledger_interrupted_without_resume(tmp_path, monkeypatch):
    # Seed persisted in-flight states without starting any asynchronous operation.
    app = create_app(tmp_path, token=SESSION)
    store = app.state.store
    store.put("videos", {"id": "source", "name": "Source", "duration": 2})
    with TestClient(app, base_url="http://127.0.0.1", headers={"X-Clip-Token": SESSION}):
        run = app.state.team.create(
            store.get("videos", "source"),
            {"brand": "Original", "objective": "sales", "language": "en"},
            "qwen-small",
        )
        tasks = run["tasks"]
        tasks[0].update(status="completed", output={"summary": "Completed output"})
        tasks[1].update(status="running")
        store.patch("team_runs", run["id"], status="running", tasks=tasks, job_id="interrupted-job")
        store.put("jobs", {"id": "interrupted-job", "status": "running", "kind": "team", "context": {}})
    calls = []
    monkeypatch.setattr("clip_factory.models.Models.run", lambda *a, **k: calls.append((a, k)))
    restarted_app = create_app(tmp_path, token=SESSION)
    with TestClient(
        restarted_app, base_url="http://127.0.0.1", headers={"X-Clip-Token": SESSION}
    ) as restarted:
        recovered = restarted.get(f"/api/team/runs/{run['id']}").json()
        assert recovered["status"] == "interrupted"
        assert recovered["tasks"][0]["output"] == {"summary": "Completed output"}
        assert all(task["status"] not in {"queued", "running"} for task in recovered["tasks"])
        assert restarted_app.state.store.get("jobs", "interrupted-job")["status"] == "failed"
        assert restarted_app.state.jobs.pending.empty() and not calls


def test_baseline_produce_uses_queued_snapshot_and_comparison_api(
    client, monkeypatch, scripted, worker_block
):
    video = upload_mock(client, monkeypatch)
    settings = {
        "production_strategy": "baseline",
        "brand": "Original",
        "objective": "sales",
        "language": "en",
    }
    assert client.put("/api/settings", json=settings).status_code == 200
    baseline_calls = []

    def baseline(job, source, model, config):
        baseline_calls.append((source["id"], model, config))
        return {"clips": []}

    monkeypatch.setattr(client.app.state.team, "baseline", baseline)
    response = client.post(f"/api/videos/{video['id']}/produce", json={})
    assert response.status_code == 202
    baseline_job = response.json()
    assert baseline_job["kind"] == "pipeline"
    assert (
        client.put("/api/settings", json={"production_strategy": "team", "brand": "Changed"}).status_code
        == 200
    )
    worker_block.set()
    assert wait_job(client, baseline_job["id"])["status"] == "completed"
    assert baseline_calls == [
        (
            video["id"],
            "qwen-small",
            {"brand": "Original", "objective": "sales", "language": "en", "custom_event": ""},
        )
    ]
    # Explicit baseline endpoint is independent of the currently selected team strategy.
    response = client.post(f"/api/videos/{video['id']}/baseline", json={})
    assert response.status_code == 202
    assert wait_job(client, response.json()["id"])["status"] == "completed"
    comparison = client.get(f"/api/team/comparisons?video_id={video['id']}").json()
    assert len(comparison["runs"]) == 2
    assert all(row["mode"] == "baseline" for row in comparison["runs"])
    assert [row["comparable"] for row in comparison["runs"]] == [True, False]
    assert all(
        row["outcomes"] == {"platform_observations": [], "manual_observations": []}
        for row in comparison["runs"]
    )
    assert not scripted.calls


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="FFmpeg required")
def test_silent_two_second_source_real_ffmpeg_team_render_cover_ledger_and_closed_gates(
    client, scripted, monkeypatch, tmp_path
):
    source = tmp_path / "silent-smoke.mp4"
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
            "color=c=blue:s=320x180:r=12:d=2",
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(source),
        ],
        check=True,
        capture_output=True,
        timeout=20,
    )
    with source.open("rb") as handle:
        response = client.post("/api/videos", files={"file": ("silent-smoke.mp4", handle, "video/mp4")})
    assert response.status_code == 201, response.text
    video = response.json()
    assert video["duration"] == pytest.approx(2, abs=0.1)
    assert client.app.state.store.get("videos", video["id"])["has_audio"] is False
    assert client.put("/api/settings", json={"brand": "Smoke brand", "objective": "sales"}).status_code == 200
    scripted.outputs = script(f"source:{video['id']}")
    persisted_clips = []
    original_put = client.app.state.store.put

    def capture_put(kind, item):
        if kind == "clips":
            persisted_clips.append(copy.deepcopy(item))
        return original_put(kind, item)

    monkeypatch.setattr(client.app.state.store, "put", capture_put)
    submitted = submit(client, video)
    run = terminal_run(client, submitted)
    assert scripted.required and all(kind == "llm" for _, kind in scripted.required)
    assert len(scripted.calls) == 5
    assert run["permissions"] == {"publish": False, "ads": False}
    assert run["plan"]["summary"] == "Make a source-backed draft"
    assert any(key.startswith("frame:") for key in run["context"]["evidence"])
    clip_id = run["clip_ids"][0]
    clip = client.app.state.store.get("clips", clip_id)
    assert persisted_clips[0]["team_run_id"] == run["id"]  # Metadata is present on FIRST persistence.
    assert persisted_clips[0]["team_review_status"] == "pass" and persisted_clips[0]["approved"] is False
    assert clip["team_checks"] == {key: "pass" for key in ("context", "claims", "captions", "duplicates")}
    path = client.app.state.root / clip["path"]
    assert path.is_file() and path.with_suffix(".jpg").is_file()
    info = media.probe(path)
    assert info["duration"] == pytest.approx(1, abs=0.2)
    assert (info["width"], info["height"]) == (1080, 1920)
    assert client.get(f"/api/clips/{clip_id}/media").content == path.read_bytes()
    assert client.get(f"/api/clips/{clip_id}/cover").content.startswith(b"\xff\xd8")
    assert client.get("/api/team/runs").json()[0]["id"] == run["id"]
    comparison = client.get(f"/api/team/comparisons?video_id={video['id']}").json()
    assert comparison["runs"][0]["comparable"] is True
    assert comparison["runs"][0]["outcomes"] == {"platform_observations": [], "manual_observations": []}
    assert (
        client.post(f"/api/clips/{clip_id}/publish", json={"public_video_url": PUBLIC_URL}).status_code == 409
    )
    at = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    assert (
        client.post(
            f"/api/clips/{clip_id}/schedule", json={"public_video_url": PUBLIC_URL, "publish_at": at}
        ).status_code
        == 409
    )
    assert client.get(f"/api/clips/{clip_id}/media", headers={"X-Clip-Token": "wrong"}).status_code == 401
    assert not client.app.state.store.all("schedules")
    assert client.put(f"/api/clips/{clip_id}", json={"approved": True}).status_code == 200
    assert not clip.get("instagram_media_id")
    assert "private reasoning" not in json.dumps(run)


def test_queued_audio_team_protects_required_transcription_model_from_deletion(
    client, monkeypatch, scripted, worker_block
):
    video = upload_mock(client, monkeypatch, has_audio=True)
    queued = submit(client, video)
    try:
        assert ("whisper-turbo", "asr") in scripted.required
        response = client.delete("/api/models/whisper-turbo")
        assert response.status_code == 409, "Queued team still depends on the transcription model"
    finally:
        # Never let this intentionally queued audio job attempt real media or inference.
        client.post(f"/api/team/runs/{queued['run']['id']}/cancel")
        worker_block.set()
