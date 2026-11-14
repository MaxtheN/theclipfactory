"""Truthful inference prerequisites, without model downloads or runtime installation."""

import inspect
import json
import struct
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from clip_factory.jobs import JobCancelled, WorkError
from clip_factory.models import CATALOG, RUNTIME_VERSIONS, Models, child_env


@pytest.fixture
def models(tmp_path):
    jobs = Mock()
    jobs.process.side_effect = AssertionError("Must not start inference or installation")
    return Models(tmp_path, jobs)


SHA = "a" * 40


def manifest(models, identifier, files):
    repo = next(m["repo"] for m in CATALOG if m["id"] == identifier)
    return {
        "repo": repo,
        "revision": SHA,
        "files": [{"name": n, "size": len(data)} for n, data in files.items()],
    }


def installed(models, identifier):
    directory = models.model_dir / identifier
    directory.mkdir(exist_ok=True)
    header = b'{"w":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}'
    header += b" " * (-len(header) % 8)
    tiny_weights = struct.pack("<Q", len(header)) + header + struct.pack("<f", 0.0)
    files = {"config.json": b"{}", "model.safetensors": tiny_weights}
    if identifier == "whisper-turbo":
        files = {"config.json": b"{}", "weights.safetensors": b"mock whisper weights"}
    if identifier == "kokoro":
        files = {"config.json": b"{}", "kokoro-v1_0.pth": b"weights", "voices/af_heart.pt": b"voice"}
    for name, data in files.items():
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    (directory / ".complete").write_text(json.dumps(manifest(models, identifier, files)))


def runtime_ready(models, monkeypatch):
    models.python.parent.mkdir(parents=True, exist_ok=True)
    models.python.touch()
    marker = {"python": [3, 12], "machine": "arm64", "packages": RUNTIME_VERSIONS}
    (models.runtime / ".ready").write_text(json.dumps(marker))
    monkeypatch.setattr(
        "clip_factory.models.subprocess.run",
        Mock(return_value=SimpleNamespace(stdout=json.dumps({**marker, "system": "Darwin"}))),
    )


def test_catalog_does_not_invent_installations(models):
    assert len(models.catalog()) == len(CATALOG)
    assert all(not row["installed"] for row in models.catalog())
    assert not models.ready()
    installed(models, "qwen-small")
    assert models.item("qwen-small")["installed"]
    assert not models.ready()
    with pytest.raises(WorkError, match="Unknown"):
        models.item("../../escape")


@pytest.mark.parametrize(
    "identifier,kind", [("qwen-small", "llm"), ("whisper-turbo", "asr"), ("kokoro", "tts")]
)
def test_require_missing_weights_has_no_simulation(models, identifier, kind):
    with pytest.raises(WorkError, match="Download and accept"):
        models.require(identifier, kind)
    models.jobs.process.assert_not_called()


def test_require_installed_weights_still_needs_runtime(models):
    installed(models, "qwen-small")
    with pytest.raises(WorkError, match="runtime"):
        models.require("qwen-small", "llm")
    with pytest.raises(WorkError, match="appropriate"):
        models.require("qwen-small", "asr")
    models.jobs.process.assert_not_called()


def test_ready_verifies_interpreter_and_packages(models, monkeypatch):
    models.python.parent.mkdir(parents=True)
    models.python.touch()
    assert not models.ready()
    (models.runtime / ".ready").touch()
    assert not models.ready()
    runtime_ready(models, monkeypatch)
    assert models.ready()
    monkeypatch.setattr("clip_factory.models.subprocess.run", Mock(return_value=SimpleNamespace(stdout="{}")))
    assert not models.ready(force=True)
    monkeypatch.setattr(
        "clip_factory.models.subprocess.run", Mock(side_effect=subprocess.TimeoutExpired("probe", 90))
    )
    assert not models.ready(force=True)
    models.python.unlink()
    assert not models.ready()


def test_require_platform_and_available_memory(models, monkeypatch):
    installed(models, "qwen-small")
    runtime_ready(models, monkeypatch)
    monkeypatch.setattr("clip_factory.models.apple_silicon", lambda: False)
    with pytest.raises(WorkError, match="Apple Silicon"):
        models.require("qwen-small", "llm")
    monkeypatch.setattr("clip_factory.models.apple_silicon", lambda: True)
    monkeypatch.setattr("clip_factory.models.psutil.virtual_memory", lambda: SimpleNamespace(available=1))
    with pytest.raises(WorkError, match="memory"):
        models.require("qwen-small", "llm")
    monkeypatch.setattr(
        "clip_factory.models.psutil.virtual_memory", lambda: SimpleNamespace(available=100 * 10**9)
    )
    assert models.require("qwen-small", "llm") is None
    models.jobs.process.assert_not_called()


def test_run_without_runtime_never_fabricates_result(models):
    installed(models, "qwen-small")
    with pytest.raises(WorkError, match="runtime"):
        models.run("job", "qwen-small", "generate", prompt="Write a hook")
    assert not (models.root / "work").exists()
    models.jobs.process.assert_not_called()


def test_non_apple_setup_never_runs_installation(models, monkeypatch):
    monkeypatch.setattr("clip_factory.models.apple_silicon", lambda: False)
    with pytest.raises(WorkError, match="Manual editing works"):
        models.setup("job")
    models.jobs.process.assert_not_called()


@pytest.mark.parametrize(
    "damage", ["empty", "repo", "revision", "size", "missing", "traversal", "reserved", "symlink", "shard"]
)
def test_installed_rejects_unsafe_or_incomplete_manifests(models, tmp_path, damage):
    installed(models, "qwen-small")
    directory = models.model_dir / "qwen-small"
    marker = directory / ".complete"
    data = json.loads(marker.read_text())
    if damage == "empty":
        data = {}
    elif damage == "repo":
        data["repo"] = "other/repo"
    elif damage == "revision":
        data["revision"] = "main"
    elif damage == "size":
        data["files"][0]["size"] += 1
    elif damage == "missing":
        (directory / "model.safetensors").unlink()
    elif damage in {"traversal", "reserved"}:
        data["files"].append({"name": "../escape" if damage == "traversal" else ".complete", "size": 1})
    elif damage == "symlink":
        weight = directory / "model.safetensors"
        other = tmp_path / "elsewhere"
        other.write_bytes(weight.read_bytes())
        weight.unlink()
        weight.symlink_to(other)
    else:
        index = directory / "model.safetensors.index.json"
        index.write_text(json.dumps({"weight_map": {"w": "missing.safetensors"}}))
        data["files"].append({"name": index.name, "size": index.stat().st_size})
    marker.write_text(json.dumps(data))
    assert not models.item("qwen-small")["installed"]


@pytest.fixture
def hub(models, monkeypatch):
    import huggingface_hub

    files = {"config.json": b"{}", "model.safetensors": b"fake weights"}
    info = SimpleNamespace(
        sha=SHA, siblings=[SimpleNamespace(rfilename=n, size=len(b)) for n, b in files.items()]
    )
    info.siblings.append(SimpleNamespace(rfilename=".gitattributes", size=3))
    api = Mock()
    api.model_info.return_value = info
    monkeypatch.setattr(huggingface_hub, "HfApi", lambda: api)
    monkeypatch.setattr("clip_factory.models.shutil.disk_usage", lambda p: SimpleNamespace(free=10**10))

    def download(repo, name, *, revision, local_dir, tqdm_class):
        assert revision == SHA
        bar = tqdm_class(total=len(files[name]))
        bar.update(len(files[name]))
        bar.close()
        (local_dir / name).write_bytes(files[name])

    transfer = Mock(side_effect=download)
    transfer.__signature__ = inspect.signature(huggingface_hub.hf_hub_download)
    monkeypatch.setattr(huggingface_hub, "hf_hub_download", transfer)
    return api, transfer, info


def test_download_uses_immutable_metadata_and_atomic_manifest(models, hub):
    api, transfer, _ = hub
    assert models.download("job", "qwen-small")["installed"]
    api.model_info.assert_called_once_with(CATALOG[0]["repo"], revision=None, files_metadata=True)
    target = models.model_dir / "qwen-small"
    assert json.loads((target / ".complete").read_text()) == {
        "repo": CATALOG[0]["repo"],
        "revision": SHA,
        "files": [{"name": "config.json", "size": 2}, {"name": "model.safetensors", "size": 12}],
    }
    assert models.item("qwen-small")["installed"]
    assert transfer.call_count == 2
    assert not (target / ".download.json").exists()
    assert any(
        c.kwargs.get("message", "").startswith("Downloading model weights (")
        for c in models.jobs.update.call_args_list
    )


def test_failed_transfer_resumes_pinned_revision(models, hub):
    api, transfer, _ = hub
    original = transfer.side_effect
    transfer.side_effect = OSError("network")
    with pytest.raises(WorkError, match="pinned revision"):
        models.download("job", "qwen-small")
    assert not models.item("qwen-small")["installed"]
    transfer.side_effect = original
    models.download("job", "qwen-small")
    assert api.model_info.call_args.kwargs == {"revision": SHA, "files_metadata": True}


def test_download_checks_disk_before_each_file(models, hub, monkeypatch):
    _, transfer, _ = hub
    monkeypatch.setattr(
        "clip_factory.models.shutil.disk_usage",
        Mock(side_effect=[SimpleNamespace(free=10**10), SimpleNamespace(free=0)]),
    )
    with pytest.raises(WorkError, match="disk"):
        models.download("job", "qwen-small")
    assert transfer.call_count == 1
    assert not models.item("qwen-small")["installed"]


def test_download_cancels_inside_http_progress(models, hub):
    _, transfer, _ = hub
    cancelled = False

    def check(job):
        if cancelled:
            raise JobCancelled()

    def download(repo, name, *, revision, local_dir, tqdm_class):
        nonlocal cancelled
        bar = tqdm_class(total=2)
        cancelled = True
        bar.update(1)

    models.jobs.check.side_effect = check
    transfer.side_effect = download
    with pytest.raises(JobCancelled):
        models.download("job", "qwen-small")
    assert not models.item("qwen-small")["installed"]


@pytest.mark.parametrize("name,size", [("../outside.json", 2), (".complete", 2), ("config.json", None)])
def test_download_rejects_unsafe_or_missing_metadata(models, hub, name, size):
    _, transfer, info = hub
    info.siblings = [SimpleNamespace(rfilename=name, size=size)]
    with pytest.raises(WorkError, match="verification failed"):
        models.download("job", "qwen-small")
    transfer.assert_not_called()


def test_run_sequential_tasks_never_reuse_response(models, monkeypatch):
    installed(models, "qwen-small")
    runtime_ready(models, monkeypatch)
    monkeypatch.setattr("clip_factory.models.apple_silicon", lambda: True)
    monkeypatch.setattr(
        "clip_factory.models.psutil.virtual_memory", lambda: SimpleNamespace(available=100 * 10**9)
    )
    monkeypatch.setenv("CLIP_META_APP_SECRET", "private")
    monkeypatch.setenv("PROVIDER_API_KEY", "private")
    monkeypatch.setenv("SOME_TOKEN", "private")
    results = iter([{"output": "first"}, {"output": "second"}, None])

    def process(job, command, **kwargs):
        request, response = map(Path, command[-2:])
        assert not response.exists()
        assert json.loads(request.read_text())["model"] == str(models.model_dir / "qwen-small")
        assert Path(command[1]).is_file()
        assert kwargs["env"]["HF_HUB_OFFLINE"] == "1"
        assert "PATH" in kwargs["env"]
        assert not any(k in kwargs["env"] for k in ("CLIP_META_APP_SECRET", "PROVIDER_API_KEY", "SOME_TOKEN"))
        result = next(results)
        if result:
            response.write_text(json.dumps(result))

    models.jobs.process.side_effect = process
    assert models.run("samejob", "qwen-small", "generate", prompt="first")["output"] == "first"
    assert models.run("samejob", "qwen-small", "generate", prompt="second")["output"] == "second"
    with pytest.raises(WorkError, match="no result"):
        models.run("samejob", "qwen-small", "generate", prompt="third")
    assert not (models.root / "work" / "samejob" / "request.json").exists()


def test_run_bounds_before_starting_worker(models):
    with pytest.raises(WorkError, match="input"):
        models.run("job", "qwen-small", "generate", prompt="x" * 96_001)
    with pytest.raises(WorkError, match="input"):
        models.run("job", "qwen-small", "generate", prompt="x", max_tokens=5000)
    models.jobs.process.assert_not_called()


def test_child_env_removes_credentials_but_keeps_runtime_settings(monkeypatch):
    for key in ("HF_TOKEN", "API_KEY", "CLIP_META_APP_SECRET", "AWS_ACCESS_KEY_ID", "SERVICE_PASSWORD"):
        monkeypatch.setenv(key, "secret")
    monkeypatch.setenv("PATH", "/local/bin")
    env = child_env()
    assert env["PATH"] == "/local/bin"
    assert env["HF_HUB_OFFLINE"] == "1"
    assert not any(
        env.get(k)
        for k in ("HF_TOKEN", "API_KEY", "CLIP_META_APP_SECRET", "AWS_ACCESS_KEY_ID", "SERVICE_PASSWORD")
    )


@pytest.mark.parametrize("probe", ["Darwin x86_64 (3, 12)", "Darwin arm64 (3, 11)", "Linux arm64 (3, 12)"])
def test_setup_rejects_non_native_or_wrong_python(models, monkeypatch, probe):
    monkeypatch.setattr("clip_factory.models.apple_silicon", lambda: True)
    monkeypatch.setattr("clip_factory.models.shutil.which", lambda name: "/candidate/python")
    monkeypatch.setattr(
        "clip_factory.models.subprocess.run", Mock(return_value=SimpleNamespace(stdout=probe))
    )
    fallback = Mock(side_effect=WorkError("Private Python download unavailable"))
    monkeypatch.setattr("clip_factory.models.bootstrap_python", fallback)
    with pytest.raises(WorkError, match="Private Python download unavailable"):
        models.setup("job")
    fallback.assert_called_once()
    models.jobs.process.assert_not_called()


def test_setup_rebuilds_runtime_and_pins_speech_assets(models, monkeypatch):
    monkeypatch.setattr("clip_factory.models.apple_silicon", lambda: True)
    monkeypatch.setattr("clip_factory.models.shutil.which", lambda name: "/candidate/python")
    marker = {"python": [3, 12], "machine": "arm64", "packages": RUNTIME_VERSIONS}
    monkeypatch.setattr(
        "clip_factory.models.subprocess.run",
        Mock(
            side_effect=[
                SimpleNamespace(stdout="Darwin arm64 (3, 12)"),
                SimpleNamespace(stdout=json.dumps({**marker, "system": "Darwin"})),
            ]
        ),
    )
    models.runtime.mkdir()
    old = models.runtime / "old-venv-data"
    old.touch()

    def process(job, command, **kwargs):
        if "venv" in command:
            assert not old.exists()
            models.python.parent.mkdir(parents=True)
            models.python.touch()
        return "verified"

    models.jobs.process.side_effect = process
    assert models.setup("job")["runtime"] == "ready"
    assert json.loads((models.runtime / ".ready").read_text()) == marker
    install = models.jobs.process.call_args_list[1].args[1]
    assert "mlx-vlm==0.7.12" in install
    assert "mlx-whisper==0.4.3" in install
    assert "kokoro==0.9.4" in install
    assert any("en_core_web_sm-3.8.0" in argument for argument in install)


def test_failed_setup_has_no_ready_marker(models, monkeypatch):
    monkeypatch.setattr("clip_factory.models.apple_silicon", lambda: True)
    monkeypatch.setattr("clip_factory.models.shutil.which", lambda name: "/candidate/python")
    monkeypatch.setattr(
        "clip_factory.models.subprocess.run",
        Mock(return_value=SimpleNamespace(stdout="Darwin arm64 (3, 12)")),
    )
    models.runtime.mkdir()
    (models.runtime / ".ready").write_text("old")
    models.jobs.process.side_effect = WorkError("installation failed")
    with pytest.raises(WorkError, match="installation failed"):
        models.setup("job")
    assert not (models.runtime / ".ready").exists()


def test_corrupt_downloaded_file_never_marks_complete(models, hub):
    _, transfer, _ = hub
    original = transfer.side_effect

    def corrupt(*args, **kwargs):
        original(*args, **kwargs)
        if args[1] == "model.safetensors":
            (kwargs["local_dir"] / args[1]).write_bytes(b"short")

    transfer.side_effect = corrupt
    with pytest.raises(WorkError, match="verification failed"):
        models.download("job", "qwen-small")
    assert not (models.model_dir / "qwen-small" / ".complete").exists()


def test_manifest_checks_every_indexed_shard(models):
    installed(models, "qwen-small")
    directory = models.model_dir / "qwen-small"
    index = directory / "model.safetensors.index.json"
    index.write_text(json.dumps({"weight_map": {"w": "model.safetensors"}}))
    marker = directory / ".complete"
    data = json.loads(marker.read_text())
    data["files"].append({"name": index.name, "size": index.stat().st_size})
    marker.write_text(json.dumps(data))
    assert models.item("qwen-small")["installed"]
    (directory / "model.safetensors").unlink()
    assert not models.item("qwen-small")["installed"]


def test_old_hub_api_cannot_silently_drop_cancellation(models, monkeypatch):
    import huggingface_hub

    def unsupported(repo, filename):
        raise AssertionError("Must not download without cancellation hook")

    monkeypatch.setattr(huggingface_hub, "hf_hub_download", unsupported)
    with pytest.raises(WorkError, match="cannot provide cancellable HTTP downloads"):
        models.download("job", "qwen-small")


def test_runtime_probe_must_report_matching_architecture_and_versions(models, monkeypatch):
    runtime_ready(models, monkeypatch)
    marker = {"python": [3, 12], "machine": "arm64", "packages": RUNTIME_VERSIONS, "system": "Darwin"}
    for mismatch in ({"machine": "x86_64"}, {"python": [3, 11]}, {"packages": {"mlx-vlm": "wrong"}}):
        monkeypatch.setattr(
            "clip_factory.models.subprocess.run",
            Mock(return_value=SimpleNamespace(stdout=json.dumps({**marker, **mismatch}))),
        )
        assert not models.ready()


def test_parallel_download_disk_reservations_prevent_overcommit(models, monkeypatch):
    mb = 1024**2
    monkeypatch.setattr("clip_factory.models.shutil.disk_usage", lambda _: SimpleNamespace(free=96 * mb))
    with models._download_space("first", models.model_dir, 20 * mb):
        with (
            pytest.raises(WorkError, match="concurrent"),
            models._download_space("second", models.model_dir, 20 * mb),
        ):
            pytest.fail("Overcommitted download started")
        assert models._download_reservations == {"first": 20 * mb}
    assert models._download_reservations == {}
    with (
        pytest.raises(WorkError, match="transfer failed"),
        models._download_space("second", models.model_dir, 20 * mb),
    ):
        raise WorkError("transfer failed")
    assert models._download_reservations == {}


@pytest.mark.parametrize("weight_name", ["weights.safetensors", "weights.npz"])
def test_whisper_download_accepts_supported_publisher_formats(models, hub, weight_name):
    _api, transfer, info = hub
    files = {"config.json": b'{"model_type":"whisper"}', weight_name: b"test model weights"}
    info.siblings = [SimpleNamespace(rfilename=name, size=len(content)) for name, content in files.items()]

    def download(repo, name, *, revision, local_dir, tqdm_class):
        assert repo == "mlx-community/whisper-large-v3-turbo"
        assert revision == SHA
        (local_dir / name).write_bytes(files[name])

    transfer.side_effect = download
    assert models.download("job", "whisper-turbo") == {"model_id": "whisper-turbo", "installed": True}
    assert models.item("whisper-turbo")["installed"]
    assert transfer.call_count == 2
    marker = json.loads((models.model_dir / "whisper-turbo" / ".complete").read_text())
    assert {file["name"] for file in marker["files"]} == {"config.json", weight_name}
    assert marker["revision"] == SHA


def test_whisper_does_not_accept_arbitrary_safetensors_filename(models, hub):
    _, transfer, _ = hub  # Qwen-style model.safetensors is not a Whisper loader filename.
    with pytest.raises(WorkError, match="verification failed"):
        models.download("job", "whisper-turbo")
    transfer.assert_not_called()
    assert not models.item("whisper-turbo")["installed"]


def test_incomplete_whisper_safetensors_never_installs_and_retry_resumes(models, hub):
    api, transfer, info = hub
    weight_name = "weights.safetensors"
    files = {"config.json": b"{}", weight_name: b"complete model weights"}
    info.siblings = [SimpleNamespace(rfilename=name, size=len(content)) for name, content in files.items()]
    truncated = True

    def download(repo, name, *, revision, local_dir, tqdm_class):
        content = files[name]
        if truncated and name == weight_name:
            content = content[:-1]
        (local_dir / name).write_bytes(content)

    transfer.side_effect = download
    with pytest.raises(WorkError, match="verification failed"):
        models.download("first", "whisper-turbo")
    assert not models.item("whisper-turbo")["installed"]
    assert not (models.model_dir / "whisper-turbo" / ".complete").exists()
    truncated = False
    assert models.download("retry", "whisper-turbo")["installed"]
    assert api.model_info.call_args.kwargs["revision"] == SHA
    assert models.item("whisper-turbo")["installed"]


def test_ready_cache_invalidates_on_marker_change_and_expiry(models, monkeypatch):
    runtime_ready(models, monkeypatch)
    probe = subprocess.run
    clock = [100.0]
    monkeypatch.setattr("clip_factory.models.time.monotonic", lambda: clock[0])
    assert models.ready() and models.ready()
    assert probe.call_count == 1
    clock[0] = 161.0
    assert models.ready()
    assert probe.call_count == 2
    marker = models.runtime / ".ready"
    marker.write_text(marker.read_text() + "\n")
    assert models.ready()
    assert probe.call_count == 3
    marker.unlink()
    assert not models.ready()
    assert probe.call_count == 3


def test_simultaneous_ready_checks_share_one_import_process(models, monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor

    runtime_ready(models, monkeypatch)
    entered, release = threading.Event(), threading.Event()
    expected = json.dumps(
        {"system": "Darwin", "machine": "arm64", "python": [3, 12], "packages": RUNTIME_VERSIONS}
    )

    def slow_probe(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return SimpleNamespace(stdout=expected)

    probe = Mock(side_effect=slow_probe)
    monkeypatch.setattr("clip_factory.models.subprocess.run", probe)
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(models.ready) for _ in range(3)]
        try:
            assert entered.wait(2)
        finally:
            release.set()
        assert all(future.result(timeout=3) for future in futures)
    assert probe.call_count == 1


def test_failed_ready_probe_is_briefly_cached_without_claiming_ready(models, monkeypatch):
    runtime_ready(models, monkeypatch)
    probe = Mock(side_effect=subprocess.TimeoutExpired("probe", 90))
    monkeypatch.setattr("clip_factory.models.subprocess.run", probe)
    assert not models.ready() and not models.ready()
    assert probe.call_count == 1
    assert not models.ready(force=True)
    assert probe.call_count == 2


def test_mlx_batch_goes_through_one_worker_process_and_is_checked(models, monkeypatch):
    calls = []

    def run(job, identifier, action, **payload):
        calls.append((job, identifier, action, payload))
        return {"outputs": [{"output": "a"}, "garbage"]}

    monkeypatch.setattr(models, "run", run)
    requests = [{"prompt": "one"}, {"prompt": "two"}]
    assert models.run_batch("job", "qwen-small", requests) == [{"output": "a"}, {"error": "Invalid result"}]
    assert calls == [("job", "qwen-small", "batch", {"requests": requests})]
    monkeypatch.setattr(models, "run", lambda *a, **k: {"outputs": [{"output": "only one"}]})
    with pytest.raises(WorkError, match="incomplete batch"):
        models.run_batch("job", "qwen-small", requests)
    assert models.run_batch("job", "qwen-small", []) == []


def test_asr_probe_is_independent_of_optional_vision_and_narration_imports(models, monkeypatch):
    runtime_ready(models, monkeypatch)
    calls = []
    expected = json.dumps({"system": "Darwin", "machine": "arm64", "python": [3, 12], "packages": RUNTIME_VERSIONS})

    def probe(command, **kwargs):
        calls.append(command[-1])
        if "mlx_vlm" in command[-1]:
            raise subprocess.CalledProcessError(1, command, stderr="missing optional torch library")
        return SimpleNamespace(stdout=expected)

    monkeypatch.setattr("clip_factory.models.subprocess.run", probe)
    assert not models.ready()
    assert models.ready(kind="asr")
    assert models.ready(kind="asr")
    assert len(calls) == 2
    assert "import mlx.core, mlx_whisper" in calls[1] and "import mlx.core, mlx_vlm" not in calls[1]
    assert not models.ready()  # Successful speech probe must not mark the full bundle healthy.
