"""Speech recognition readiness: production never runs speechless on footage that has sound.

A source with an audio stream is cut from what is said. When the speech model or its runtime is
missing (or its files were removed from disk), production stops before any model or render work
with one actionable blocker instead of quietly making clips without captions.
"""

from __future__ import annotations

from . import speech_backend
from .jobs import WorkError

ASR_MODEL = "whisper-turbo"
DAMAGED = "Speech model files are damaged or were removed — repair (re-download)."
NO_SPEECH = "No speech in this footage"
UNSUPPORTED = speech_backend.UNSUPPORTED
MODEL_GB = 1.6


def steps() -> dict:
    """One-time downloads for this computer's speech engine, as the setup card shows them."""
    if speech_backend.backend() is None:
        return {}
    return {
        "runtime": {"label": "Speech engine packages", "approx_gb": speech_backend.runtime_gb()},
        ASR_MODEL: {"label": "Speech model (Whisper)", "approx_gb": MODEL_GB},
    }


def missing_message(download_gb: float | None = None) -> str:
    if download_gb is None:
        download_gb = sum(step["approx_gb"] for step in steps().values())
    return f"Speech recognition isn't set up yet. Set it up once (about {download_gb:.1f} GB download) and run again."


class SpeechUnavailable(WorkError):
    """Raised before production work when a source with sound cannot be transcribed."""

    def __init__(self, blocker: dict):
        super().__init__(blocker["message"])
        self.blocker = blocker


def needs_speech(video: dict) -> bool:
    """Footage with an audio stream (unknown counts as audio) and no transcript yet."""
    return video.get("has_audio", True) is not False and video.get("transcript") is None


def integrity(models) -> dict:
    """Cheap on-disk state of the runtime and the speech model; fakes without a probe count as ready."""
    probe = getattr(models, "integrity", None)
    if not callable(probe):
        return {"runtime": {"state": "ok", "problems": []}, ASR_MODEL: {"state": "ok", "problems": []}}
    return probe()


def blocker(code: str, health: dict | None = None, message: str | None = None) -> dict:
    """The speech blocker. Only steps that can run on this computer are listed, with their real sizes."""
    health = health or {}
    if code == "asr_unsupported" or speech_backend.backend() is None:
        return {
            "code": "asr_unsupported", "message": message or UNSUPPORTED, "tab": "Models", "scope": "speech",
            "action": None, "steps": [], "download_gb": 0,
        }
    available = steps()
    pending = []
    for key, info in available.items():
        state = (health.get(key) or {}).get("state", "missing")
        if state != "ok":
            pending.append({"id": key, **info, "state": state})
    if not pending and code in {"asr_missing", "asr_damaged"}:
        pending = [{"id": key, **info, "state": "missing"} for key, info in available.items()]
    download_gb = round(sum(step["approx_gb"] for step in pending), 1)
    return {
        "code": code,
        "message": message or (DAMAGED if code == "asr_damaged" else missing_message(download_gb)),
        "tab": "Models",
        "scope": "speech",
        "action": "speech_setup" if code in {"asr_missing", "asr_damaged"} else None,
        "steps": pending,
        "download_gb": download_gb,
    }


def classify(models, failure: str = "") -> dict | None:
    """The blocker for an unavailable speech model, or None when only transient (memory) stops it.

    Damaged files (manifest present but files missing, runtime venv missing MLX's metallib) are told
    apart from a fresh install so the creator knows a repair, not a first setup, is needed.
    """
    if speech_backend.backend() is None:
        return blocker("asr_unsupported")  # Setting up cannot help on this computer: never offer it.
    health = integrity(models)
    states = {health.get(key, {}).get("state", "missing") for key in steps()}
    if "damaged" in states:
        return blocker("asr_damaged", health)
    if "missing" in states:
        return blocker("asr_missing", health)
    lowered = failure.lower()
    if "memory" in lowered:
        return None  # Installed and intact: the run tries, and a real memory error is reported then.
    if "apple silicon" in lowered or failure == UNSUPPORTED:
        return blocker("asr_unsupported", health, failure)
    # Files look intact but the runtime does not answer: a reinstall repairs it.
    return blocker("asr_damaged", {**health, "runtime": {"state": "damaged", "problems": ["probe"]}})


def check(models) -> dict | None:
    """None when speech recognition can run now; otherwise the blocker to show."""
    try:
        models.require(ASR_MODEL, "asr")
        return None
    except WorkError as exc:
        return classify(models, str(exc))


class BandedJobs:
    """A Jobs view that maps one step's 0-100 progress into its band of a multi-step job."""

    def __init__(self, jobs, job_id: str, low: int, high: int, **step):
        self._jobs, self._job_id, self._low, self._high, self._step = jobs, job_id, low, high, step

    def update(self, identifier: str, **changes):
        if identifier == self._job_id:
            if isinstance(changes.get("progress"), (int, float)):
                share = max(0.0, min(100.0, float(changes["progress"]))) / 100
                changes["progress"] = round(self._low + (self._high - self._low) * share)
            changes = {**self._step, **changes}
        return self._jobs.update(identifier, **changes)

    def __getattr__(self, name):
        return getattr(self._jobs, name)
