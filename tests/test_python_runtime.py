"""Private Python bootstrap boundaries; no network or native execution in unit tests."""

import hashlib
import io
import json
import tarfile
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from clip_factory import python_runtime as runtime
from clip_factory.jobs import JobCancelled, WorkError
from clip_factory.models import RUNTIME_VERSIONS, Models, child_env

# These tests describe the Apple Silicon (MLX) engine; the other platforms are in test_speech_backend.
pytestmark = pytest.mark.usefixtures("mac_host")


def archive_bytes(entries=None):
    entries = entries or [
        ("python/bin/python3.12", b"binary", None),
        ("python/bin/python", None, "python3.12"),
    ]
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, content, link in entries:
            item = tarfile.TarInfo(name)
            item.mode = 0o755
            if link:
                item.type, item.linkname = tarfile.SYMTYPE, link
                archive.addfile(item)
            else:
                item.size = len(content)
                archive.addfile(item, io.BytesIO(content))
    return output.getvalue()


@pytest.fixture
def bootstrap(tmp_path, monkeypatch):
    jobs = Mock()
    data = archive_bytes()
    response = io.BytesIO(data)
    response.geturl = lambda: runtime.PYTHON_URL
    network = Mock(return_value=response)
    monkeypatch.setattr(runtime.urllib.request, "urlopen", network)
    monkeypatch.setattr(runtime, "PYTHON_BYTES", len(data))
    monkeypatch.setattr(runtime, "PYTHON_SHA256", hashlib.sha256(data).hexdigest())
    monkeypatch.setattr(runtime, "native_python", Mock(return_value=True))
    return tmp_path, jobs, network


def target(root):
    return root / "python" / f"cpython-{runtime.PYTHON_VERSION}-{runtime.PYTHON_RELEASE}-arm64"


def test_missing_python_is_installed_privately_and_reused(bootstrap):
    root, jobs, network = bootstrap
    executable = runtime.bootstrap_python(root, jobs, "job", {})
    assert executable == target(root) / "bin" / "python3.12"
    assert executable.read_bytes() == b"binary"
    assert json.loads((target(root) / ".clip-factory-python.json").read_text()) == runtime.MANIFEST
    assert (target(root) / "bin" / "python").resolve() == executable
    assert not list((root / "python").glob(".install-*"))
    assert runtime.bootstrap_python(root, jobs, "second", {}) == executable
    network.assert_called_once()
    messages = [call.kwargs.get("message", "") for call in jobs.update.call_args_list]
    assert any("no Homebrew" in m for m in messages)


@pytest.mark.parametrize("mode", ["checksum", "truncated", "too_large"])
def test_failed_download_never_installs_python(bootstrap, monkeypatch, mode):
    root, jobs, _ = bootstrap
    if mode == "checksum":
        monkeypatch.setattr(runtime, "PYTHON_SHA256", "0" * 64)
    elif mode == "truncated":
        monkeypatch.setattr(runtime, "PYTHON_BYTES", runtime.PYTHON_BYTES + 1)
    else:
        monkeypatch.setattr(runtime, "PYTHON_BYTES", runtime.PYTHON_BYTES - 1)
    with pytest.raises(WorkError):
        runtime.bootstrap_python(root, jobs, "job", {})
    assert not target(root).exists()
    assert not list((root / "python").glob(".install-*"))
    runtime.native_python.assert_not_called()


def test_cancellation_cleans_partial_files(bootstrap):
    root, jobs, _ = bootstrap
    jobs.check.side_effect = [None, JobCancelled()]
    with pytest.raises(JobCancelled):
        runtime.bootstrap_python(root, jobs, "job", {})
    assert not target(root).exists()
    assert not list((root / "python").glob(".install-*"))


def test_wrong_architecture_is_not_committed(bootstrap):
    root, jobs, _ = bootstrap
    runtime.native_python.return_value = False
    with pytest.raises(WorkError, match="native Apple Silicon"):
        runtime.bootstrap_python(root, jobs, "job", {})
    assert not target(root).exists()


@pytest.mark.parametrize(
    "path,link",
    [
        ("../escape", None),
        ("/tmp/escape", None),
        ("python/bin/link", "../../../escape"),
        ("python/bin/link", "/tmp/escape"),
    ],
)
def test_archive_paths_and_links_cannot_escape(tmp_path, path, link):
    archive = tmp_path / "archive.tar.gz"
    archive.write_bytes(archive_bytes([(path, b"content", link)]))
    with pytest.raises(WorkError):
        runtime._extract(archive, tmp_path / "stage", Mock(), "job")
    assert not (tmp_path / "escape").exists()


def test_archive_devices_and_hardlinks_rejected(tmp_path):
    archive = tmp_path / "archive.tar.gz"
    with tarfile.open(archive, "w:gz") as bundle:
        item = tarfile.TarInfo("python/device")
        item.type = tarfile.CHRTYPE
        bundle.addfile(item)
    with pytest.raises(WorkError, match="unsupported"):
        runtime._extract(archive, tmp_path / "stage", Mock(), "job")


def test_symlink_installation_directory_rejected(bootstrap):
    root, jobs, network = bootstrap
    destination = root / "outside"
    destination.mkdir()
    (root / "python").symlink_to(destination)
    with pytest.raises(WorkError, match="symlink"):
        runtime.bootstrap_python(root, jobs, "job", {})
    network.assert_not_called()


def test_disk_preflight_prevents_download(bootstrap, monkeypatch):
    root, jobs, network = bootstrap
    monkeypatch.setattr(runtime.shutil, "disk_usage", lambda _: SimpleNamespace(free=1))
    with pytest.raises(WorkError, match="512 MB"):
        runtime.bootstrap_python(root, jobs, "job", {})
    network.assert_not_called()


def test_native_probe_is_isolated_and_rejects_rosetta(monkeypatch):
    probe = Mock(return_value=SimpleNamespace(stdout="Darwin x86_64 (3, 12)"))
    monkeypatch.setattr(runtime.subprocess, "run", probe)
    assert not runtime.native_python("/python", {"HOME": "/local"})
    assert probe.call_args.args[0][:3] == ["/python", "-I", "-c"]
    assert probe.call_args.kwargs["env"] == {"HOME": "/local"}


def test_missing_external_python_setup_continues_in_same_job(tmp_path, monkeypatch):
    jobs = Mock()
    models = Models(tmp_path, jobs)
    monkeypatch.setattr("clip_factory.models.apple_silicon", lambda: True)
    monkeypatch.setattr("clip_factory.models.shutil.which", lambda _: None)
    monkeypatch.setattr("clip_factory.models.native_python", lambda *_: False)
    fallback = Mock(return_value=tmp_path / "python" / "bin" / "python3.12")
    monkeypatch.setattr("clip_factory.models.bootstrap_python", fallback)
    monkeypatch.setattr(models, "ready", lambda: True)

    def process(job, command, **kwargs):
        if "venv" in command:
            models.runtime.mkdir()

    jobs.process.side_effect = process
    assert models.setup("same-job")["runtime"] == "ready"
    fallback.assert_called_once_with(tmp_path, jobs, "same-job", child_env())
    command = jobs.process.call_args_list[0].args[1]
    assert command == [str(fallback.return_value), "-m", "venv", str(models.runtime)]
    assert json.loads((models.runtime / ".ready").read_text())["packages"] == RUNTIME_VERSIONS


def test_frozen_and_python_environment_does_not_leak(monkeypatch):
    for name in (
        "PYTHONHOME",
        "PYTHONPATH",
        "DYLD_LIBRARY_PATH",
        "DYLD_INSERT_LIBRARIES",
        "__PYVENV_LAUNCHER__",
    ):
        monkeypatch.setenv(name, "bad-location")
        assert name not in child_env()
