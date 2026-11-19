"""Which local engine runs agent roles on this computer, and whether this computer can run one.

Apple Silicon Macs run agents on MLX (or on an Ollama model the creator picked). Windows and Linux run
them on Ollama, which the creator installs: the engine detects it and guides the creator, and never
installs it silently. A hardware check (installed memory, plus NVIDIA GPU memory when the driver
answers) picks the recommended model. When nothing fits, production is blocked before it starts and
the alternatives are named; cloud processing is never switched on to make up for weak hardware.
"""

from __future__ import annotations

import functools
import os
import shutil
import subprocess
from pathlib import Path

import psutil

from . import speech_backend
from .jobs import WorkError

MLX = "mlx"
OLLAMA = "ollama"
INSTALL_URL = "https://ollama.com/download"
GB = 1e9
# A computer sold with 8 GB reports a little less (firmware and integrated graphics reserve some).
RAM_TOLERANCE_GB = 0.6

# Ollama library tags, download sizes from registry.ollama.ai (Nov 2026). Both read frames and write
# text, so one model serves the text and the vision roles. min_ram_gb is installed memory for running
# on the CPU: weights, about 3 GB of runtime headroom, and the app, FFmpeg and speech beside it.
# min_vram_gb lets Ollama hold the whole model on an NVIDIA GPU, which then needs only MIN_RAM_GB.
CATALOGUE = [
    {
        "id": "ollama:qwen3-vl:4b-instruct",
        "tag": "qwen3-vl:4b-instruct",
        "name": "Qwen3-VL 4B Instruct",
        "download_gb": 3.3,
        "min_ram_gb": 12,
        "min_vram_gb": 5,
        "roles": ["text", "vision"],
        "license": "Apache-2.0",
        "note": "Recommended. Brand research, post copy, references and the strategist are tuned for it.",
    },
    {
        "id": "ollama:qwen3-vl:2b-instruct",
        "tag": "qwen3-vl:2b-instruct",
        "name": "Qwen3-VL 2B Instruct",
        "download_gb": 1.9,
        "min_ram_gb": 8,
        "min_vram_gb": 3,
        "roles": ["text", "vision"],
        "license": "Apache-2.0",
        "note": (
            "For computers with 8 to 12 GB of memory. Clips can be produced; brand research, post copy, "
            "references and the strategist need the 4B model or your own cloud key."
        ),
    },
]
MIN_RAM_GB = min(entry["min_ram_gb"] for entry in CATALOGUE)
ALTERNATIVES = (
    "add your own OpenRouter key under Brand profile → AI model and turn on cloud agents, "
    "or edit clips by hand"
)


def engine() -> str:
    """MLX on Apple Silicon, Ollama everywhere else."""
    return MLX if speech_backend.backend() == speech_backend.MLX else OLLAMA


def entry(identifier: str) -> dict | None:
    return next((item for item in CATALOGUE if item["id"] == identifier), None)


@functools.lru_cache(maxsize=1)
def nvidia_memory_gb() -> float | None:
    """Memory of the largest NVIDIA GPU when its driver answers, else None. Never raises."""
    tool = shutil.which("nvidia-smi")
    if not tool:
        return None
    try:
        result = subprocess.run(
            [tool, "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10, check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    sizes = []
    for line in result.stdout.splitlines():
        try:
            sizes.append(float(line.strip()) * 1024**2 / GB)  # MiB
        except ValueError:
            continue
    return max(sizes) if sizes else None


def hardware() -> dict:
    """{ram_gb, gpu, vram_gb}: installed memory, and the NVIDIA GPU when one is detected."""
    gpu = speech_backend.nvidia_gpu()
    vram = nvidia_memory_gb() if gpu else None
    return {
        "ram_gb": round(psutil.virtual_memory().total / GB, 1),
        "gpu": gpu,
        "vram_gb": round(vram, 1) if vram else None,
    }


def on_gpu(item: dict, hw: dict) -> bool:
    return bool(hw.get("vram_gb")) and hw["vram_gb"] >= item["min_vram_gb"]


def fits(item: dict, hw: dict) -> bool:
    ram = hw["ram_gb"] + RAM_TOLERANCE_GB
    return ram >= item["min_ram_gb"] or (on_gpu(item, hw) and ram >= MIN_RAM_GB)


def recommend(hw: dict) -> dict | None:
    """The first catalogue model that fits, best first; None when this computer is below the minimum."""
    return next((item for item in CATALOGUE if fits(item, hw)), None)


def ollama_binary() -> str | None:
    """Where Ollama is installed: on PATH, or its installer's default location for this system."""
    found = shutil.which("ollama")
    if found:
        return found
    system = speech_backend.host()[0]
    candidates: list[Path] = []
    if system == "Windows":
        local = os.environ.get("LOCALAPPDATA")
        if local:
            candidates.append(Path(local) / "Programs" / "Ollama" / "ollama.exe")
    elif system == "Darwin":
        candidates.append(Path("/Applications/Ollama.app/Contents/Resources/ollama"))
    else:
        candidates += [Path("/usr/local/bin/ollama"), Path("/usr/bin/ollama")]
    return next((str(path) for path in candidates if path.is_file()), None)


def ollama_store() -> Path:
    """Where Ollama keeps model files (OLLAMA_MODELS, else ~/.ollama/models), for the disk check."""
    configured = os.environ.get("OLLAMA_MODELS", "").strip()
    path = Path(configured) if configured else Path.home() / ".ollama" / "models"
    while not path.exists() and path != path.parent:
        path = path.parent
    return path


def status(ollama, *, force: bool = False) -> dict:
    """Agent engine, Ollama state, hardware and the catalogue with what fits and what is installed."""
    hw = hardware()
    listing = ollama.status(force=force)
    names = {model["name"] for model in listing["models"]}
    best = recommend(hw)
    catalogue = []
    for item in CATALOGUE:
        fit = fits(item, hw)
        catalogue.append(
            {
                **item,
                "fits": fit,
                "device": ("cuda" if on_gpu(item, hw) else "cpu") if fit else None,
                "installed": item["tag"] in names,
                "recommended": best is item,
            }
        )
    return {
        "engine": engine(),
        "ollama": {
            "installed": listing["running"] or ollama_binary() is not None,
            "running": listing["running"],
            "install_url": INSTALL_URL,
        },
        "hardware": hw,
        "minimum_ram_gb": MIN_RAM_GB,
        "recommended": {"text": best["id"], "vision": best["id"]} if best else None,
        "catalogue": catalogue,
    }


def blocker(state: dict, installed: list[dict]) -> dict | None:
    """Why local agents cannot run on this computer right now, with the step that fixes it; else None.

    ``installed`` lists the Ollama language models Ollama reports. The order matters: installing Ollama
    does not help a computer that is too small, and a model cannot be pulled while Ollama is stopped.
    """
    if state["engine"] != OLLAMA:
        return None
    base = {"scope": "agents", "tab": "AI model", "steps": []}
    hw = state["hardware"]
    best = next((item for item in state["catalogue"] if item["recommended"]), None)
    if best is None:
        small = CATALOGUE[-1]
        return {
            **base,
            "code": "agents_hardware",
            "action": None,
            "alternatives": ["openrouter_key", "manual"],
            "message": (
                f"Local agents need at least {MIN_RAM_GB} GB of memory, or an NVIDIA GPU with "
                f"{small['min_vram_gb']} GB; this computer has {hw['ram_gb']:g} GB. To make clips anyway, "
                f"{ALTERNATIVES}."
            ),
        }
    if not state["ollama"]["installed"]:
        return {
            **base,
            "code": "ollama_missing",
            "action": "check",
            "install_url": INSTALL_URL,
            "message": (
                "Agents run on this computer through Ollama, which isn't installed. Install it from "
                "ollama.com/download, open it, then check again."
            ),
        }
    if not state["ollama"]["running"]:
        return {
            **base,
            "code": "ollama_stopped",
            "action": "check",
            "message": "Ollama is installed but not running. Open the Ollama app (or run `ollama serve`), then check again.",
        }
    if not installed:
        return {
            **base,
            "code": "agent_model_missing",
            "action": "pull",
            "model_id": best["id"],
            "download_gb": best["download_gb"],
            "message": (
                f"Download {best['name']} (about {best['download_gb']:g} GB) through Ollama to run agents "
                "on this computer. The download needs an internet connection; agents then run offline."
            ),
        }
    return None


def pull(ollama, jobs, job_id: str, item: dict) -> dict:
    """Download one catalogue model through Ollama as a job, with progress; verify it is listed after."""
    from .ollama import OllamaError

    jobs.update(job_id, progress=0, message=f"Downloading {item['name']} through Ollama")
    try:
        ollama.pull(
            item["tag"],
            progress=lambda percent, message: jobs.update(job_id, progress=percent, message=message),
            check=lambda: jobs.check(job_id),
        )
    except OllamaError as exc:
        raise WorkError(str(exc)) from exc
    ollama.status(force=True)
    if ollama.model(item["tag"]) is None:
        raise WorkError("Ollama finished the download but does not list the model. Check `ollama list`.")
    jobs.update(job_id, progress=100, message=f"{item['name']} is ready")
    return {"model_id": item["id"], "installed": True}
