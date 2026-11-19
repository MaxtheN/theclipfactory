"""Offline, standalone inference worker. No remote code, tools, or cloud fallback."""

from __future__ import annotations

import contextlib
import json
import math
import numbers
import os
import sys
from pathlib import Path

MAX_PROMPT = 96_000
MAX_TEXT = 20_000
MAX_TOKENS = 4096
MAX_IMAGES = 24
MAX_BATCH = 64
MAX_SCHEMA = 64_000
MAX_RESPONSE = 4 * 1024**2


def validate_generation(request):
    prompt = request["prompt"]
    tokens = request.get("max_tokens", 1500)
    images = request.get("images", [])
    labels = request.get("image_labels")
    schema = request.get("schema")
    temperature = request.get("temperature", 0.3)
    if not isinstance(prompt, str) or not 0 < len(prompt) <= MAX_PROMPT:
        raise ValueError("Prompt limit exceeded")
    if type(tokens) is not int or not 1 <= tokens <= MAX_TOKENS:
        raise ValueError("Token limit exceeded")
    if not isinstance(images, list) or len(images) > MAX_IMAGES:
        raise ValueError("Image limit exceeded")
    for image in images:
        if not isinstance(image, str) or not Path(image).is_file():
            raise ValueError("Images must be local files")
    if labels is not None and (
        not isinstance(labels, list)
        or len(labels) != len(images)
        or not all(isinstance(label, str) and 0 < len(label) <= 120 for label in labels)
    ):
        raise ValueError("Each image needs one short label")
    if schema is not None and (
        not isinstance(schema, dict) or len(json.dumps(schema, allow_nan=False)) > MAX_SCHEMA
    ):
        raise ValueError("Invalid output schema")
    if isinstance(temperature, bool) or not isinstance(temperature, numbers.Real) or not 0 <= temperature <= 1.5:
        raise ValueError("Invalid temperature")


def validate_request(request):
    if not isinstance(request, dict) or not isinstance(request.get("model"), str):
        raise TypeError("Invalid request")
    action = request.get("action")
    if action == "generate":
        validate_generation(request)
    elif action == "batch":
        requests = request["requests"]
        if not isinstance(requests, list) or not 0 < len(requests) <= MAX_BATCH:
            raise ValueError("Batch limit exceeded")
        for item in requests:
            if not isinstance(item, dict):
                raise TypeError("Invalid batch request")
            validate_generation(item)
    elif action == "narrate":
        text = request["text"]
        if not isinstance(text, str) or not 0 < len(text) <= MAX_TEXT:
            raise ValueError("Narration limit exceeded")
        if not isinstance(request["output_path"], str):
            raise ValueError("Invalid output path")
    elif action == "transcribe":
        if not isinstance(request["audio"], str) or not Path(request["audio"]).is_file():
            raise ValueError("Audio must be a local file")
        language = request.get("language")
        if language is not None and (not isinstance(language, str) or len(language) > 32):
            raise ValueError("Invalid language")
        if request.get("engine", "mlx") not in {"mlx", "faster-whisper"}:
            raise ValueError("Unsupported speech engine")
        if request.get("device", "cpu") not in {"cpu", "cuda"}:
            raise ValueError("Unsupported speech device")
    else:
        raise ValueError("Unsupported inference action")


def json_value(value):
    """Cast NumPy scalar timestamps/words; reject NaN/Infinity and opaque objects."""
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, numbers.Integral):
        return int(value)
    if isinstance(value, numbers.Real):
        value = float(value)
        if not math.isfinite(value):
            raise ValueError("Non-finite inference result")
        return value
    if isinstance(value, dict):
        if not all(isinstance(k, str) for k in value):
            raise ValueError("Invalid result key")
        return {k: json_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_value(v) for v in value]
    # NumPy bool scalars, without requiring NumPy in the app process.
    if type(value).__module__.startswith("numpy") and hasattr(value, "item"):
        return json_value(value.item())
    raise ValueError("Unsupported inference result type")


def constraint(processor, schema):
    """Grammar-constrained decoding: the model can only emit JSON matching the schema.

    Unsupported schema features or a missing grammar engine fall back to free generation; the
    caller validates every handoff either way.
    """
    try:
        from mlx_vlm.structured import build_json_schema_logits_processor

        tokenizer = processor.tokenizer if hasattr(processor, "tokenizer") else processor
        return build_json_schema_logits_processor(tokenizer, schema)
    except Exception:  # noqa: BLE001 - optional capability; never fail the request for it
        return None


def generate_text(model, processor, generate, model_path, request, config=None):
    images = request.get("images", [])
    labels = request.get("image_labels")
    if labels:
        # Interleave each frame with its label so the model can ground what it sees in time.
        parts = []
        for label in labels:
            parts.append({"type": "text", "text": f"\n{label}:"})
            parts.append({"type": "image"})
        parts.append({"type": "text", "text": "\n" + request["prompt"]})
        formatted = processor.apply_chat_template(
            [{"role": "user", "content": parts}],
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,
        )
    else:
        from mlx_vlm.prompt_utils import apply_chat_template
        from mlx_vlm.utils import load_config

        formatted = apply_chat_template(
            processor,
            load_config(model_path) if config is None else config,
            request["prompt"],
            num_images=len(images),
            enable_thinking=False,
        )
    options = {}
    if request.get("schema") is not None:
        guide = constraint(processor, request["schema"])
        if guide is not None:
            options["logits_processors"] = [guide]
    output = generate(
        model,
        processor,
        formatted,
        image=images or None,
        max_tokens=request.get("max_tokens", 1500),
        temperature=request.get("temperature", 0.3),
        verbose=False,
        **options,
    )
    # MLX-VLM 0.7.12 returns GenerationResult, not its repr/metrics.
    text = output.text if hasattr(output, "text") else output
    if not isinstance(text, str) or len(text) > 1_000_000:
        raise ValueError("Invalid generated text")
    return text


def read_wav(path):
    """16 kHz mono 16-bit PCM WAV (what the app extracts) as float32 samples, else None.

    Decoding here rather than through PyAV keeps transcription independent of PyAV's audio API.
    """
    import wave

    try:
        with wave.open(str(path), "rb") as audio:
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (1, 2, 16000):
                return None
            frames = audio.readframes(audio.getnframes())
    except (OSError, EOFError, wave.Error):
        return None
    import numpy as np  # faster-whisper's own dependency, present in its runtime

    return np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0


def load_cuda_libraries():
    """Make the pip-installed NVIDIA cuBLAS/cuDNN libraries findable by CTranslate2."""
    import importlib.util

    folders = []
    for name in ("nvidia.cublas", "nvidia.cudnn"):
        try:
            spec = importlib.util.find_spec(name)
        except (ImportError, ValueError):
            spec = None
        for base in (spec.submodule_search_locations or []) if spec else []:
            folders += [Path(base) / sub for sub in ("bin", "lib") if (Path(base) / sub).is_dir()]
    if os.name == "nt":
        for folder in folders:
            os.add_dll_directory(str(folder))
        os.environ["PATH"] = os.pathsep.join([*map(str, folders), os.environ.get("PATH", "")])
        return
    import ctypes

    # cuBLASLt before cuBLAS, then cuDNN and its sub-libraries, loaded globally so dlopen finds them.
    for folder in folders:
        for library in sorted(folder.glob("lib*.so*"), key=lambda p: ("Lt" not in p.name, p.name)):
            with contextlib.suppress(OSError):
                ctypes.CDLL(str(library), mode=ctypes.RTLD_GLOBAL)


def transcribe_faster_whisper(request, model_path):
    from faster_whisper import WhisperModel

    samples = read_wav(request["audio"])
    audio = samples if samples is not None else request["audio"]
    options = {
        "language": request.get("language") or None,
        "word_timestamps": True,
        # Greedy decoding like MLX Whisper; VAD skips silence (faster on the CPU, fewer invented lines).
        "beam_size": 1,
        "vad_filter": True,
        "condition_on_previous_text": False,
        "hallucination_silence_threshold": 2.0,
    }
    attempts = [("cuda", "float16")] if request.get("device") == "cuda" else []
    # float32 on the CPU, not int8: in testing, int8 runs of the same audio differed and some lost whole
    # sentences; float32 (about half int8's speed) gave the identical, complete transcript every run.
    attempts.append(("cpu", "float32"))
    for device, compute_type in attempts:
        try:
            if device == "cuda":
                load_cuda_libraries()
            model = WhisperModel(
                model_path, device=device, compute_type=compute_type, cpu_threads=os.cpu_count() or 4,
                local_files_only=True,
            )
            pieces, info = model.transcribe(audio, **options)
            pieces = list(pieces)  # Decoding happens while iterating: CUDA errors surface here.
            break
        except Exception:
            if device == "cpu":
                raise
            # A missing or mismatched CUDA library: the CPU still transcribes, only slower.
    segments = []
    for s in pieces:
        segment = {
            "start": float(s.start),
            "end": float(s.end),
            "text": s.text,
            "words": [
                {"word": w.word, "start": float(w.start), "end": float(w.end), "probability": float(w.probability)}
                for w in (s.words or [])
            ],
        }
        for key in ("no_speech_prob", "avg_logprob"):
            if getattr(s, key, None) is not None:
                segment[key] = float(getattr(s, key))
        segments.append(segment)
    return {
        "text": "".join(s["text"] for s in segments),
        "language": info.language,
        "segments": segments,
        "device": device,
        "compute_type": compute_type,
    }


def infer(request):
    validate_request(request)
    model_path = request["model"]
    if not Path(model_path).is_dir():
        raise ValueError("Model must be a local installed directory")
    action = request["action"]
    if action == "generate":
        from mlx_vlm import generate, load

        model, processor = load(model_path, trust_remote_code=False)
        return {"output": generate_text(model, processor, generate, model_path, request)}
    if action == "batch":
        # One model load serves every request: watching a source is dozens of short calls.
        from mlx_vlm import generate, load
        from mlx_vlm.utils import load_config

        model, processor = load(model_path, trust_remote_code=False)
        config = load_config(model_path)
        outputs = []
        for item in request["requests"]:
            try:
                outputs.append({"output": generate_text(model, processor, generate, model_path, item, config)})
            except Exception:  # noqa: BLE001 - one unreadable window must not discard the rest
                outputs.append({"error": "Generation failed for this request."})
        return {"outputs": outputs}
    if action == "transcribe" and request.get("engine") == "faster-whisper":
        return transcribe_faster_whisper(request, model_path)
    if action == "transcribe":
        import mlx_whisper

        output = mlx_whisper.transcribe(
            request["audio"],
            path_or_hf_repo=model_path,
            word_timestamps=True,
            language=request.get("language") or None,
            verbose=False,
            # Each window is decoded on its own and silent stretches are skipped: far fewer
            # invented phrases ("Thank you.") on footage with little or no speech.
            condition_on_previous_text=False,
            hallucination_silence_threshold=2.0,
        )
        segments = []
        for s in output.get("segments", []):
            segment = {
                "start": float(s["start"]),
                "end": float(s["end"]),
                "text": s["text"],
                "words": s.get("words", []),
            }
            for key in ("no_speech_prob", "avg_logprob"):
                if s.get(key) is not None:
                    segment[key] = float(s[key])
            segments.append(segment)
        return {"text": output.get("text", ""), "language": output.get("language"), "segments": segments}

    import importlib.util

    import numpy as np
    import soundfile as sf
    import torch
    from kokoro import KModel, KPipeline

    path = Path(model_path)
    if importlib.util.find_spec("en_core_web_sm") is None:
        raise RuntimeError("English speech assets missing; rerun runtime setup")
    model = KModel(config=str(path / "config.json"), model=str(path / "kokoro-v1_0.pth")).eval()
    pipeline = KPipeline(lang_code="a", model=model, repo_id="hexgrad/Kokoro-82M")
    voice = torch.load(path / "voices" / "af_heart.pt", weights_only=True, map_location="cpu")
    pieces = []
    samples = 0
    for _, _, audio in pipeline(request["text"], voice=voice):
        if hasattr(audio, "detach"):
            audio = audio.detach().cpu()
        audio = np.asarray(audio.numpy() if hasattr(audio, "numpy") else audio, dtype=np.float32)
        if audio.ndim != 1 or not audio.size or not np.isfinite(audio).all():
            raise ValueError("Invalid Kokoro audio shape or samples")
        samples += audio.size
        if samples > 24000 * 1200:
            raise ValueError("Narration output exceeds 20 minutes")
        pieces.append(audio)
    if not pieces:
        raise ValueError("No audio generated")
    sf.write(request["output_path"], np.concatenate(pieces), 24000)
    return {"output_path": request["output_path"], "sample_rate": 24000}


def main():
    # Set before importing any model library. Inference never downloads model assets.
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_XET="1")
    source, destination = Path(sys.argv[1]), Path(sys.argv[2])
    destination.unlink(missing_ok=True)
    if source.stat().st_size > MAX_RESPONSE:
        raise ValueError("Request too large")
    request = json.loads(source.read_text(encoding="utf-8"))
    # Native libraries and Python packages can echo prompts/ASR into stdout/stderr.
    # Redirect both OS descriptors and Python streams, not just verbose=False.
    with open(os.devnull, "w") as sink:
        saved = [os.dup(fd) for fd in (1, 2)]
        try:
            os.dup2(sink.fileno(), 1)
            os.dup2(sink.fileno(), 2)
            with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                result = json_value(infer(request))
        finally:
            for fd, original in zip((1, 2), saved):
                os.dup2(original, fd)
                os.close(original)
    encoded = json.dumps(result, ensure_ascii=False, allow_nan=False)
    if len(encoded.encode("utf-8")) > MAX_RESPONSE:
        raise ValueError("Result too large")
    temporary = destination.with_name(destination.name + ".tmp")
    temporary.unlink(missing_ok=True)
    temporary.write_text(encoded, encoding="utf-8")
    temporary.chmod(0o600)
    os.replace(temporary, destination)


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 - private process boundary; never log user data
        # Tracebacks may contain input text, filesystem names, or package credentials.
        print("Local inference failed; verify runtime, model, and input limits.", file=sys.stderr)
        sys.exit(1)
