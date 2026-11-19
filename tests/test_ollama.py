"""Ollama connector: loopback only, no cloud models, truthful availability, cancellable."""

import json
import sys
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


def test_schema_becomes_the_format_and_frame_labels_reach_the_prompt(models, tmp_path):
    seen = []
    models.ollama = fake(seen=seen)
    frames = [tmp_path / "a.jpg", tmp_path / "b.jpg"]
    for frame in frames:
        frame.write_bytes(b"\xff\xd8jpeg")
    schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}}
    models.run(
        "job", "ollama:qwen3.6:35b-a3b", "generate", prompt="Describe.", images=[str(f) for f in frames],
        image_labels=["Frame at 1.0s", "Frame at 2.5s"], schema=schema, temperature=0.2,
    )
    body = seen[0]
    assert body["format"] == schema and body["options"]["temperature"] == 0.2 and body["keep_alive"] == 0
    assert body["messages"][0]["content"] == (
        "The attached images are in order: image 1 is the Frame at 1.0s; image 2 is the Frame at 2.5s.\nDescribe."
    )
    assert len(body["messages"][0]["images"]) == 2


def test_a_server_that_rejects_the_schema_is_retried_without_it():
    bodies = []

    def handler(request: httpx.Request):
        if request.url.path == "/api/tags":
            return httpx.Response(200, json=TAGS)
        if request.url.path == "/api/show":
            return httpx.Response(200, json={"capabilities": CAPS[json.loads(request.content)["model"]]})
        body = json.loads(request.content)
        bodies.append(body)
        if "format" in body:
            return httpx.Response(400, json={"error": "invalid format"})
        return httpx.Response(200, content=json.dumps({"message": {"content": "{}"}, "done": True}).encode())

    ollama = Ollama("http://ollama.test", transport=httpx.MockTransport(handler))
    assert ollama.generate("llama3.2:3b", "p", schema={"type": "object"}) == "{}"
    assert ["format" in body for body in bodies] == [True, False]
    with pytest.raises(OllamaError, match="refused"):
        fake_refusing().generate("llama3.2:3b", "p")


def fake_refusing():
    def handler(request: httpx.Request):
        if request.url.path == "/api/tags":
            return httpx.Response(200, json=TAGS)
        if request.url.path == "/api/show":
            return httpx.Response(200, json={"capabilities": CAPS[json.loads(request.content)["model"]]})
        return httpx.Response(500)

    return Ollama("http://ollama.test", transport=httpx.MockTransport(handler))


def test_a_batch_keeps_the_model_loaded_until_its_last_request(models):
    seen = []
    models.ollama = fake(seen=seen)
    results = models.run_batch("job", "ollama:llama3.2:3b", [{"prompt": "one"}, {"prompt": "two"}, {"prompt": "three"}])
    assert results == [{"output": "hello"}] * 3
    assert [body["keep_alive"] for body in seen] == ["5m", "5m", 0]
    assert models.run_batch("job", "ollama:llama3.2:3b", []) == []
    with pytest.raises(WorkError, match="invalid"):
        models.run_batch("job", "ollama:llama3.2:3b", [{"prompt": ""}])
    models.jobs.process.assert_not_called()


def test_vision_is_known_per_model(models):
    models.ollama = fake()
    assert models.vision("ollama:qwen3.6:35b-a3b") is True
    assert models.vision("ollama:llama3.2:3b") is False
    assert models.vision("ollama:missing:1b") is False and models.vision("ollama:../evil") is False
    assert models.vision("qwen-small") is True and models.vision("qwen-large") is True
    assert models.vision("whisper-turbo") is False and models.vision("unknown") is False


def test_raw_reply_is_kept_in_the_job_log(models):
    models.ollama = fake()
    models.run("job-1", "ollama:llama3.2:3b", "generate", prompt="p")
    models.ollama = fake(chat=[{"error": "boom"}])
    with pytest.raises(WorkError):
        models.run("job-1", "ollama:llama3.2:3b", "generate", prompt="p")
    log = (models.logs / "job-1.log").read_text()
    assert "hello" in log and "ERROR: Ollama error: boom" in log
    assert sys.platform == "win32" or (models.logs / "job-1.log").stat().st_mode & 0o777 == 0o600


def test_keep_warm_calls_keep_the_model_loaded_between_scout_prompts(models):
    seen = []
    models.ollama = fake(seen=seen)
    models.run("job", "ollama:llama3.2:3b", "generate", keep_warm=True, prompt="p")
    models.run("job", "ollama:llama3.2:3b", "generate", prompt="p")
    assert [body["keep_alive"] for body in seen] == ["10m", 0]
    # Progress wording belongs to the caller (a role, a scout, a scene), not to the model runner.
    assert models.jobs.update.call_count == 0


def test_unload_releases_weights_without_prompt_or_inference():
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={"done": True})
    model = Ollama(transport=httpx.MockTransport(handler))
    model.unload("qwen3-vl:4b-instruct")
    assert len(calls) == 1
    assert calls[0].url.path == "/api/generate"
    assert json.loads(calls[0].content) == {"model": "qwen3-vl:4b-instruct", "keep_alive": 0}


def test_unload_failure_has_safe_error_without_provider_body():
    def handler(request):
        return httpx.Response(500, text="private provider detail")
    model = Ollama(transport=httpx.MockTransport(handler))
    with pytest.raises(OllamaError, match="Could not release") as error:
        model.unload("qwen3-vl:4b-instruct")
    assert "private provider detail" not in str(error.value)


@pytest.mark.parametrize("context_tokens", [2048, 8192, 16384])
def test_explicit_context_cap_reaches_actual_ollama_chat_json(models, context_tokens):
    seen = []
    models.ollama = fake(seen=seen)
    result = models.run("context-job", "ollama:llama3.2:3b", "generate",
        prompt="A bounded learning prompt", max_tokens=1500, context_tokens=context_tokens)
    assert result == {"output": "hello"}
    assert len(seen) == 1
    assert seen[0]["options"] == {"temperature": 0.3, "num_predict": 1500, "num_ctx": context_tokens}
    assert "context_tokens" not in seen[0]
    assert seen[0]["messages"] == [{"role": "user", "content": "A bounded learning prompt"}]
    models.jobs.process.assert_not_called()


def test_default_context_does_not_override_existing_vision_behavior(models, tmp_path):
    seen = []
    models.ollama = fake(seen=seen)
    image = tmp_path / "frame.jpg"
    image.write_bytes(b"local-test-frame")
    models.run("vision-job", "ollama:qwen3.6:35b-a3b", "generate", prompt="Inspect this frame", images=[str(image)])
    assert "num_ctx" not in seen[0]["options"]
    assert len(seen[0]["messages"][0]["images"]) == 1
    assert seen[0]["keep_alive"] == 0


@pytest.mark.parametrize("context_tokens", [True, False, 0, -1, 2047, 16385, 8192.0, "8192", float("nan")])
def test_invalid_context_is_rejected_before_runtime_or_inference(models, context_tokens):
    models.require = Mock()
    models.ollama = Mock()
    with pytest.raises(WorkError, match="context size"):
        models.run("invalid-context", "ollama:llama3.2:3b", "generate", prompt="p", context_tokens=context_tokens)
    models.require.assert_not_called()
    models.ollama.generate.assert_not_called()
    models.jobs.process.assert_not_called()


@pytest.mark.parametrize("context_tokens", [True, 2047, 16385, "8192", 8192.0])
def test_connector_rejects_invalid_context_without_sending_chat(context_tokens):
    seen = []
    with pytest.raises(OllamaError, match="context size"):
        fake(seen=seen).generate("llama3.2:3b", "p", context_tokens=context_tokens)
    assert seen == []


def test_non_ollama_worker_never_silently_ignores_an_explicit_context_cap(models):
    models.require = Mock()
    with pytest.raises(WorkError, match="context"):
        models.run("unsupported-context", "qwen-small", "generate", prompt="p", context_tokens=8192)
    models.jobs.process.assert_not_called()


def test_context_cap_is_not_a_transcription_or_narration_argument(models):
    models.require = Mock()
    with pytest.raises(WorkError, match="context"):
        models.run("unsupported-action", "whisper-turbo", "transcribe", audio="missing", context_tokens=8192)
    models.jobs.process.assert_not_called()


def test_default_mlx_worker_request_has_no_ollama_context_fields(models):
    models.require = Mock()
    seen = []

    def fake_process(_job_id, command, **_kwargs):
        from pathlib import Path
        request = json.loads(Path(command[-2]).read_text())
        seen.append(request)
        Path(command[-1]).write_text(json.dumps({"output": "offline fixture"}))

    models.jobs.process.side_effect = fake_process
    assert models.run("mlx-default", "qwen-small", "generate", prompt="p", max_tokens=64) == {"output": "offline fixture"}
    assert set(seen[0]) == {"action", "model", "prompt", "max_tokens"}
    assert "context_tokens" not in seen[0] and "num_ctx" not in seen[0]


def learning_runtime(tmp_path):
    """Synchronous fake jobs exercise the adapter without a lifespan, model or IO."""
    from types import SimpleNamespace

    from clip_factory.autonomy_runtime import AutonomyRuntime
    from clip_factory.store import Store

    store = Store(tmp_path / "runtime-context")
    jobs = Mock()
    jobs.busy.return_value = False
    infer = Mock(return_value={"output": json.dumps({"status": "insufficient_evidence", "rationale": "Measured observations are limited.", "limitations": "No causal comparison."})})
    runtime = AutonomyRuntime.__new__(AutonomyRuntime)
    runtime.resource_check = Mock()  # Resource admission has separate hermetic integration tests.
    runtime.store = store
    runtime.stop = Mock()
    runtime.stop.wait.return_value = False
    runtime.app = SimpleNamespace(state=SimpleNamespace(jobs=jobs, models=SimpleNamespace(run=infer)))

    def submit(kind, execute, **context):
        store.put("jobs", {"id": "analysis-job", "kind": kind, "status": "queued", "context": context})
        try:
            result = execute("analysis-job")
        except JobCancelled:
            return store.patch("jobs", "analysis-job", status="cancelled", error="Cancelled by fixture", result=None)
        except WorkError as exc:
            return store.patch("jobs", "analysis-job", status="failed", error=str(exc), result=None)
        return store.patch("jobs", "analysis-job", status="completed", result=result)

    jobs.submit.side_effect = submit
    jobs.update.side_effect = lambda job_id, **changes: store.patch("jobs", job_id, **changes)
    context = {"snapshot": {"id": "snapshot", "metrics": {"views": 12}},
        "policy": {"campaign_id": "campaign", "profile_id": "profile", "account_id": "account"},
        "profile": {"id": "profile", "objective": "traffic"}, "publication": {"id": "publication"},
        "clip": {"id": "clip", "start": 10, "end": 30, "hook": "A source-grounded opening"},
        "source": {"id": "source", "duration": 5000, "transcript": {"segments": []}},
        "strategy": {"directions": {"profile": {"framing": "fit"}}}}
    return runtime, context, infer, jobs


def test_learning_context_projects_only_timed_text_and_sets_explicit_8k_limit(tmp_path):
    runtime, context, infer, jobs = learning_runtime(tmp_path)
    context["source"]["transcript"]["segments"] = [
        {"start": 0, "end": 1, "text": "outside range" * 6000},
        {"start": 10, "end": 30, "text": "Actual complete thought.", "words": [{"word": "large word payload" * 6000}], "tokens": list(range(1000)), "probability": .9},
    ]
    assert runtime.analyze(context)["status"] == "insufficient_evidence"
    kwargs = infer.call_args.kwargs
    assert kwargs["context_tokens"] == 8192 and kwargs["max_tokens"] == 1500
    assert len(kwargs["prompt"].encode("utf-8")) + 1500 <= 8192
    payload = json.loads(kwargs["prompt"].split("Evidence:\n", 1)[1])
    assert payload["source"]["timed_cues"] == [{"start": 10, "end": 30, "text": "Actual complete thought."}]
    assert payload["snapshot"]["id"] == context["snapshot"]["id"]
    assert payload["snapshot"]["metrics"] == context["snapshot"]["metrics"]
    assert jobs.submit.call_args.kwargs["account_id"] == "account"
    assert jobs.submit.call_count == infer.call_count == 1


@pytest.mark.parametrize("text", ["x" * 8000, "漢" * 2000])
def test_learning_rejects_ascii_or_utf8_oversize_before_any_job_or_model_call(tmp_path, text):
    runtime, context, infer, jobs = learning_runtime(tmp_path)
    context["source"]["transcript"]["segments"] = [{"start": 10, "end": 30, "text": text}]
    with pytest.raises(WorkError, match="context budget"):
        runtime.analyze(context)
    jobs.submit.assert_not_called()
    infer.assert_not_called()


def learning_reply(**changes):
    return {"status": "experiment", "variable": "hook", "proposed_hook": "A new source-grounded opening",
        "proposed_duration_seconds": None, "evidence_ids": ["snapshot"],
        "rationale": "Test a clearer opening against the measured count.",
        "limitations": "One post does not establish causal lift.", **changes}


@pytest.mark.parametrize("bad", [
    {"proposed_duration_seconds": 15},
    {"evidence_ids": ["different-account-snapshot"]},
])
def test_learning_repairs_one_invalid_handoff_then_returns_the_genuine_changed_hook(tmp_path, bad):
    runtime, context, infer, jobs = learning_runtime(tmp_path)
    invalid = learning_reply(**bad)
    valid = learning_reply()
    infer.side_effect = [{"output": json.dumps(invalid)}, {"output": json.dumps(valid)}]
    assert runtime.analyze(context) == valid
    assert infer.call_count == 2 and jobs.submit.call_count == 1
    job = runtime.store.get("jobs", "analysis-job")
    assert job["status"] == "completed" and job["agent_attempts"] == 2
    assert len(job["validation_failures"]) == 1
    first, second = [call.kwargs["prompt"] for call in infer.call_args_list]
    assert second.startswith(first)
    assert "One correction is allowed" in second
    assert json.dumps(invalid) not in second  # No untrusted previous answer is promoted to instructions.
    assert all(call.kwargs["context_tokens"] == 8192 for call in infer.call_args_list)
    assert all(len(call.kwargs["prompt"].encode("utf-8")) + 1500 + 256 <= 8192 for call in infer.call_args_list)


def test_learning_noop_can_repair_to_an_actual_insufficient_evidence_decision(tmp_path):
    runtime, context, infer, _jobs = learning_runtime(tmp_path)
    insufficient = {"status": "insufficient_evidence", "variable": None, "proposed_hook": None,
        "proposed_duration_seconds": None, "evidence_ids": [],
        "rationale": "A meaningful source-faithful alternative is unsupported.", "limitations": "No comparative evidence."}
    infer.side_effect = [{"output": json.dumps(learning_reply(proposed_hook=f"  {context['clip']['hook']}  "))},
        {"output": json.dumps(insufficient)}]
    assert runtime.analyze(context) == insufficient
    job = runtime.store.get("jobs", "analysis-job")
    assert infer.call_count == 2 and job["agent_attempts"] == 2
    assert "repeats" in job["validation_failures"][0]
    assert job["result"]["rationale"] == insufficient["rationale"]


def test_learning_invalid_twice_fails_the_analysis_job_without_inventing_insufficiency(tmp_path):
    runtime, context, infer, jobs = learning_runtime(tmp_path)
    infer.side_effect = [{"output": json.dumps(learning_reply(proposed_duration_seconds=15))},
        {"output": json.dumps(learning_reply(proposed_hook=context["clip"]["hook"]))}]
    with pytest.raises(WorkError, match="did not complete"):
        runtime.analyze(context)
    job = runtime.store.get("jobs", "analysis-job")
    assert infer.call_count == 2 and jobs.submit.call_count == 1
    assert job["status"] == "failed" and job["agent_attempts"] == 2
    assert len(job["validation_failures"]) == 2 and job["result"] is None
    assert "after one correction" in job["error"]


def test_learning_cancellation_before_repair_prevents_a_second_model_call(tmp_path):
    runtime, context, infer, jobs = learning_runtime(tmp_path)
    infer.return_value = {"output": json.dumps(learning_reply(proposed_duration_seconds=15))}
    jobs.check.side_effect = [None, JobCancelled()]
    with pytest.raises(WorkError, match="did not complete"):
        runtime.analyze(context)
    job = runtime.store.get("jobs", "analysis-job")
    assert infer.call_count == 1 and jobs.check.call_count == 2
    assert job["status"] == "cancelled" and job["agent_attempts"] == 1
    assert job["result"] is None


@pytest.mark.parametrize("unit", ["x", "漢"])
def test_learning_repair_must_fit_budget_before_second_inference(tmp_path, unit):
    runtime, context, infer, jobs = learning_runtime(tmp_path)
    # Required timed evidence is preserved whole; profile audience is intentionally
    # bounded by brief_block and cannot be used to fill the inference context.
    cue = {"start": 10, "end": 30, "text": ""}
    context["source"]["transcript"]["segments"] = [cue]
    # Calibrate with the actual schema/prompt so unrelated prompt copy can evolve.
    runtime.analyze(context)
    base_bytes = len(infer.call_args.kwargs["prompt"].encode("utf-8"))
    content_limit = 8192 - 1500 - 256
    padding_bytes = content_limit - 10 - base_bytes
    assert padding_bytes > 0
    repeats, remainder = divmod(padding_bytes, len(unit.encode("utf-8")))
    cue["text"] = unit * repeats + "x" * remainder
    infer.reset_mock()
    jobs.submit.reset_mock()
    infer.side_effect = [{"output": json.dumps(learning_reply(proposed_duration_seconds=15))}]
    with pytest.raises(WorkError, match="did not complete"):
        runtime.analyze(context)
    job = runtime.store.get("jobs", "analysis-job")
    assert infer.call_count == 1 and jobs.submit.call_count == 1
    assert job["status"] == "failed" and job["agent_attempts"] == 1
    assert "repair exceeds" in job["error"]
    assert len(infer.call_args.kwargs["prompt"].encode("utf-8")) == content_limit - 10
