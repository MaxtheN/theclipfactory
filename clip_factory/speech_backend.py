"""Which local speech engine this computer runs, and what setting it up costs.

Apple Silicon Macs transcribe with MLX Whisper on the GPU. Windows and Linux on x64 transcribe with
faster-whisper (CTranslate2): on an NVIDIA GPU (float16) when one is present, otherwise on the CPU
(float32, which unlike int8 gives the same complete transcript every run). Everything else (Intel Macs, ARM Linux/Windows) has no local speech engine: setup is never
offered there, only cloud speech or manual editing.
"""

from __future__ import annotations

import functools
import platform
import shutil
import subprocess

MLX = "mlx"
FASTER_WHISPER = "faster-whisper"

# faster-whisper 1.2.1 calls av.open(metadata_errors=...), which PyAV 19 removed: pin PyAV too.
FW_VERSIONS = {"faster-whisper": "1.2.1", "ctranslate2": "4.9.0", "av": "18.0.0"}
FW_PACKAGES = [f"{name}=={version}" for name, version in FW_VERSIONS.items()]
# CTranslate2 4.x is built against CUDA 12 and cuDNN 9. 12.9.2.10 is the newest cuBLAS with a Windows wheel.
CUDA_PACKAGES = ["nvidia-cublas-cu12==12.9.2.10", "nvidia-cudnn-cu12==9.28.1.4"]

# Downloads as the setup card shows them (wheels and archives, not the unpacked size).
RUNTIME_GB = {MLX: 1.4, FASTER_WHISPER: 0.2}
CUDA_GB = 1.3

FW_MODEL = {
    "name": "Whisper large-v3-turbo · faster-whisper",
    "repo": "dropbox-dash/faster-whisper-large-v3-turbo",
    "license": "MIT (OpenAI upstream)",
    "estimated_gb": 1.6,
    "format": "ctranslate2",
}
# Speech windows faster-whisper decodes at once. On an 8-thread CPU, 8 transcribed 1.28x faster than one
# window at a time, with as accurate a transcript and no more memory; 16 was no faster and used 1.4 GB more.
# GPUs gain more from batching. A fixed size keeps the transcript the same from run to run.
FW_BATCH = 8

UNSUPPORTED = (
    "Local speech recognition needs an Apple Silicon Mac, or Windows or Linux on a 64-bit Intel/AMD "
    "processor. On this computer, choose cloud speech (Groq) under Speech recognition in Settings → AI model, "
    "or write the transcript by hand."
)


def host() -> tuple[str, str]:
    """(system, machine) as Python reports them, e.g. ("Windows", "AMD64"). Tests replace this."""
    return platform.system(), platform.machine()


def normal_machine(machine: str) -> str:
    lowered = machine.lower()
    if lowered in {"amd64", "x86_64", "x64"}:
        return "x86_64"
    return "arm64" if lowered in {"arm64", "aarch64"} else lowered


def backend(system: str | None = None, machine: str | None = None) -> str | None:
    """The speech engine for this platform, or None when no local engine runs on it."""
    if system is None or machine is None:
        system, machine = host()
    arch = normal_machine(machine)
    if system == "Darwin" and arch == "arm64":
        return MLX
    if system in {"Windows", "Linux"} and arch == "x86_64":
        return FASTER_WHISPER
    return None


@functools.lru_cache(maxsize=1)
def nvidia_gpu() -> str | None:
    """The first NVIDIA GPU's name when its driver answers, else None. Never raises."""
    tool = shutil.which("nvidia-smi")
    if not tool:
        return None
    try:
        result = subprocess.run(
            [tool, "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=10, check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    name = next((line.strip() for line in result.stdout.splitlines() if line.strip()), "")
    return name or None


def runtime_gb(engine: str | None = None) -> float:
    """Download size of the speech engine packages for this computer."""
    engine = engine if engine is not None else backend()
    if engine == FASTER_WHISPER:
        return round(RUNTIME_GB[FASTER_WHISPER] + (CUDA_GB if nvidia_gpu() else 0), 1)
    return RUNTIME_GB[MLX]


def label(engine: str | None = None) -> str:
    engine = engine if engine is not None else backend()
    return {MLX: "MLX Whisper (Apple GPU)", FASTER_WHISPER: "faster-whisper"}.get(engine, "unavailable")
