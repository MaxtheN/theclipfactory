"""Isolated runtime contracts with fake model packages; no network or weight downloads."""

import json
import os
import subprocess
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock

import pytest

from clip_factory import inference_worker as worker


def module(monkeypatch, name, **attributes):
    fake = ModuleType(name)
    fake.__dict__.update(attributes)
    monkeypatch.setitem(sys.modules, name, fake)
    return fake


@pytest.fixture
def model(tmp_path):
    path = tmp_path / "model"
    path.mkdir()
    return str(path)


def fake_vlm(monkeypatch, output):
    load = Mock(return_value=("model", "processor"))
    generate = Mock(return_value=output)
    template = Mock(return_value="formatted")
    module(monkeypatch, "mlx_vlm", load=load, generate=generate)
    module(monkeypatch, "mlx_vlm.prompt_utils", apply_chat_template=template)
    module(monkeypatch, "mlx_vlm.utils", load_config=Mock(return_value={}))
    return load, generate, template


def test_generation_result_uses_text_not_object_repr(model, monkeypatch):
    class GenerationResult:
        text = "actual model output"

        def __str__(self):
            raise AssertionError("Must not stringify GenerationResult")

    load, generate, template = fake_vlm(monkeypatch, GenerationResult())
    assert worker.infer({"model": model, "action": "generate", "prompt": "intent"}) == {
        "output": "actual model output"
    }
    load.assert_called_once_with(model, trust_remote_code=False)
    template.assert_called_once_with("processor", {}, "intent", num_images=0, enable_thinking=False)
    generate.assert_called_once_with(
        "model", "processor", "formatted", image=None, max_tokens=1500, temperature=0.3, verbose=False
    )


@pytest.mark.parametrize("output", [object(), SimpleNamespace(text=123), "x" * 1_000_001])
def test_generation_rejects_opaque_or_unbounded_output(model, monkeypatch, output):
    fake_vlm(monkeypatch, output)
    with pytest.raises(ValueError, match="generated text"):
        worker.infer({"model": model, "action": "generate", "prompt": "intent"})


@pytest.mark.parametrize(
    "changes",
    [
        {"prompt": ""},
        {"prompt": "x" * 64_001},
        {"max_tokens": True},
        {"max_tokens": 0},
        {"max_tokens": 4097},
        {"images": ["https://external.example/image.jpg"]},
        {"images": ["image"] * 17},
    ],
)
def test_generation_bounds_without_model_load(model, monkeypatch, changes):
    load, _, _ = fake_vlm(monkeypatch, "output")
    with pytest.raises(ValueError):
        worker.infer({"model": model, "action": "generate", "prompt": "intent", **changes})
    load.assert_not_called()


def test_whisper_normalizes_numpy_segments_and_words(model, monkeypatch, tmp_path):
    np = pytest.importorskip("numpy")
    audio = tmp_path / "input.wav"
    audio.touch()
    transcribe = Mock(
        return_value={
            "text": "hello",
            "language": "en",
            "unused": object(),
            "segments": [
                {
                    "start": np.float32(0.5),
                    "end": np.float64(1),
                    "text": "hello",
                    "words": [
                        {
                            "word": "hello",
                            "start": np.float32(0.5),
                            "end": np.float64(1),
                            "probability": np.float32(0.75),
                            "id": np.int64(2),
                        }
                    ],
                }
            ],
        }
    )
    module(monkeypatch, "mlx_whisper", transcribe=transcribe)
    result = worker.json_value(worker.infer({"model": model, "action": "transcribe", "audio": str(audio)}))
    assert json.loads(json.dumps(result, allow_nan=False)) == {
        "text": "hello",
        "language": "en",
        "segments": [
            {
                "start": 0.5,
                "end": 1.0,
                "text": "hello",
                "words": [{"word": "hello", "start": 0.5, "end": 1.0, "probability": 0.75, "id": 2}],
            }
        ],
    }
    transcribe.assert_called_once_with(
        str(audio), path_or_hf_repo=model, word_timestamps=True, language=None, verbose=False
    )


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_serialization_rejects_nonfinite_segment_or_word(value):
    with pytest.raises(ValueError, match="Non-finite"):
        worker.json_value({"segments": [{"words": [{"start": value}]}]})


@pytest.fixture
def kokoro(monkeypatch):
    np = pytest.importorskip("numpy")
    import importlib.util

    monkeypatch.setattr(importlib.util, "find_spec", lambda name: object())
    evaluated = object()
    instance = SimpleNamespace(eval=Mock(return_value=evaluated))
    kmodel = Mock(return_value=instance)
    pipeline = Mock(return_value=iter([("text", "phones", np.array([0.2, -0.2], dtype=np.float32))]))
    kpipeline = Mock(return_value=pipeline)
    load_voice = Mock(return_value="local-voice")
    write = Mock()
    module(monkeypatch, "kokoro", KModel=kmodel, KPipeline=kpipeline)
    module(monkeypatch, "torch", load=load_voice)
    module(monkeypatch, "soundfile", write=write)
    return kmodel, instance, evaluated, kpipeline, pipeline, load_voice, write


def test_kokoro_pinned_schema_eval_local_voice_and_mono_output(model, kokoro, tmp_path):
    kmodel, instance, evaluated, kpipeline, pipeline, load_voice, write = kokoro
    output = str(tmp_path / "narration.wav")
    assert worker.infer({"model": model, "action": "narrate", "text": "Hello", "output_path": output}) == {
        "output_path": output,
        "sample_rate": 24000,
    }
    kmodel.assert_called_once_with(
        config=str(Path(model) / "config.json"), model=str(Path(model) / "kokoro-v1_0.pth")
    )
    instance.eval.assert_called_once_with()
    kpipeline.assert_called_once_with(lang_code="a", model=evaluated, repo_id="hexgrad/Kokoro-82M")
    load_voice.assert_called_once_with(
        Path(model) / "voices" / "af_heart.pt", weights_only=True, map_location="cpu"
    )
    pipeline.assert_called_once_with("Hello", voice="local-voice")
    assert write.call_args.args[0] == output
    assert write.call_args.args[1].shape == (2,)
    assert write.call_args.args[2] == 24000


@pytest.mark.parametrize("shape", ["stereo", "nan", "empty"])
def test_kokoro_rejects_invalid_shapes_and_samples(model, kokoro, shape, tmp_path):
    np = pytest.importorskip("numpy")
    audio = {"stereo": np.zeros((2, 2)), "nan": np.array([np.nan]), "empty": np.array([])}[shape]
    *_, pipeline, _, write = kokoro
    pipeline.return_value = iter([("text", "phones", audio)])
    with pytest.raises(ValueError, match="Kokoro audio"):
        worker.infer(
            {"model": model, "action": "narrate", "text": "Hello", "output_path": str(tmp_path / "out.wav")}
        )
    write.assert_not_called()


def test_kokoro_missing_spacy_assets_never_generates_or_downloads(model, kokoro, monkeypatch):
    import importlib.util

    monkeypatch.setattr(importlib.util, "find_spec", lambda name: None)
    with pytest.raises(RuntimeError, match="English speech assets"):
        worker.infer({"model": model, "action": "narrate", "text": "Hello", "output_path": "out.wav"})
    kokoro[0].assert_not_called()


def test_worker_main_atomic_finite_response_and_private_streams(model, monkeypatch, tmp_path, capfd):
    request, response = tmp_path / "request.json", tmp_path / "response.json"
    request.write_text(json.dumps({"model": model, "action": "generate", "prompt": "private input"}))
    response.write_text('{"output":"old"}')
    monkeypatch.setattr(sys, "argv", ["worker", str(request), str(response)])

    def infer(data):
        assert os.environ["HF_HUB_OFFLINE"] == "1"
        print(data["prompt"])
        print("private stderr", file=sys.stderr)
        os.write(1, b"native private stdout")
        return {"output": "new", "number": 0.5}

    monkeypatch.setattr(worker, "infer", infer)
    worker.main()
    assert capfd.readouterr() == ("", "")
    assert json.loads(response.read_text()) == {"output": "new", "number": 0.5}
    assert response.stat().st_mode & 0o777 == 0o600
    assert not response.with_suffix(".json.tmp").exists()


def test_worker_main_failure_removes_stale_result(model, monkeypatch, tmp_path):
    request, response = tmp_path / "request.json", tmp_path / "response.json"
    request.write_text(json.dumps({"model": model, "action": "generate", "prompt": "private"}))
    response.write_text('{"output":"old"}')
    monkeypatch.setattr(sys, "argv", ["worker", str(request), str(response)])
    monkeypatch.setattr(worker, "infer", lambda data: {"segments": [{"start": float("nan")}]})
    with pytest.raises(ValueError, match="Non-finite"):
        worker.main()
    assert not response.exists()


def test_standalone_error_is_generic_and_does_not_echo_input(tmp_path):
    request, response = tmp_path / "request.json", tmp_path / "response.json"
    request.write_text('{"private unparseable text')
    result = subprocess.run(
        [sys.executable, worker.__file__, str(request), str(response)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert result.stdout == ""
    assert "private" not in result.stderr
    assert "Traceback" not in result.stderr
    assert not response.exists()
