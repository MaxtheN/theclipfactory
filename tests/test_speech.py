"""Production never runs speechless on footage with sound; missing vs damaged speech setup is told apart."""

import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from test_app import client as authenticated_client_fixture
from test_app import upload_mock, wait_job
from test_models import installed

from clip_factory import ranking, speech
from clip_factory.jobs import WorkError
from clip_factory.models import RUNTIME_VERSIONS, Models
from clip_factory.store import Store
from clip_factory.storyboard import VERSION, Storyboards

client = authenticated_client_fixture


@pytest.fixture
def models(tmp_path):
    return Models(tmp_path, Mock())


def set_up_runtime(models, *, metallib=True):
    models.python.parent.mkdir(parents=True, exist_ok=True)
    models.python.touch()
    package = models.runtime / "lib" / "python3.12" / "site-packages" / "mlx" / "lib"
    package.mkdir(parents=True)
    if metallib:
        (package / "mlx.metallib").write_bytes(b"metal")
    (models.runtime / ".ready").write_text(
        json.dumps({"python": [3, 12], "machine": "arm64", "packages": RUNTIME_VERSIONS})
    )


# ----------------------------------------------------------------- integrity probe


def test_fresh_data_dir_reports_speech_as_not_installed(models):
    health = models.integrity()
    assert health["runtime"]["state"] == "missing"
    assert health["whisper-turbo"]["state"] == "missing"
    blocker = speech.classify(models)
    assert blocker["code"] == "asr_missing" and blocker["message"] == speech.MISSING
    assert [s["id"] for s in blocker["steps"]] == ["runtime", "whisper-turbo"]
    assert blocker["download_gb"] == 3.0 and blocker["action"] == "speech_setup"


def test_removed_whisper_weights_are_damaged_not_missing(models):
    installed(models, "whisper-turbo")
    assert models.item("whisper-turbo")["integrity"] == "ok"
    (models.model_dir / "whisper-turbo" / "weights.safetensors").unlink()
    item = models.item("whisper-turbo")
    assert not item["installed"] and item["integrity"] == "damaged" and item["status"] == "damaged"
    with pytest.raises(WorkError, match="damaged or were removed"):
        models.require("whisper-turbo", "asr")
    blocker = speech.classify(models)
    assert blocker["code"] == "asr_damaged" and blocker["message"] == speech.DAMAGED


def test_truncated_whisper_weights_are_damaged(models):
    installed(models, "whisper-turbo")
    (models.model_dir / "whisper-turbo" / "weights.safetensors").write_bytes(b"short")
    assert models.item("whisper-turbo")["integrity"] == "damaged"


def test_runtime_missing_its_metallib_is_damaged(models):
    set_up_runtime(models, metallib=False)
    installed(models, "whisper-turbo")
    runtime = models.integrity()["runtime"]
    assert runtime == {"state": "damaged", "problems": ["mlx.metallib"]}
    with pytest.raises(WorkError, match="runtime's files are damaged"):
        models.require("whisper-turbo", "asr")
    blocker = speech.classify(models)
    assert blocker["code"] == "asr_damaged" and [s["id"] for s in blocker["steps"]] == ["runtime"]


def test_runtime_missing_its_python_is_damaged(models):
    set_up_runtime(models)
    models.python.unlink()
    assert models.integrity()["runtime"] == {"state": "damaged", "problems": ["python"]}


def test_intact_runtime_and_model_pass_the_cheap_probe(models):
    set_up_runtime(models)
    installed(models, "whisper-turbo")
    assert models.integrity() == {
        "runtime": {"state": "ok", "problems": []},
        "whisper-turbo": {"state": "ok", "problems": []},
    }


def test_low_memory_on_an_intact_install_is_not_a_setup_blocker(models, monkeypatch):
    set_up_runtime(models)
    installed(models, "whisper-turbo")
    assert speech.classify(models, "Not enough currently available memory.") is None


def test_needs_speech_only_for_footage_with_sound_and_no_transcript():
    assert speech.needs_speech({"has_audio": True, "transcript": None})
    assert speech.needs_speech({"transcript": None})  # unknown audio counts as sound
    assert not speech.needs_speech({"has_audio": False, "transcript": None})
    assert not speech.needs_speech({"has_audio": True, "transcript": {"segments": []}})


def test_banded_jobs_map_step_progress_into_one_bar():
    jobs = Mock()
    banded = speech.BandedJobs(jobs, "job", 40, 98, step="whisper-turbo", step_index=2, step_count=2)
    banded.update("job", progress=50, message="half")
    jobs.update.assert_called_with("job", step="whisper-turbo", step_index=2, step_count=2, progress=69, message="half")
    banded.check("job")
    jobs.check.assert_called_with("job")


# ----------------------------------------------------------------- API: blockers and fail-fast


def only_speech_unavailable(client, monkeypatch):
    """A usable language model, but the real (missing) speech model."""
    real = client.app.state.models.require

    def require(identifier, kind):
        if kind == "asr":
            return real(identifier, kind)

    monkeypatch.setattr(client.app.state.models, "require", require)


def test_factory_reports_asr_missing_and_blocks_only_sources_with_sound(client, monkeypatch):
    client.patch("/api/settings", json={"autonomy": "review"})
    only_speech_unavailable(client, monkeypatch)
    talk = upload_mock(client, monkeypatch, has_audio=True)
    silent = upload_mock(client, monkeypatch, has_audio=False)
    line = client.get("/api/factory").json()
    assert not line["ready"]
    [blocker] = line["blockers"]
    assert blocker["code"] == "asr_missing" and blocker["message"] == speech.MISSING
    assert blocker["action"] == "speech_setup" and blocker["scope"] == "speech"
    assert line["engine"]["ready"] is False and {s["id"] for s in line["engine"]["steps"]} == {"runtime", "whisper-turbo"}
    sources = {s["video_id"]: s for s in line["sources"]}
    assert sources[talk["id"]]["can_produce"] is False and sources[talk["id"]]["blocked_code"] == "asr_missing"
    assert sources[silent["id"]]["can_produce"] is True
    assert sources[silent["id"]]["speech_label"] == speech.NO_SPEECH
    listen = next(s for s in sources[silent["id"]]["stages"] if s["key"] == "listen")
    assert listen["detail"] == speech.NO_SPEECH


def test_production_with_sound_fails_fast_without_queuing_any_job(client, monkeypatch):
    client.patch("/api/settings", json={"autonomy": "review"})
    only_speech_unavailable(client, monkeypatch)
    talk = upload_mock(client, monkeypatch, has_audio=True)
    for path in ("produce", "baseline", "team", "storyboard", "analyze"):
        response = client.post(f"/api/videos/{talk['id']}/{path}", json={})
        assert response.status_code == 409, path
        assert response.json()["detail"] == speech.MISSING
    assert client.get("/api/jobs").json() == []
    assert client.app.state.store.all("team_runs") == []


def test_production_without_an_audio_stream_may_run_speechless(client, monkeypatch):
    client.patch("/api/settings", json={"autonomy": "review"})
    only_speech_unavailable(client, monkeypatch)
    silent = upload_mock(client, monkeypatch, has_audio=False)
    monkeypatch.setattr(client.app.state.team, "execute", lambda run_id, job: {"ok": True})
    response = client.post(f"/api/videos/{silent['id']}/baseline", json={})
    assert response.status_code == 202
    assert "whisper-turbo" not in response.json()["context"]["required_model_ids"]


def test_damaged_speech_files_surface_a_repair_blocker(client, monkeypatch):
    only_speech_unavailable(client, monkeypatch)
    models = client.app.state.models
    installed(models, "whisper-turbo")
    (models.model_dir / "whisper-turbo" / "weights.safetensors").unlink()
    line = client.get("/api/factory").json()
    assert line["blockers"][0]["code"] == "asr_damaged"
    assert line["blockers"][0]["message"] == speech.DAMAGED
    system = client.get("/api/system").json()
    assert system["integrity"]["whisper-turbo"]["state"] == "damaged"
    assert system["engine"]["blocker"]["code"] == "asr_damaged"


def test_speech_setup_runs_runtime_then_whisper_in_one_job_with_one_progress_bar(client, monkeypatch):
    seen = []

    def setup(self, job):
        self.jobs.update(job, progress=50, message="Installing")
        seen.append(("runtime", client.app.state.store.get("jobs", job)["progress"]))
        return {"runtime": "ready"}

    def download(self, job, identifier):
        self.jobs.update(job, progress=50, message="Downloading")
        seen.append((identifier, client.app.state.store.get("jobs", job)["progress"]))
        return {"model_id": identifier, "installed": True}

    monkeypatch.setattr("clip_factory.models.Models.setup", setup)
    monkeypatch.setattr("clip_factory.models.Models.download", download)
    monkeypatch.setattr(
        "clip_factory.app.shutil.disk_usage", lambda _: SimpleNamespace(free=10**13, total=10**13, used=0)
    )
    assert client.post("/api/speech/setup", json={"accept_license": False}).status_code == 422
    job = client.post("/api/speech/setup", json={"accept_license": True}).json()
    assert job["kind"] == "speech_setup" and job["context"]["steps"] == ["runtime", "whisper-turbo"]
    done = wait_job(client, job["id"])
    assert done["status"] == "completed" and done["result"]["installed"] == ["runtime", "whisper-turbo"]
    # Runtime ~1.4 GB of 3.0 GB takes the first part of the bar, Whisper the rest.
    assert seen == [("runtime", 23), ("whisper-turbo", 72)]
    assert done["step"] == "whisper-turbo" and done["step_count"] == 2


def test_speech_setup_refuses_when_already_set_up(client, monkeypatch):
    models = client.app.state.models
    monkeypatch.setattr(models, "integrity", lambda: {"runtime": {"state": "ok"}, "whisper-turbo": {"state": "ok"}})
    monkeypatch.setattr(models, "ready", lambda **_: True)
    response = client.post("/api/speech/setup", json={"accept_license": True})
    assert response.status_code == 409 and "already set up" in response.json()["detail"]


# ----------------------------------------------------------------- storyboard and speechless clips


def test_storyboard_watched_without_speech_is_rebuilt_once_a_transcript_exists(tmp_path):
    store = Store(tmp_path)
    boards = Storyboards(tmp_path, store, Mock(), Mock(), lambda v: tmp_path / "v.mp4")
    video = {"id": "v1", "has_audio": True, "transcript": None, "transcript_updated_at": "t1"}
    board = {"id": "v1", "video_id": "v1", "version": VERSION, "transcript_stamp": "t1", "vision": True,
             "speech_available": False, "scenes": []}
    store.put("storyboards", board)
    assert boards.fresh(video) == board  # still no words: nothing better to rebuild from
    assert boards.fresh({**video, "transcript": {"segments": []}}) is None
    store.put("storyboards", {**board, "speech_available": True})
    assert boards.fresh({**video, "transcript": {"segments": []}})["speech_available"] is True


def test_clips_made_without_speech_rank_below_the_bar():
    good = {"id": "a", "start": 0, "end": 20, "hook": "Big claim here", "subtitles_burned": True,
            "team_review_status": "pass"}
    mute = {**good, "id": "b", "start": 40, "end": 60, "made_without_speech": True}
    records = ranking.rank([good, mute])
    assert records["b"]["below_bar"] and records["b"]["reason"] == "Made without speech"
    assert records["b"]["top_pick"] is False and records["a"]["position"] == 1
    assert ranking.speechless({"score": 80, "below_bar": False, "top_pick": True})["below_bar"] is True


def test_legacy_speechless_clips_are_flagged_and_moved_below_the_bar(client, monkeypatch):
    client.patch("/api/settings", json={"autonomy": "review"})
    talk = upload_mock(client, monkeypatch, has_audio=True)
    store = client.app.state.store
    store.put("team_runs", {"id": "run1", "video_id": talk["id"], "status": "needs_review", "mode": "swarm",
                            "tasks": [{"role": "transcribe", "status": "skipped", "error": "not installed"}]})
    store.put("clips", {"id": "c1", "video_id": talk["id"], "team_run_id": "run1", "path": "clips/c1.mp4",
                        "approved": False, "rank": {"score": 52, "below_bar": False, "top_pick": True, "position": 1}})
    clip = next(c for c in client.get("/api/clips").json() if c["id"] == "c1")
    assert clip["made_without_speech"] is True
    assert clip["rank"]["below_bar"] is True and clip["rank"]["reason"] == "Made without speech"
    source = next(s for s in client.get("/api/factory").json()["sources"] if s["video_id"] == talk["id"])
    assert source["made_without_speech"] == 1 and source["below_bar"] == 1 and source["unreviewed"] == 0
