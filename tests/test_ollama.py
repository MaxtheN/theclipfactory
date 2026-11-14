"""Ollama connector: loopback only, no cloud models, truthful availability, cancellable."""

import json
from unittest.mock import Mock

import httpx
import pytest
from pydantic import TypeAdapter, ValidationError

from clip_factory.jobs import JobCancelled, WorkError
from clip_factory.models import Models
from clip_factory.ollama import LlmId, Ollama, OllamaError, base_url, is_remote

TAGS = {
    "models": [
        {
            "name": "qwen3.6:35b-a3b",
            "size": 22_600_000_000,
            "digest": "a",
            "details": {"parameter_size": "35B", "quantization_level": "Q4_K_M"},
        },
        {"name": "llama3.2:3b", "size": 2_000_000_000, "digest": "b", "details": {}},
        {"name": "nomic-embed-text:latest", "size": 270_000_000, "digest": "c"},
        {"name": "gpt-oss:120b-cloud", "size": 384, "digest": "d", "remote_host": "https://ollama.com:443"},
        {"name": "../evil", "size": 1, "digest": "e"},
    ]
}
CAPS = {
    "qwen3.6:35b-a3b": ["completion", "vision", "thinking"],
    "llama3.2:3b": ["completion"],
    "nomic-embed-text:latest": ["embedding"],
}


def fake(chat=None, seen=None):
    def handler(request: httpx.Request):
        assert request.url.host == "ollama.test"
        if request.url.path == "/api/tags":
            return httpx.Response(200, json=TAGS)
        if request.url.path == "/api/show":
            name = json.loads(request.content)["model"]
            assert name in CAPS, f"show must not be called for {name}"
            return httpx.Response(200, json={"capabilities": CAPS[name]})
        if request.url.path == "/api/chat":
            body = json.loads(request.content)
            if seen is not None:
                seen.append(body)
            lines = chat or [{"message": {"content": "hel"}}, {"message": {"content": "lo"}, "done": True}]
            return httpx.Response(200, content="\n".join(json.dumps(x) for x in lines).encode())
        return httpx.Response(404)

    return Ollama("http://ollama.test", transport=httpx.MockTransport(handler))


def refused(request):
    raise httpx.ConnectError("refused", request=request)


@pytest.fixture
def models(tmp_path):
    jobs = Mock()
    jobs.process.side_effect = AssertionError("Ollama models must not spawn the MLX worker")
    return Models(tmp_path, jobs)


def test_lists_local_completion_models_only():
    status = fake().status()
    assert status["running"] is True
    names = {m["name"]: m for m in status["models"]}
    assert set(names) == {"qwen3.6:35b-a3b", "llama3.2:3b"}
    assert names["qwen3.6:35b-a3b"]["vision"] is True
    assert names["llama3.2:3b"]["vision"] is False


def test_cloud_detection():
    assert is_remote({"name": "gpt-oss:120b-cloud"})
    assert is_remote({"name": "deepseek-v3.1:671b", "remote_host": "https://ollama.com"})
    assert is_remote({"name": "kimi:cloud"})
    assert not is_remote({"name": "qwen3.6:35b-a3b"})
    assert not is_remote({"name": "cloudy-llama:7b"})


@pytest.mark.parametrize(
    "value, expected",
    [
        ("", "http://127.0.0.1:11434"),
        ("127.0.0.1:11500", "http://127.0.0.1:11500"),
        ("http://localhost:11434", "http://localhost:11434"),
        ("0.0.0.0:11434", "http://127.0.0.1:11434"),
        ("https://evil.example.com", "http://127.0.0.1:11434"),
        ("http://10.0.0.5:11434", "http://127.0.0.1:11434"),
    ],
)
def test_host_is_loopback_only(monkeypatch, value, expected):
    monkeypatch.setenv("OLLAMA_HOST", value)
    assert base_url() == expected


def test_not_running_is_reported_not_invented(models):
    models.ollama = Ollama("http://ollama.test", transport=httpx.MockTransport(refused))
    assert models.ollama.status() == {"running": False, "models": []}
    assert all(not m["id"].startswith("ollama:") for m in models.catalog())
    with pytest.raises(WorkError, match="Ollama is not running"):
        models.require("ollama:qwen3.6:35b-a3b", "llm")


def test_catalog_and_require_skip_mlx_runtime(models):
    models.ollama = fake()
    catalog = {m["id"]: m for m in models.catalog()}
    item = catalog["ollama:qwen3.6:35b-a3b"]
    assert item["installed"] is True and item["kind"] == "llm" and item["source"] == "ollama"
    assert item["estimated_gb"] == 22.6
    assert catalog["qwen-small"]["installed"] is False
    models.require("ollama:qwen3.6:35b-a3b", "llm")  # no MLX runtime, no exception
    with pytest.raises(WorkError, match="appropriate"):
        models.require("ollama:qwen3.6:35b-a3b", "asr")
    with pytest.raises(WorkError, match="not available"):
        models.require("ollama:mistral:7b", "llm")


def test_run_streams_and_unloads(models, tmp_path):
    seen = []
    models.ollama = fake(seen=seen)
    frame = tmp_path / "f.jpg"
    frame.write_bytes(b"\xff\xd8jpeg")
    result = models.run("job", "ollama:qwen3.6:35b-a3b", "generate", prompt="pick", images=[str(frame)])
    assert result == {"output": "hello"}
    body = seen[0]
    assert body["keep_alive"] == 0 and body["think"] is False and body["stream"] is True
    assert body["options"]["num_predict"] == 1500
    assert len(body["messages"][0]["images"]) == 1
    models.jobs.process.assert_not_called()


def test_text_only_model_refuses_frames(models, tmp_path):
    models.ollama = fake()
    frame = tmp_path / "f.jpg"
    frame.write_bytes(b"x")
    with pytest.raises(WorkError, match="cannot read images"):
        models.run("job", "ollama:llama3.2:3b", "generate", prompt="p", images=[str(frame)])
    assert models.run("job", "ollama:llama3.2:3b", "generate", prompt="p") == {"output": "hello"}


def test_ollama_error_event_is_not_returned_as_output(models):
    models.ollama = fake(chat=[{"error": "model failed to load"}])
    with pytest.raises(WorkError, match="model failed to load"):
        models.run("job", "ollama:llama3.2:3b", "generate", prompt="p")


def test_cancellation_propagates(models):
    models.ollama = fake()
    models.jobs.check.side_effect = JobCancelled()
    with pytest.raises(JobCancelled):
        models.run("job", "ollama:llama3.2:3b", "generate", prompt="p")


def test_generate_rejects_unknown_model():
    with pytest.raises(OllamaError):
        fake().generate("missing:1b", "p")


@pytest.mark.parametrize(
    "value", ["qwen-small", "qwen-large", "ollama:qwen3.6:35b-a3b", "ollama:hf.co/u/m:Q4"]
)
def test_llm_id_accepts(value):
    assert TypeAdapter(LlmId).validate_python(value) == value


@pytest.mark.parametrize("value", ["whisper-turbo", "ollama:", "ollama:-x", "ollama:a b", "gpt-4"])
def test_llm_id_rejects(value):
    with pytest.raises(ValidationError):
        TypeAdapter(LlmId).validate_python(value)


def test_raw_reply_is_kept_in_the_job_log(models):
    models.ollama = fake()
    models.run("job-1", "ollama:llama3.2:3b", "generate", prompt="p")
    models.ollama = fake(chat=[{"error": "boom"}])
    with pytest.raises(WorkError):
        models.run("job-1", "ollama:llama3.2:3b", "generate", prompt="p")
    log = (models.logs / "job-1.log").read_text()
    assert "hello" in log and "ERROR: Ollama error: boom" in log
    assert (models.logs / "job-1.log").stat().st_mode & 0o777 == 0o600


def test_keep_warm_calls_keep_the_model_loaded_and_skip_generic_progress(models):
    seen = []
    models.ollama = fake(seen=seen)
    models.run("job", "ollama:llama3.2:3b", "generate", keep_warm=True, prompt="p")
    models.run("job", "ollama:llama3.2:3b", "generate", prompt="p")
    assert [body["keep_alive"] for body in seen] == ["10m", 0]
    assert models.jobs.update.call_count == 1
