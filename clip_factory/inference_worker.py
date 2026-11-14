"""Standalone script run by the isolated model Python, including from a frozen app.

No remote code or tools. Inputs are data, never shell commands. Offline inference;
process exit releases all model memory. Parent supervises cancellation/timeouts.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main():
    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    model_path = request["model"]
    action = request["action"]
    if action == "generate":
        from mlx_vlm import generate, load
        from mlx_vlm.prompt_utils import apply_chat_template
        from mlx_vlm.utils import load_config

        model, processor = load(model_path, trust_remote_code=False)
        images = request.get("images", [])
        formatted = apply_chat_template(
            processor, load_config(model_path), request["prompt"], num_images=len(images)
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
        result = {"output": output.text if hasattr(output, "text") else str(output)}
    elif action == "transcribe":
        import mlx_whisper

        result = mlx_whisper.transcribe(
            request["audio"],
            path_or_hf_repo=model_path,
            word_timestamps=True,
            language=request.get("language") or None,
            verbose=False,
        )
        result = {
            "text": result.get("text", ""),
            "language": result.get("language"),
            "segments": [
                {
                    "start": float(s["start"]),
                    "end": float(s["end"]),
                    "text": s["text"],
                    "words": s.get("words", []),
                }
                for s in result.get("segments", [])
            ],
        }
    elif action == "narrate":
        import numpy as np
        import soundfile as sf
        import torch
        from kokoro import KModel, KPipeline

        path = Path(model_path)
        import importlib.util

        if importlib.util.find_spec("en_core_web_sm") is None:
            raise RuntimeError("English speech assets missing; rerun runtime setup")
        model = KModel(config=str(path / "config.json"), model=str(path / "kokoro-v1_0.pth")).eval()
        pipeline = KPipeline(lang_code="a", model=model)
        voice = torch.load(path / "voices" / "af_heart.pt", weights_only=True, map_location="cpu")
        pieces = [
            audio.numpy() if hasattr(audio, "numpy") else audio
            for _, _, audio in pipeline(request["text"], voice=voice)
        ]
        if not pieces:
            raise ValueError("No audio generated")
        sf.write(request["output_path"], np.concatenate(pieces), 24000)
        result = {"output_path": request["output_path"], "sample_rate": 24000}
    else:
        raise ValueError("Unsupported inference action")
    Path(sys.argv[2]).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
