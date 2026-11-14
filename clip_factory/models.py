"""Opt-in model catalogue and isolated Apple Silicon runtime."""

from __future__ import annotations

import inspect
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path, PurePosixPath

import psutil

from .jobs import Jobs, WorkError
from .python_runtime import bootstrap_python, native_python

# Opt out before huggingface_hub first import: HTTP tqdm hooks support cancellation.
os.environ["HF_HUB_DISABLE_XET"] = "1"

RUNTIME_VERSIONS = {"mlx-vlm": "0.7.12", "mlx-whisper": "0.4.3", "kokoro": "0.9.4"}
RUNTIME_PROBE = """
import json, platform, sys
from importlib.metadata import version
import mlx.core, mlx_vlm, mlx_whisper, kokoro, spacy
spacy.load('en_core_web_sm')
print(json.dumps({'system': platform.system(), 'machine': platform.machine(),
                 'python': list(sys.version_info[:2]),
                 'packages': {n: version(n) for n in ('mlx-vlm', 'mlx-whisper', 'kokoro')}}))
"""


def child_env() -> dict:
    """Do not pass application/API credentials to third-party inference packages."""
    return {
        **{
            k: v
            for k, v in os.environ.items()
            if not k.upper().endswith(("_TOKEN", "_KEY", "_SECRET", "_PASSWORD"))
            and k.upper()
            not in {
                "HF_TOKEN",
                "HUGGING_FACE_HUB_TOKEN",
                "AWS_ACCESS_KEY_ID",
                "AWS_SECRET_ACCESS_KEY",
                "GOOGLE_APPLICATION_CREDENTIALS",
                "PYTHONHOME",
                "PYTHONPATH",
                "VIRTUAL_ENV",
                "__PYVENV_LAUNCHER__",
                "DYLD_LIBRARY_PATH",
                "DYLD_FRAMEWORK_PATH",
                "DYLD_INSERT_LIBRARIES",
                "LD_LIBRARY_PATH",
            }
        },
        "HF_HUB_OFFLINE": "1",
        "HF_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_HUB_DISABLE_XET": "1",
        "TOKENIZERS_PARALLELISM": "false",
    }


def safe_file(root: Path, name: str) -> Path:
    if not isinstance(name, str) or not name or "\\" in name:
        raise ValueError("Unsafe model path")
    parts = name.split("/")
    if any(p in {"", ".", ".."} or p.startswith(".") or ":" in p for p in parts):
        raise ValueError("Reserved or unsafe model path")
    if PurePosixPath(name).is_absolute() or root.is_symlink():
        raise ValueError("Unsafe model path")
    path = root
    for part in parts:
        path = path / part
        if path.is_symlink():
            raise ValueError("Model symlinks are not allowed")
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("Unsafe model path")
    return path


def atomic_json(path: Path, value: dict):
    temporary = path.with_name(path.name + ".tmp")
    temporary.unlink(missing_ok=True)
    temporary.write_text(json.dumps(value, allow_nan=False), encoding="utf-8")
    temporary.chmod(0o600)
    os.replace(temporary, path)


def validate_manifest(target: Path, manifest: dict, repo: str, identifier: str, *, verify=True):
    if not isinstance(manifest, dict) or manifest.get("repo") != repo:
        raise ValueError("Wrong repository")
    if not re.fullmatch(r"[0-9a-f]{40,64}", manifest.get("revision", "")):
        raise ValueError("Missing immutable revision")
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise ValueError("No files")
    names = set()
    for entry in files:
        name, size = entry["name"], entry["size"]
        path = safe_file(target, name)
        if name in names or type(size) is not int or size <= 0:
            raise ValueError("Invalid file metadata")
        names.add(name)
        if verify and (not path.is_file() or path.stat().st_size != size):
            raise ValueError("Incomplete model file")
    required = {"config.json"}
    if identifier == "kokoro":
        required |= {"kokoro-v1_0.pth", "voices/af_heart.pt"}
    if identifier == "whisper-turbo":
        required.add("weights.npz")
    has_weights = (
        any(n.endswith(".safetensors") for n in names)
        if identifier.startswith("qwen-")
        else bool(names & {"weights.npz", "kokoro-v1_0.pth"})
    )
    if not required <= names or not has_weights:
        raise ValueError("Required config or weights missing")
    if verify:
        if not isinstance(json.loads((target / "config.json").read_text()), dict):
            raise ValueError("Invalid model config")
        for name in names:
            if name.endswith(".index.json"):
                index = json.loads(safe_file(target, name).read_text())
                if not isinstance(index, dict):
                    raise ValueError("Invalid shard index")
                mapping = index.get("weight_map")
                if not isinstance(mapping, dict) or not mapping:
                    raise ValueError("Invalid shard index")
                for shard in mapping.values():
                    safe_file(target, shard)
                    if shard not in names or not shard.endswith((".safetensors", ".npz", ".pth")):
                        raise ValueError("Missing indexed shard")


CATALOG = [
    {
        "id": "qwen-small",
        "name": "Qwen3.5 9B · 4-bit",
        "repo": "mlx-community/Qwen3.5-9B-MLX-4bit",
        "kind": "llm",
        "license": "Apache-2.0 (check upstream terms)",
        "estimated_gb": 6,
    },
    {
        "id": "qwen-large",
        "name": "Qwen3.5 35B-A3B · 4-bit",
        "repo": "mlx-community/Qwen3.5-35B-A3B-4bit",
        "kind": "llm",
        "license": "Apache-2.0 (check upstream terms)",
        "estimated_gb": 24,
    },
    {
        "id": "whisper-turbo",
        "name": "Whisper large-v3-turbo · MLX",
        "repo": "mlx-community/whisper-large-v3-turbo",
        "kind": "asr",
        "license": "MIT (OpenAI upstream)",
        "estimated_gb": 2,
    },
    {
        "id": "kokoro",
        "name": "Kokoro 82M · narration",
        "repo": "hexgrad/Kokoro-82M",
        "kind": "tts",
        "license": "Apache-2.0",
        "estimated_gb": 0.5,
    },
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
        try:
            if self.runtime.is_symlink() or not self.python.is_file():
                return False
            marker = json.loads((self.runtime / ".ready").read_text())
            if marker != {"python": [3, 12], "machine": "arm64", "packages": RUNTIME_VERSIONS}:
                return False
            probe = subprocess.run(
                [str(self.python), "-c", RUNTIME_PROBE],
                env=child_env(),
                capture_output=True,
                text=True,
                timeout=90,
                check=True,
            )
            actual = json.loads(probe.stdout)
            return actual == {**marker, "system": "Darwin"}
        except (OSError, ValueError, subprocess.SubprocessError):
            return False

    def item(self, identifier: str) -> dict:
        item = next((m for m in CATALOG if m["id"] == identifier), None)
        if not item:
            raise WorkError("Unknown model.")
        path = self.model_dir / identifier
        installed = False
        try:
            if path.is_symlink() or (path / ".complete").is_symlink():
                raise ValueError("Unsafe manifest")
            if (path / ".complete").stat().st_size > 1024**2:
                raise ValueError("Manifest too large")
            validate_manifest(path, json.loads((path / ".complete").read_text()), item["repo"], identifier)
            installed = True
        except (OSError, ValueError, TypeError, KeyError):
            pass
        return {**item, "installed": installed, "status": "installed" if installed else "not installed"}

    def catalog(self) -> list[dict]:
        return [self.item(m["id"]) for m in CATALOG]

    def setup(self, job_id: str) -> dict:
        if not apple_silicon():
            raise WorkError(
                "MLX inference requires native Apple Silicon macOS. Manual editing works on this machine."
            )
        candidates = [shutil.which("python3.12")]
        if not getattr(sys, "frozen", False) and sys.version_info[:2] == (3, 12):
            candidates.append(sys.executable)
        python = None
        for candidate in filter(None, candidates):
            self.jobs.check(job_id)
            if native_python(candidate, child_env()):
                python = candidate
                break
        if not python:
            python = str(bootstrap_python(self.root, self.jobs, job_id, child_env()))
        self.jobs.check(job_id)
        # Never overlay an old venv (it may be Rosetta or a different Python version).
        if self.runtime.is_symlink():
            raise WorkError("Runtime directory must not be a symlink.")
        if self.runtime.exists():
            shutil.rmtree(self.runtime)
        self.jobs.update(job_id, progress=15, message="Creating isolated Python runtime")
        self.jobs.process(
            job_id,
            [python, "-m", "venv", str(self.runtime)],
            env=child_env(),
            timeout=180,
            failure="Cannot create runtime. Ensure the app data directory is writable and retry setup.",
        )
        self.jobs.update(
            job_id, progress=20, message="Installing MLX vision, Whisper, and Kokoro (network download)"
        )
        self.jobs.process(
            job_id,
            [
                str(self.python),
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "mlx-vlm==0.7.12",
                "mlx-whisper==0.4.3",
                "kokoro==0.9.4",
                "soundfile>=0.13,<1",
                "https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl",
            ],
            env={**child_env(), "HF_HUB_OFFLINE": "0", "TRANSFORMERS_OFFLINE": "0"},
            timeout=1800,
            log_path=self.logs / f"{job_id}.log",
            failure="Runtime install failed. Open the local logs folder; verify native Python 3.12, network, and disk space.",
        )
        self.jobs.process(
            job_id,
            [str(self.python), "-c", RUNTIME_PROBE],
            env=child_env(),
            timeout=90,
            failure="Runtime imports failed. Check package compatibility and native Apple Silicon Python.",
        )
        atomic_json(
            self.runtime / ".ready", {"python": [3, 12], "machine": "arm64", "packages": RUNTIME_VERSIONS}
        )
        if not self.ready():
            (self.runtime / ".ready").unlink(missing_ok=True)
            raise WorkError("Runtime verification failed. Native Apple Silicon Python 3.12 is required.")
        return {"runtime": "ready", "path": str(self.runtime)}

    def download(self, job_id: str, identifier: str) -> dict:
        from huggingface_hub import HfApi, constants, hf_hub_download
        from tqdm.auto import tqdm

        if "tqdm_class" not in inspect.signature(hf_hub_download).parameters:
            raise WorkError(
                "This Hugging Face client cannot provide cancellable HTTP downloads. "
                "Upgrade huggingface-hub to a version supporting hf_hub_download(tqdm_class=...)."
            )
        # Also handle another module having imported the hub before this module.
        constants.HF_HUB_DISABLE_XET = True
        item = self.item(identifier)
        target = self.model_dir / identifier
        if target.is_symlink():
            raise WorkError("Model directory must not be a symlink.")
        target.mkdir(exist_ok=True)
        (target / ".complete").unlink(missing_ok=True)
        self.jobs.check(job_id)
        try:
            pending = target / ".download.json"
            revision = None
            if pending.exists():
                if pending.is_symlink():
                    raise ValueError("Unsafe resume manifest")
                previous = json.loads(pending.read_text())
                validate_manifest(target, previous, item["repo"], identifier, verify=False)
                revision = previous["revision"]
            info = HfApi().model_info(item["repo"], revision=revision, files_metadata=True)
            files = []
            for sibling in info.siblings:
                name = sibling.rfilename
                if name not in {".gitattributes", ".gitignore"}:
                    safe_file(target, name)
                selected = name.endswith(
                    (".json", ".safetensors", ".txt", ".model", ".jinja", ".tiktoken", ".npz")
                )
                if identifier == "kokoro":
                    selected = name in {"config.json", "kokoro-v1_0.pth", "voices/af_heart.pt"}
                if selected:
                    files.append({"name": name, "size": sibling.size})
            files.sort(key=lambda entry: entry["name"])
            manifest = {"repo": item["repo"], "revision": info.sha, "files": files}
            validate_manifest(target, manifest, item["repo"], identifier, verify=False)
            if revision and manifest != previous:
                raise ValueError("Pinned metadata changed")
            atomic_json(pending, manifest)
            total = sum(f["size"] for f in files)
            completed = 0
            jobs = self.jobs

            class CancelProgress(tqdm):
                def __init__(bar, *args, **kwargs):
                    jobs.check(job_id)
                    kwargs["disable"] = True
                    super().__init__(*args, **kwargs)
                    bar.last_progress = -1

                def update(bar, n=1):
                    jobs.check(job_id)
                    result = super().update(n)
                    # tqdm disable skips n accounting, so account explicitly.
                    bar.n += n
                    downloaded = min(total, completed + bar.n)
                    progress = min(95, round(downloaded / total * 95))
                    if progress != bar.last_progress:
                        jobs.update(
                            job_id,
                            progress=progress,
                            message=f"Downloading model weights ({downloaded:,}/{total:,} bytes)",
                        )
                        bar.last_progress = progress
                    return result

            for entry in files:
                self.jobs.check(job_id)
                path = safe_file(target, entry["name"])
                existing = path.stat().st_size if path.is_file() else 0
                needed = entry["size"] if existing != entry["size"] else 0
                for cache in (target / ".cache", target / ".cache" / "huggingface"):
                    if cache.is_symlink():
                        raise ValueError("Unsafe download cache")
                if shutil.disk_usage(target).free < needed + 64 * 1024**2:
                    raise WorkError("Not enough disk space to download the next model file.")
                self.jobs.update(
                    job_id, progress=round(completed / total * 95), message=f"Downloading {entry['name']}"
                )
                hf_hub_download(
                    item["repo"],
                    entry["name"],
                    revision=info.sha,
                    local_dir=target,
                    tqdm_class=CancelProgress,
                )
                completed += entry["size"]
                self.jobs.update(
                    job_id, progress=round(completed / total * 95), message="Verifying downloaded model files"
                )
            self.jobs.check(job_id)
            validate_manifest(target, manifest, item["repo"], identifier)
            atomic_json(target / ".complete", manifest)
            pending.unlink(missing_ok=True)
        except Exception as exc:
            (target / ".complete").unlink(missing_ok=True)
            self.jobs.check(job_id)  # preserve cancellation even if the library wrapped it
            if isinstance(exc, WorkError):
                raise
            raise WorkError(
                "Model download or verification failed; retry resumes the pinned revision. No installation was recorded."
            ) from exc
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
            raise WorkError(
                "Not enough currently available memory. Close other apps or use the smaller model."
            )

    def run(self, job_id: str, identifier: str, action: str, **payload) -> dict:
        if action not in {"generate", "transcribe", "narrate"}:
            raise WorkError("Unsupported inference action.")
        from .inference_worker import validate_request

        data = {**payload, "action": action, "model": str(self.model_dir / identifier)}
        try:
            validate_request(data)
        except (ValueError, TypeError, KeyError) as exc:
            raise WorkError("Inference input exceeds limits or is invalid.") from exc
        self.require(identifier, {"generate": "llm", "transcribe": "asr", "narrate": "tts"}[action])
        worker = Path(__file__).with_name("inference_worker.py")
        if not worker.is_file():
            raise WorkError(
                "Packaged inference worker is missing. Rebuild the Mac app with its worker data file."
            )
        scratch = self.root / "work" / job_id
        scratch.mkdir(parents=True, exist_ok=True)
        request = scratch / "request.json"
        response = scratch / "response.json"
        response.unlink(missing_ok=True)
        request.write_text(
            json.dumps(data, allow_nan=False),
            encoding="utf-8",
        )
        request.chmod(0o600)
        env = child_env()
        self.jobs.update(
            job_id, progress=35, message=f"Running {identifier} locally; model unloads after this task"
        )
        try:
            self.jobs.process(
                job_id,
                [str(self.python), str(worker), str(request), str(response)],
                env=env,
                timeout=1800,
                log_path=self.logs / f"{job_id}.log",
                failure="Local inference failed. Check local logs, memory, and the installed runtime/model. No output was fabricated.",
            )
        finally:
            request.unlink(missing_ok=True)
        if not response.exists():
            raise WorkError("Inference worker returned no result.")
        try:
            if response.stat().st_size > 4 * 1024**2:
                raise ValueError("Oversized response")
            from .inference_worker import json_value

            result = json_value(
                json.loads(
                    response.read_text(encoding="utf-8"),
                    parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
                )
            )
            if not isinstance(result, dict):
                raise TypeError("Invalid response")
            return result
        except (OSError, ValueError, TypeError) as exc:
            raise WorkError("Inference worker returned an invalid result.") from exc
