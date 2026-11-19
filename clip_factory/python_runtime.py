"""App-owned, checksum-pinned native Python; never installs Homebrew/system packages.

One pinned python-build-standalone archive per supported platform (Apple Silicon macOS, Windows x64,
Linux x64); every archive was downloaded and its size and SHA-256 checked before pinning.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import ssl
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path, PurePosixPath

import certifi

from . import speech_backend
from .jobs import Jobs, WorkError

# Publisher release metadata and archive independently verified before pinning.
PYTHON_VERSION = "3.12.16"
PYTHON_RELEASE = "20261110"
PYTHON_URL = (
    "https://github.com/astral-sh/python-build-standalone/releases/download/20261110/"
    "cpython-3.12.16%2B20261110-aarch64-apple-darwin-install_only_stripped.tar.gz"
)
PYTHON_SHA256 = "2f11b8aa3726bdbd87dd9eb76568412faddf4f47e26913fa45d6a2e424972acd"
PYTHON_BYTES = 25_237_581
MAX_EXPANDED_BYTES = 512 * 1024**2
MANIFEST = {"version": PYTHON_VERSION, "release": PYTHON_RELEASE, "sha256": PYTHON_SHA256}
PROBE = "import platform,sys; print(platform.system(), platform.machine(), sys.version_info[:2])"
_RELEASES = "https://github.com/astral-sh/python-build-standalone/releases/download/20261110/"
# Windows and Linux x64 builds from the same release as the macOS pin above.
OTHER_PINS = {
    ("Windows", "x86_64"): {
        "url": _RELEASES + "cpython-3.12.16%2B20261110-x86_64-pc-windows-msvc-install_only_stripped.tar.gz",
        "sha256": "355ee61b8207b91574491b1c6dc9b0ebb4408fc56bfafe498f3ef439314b52dc",
        "bytes": 22_365_213,
        "executable": ("python.exe",),
        "probe": "Windows AMD64 (3, 12)",
        "suffix": "x86_64-windows",
        "label": "Windows x64",
    },
    ("Linux", "x86_64"): {
        "url": _RELEASES + "cpython-3.12.16%2B20261110-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
        "sha256": "6a9e62dad033790aef722dbd370e0ce76ce17b73627ba3ae679f537049350b39",
        "bytes": 34_709_145,
        "executable": ("bin", "python3.12"),
        "probe": "Linux x86_64 (3, 12)",
        "suffix": "x86_64-linux",
        "label": "Linux x64",
    },
}


def pin(system: str | None = None, machine: str | None = None) -> dict | None:
    """The pinned Python archive for this platform, or None where no private Python is offered."""
    if system is None or machine is None:
        system, machine = speech_backend.host()
    key = (system, speech_backend.normal_machine(machine))
    if key == ("Darwin", "arm64"):
        # Read the module values at call time (tests replace them); the marker shape never changes.
        return {
            "url": PYTHON_URL, "sha256": PYTHON_SHA256, "bytes": PYTHON_BYTES,
            "executable": ("bin", "python3.12"), "probe": "Darwin arm64 (3, 12)", "suffix": "arm64",
            "label": "Apple Silicon", "manifest": MANIFEST,
        }
    found = OTHER_PINS.get(key)
    if found is None:
        return None
    return {**found, "manifest": {"version": PYTHON_VERSION, "release": PYTHON_RELEASE, "sha256": found["sha256"]}}


def _current() -> dict:
    found = pin()
    if found is None:
        raise WorkError("No app-owned Python is available for this computer's operating system and processor.")
    return found


def native_python(executable: Path | str, env: dict) -> bool:
    """A native (not emulated) Python 3.12 for this platform, e.g. never Rosetta on a Mac."""
    found = pin()
    if found is None:
        return False
    try:
        result = subprocess.run(
            [str(executable), "-I", "-c", PROBE],
            capture_output=True,
            text=True,
            timeout=15,
            check=True,
            env=env,
        )
        return result.stdout.strip() == found["probe"]
    except (OSError, subprocess.SubprocessError):
        return False


def _download(archive: Path, jobs: Jobs, job_id: str, found: dict | None = None):
    found = found or _current()
    expected = found["bytes"]
    digest, downloaded = hashlib.sha256(), 0
    request = urllib.request.Request(found["url"], headers={"User-Agent": "ClipFactory-runtime-setup"})
    with (
        urllib.request.urlopen(
            request, timeout=30, context=ssl.create_default_context(cafile=certifi.where())
        ) as response,
        archive.open("xb") as output,
    ):
        if not response.geturl().startswith("https://"):
            raise WorkError("Python download must use a secure connection.")
        while True:
            jobs.check(job_id)
            block = response.read(256 * 1024)
            if not block:
                break
            downloaded += len(block)
            if downloaded > expected:
                raise WorkError("Python download exceeded its verified size.")
            output.write(block)
            digest.update(block)
            jobs.update(
                job_id,
                progress=1 + round(downloaded / expected * 9),
                message=f"Downloading app-owned Python 3.12 ({downloaded:,}/{expected:,} bytes)",
            )
    jobs.check(job_id)
    if downloaded != expected or digest.hexdigest() != found["sha256"]:
        raise WorkError("Python download failed checksum verification. Retry runtime setup.")


def _extract(archive: Path, directory: Path, jobs: Jobs, job_id: str):
    """Accept only the pinned distribution's tree and links confined to that tree."""
    root = (directory / "python").resolve()
    with tarfile.open(archive, "r:gz") as bundle:
        size, seen, members = 0, set(), []
        for member in bundle:
            jobs.check(job_id)
            parts = PurePosixPath(member.name).parts
            if (
                not parts
                or parts[0] != "python"
                or any(p in {"..", "."} for p in parts)
                or "\\" in member.name
            ):
                raise WorkError("Python archive contains an unsafe path.")
            if member.name in seen or len(seen) >= 10_000:
                raise WorkError("Python archive contains duplicate or excessive entries.")
            seen.add(member.name)
            size += member.size
            if size > MAX_EXPANDED_BYTES or not (member.isdir() or member.isfile() or member.issym()):
                raise WorkError("Python archive contains unsupported content.")
            if member.issym():
                if PurePosixPath(member.linkname).is_absolute() or "\\" in member.linkname:
                    raise WorkError("Python archive contains an unsafe link.")
                target = (directory / member.name).parent / member.linkname
                if not target.resolve().is_relative_to(root):
                    raise WorkError("Python archive link escapes its installation.")
            members.append(member)
        for member in members:
            jobs.check(job_id)
            if not (directory / member.name).resolve().is_relative_to(root):
                raise WorkError("Python archive path escapes its installation.")
            bundle.extract(member, directory, filter="data")


def bootstrap_python(directory: Path, jobs: Jobs, job_id: str, env: dict) -> Path:
    """Install privately and atomically; a failed/cancelled install is never selected."""
    found = _current()
    parent = directory / "python"
    target = parent / f"cpython-{PYTHON_VERSION}-{PYTHON_RELEASE}-{found['suffix']}"
    executable = target.joinpath(*found["executable"])
    marker = target / ".clip-factory-python.json"
    jobs.check(job_id)
    if directory.is_symlink() or parent.is_symlink() or target.is_symlink():
        raise WorkError("Python installation directory must not be a symlink.")
    parent.mkdir(mode=0o700, exist_ok=True)
    if target.exists():
        try:
            if (
                not marker.is_symlink()
                and not executable.is_symlink()
                and json.loads(marker.read_text()) == found["manifest"]
                and native_python(executable, env)
            ):
                return executable
        except (OSError, ValueError):
            pass
        # Do not replace a base interpreter which an existing venv may still use.
        raise WorkError(
            "The app-owned Python installation is damaged. Restore or remove its folder before retrying runtime setup."
        )
    if shutil.disk_usage(parent).free < MAX_EXPANDED_BYTES:
        raise WorkError("Free at least 512 MB before downloading the app-owned Python runtime.")
    jobs.update(
        job_id,
        progress=1,
        message="Preparing private Python 3.12 download — no Homebrew or administrator access",
    )
    try:
        with tempfile.TemporaryDirectory(prefix=".install-", dir=parent) as temporary:
            staging = Path(temporary)
            archive = staging / "python.tar.gz"
            _download(archive, jobs, job_id, found)
            jobs.update(job_id, progress=11, message="Verifying and extracting app-owned Python")
            _extract(archive, staging, jobs, job_id)
            staged_python = (staging / "python").joinpath(*found["executable"])
            if staged_python.is_symlink() or not native_python(staged_python, env):
                raise WorkError(f"Downloaded Python is not a working native {found['label']} Python 3.12.")
            jobs.check(job_id)
            (staging / "python" / marker.name).write_text(json.dumps(found["manifest"]))
            os.replace(staging / "python", target)
    except (OSError, tarfile.TarError) as exc:
        raise WorkError(
            "App-owned Python setup failed. Check network and writable disk space, then retry runtime setup."
        ) from exc
    return executable
