"""Opt-in model catalogue and isolated Apple Silicon runtime."""
from __future__ import annotations

import json
import os
import platform
import shutil
import sys
from pathlib import Path

import psutil

from .jobs import Jobs, WorkError

CATALOG = [
    {"id": "qwen-small", "name": "Qwen3.5 9B · 4-bit", "repo": "mlx-community/Qwen3.5-9B-MLX-4bit", "kind": "llm", "license": "Apache-2.0 (check upstream terms)", "estimated_gb": 6},
    {"id": "qwen-large", "name": "Qwen3.5 35B-A3B · 4-bit", "repo": "mlx-community/Qwen3.5-35B-A3B-4bit", "kind": "llm", "license": "Apache-2.0 (check upstream terms)", "estimated_gb": 24},
    {"id": "whisper-turbo", "name": "Whisper large-v3-turbo · MLX", "repo": "mlx-community/whisper-large-v3-turbo", "kind": "asr", "license": "MIT (OpenAI upstream)", "estimated_gb": 2},
    {"id": "kokoro", "name": "Kokoro 82M · narration", "repo": "hexgrad/Kokoro-82M", "kind": "tts", "license": "Apache-2.0", "estimated_gb": 0.5},
]


def apple_silicon() -> bool:
    return platform.system() == "Darwin" and platform.machine() == "arm64"


class Models:
    def __init__(self, directory: Path, jobs: Jobs):
        self.root = directory
        self.jobs = jobs
        self.model_dir = directory / "models"
        self.runtime = directory / "runtime"
        self.logs = directory / "logs"
        self.model_dir.mkdir(exist_ok=True)
        self.logs.mkdir(exist_ok=True)

    @property
    def python(self) -> Path:
        return self.runtime / "bin" / "python"

    def ready(self) -> bool:
        return self.python.exists() and (self.runtime / ".ready").exists()

    def item(self, identifier: str) -> dict:
        item = next((m for m in CATALOG if m["id"] == identifier), None)
        if not item:
            raise WorkError("Unknown model.")
        path = self.model_dir / identifier
        installed = (path / ".complete").exists()
        return {**item, "installed": installed, "status": "installed" if installed else "not installed"}

    def catalog(self) -> list[dict]:
        return [self.item(m["id"]) for m in CATALOG]

    def setup(self, job_id: str) -> dict:
        if not apple_silicon():
            raise WorkError("MLX inference requires native Apple Silicon macOS. Manual editing works on this machine.")
        candidates = [shutil.which("python3.12"), shutil.which("python3.11")]
        if not getattr(sys, "frozen", False) and (3, 11) <= sys.version_info[:2] <= (3, 12):
            candidates.append(sys.executable)
        python = next((p for p in candidates if p), None)
        if not python:
            raise WorkError("Install native Python 3.12 with Homebrew, then restart and run runtime setup.")
        (self.runtime / ".ready").unlink(missing_ok=True)
        self.jobs.update(job_id, progress=5, message="Creating isolated Python runtime")
        self.jobs.process(job_id, [python, "-m", "venv", str(self.runtime)], timeout=180,
                          failure="Cannot create runtime. Install native Python 3.12 and ensure data directory is writable.")
        self.jobs.update(job_id, progress=20, message="Installing MLX vision, Whisper, and Kokoro (network download)")
        self.jobs.process(job_id, [str(self.python), "-m", "pip", "install", "--disable-pip-version-check",
                                  "mlx-vlm==0.7.12", "mlx-whisper==0.4.3", "kokoro==0.9.4", "soundfile>=0.13,<1"],
                          timeout=1800, log_path=self.logs / f"{job_id}.log",
                          failure="Runtime install failed. Open the local logs folder; verify native Python 3.12, network, and disk space.")
        self.jobs.process(job_id, [str(self.python), "-c", "import mlx.core, mlx_vlm, mlx_whisper, kokoro"], timeout=90,
                          failure="Runtime imports failed. Check package compatibility and native Apple Silicon Python.")
        (self.runtime / ".ready").write_text("mlx-vlm=0.7.12\nmlx-whisper=0.4.3\nkokoro=0.9.4\n")
        return {"runtime": "ready", "path": str(self.runtime)}

    def download(self, job_id: str, identifier: str) -> dict:
        from huggingface_hub import HfApi, hf_hub_download
        item = self.item(identifier)
        target = self.model_dir / identifier
        target.mkdir(exist_ok=True)
        # Metadata enumerates actual weights. Sequential files permit cancellation and per-file progress.
        files = HfApi().list_repo_files(item["repo"])
        allowed = [f for f in files if f.endswith((".json", ".safetensors", ".txt", ".model", ".jinja", ".tiktoken", ".npz"))]
        if identifier == "kokoro":
            allowed = [f for f in files if f in {"config.json", "kokoro-v1_0.pth", "voices/af_heart.pt"}]
        if not allowed or not any(f.endswith((".safetensors", ".pth", ".npz")) for f in allowed):
            raise WorkError("Repository did not provide expected weight files. Model was not marked installed.")
        for index, name in enumerate(allowed):
            self.jobs.check(job_id)
            self.jobs.update(job_id, progress=round(index / len(allowed) * 95), message=f"Downloading {name} ({index+1}/{len(allowed)})")
            hf_hub_download(item["repo"], name, local_dir=target)
        self.jobs.check(job_id)
        (target / ".complete").write_text(json.dumps({"repo": item["repo"], "files": allowed}))
        return {"model_id": identifier, "installed": True}

    def require(self, identifier: str, kind: str):
        item = self.item(identifier)
        if item["kind"] != kind:
            raise WorkError("Choose a model appropriate to this task.")
        if not item["installed"]:
            raise WorkError("Download and accept this model's license in Models first.")
        if not self.ready():
            raise WorkError("Set up the local inference runtime in Models first.")
        if not apple_silicon():
            raise WorkError("This inference runtime requires Apple Silicon macOS.")
        if psutil.virtual_memory().available < (item["estimated_gb"] + 3) * 1e9:
            raise WorkError("Not enough currently available memory. Close other apps or use the smaller model.")

    def run(self, job_id: str, identifier: str, action: str, **payload) -> dict:
        self.require(identifier, {"generate": "llm", "transcribe": "asr", "narrate": "tts"}[action])
        scratch = self.root / "work" / job_id
        scratch.mkdir(parents=True, exist_ok=True)
        request = scratch / "request.json"
        response = scratch / "response.json"
        request.write_text(json.dumps({"action": action, "model": str(self.model_dir / identifier), **payload}), encoding="utf-8")
        request.chmod(0o600)
        worker = Path(__file__).with_name("inference_worker.py")
        env = {**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "TOKENIZERS_PARALLELISM": "false"}
        self.jobs.update(job_id, progress=35, message=f"Running {identifier} locally; model unloads after this task")
        self.jobs.process(job_id, [str(self.python), str(worker), str(request), str(response)], env=env,
                          timeout=1800, log_path=self.logs / f"{job_id}.log",
                          failure="Local inference failed. Check local logs, memory, and the installed runtime/model. No output was fabricated.")
        if not response.exists():
            raise WorkError("Inference worker returned no result.")
        return json.loads(response.read_text(encoding="utf-8"))
