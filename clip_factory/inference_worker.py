"""Offline, standalone inference worker. No remote code, tools, or cloud fallback."""

from __future__ import annotations

import contextlib
import json
import math
import numbers
import os
import sys
from pathlib import Path

MAX_PROMPT = 64_000
MAX_TEXT = 20_000
MAX_TOKENS = 4096
MAX_RESPONSE = 4 * 1024**2


def validate_request(request):
    if not isinstance(request, dict) or not isinstance(request.get("model"), str):
        raise TypeError("Invalid request")
    action = request.get("action")
    if action == "generate":
        prompt = request["prompt"]
        tokens = request.get("max_tokens", 1500)
        images = request.get("images", [])
        if not isinstance(prompt, str) or not 0 < len(prompt) <= MAX_PROMPT:
            raise ValueError("Prompt limit exceeded")
        if type(tokens) is not int or not 1 <= tokens <= MAX_TOKENS:
            raise ValueError("Token limit exceeded")
        if not isinstance(images, list) or len(images) > 16:
            raise ValueError("Image limit exceeded")
        for image in images:
            if not isinstance(image, str) or not Path(image).is_file():
                raise ValueError("Images must be local files")
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


def infer(request):
    validate_request(request)
    model_path = request["model"]
    if not Path(model_path).is_dir():
        raise ValueError("Model must be a local installed directory")
    action = request["action"]
    if action == "generate":
        from mlx_vlm import generate, load
        from mlx_vlm.prompt_utils import apply_chat_template
        from mlx_vlm.utils import load_config

        model, processor = load(model_path, trust_remote_code=False)
        images = request.get("images", [])
        formatted = apply_chat_template(
            processor,
            load_config(model_path),
            request["prompt"],
            num_images=len(images),
            enable_thinking=False,
        )
        output = generate(
            model,
            processor,
            formatted,
            image=images or None,
            max_tokens=request.get("max_tokens", 1500),
            temperature=0.3,
            verbose=False,
        )
        # MLX-VLM 0.7.12 returns GenerationResult, not its repr/metrics.
        text = output.text if hasattr(output, "text") else output
        if not isinstance(text, str) or len(text) > 1_000_000:
            raise ValueError("Invalid generated text")
        return {"output": text}
    if action == "transcribe":
        import mlx_whisper

        output = mlx_whisper.transcribe(
            request["audio"],
            path_or_hf_repo=model_path,
            word_timestamps=True,
            language=request.get("language") or None,
            verbose=False,
        )
        return {
            "text": output.get("text", ""),
            "language": output.get("language"),
            "segments": [
                {
                    "start": float(s["start"]),
                    "end": float(s["end"]),
                    "text": s["text"],
                    "words": s.get("words", []),
                }
                for s in output.get("segments", [])
            ],
        }

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
