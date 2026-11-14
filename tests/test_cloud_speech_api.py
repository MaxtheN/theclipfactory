"""Cloud speech is an explicit independent route, without a local ASR fallback."""

import threading

import pytest
from test_app import client as authenticated_client_fixture
from test_app import upload_mock, wait_job

from clip_factory.jobs import WorkError

client = authenticated_client_fixture


def prepare(client, monkeypatch, *, configured=True):
    monkeypatch.setattr("clip_factory.cloud_speech.groq_configured", lambda: configured)
    client.app.state.llm.update_settings({"speech_provider": "groq"})
    client.patch("/api/settings", json={"autonomy": "review"})
    source = upload_mock(client, monkeypatch, has_audio=True)

    def require(identifier, kind):
        if kind == "asr":
            pytest.fail("Cloud speech must not invoke local ASR memory/runtime admission")

    monkeypatch.setattr(client.app.state.models, "require", require)
    monkeypatch.setattr(client.app.state.models, "run", lambda *a, **kw: pytest.fail("No local fallback"))
    monkeypatch.setattr("clip_factory.media.extract_audio", lambda jobs, job, source, audio: audio.write_bytes(b"audio"))
    return source


def test_cloud_transcription_keeps_timed_words_and_records_provider(client, monkeypatch):
    source = prepare(client, monkeypatch)
    words = [{"word": word, "start": n * .5, "end": (n + 1) * .5}
             for n, word in enumerate(["A", "grounded", "complete", "source", "sentence", "with", "useful", "context"])]
    monkeypatch.setattr("clip_factory.cloud_speech.transcribe", lambda *a, **kw: {
        "text": "A grounded complete source sentence with useful context", "language": "en",
        "segments": [{"start": 0, "end": 4, "text": "A grounded complete source sentence with useful context", "words": words}],
        "cloud_receipt": {"status": "ok", "model": "whisper-large-v3-turbo", "audio_seconds": 5, "actual_cost_usd": None},
    })
    engine = client.get("/api/factory").json()["engine"]
    assert engine["ready"] and engine["speech_provider"] == "groq"
    response = client.post(f"/api/videos/{source['id']}/transcribe")
    assert response.status_code == 202
    assert wait_job(client, response.json()["id"])["status"] == "completed"
    saved = client.app.state.store.get("videos", source["id"])
    assert saved["transcript_provider"] == "groq"
    assert saved["transcript_model"] == "groq/whisper-large-v3-turbo"
    assert saved["transcript"]["segments"][0]["words"] == words
    [receipt] = client.app.state.store.all("speech_calls")
    assert receipt["status"] == "ok" and receipt["actual_cost_usd"] is None
    assert saved["transcript_call_id"] == receipt["id"]
    assert not list((client.app.state.root / "work").rglob("speech.wav"))


def test_cloud_missing_key_does_not_offer_local_model_repair_or_queue(client, monkeypatch):
    source = prepare(client, monkeypatch, configured=False)
    engine = client.get("/api/factory").json()["engine"]
    assert engine["blocker"]["code"] == "cloud_speech_unavailable"
    assert engine["steps"] == []
    assert client.post(f"/api/videos/{source['id']}/transcribe").status_code == 409
    assert not client.app.state.store.all("jobs")


def test_cloud_workflow_readiness_never_requires_a_local_model(client, monkeypatch):
    prepare(client, monkeypatch)
    client.app.state.llm.update_settings({"provider": "cloud", "cloud_agents": True, "fallback_to_local": False})
    monkeypatch.setattr(client.app.state.llm, "key_status", lambda **kw: {"present": True, "error": None})
    monkeypatch.setattr(client.app.state.models, "require", lambda *a: pytest.fail("A cloud workflow must not require local inference"))
    factory = client.get("/api/factory").json()
    assert factory["ready"] is True and factory["blockers"] == []
    assert factory["engine"]["speech_provider"] == "groq"


def test_cloud_failure_never_runs_local_or_saves_fake_transcript(client, monkeypatch):
    source = prepare(client, monkeypatch)

    def failed(*a, **kw):
        raise WorkError("Groq speech was rate limited. Retry later.")

    monkeypatch.setattr("clip_factory.cloud_speech.transcribe", failed)
    response = client.post(f"/api/videos/{source['id']}/transcribe")
    assert wait_job(client, response.json()["id"])["status"] == "failed"
    assert client.app.state.store.get("videos", source["id"])["transcript"] is None
    assert client.app.state.store.all("speech_calls")[0]["status"] == "failed"


@pytest.mark.parametrize("queued_provider", ["local", "groq"])
def test_queued_route_cannot_silently_change_or_override_cloud_opt_out(client, monkeypatch, queued_provider):
    source = prepare(client, monkeypatch)
    client.app.state.llm.update_settings({"speech_provider": queued_provider})
    monkeypatch.setattr(client.app.state.models, "require", lambda *a: None)
    local_calls = []

    def local(*args, **kwargs):
        local_calls.append(args)
        return {"text": "", "segments": []}

    monkeypatch.setattr(client.app.state.models, "run", local)
    monkeypatch.setattr("clip_factory.cloud_speech.transcribe", lambda *a, **kw: pytest.fail("A setting change cannot authorize a queued upload"))
    release = threading.Event()
    client.app.state.jobs.submit("test_barrier", lambda job: release.wait(5))
    try:
        response = client.post(f"/api/videos/{source['id']}/transcribe")
        assert response.status_code == 202
        assert response.json()["context"]["speech_provider"] == queued_provider
        client.app.state.llm.update_settings({"speech_provider": "local" if queued_provider == "groq" else "groq"})
    finally:
        release.set()
    done = wait_job(client, response.json()["id"])
    assert done["status"] == ("completed" if queued_provider == "local" else "failed")
    assert bool(local_calls) == (queued_provider == "local")
    assert not client.app.state.store.all("speech_calls")
