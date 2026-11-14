"""Read-only, conservative admission check for the local learning analyst.

This is a snapshot estimate, not a memory reservation or model-quality check.
Call immediately before each inference, including repair calls. No inference,
metadata discovery, downloads, credentials or application termination occur here.
"""

from __future__ import annotations

import platform
import subprocess
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass
from typing import Any

import psutil

GIB = 1024**3
MIN_AVAILABLE_BYTES = 6 * GIB
RUNTIME_RESERVE_BYTES = 3 * GIB
MAX_CONTEXT_TOKENS = 8192
MIN_CONTEXT_TOKENS = 2048


@dataclass(frozen=True)
class ResourceReadiness:
    ready: bool
    reasons: tuple[str, ...]
    required_available_bytes: int
    observed_available_bytes: int | None
    memory_pressure: str
    context_tokens: int

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible snapshot without provider/model details."""
        value = asdict(self)
        value["reasons"] = list(self.reasons)
        return value


def read_macos_memory_pressure() -> str:
    """Read kernel pressure (1 normal, 2 warning, 4 critical), never reclaim RAM.

    Unsupported platforms return unknown. Command/timeout errors are handled by
    the admission check; no error output is exposed to callers.
    """
    if platform.system() != "Darwin":
        return "unknown"
    result = subprocess.run(
        ["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level"],
        capture_output=True, text=True, check=True, timeout=1,
    )
    return _pressure(result.stdout.strip())


def _pressure(value: Any) -> str:
    if type(value) is int:
        return {1: "normal", 2: "warning", 4: "critical"}.get(value, "unknown")
    if isinstance(value, str):
        return {"1": "normal", "2": "warning", "4": "critical", "normal": "normal",
                "warning": "warning", "critical": "critical"}.get(value.strip().lower(), "unknown")
    return "unknown"


def _positive_bytes(value: Any) -> bool:
    return type(value) is int and value > 0


def check_learning_resources(
    model_metadata: Mapping[str, Any] | None,
    *,
    memory_reader: Callable[[], Any] = psutil.virtual_memory,
    pressure_reader: Callable[[], Any] = read_macos_memory_pressure,
    context_tokens: int = MAX_CONTEXT_TOKENS,
) -> ResourceReadiness:
    """Hold unless metadata, available RAM, pressure and context all pass.

    `model_metadata` must describe the selected model using positive integer
    `weights_bytes` or Ollama's `size` bytes. Explicit `weights_bytes` takes
    precedence, including invalid values. Names/parameter counts/rounded GB
    estimates alone cannot establish this budget. Memory readers return psutil
    stats or a mapping with integer `available` and `total` byte counts. Pressure
    readers return kernel levels 1/2/4 or normal/warning/critical strings.

    Required RAM is max(6 GiB, weights + 3 GiB), without discounting supposedly
    resident weights. There is no way to bypass the floor via injected metadata.
    A valid context is returned unchanged; invalid requests hold and report the
    safe default. Callers must never infer after a held result.
    """
    reasons: list[str] = []
    required = MIN_AVAILABLE_BYTES
    try:
        weights = (model_metadata.get("weights_bytes") if "weights_bytes" in model_metadata
                   else model_metadata.get("size")) if isinstance(model_metadata, Mapping) else None
        if not _positive_bytes(weights):
            raise ValueError("Unknown model size")
        required = max(required, weights + RUNTIME_RESERVE_BYTES)
    except Exception:  # noqa: BLE001 - untrusted metadata must hold without exposing details
        reasons.append("Learning is paused because the selected model's size is unknown. Refresh model details.")

    if type(context_tokens) is not int or not MIN_CONTEXT_TOKENS <= context_tokens <= MAX_CONTEXT_TOKENS:
        reasons.append("Learning is paused: set the model context between 2,048 and 8,192 tokens.")
        context_tokens = MAX_CONTEXT_TOKENS

    available = None
    try:
        memory = memory_reader()
        observed = memory.get("available") if isinstance(memory, Mapping) else memory.available
        total = memory.get("total") if isinstance(memory, Mapping) else memory.total
        if type(observed) is not int or observed < 0 or not _positive_bytes(total) or observed > total:
            raise ValueError("Invalid memory telemetry")
        available = observed
        if available < required:
            reasons.append(
                f"Learning is paused: about {required / GIB:.1f} GiB available memory is required; "
                f"{available / GIB:.1f} GiB is available. Close other heavy apps, then try again."
            )
    except Exception:  # noqa: BLE001 - OS/provider exception text can contain private details
        reasons.append("Learning is paused because available memory could not be verified. Try again shortly.")

    pressure = "unknown"
    try:
        pressure = _pressure(pressure_reader())
    except Exception:  # noqa: BLE001 - inability to observe pressure must fail closed
        pressure = "unknown"
    if pressure in {"warning", "critical"}:
        reasons.append(f"Learning is paused because this Mac reports {pressure} memory pressure. Try again later.")
    elif pressure != "normal":
        reasons.append("Learning is paused because memory pressure could not be verified. Try again shortly.")

    return ResourceReadiness(
        ready=not reasons,
        reasons=tuple(reasons),
        required_available_bytes=required,
        observed_available_bytes=available,
        memory_pressure=pressure,
        context_tokens=context_tokens,
    )
