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
import threading
import time
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

import psutil

from .jobs import Jobs, WorkError
from .ollama import Ollama, OllamaError, is_ollama, model_name
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


# Speech production imports only Whisper/MLX. Optional vision/narration dependencies
# must not turn a healthy speech engine into a misleading full-bundle repair request.
ASR_RUNTIME_PROBE = RUNTIME_PROBE.replace(
    "import mlx.core, mlx_vlm, mlx_whisper, kokoro, spacy\nspacy.load('en_core_web_sm')",
    "import mlx.core, mlx_whisper",
)


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
    has_weights = (
        any(n.endswith(".safetensors") for n in names)
        if identifier.startswith("qwen-")
        else bool(names & {"weights.npz", "weights.safetensors"})
        if identifier == "whisper-turbo"
        else "kokoro-v1_0.pth" in names
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
        self._download_lock = threading.RLock()
        self._download_reservations: dict[str, int] = {}
        self._ready_lock = threading.Lock()
        self._ready_cache = None
        self._asr_ready_cache = None
        self.ollama = Ollama()

    @property
    def python(self) -> Path:
        return self.runtime / "bin" / "python"

    def ready(self, *, force=False, kind=None) -> bool:
        # UI polling and preflight calls share one probe, not dozens of simultaneous
        # MLX/Torch/spaCy imports. Marker/interpreter changes invalidate the cache.
        cache_name = "_asr_ready_cache" if kind == "asr" else "_ready_cache"
        probe_code = ASR_RUNTIME_PROBE if kind == "asr" else RUNTIME_PROBE
        with self._ready_lock:
            key = None
            try:
                marker_path = self.runtime / ".ready"
                if self.runtime.is_symlink() or marker_path.is_symlink() or not self.python.is_file():
                    setattr(self, cache_name, None)
                    return False
                marker_stat, python_stat = marker_path.stat(), self.python.stat()
                if marker_stat.st_size > 4096:
                    return False
                marker = json.loads(marker_path.read_text())
                if marker != {"python": [3, 12], "machine": "arm64", "packages": RUNTIME_VERSIONS}:
                    setattr(self, cache_name, None)
                    return False
                key = (
                    marker_stat.st_ino,
                    marker_stat.st_mtime_ns,
                    marker_stat.st_size,
                    python_stat.st_ino,
                    python_stat.st_mtime_ns,
                    python_stat.st_size,
                )
                if not force and getattr(self, cache_name):
                    cached_key, expires, value = getattr(self, cache_name)
                    if key == cached_key and time.monotonic() < expires:
                        return value
                probe = subprocess.run(
                    [str(self.python), "-c", probe_code],
                    env=child_env(),
                    capture_output=True,
                    text=True,
                    timeout=90,
                    check=True,
                )
                actual = json.loads(probe.stdout)
                value = actual == {**marker, "system": "Darwin"}
                setattr(self, cache_name, (key, time.monotonic() + (60 if value else 5), value))
                return value
            except (OSError, ValueError, subprocess.SubprocessError):
                setattr(self, cache_name, (key, time.monotonic() + 5, False) if key else None)
                return False

    @staticmethod
    def _ollama_item(info: dict) -> dict:
        details = " · ".join(filter(None, [info["parameter_size"], info["quantization"]]))
        return {
            "id": f"ollama:{info['name']}",
            "name": f"{info['name']} · Ollama" + (f" ({details})" if details else ""),
            "repo": "Managed by Ollama on this Mac",
            "kind": "llm",
            "license": "See `ollama show --license` for this model",
            "estimated_gb": round(info["size"] / 1e9, 1) if info["size"] else None,
            "installed": True,
            "status": "Ready via Ollama",
            "source": "ollama",
            "vision": info["vision"],
        }

    def item(self, identifier: str) -> dict:
        if is_ollama(identifier):
            try:
                name = model_name(identifier)
            except OllamaError as exc:
                raise WorkError(str(exc)) from exc
            status = self.ollama.status()
            if not status["running"]:
                raise WorkError("Ollama is not running. Open the Ollama app or run `ollama serve`.")
            info = self.ollama.model(name)
            if info is None:
                raise WorkError("That Ollama model is not available locally. Run `ollama list` to check.")
            return self._ollama_item(info)
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
        # A recorded install whose files no longer verify (removed or truncated on disk) is damaged:
        # it needs a repair download, not a first install.
        damaged = not installed and (path / ".complete").is_file()
        return {
            **item,
            "installed": installed,
            "integrity": "ok" if installed else "damaged" if damaged else "missing",
            "status": "installed" if installed else "damaged" if damaged else "not installed",
        }

    def metallibs(self) -> list[Path]:
        return list(self.runtime.glob("lib/python3*/site-packages/mlx/lib/mlx.metallib"))

    def integrity(self) -> dict:
        """Cheap file checks (no imports): is the runtime and the speech model still on disk?

        "missing" means never set up; "damaged" means set up once but files were removed since.
        """
        whisper = self.item("whisper-turbo")
        state = whisper.get("integrity") or ("ok" if whisper.get("installed") else "missing")
        return {
            "runtime": self.runtime_integrity(),
            "whisper-turbo": {"state": state, "problems": ["files"] if state == "damaged" else []},
        }

    def runtime_integrity(self) -> dict:
        problems = []
        if self.runtime.is_symlink():
            problems.append("runtime symlink")
        elif (self.runtime / ".ready").is_file():
            if not self.python.is_file():
                problems.append("python")
            packages = list(self.runtime.glob("lib/python3*/site-packages/mlx"))
            if packages and not self.metallibs():
                problems.append("mlx.metallib")
        runtime_state = (
            "damaged" if problems else "ok" if (self.runtime / ".ready").is_file() else "missing"
        )
        return {"state": runtime_state, "problems": problems}

    def catalog(self) -> list[dict]:
        local = [self._ollama_item(m) for m in self.ollama.status()["models"]]
        return [self.item(m["id"]) for m in CATALOG] + local

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

    @contextmanager
    def _download_space(self, job_id: str, target: Path, needed: int):
        # Other concurrent transfers may not yet have written their reserved bytes.
        with self._download_lock:
            if (
                shutil.disk_usage(target).free
                < needed + sum(self._download_reservations.values()) + 64 * 1024**2
            ):
                raise WorkError("Not enough free disk space for concurrent model downloads.")
            self._download_reservations[job_id] = needed
        try:
            yield
        finally:
            with self._download_lock:
                self._download_reservations.pop(job_id, None)

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
                with self._download_space(job_id, target, needed):
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
        if item.get("source") == "ollama":
            return  # Ollama schedules its own memory and does not need the MLX runtime.
        if not item["installed"]:
            if item.get("integrity") == "damaged":
                raise WorkError("This model's files are damaged or were removed — repair (re-download) it in Models.")
            raise WorkError("Download and accept this model's license in Models first.")
        if self.runtime_integrity()["state"] == "damaged":
            raise WorkError(
                "The local inference runtime's files are damaged or were removed — repair (reinstall) it in Models."
            )
        if not (self.ready(kind="asr") if kind == "asr" else self.ready()):
            raise WorkError("Set up the local inference runtime in Models first.")
        if not apple_silicon():
            raise WorkError("This inference runtime requires Apple Silicon macOS.")
        if psutil.virtual_memory().available < (item["estimated_gb"] + 3) * 1e9:
            raise WorkError(
                "Not enough currently available memory. Close other apps or use the smaller model."
            )

    def release_warm(self, identifier: str):
        if is_ollama(identifier):
            from .ollama import model_name

            try:
                self.ollama.unload(model_name(identifier))
            except OllamaError:
                return  # Cleanup must not erase a completed result or original task failure.

    def vision(self, identifier: str) -> bool:
        """Whether this LLM can read frames. Both MLX shelf models are vision-language models."""
        if is_ollama(identifier):
            try:
                info = self.ollama.model(model_name(identifier))
            except OllamaError:
                return False
            return bool(info and info["vision"])
        return any(m["id"] == identifier and m["kind"] == "llm" for m in CATALOG)

    def run_batch(self, job_id: str, identifier: str, requests: list[dict]) -> list[dict]:
        """Several generations with one model load. Each result is {"output": text} or {"error": ...}."""
        if not requests:
            return []
        if is_ollama(identifier):
            from .inference_worker import validate_generation

            try:
                for request in requests:
                    validate_generation(request)
            except (ValueError, TypeError, KeyError) as exc:
                raise WorkError("Inference input exceeds limits or is invalid.") from exc
            self.require(identifier, "llm")
            name = model_name(identifier)
            results = []
            for index, request in enumerate(requests):
                self.jobs.check(job_id)
                try:
                    text = self.ollama.generate(
                        name,
                        request["prompt"],
                        images=request.get("images", []),
                        image_labels=request.get("image_labels"),
                        schema=request.get("schema"),
                        temperature=request.get("temperature", 0.3),
                        max_tokens=request.get("max_tokens", 1500),
                        keep_alive="5m" if index + 1 < len(requests) else 0,
                        check=lambda: self.jobs.check(job_id),
                    )
                    self._log_ollama(job_id, name, text)
                    results.append({"output": text})
                except OllamaError as exc:
                    self._log_ollama(job_id, name, f"ERROR: {exc}")
                    if index == 0:
                        raise WorkError(f"{exc} No output was fabricated.") from exc
                    results.append({"error": str(exc)[:300]})
            return results
        result = self.run(job_id, identifier, "batch", requests=requests)
        outputs = result.get("outputs")
        if not isinstance(outputs, list) or len(outputs) != len(requests):
            raise WorkError("Inference worker returned an incomplete batch.")
        return [o if isinstance(o, dict) else {"error": "Invalid result"} for o in outputs]

    def run(self, job_id: str, identifier: str, action: str, *, keep_warm: bool = False,
            context_tokens: int | None = None, **payload) -> dict:
        """keep_warm: one of many calls in a row (scout swarm); Ollama keeps weights loaded between them."""
        if action not in {"generate", "batch", "transcribe", "narrate"}:
            raise WorkError("Unsupported inference action.")
        if context_tokens is not None and (type(context_tokens) is not int or not 2048 <= context_tokens <= 16384):
            raise WorkError("Local context size must be between 2048 and 16384 tokens.")
        if context_tokens is not None and (action != "generate" or not is_ollama(identifier)):
            raise WorkError("Explicit context limits currently require an Ollama text-generation model.")
        from .inference_worker import validate_request

        data = {**payload, "action": action, "model": str(self.model_dir / identifier)}
        try:
            validate_request(data)
        except (ValueError, TypeError, KeyError) as exc:
            raise WorkError("Inference input exceeds limits or is invalid.") from exc
        self.require(
            identifier, {"generate": "llm", "batch": "llm", "transcribe": "asr", "narrate": "tts"}[action]
        )
        if is_ollama(identifier):
            if action != "generate":
                raise WorkError("Unsupported inference action.")
            return self._run_ollama(job_id, identifier, data, keep_warm=keep_warm, context_tokens=context_tokens)
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

    def _run_ollama(self, job_id: str, identifier: str, data: dict, *, keep_warm: bool = False,
                    context_tokens: int | None = None) -> dict:
        name = model_name(identifier)
        try:
            text = self.ollama.generate(
                name,
                data["prompt"],
                images=data.get("images", []),
                image_labels=data.get("image_labels"),
                schema=data.get("schema"),
                temperature=data.get("temperature", 0.3),
                max_tokens=data.get("max_tokens", 1500),
                check=lambda: self.jobs.check(job_id),
                keep_alive="10m" if keep_warm else 0,
                **({"context_tokens": context_tokens} if context_tokens is not None else {}),
            )
        except OllamaError as exc:
            self._log_ollama(job_id, name, f"ERROR: {exc}")
            raise WorkError(f"{exc} No output was fabricated.") from exc
        self._log_ollama(job_id, name, text)
        return {"output": text}

    def _log_ollama(self, job_id: str, name: str, text: str):
        """Keep the raw reply in the local job log, like the MLX worker's output, for diagnosis."""
        path = self.logs / f"{job_id}.log"
        try:
            if path.is_symlink():
                return
            with path.open("a", encoding="utf-8") as log:
                log.write(f"--- {time.strftime('%Y-%m-%dT%H:%M:%S')} ollama:{name} raw reply ---\n")
                log.write(text[:65536] + ("\n[truncated]" if len(text) > 65536 else "") + "\n")
            path.chmod(0o600)
        except OSError:
            pass
