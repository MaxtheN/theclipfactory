"""Local speech on every supported platform: MLX on Apple Silicon, faster-whisper on Windows/Linux x64.

No model is downloaded and nothing native runs: platforms are simulated with the speech_host fixture.
"""

import hashlib
import io
import json
import subprocess
import sys
import tarfile
import wave
from pathlib import Path
from types import SimpleNamespace
from typing import ClassVar
from unittest.mock import Mock

import pytest
from conftest import REAL_NVIDIA_GPU
from test_app import client as authenticated_client_fixture

from clip_factory import inference_worker, speech, speech_backend
from clip_factory import python_runtime as runtime
from clip_factory.jobs import WorkError
from clip_factory.models import FW_PROBE, FW_VERSIONS, RUNTIME_VERSIONS, Models, runtime_marker

client = authenticated_client_fixture
SHA = "b" * 40
FW_REPO = "dropbox-dash/faster-whisper-large-v3-turbo"


@pytest.fixture
def models(tmp_path):
    jobs = Mock()
    jobs.process.side_effect = AssertionError("Must not start inference or installation")
    return Models(tmp_path, jobs)


def fw_installed(models, files=None):
    files = files or {"config.json": b"{}", "model.bin": b"ct2 weights", "tokenizer.json": b"{}"}
    directory = models.model_dir / "whisper-turbo"
    directory.mkdir(exist_ok=True)
    for name, data in files.items():
        (directory / name).write_bytes(data)
    manifest = {"repo": FW_REPO, "revision": SHA, "files": [{"name": n, "size": len(d)} for n, d in files.items()]}
    (directory / ".complete").write_text(json.dumps(manifest))


def fw_runtime(models, monkeypatch, *, cuda=False, probe=None):
    models.python.parent.mkdir(parents=True, exist_ok=True)
    models.python.touch()
    marker = runtime_marker(cuda)
    (models.runtime / ".ready").write_text(json.dumps(marker))
    site = models.runtime / ("Lib" if models.python.name == "python.exe" else "lib/python3.12") / "site-packages"
    for package in ("ctranslate2", "faster_whisper"):
        (site / package).mkdir(parents=True, exist_ok=True)
    answer = probe if probe is not None else {**marker, "system": speech_backend.host()[0]}
    run = Mock(return_value=SimpleNamespace(stdout=json.dumps(answer)))
    monkeypatch.setattr("clip_factory.models.subprocess.run", run)
    return marker, run


# Which engine each platform gets.


@pytest.mark.parametrize(
    ("system", "machine", "engine"),
    [
        ("Darwin", "arm64", "mlx"),
        ("Darwin", "x86_64", None),  # Intel Mac: no local engine
        ("Windows", "AMD64", "faster-whisper"),
        ("Windows", "ARM64", None),
        ("Linux", "x86_64", "faster-whisper"),
        ("Linux", "aarch64", None),
        ("FreeBSD", "amd64", None),
    ],
)
def test_backend_follows_operating_system_and_processor(system, machine, engine):
    assert speech_backend.backend(system, machine) == engine


def test_runtime_download_size_includes_cuda_only_with_an_nvidia_gpu(speech_host):
    speech_host("Windows", "AMD64")
    assert speech_backend.runtime_gb() == 0.2
    speech_host("Windows", "AMD64", gpu="NVIDIA GeForce RTX 4070")
    assert speech_backend.runtime_gb() == 1.5
    speech_host("Darwin", "arm64")
    assert speech_backend.runtime_gb() == 1.4


def test_nvidia_gpu_reads_the_driver_and_never_raises(monkeypatch):
    probe = REAL_NVIDIA_GPU.__wrapped__
    monkeypatch.setattr(speech_backend.shutil, "which", lambda name: None)
    assert probe() is None
    monkeypatch.setattr(speech_backend.shutil, "which", lambda name: "/usr/bin/nvidia-smi")
    monkeypatch.setattr(
        speech_backend.subprocess, "run", Mock(return_value=SimpleNamespace(stdout="NVIDIA RTX A4000\nNVIDIA T4\n"))
    )
    assert probe() == "NVIDIA RTX A4000"
    monkeypatch.setattr(speech_backend.subprocess, "run", Mock(side_effect=subprocess.CalledProcessError(9, "x")))
    assert probe() is None


# Readiness and blockers list only steps that can run here, with their real sizes.


def test_unsupported_platform_never_offers_setup(speech_host, models):
    speech_host("Darwin", "x86_64")
    blocker = speech.check(models)
    assert blocker["code"] == "asr_unsupported" and blocker["action"] is None
    assert blocker["steps"] == [] and blocker["download_gb"] == 0
    assert "Apple Silicon Mac, or Windows or Linux" in blocker["message"]
    assert speech.steps() == {}
    with pytest.raises(WorkError, match="Local speech recognition needs"):
        models.require("whisper-turbo", "asr")


def test_unsupported_platform_setup_runs_nothing(speech_host, models):
    speech_host("Linux", "aarch64")
    with pytest.raises(WorkError, match="Manual editing works"):
        models.setup("job")
    models.jobs.process.assert_not_called()


@pytest.mark.parametrize(("gpu", "runtime_gb", "total"), [(None, 0.2, 1.8), ("NVIDIA RTX 3060", 1.5, 3.1)])
def test_windows_and_linux_blockers_show_faster_whisper_sizes(speech_host, models, gpu, runtime_gb, total):
    for system, machine in (("Windows", "AMD64"), ("Linux", "x86_64")):
        speech_host(system, machine, gpu=gpu)
        blocker = speech.check(models)
        assert blocker["code"] == "asr_missing" and blocker["action"] == "speech_setup"
        assert [(s["id"], s["approx_gb"]) for s in blocker["steps"]] == [("runtime", runtime_gb), ("whisper-turbo", 1.6)]
        assert blocker["download_gb"] == total
        assert f"about {total:.1f} GB download" in blocker["message"]


def test_mac_blocker_sizes_are_unchanged(speech_host, models):
    speech_host("Darwin", "arm64")
    blocker = speech.check(models)
    assert blocker["download_gb"] == 3.0 and "about 3.0 GB" in blocker["message"]


def test_only_the_model_step_remains_when_the_runtime_is_ready(speech_host, models, monkeypatch):
    speech_host("Linux", "x86_64")
    fw_runtime(models, monkeypatch)
    blocker = speech.check(models)
    assert [s["id"] for s in blocker["steps"]] == ["whisper-turbo"] and blocker["download_gb"] == 1.6


# The catalogue entry, manifest, and download for the CTranslate2 model.


def test_whisper_catalog_entry_comes_from_the_faster_whisper_repo_off_the_mac(speech_host, models):
    speech_host("Windows", "AMD64")
    item = models.item("whisper-turbo")
    assert item["repo"] == FW_REPO and item["format"] == "ctranslate2" and item["estimated_gb"] == 1.6
    assert "faster-whisper" in item["name"]
    speech_host("Darwin", "arm64")
    assert models.item("whisper-turbo")["repo"] == "mlx-community/whisper-large-v3-turbo"


def test_ctranslate2_whisper_requires_model_bin(speech_host, models):
    speech_host("Linux", "x86_64")
    fw_installed(models)
    assert models.item("whisper-turbo")["installed"]
    fw_installed(models, {"config.json": b"{}", "weights.safetensors": b"mlx weights"})
    (models.model_dir / "whisper-turbo" / "model.bin").unlink()
    assert not models.item("whisper-turbo")["installed"]


def test_mac_model_folder_counts_as_damaged_on_windows(speech_host, models):
    speech_host("Darwin", "arm64")
    directory = models.model_dir / "whisper-turbo"
    directory.mkdir()
    (directory / "config.json").write_bytes(b"{}")
    (directory / "weights.safetensors").write_bytes(b"w")
    manifest = {
        "repo": "mlx-community/whisper-large-v3-turbo", "revision": SHA,
        "files": [{"name": "config.json", "size": 2}, {"name": "weights.safetensors", "size": 1}],
    }
    (directory / ".complete").write_text(json.dumps(manifest))
    assert models.item("whisper-turbo")["installed"]
    speech_host("Windows", "AMD64")
    assert models.item("whisper-turbo")["integrity"] == "damaged"  # Repair re-downloads the right format.


def test_download_selects_ctranslate2_files_only(speech_host, models, monkeypatch):
    import inspect

    import huggingface_hub

    speech_host("Windows", "AMD64")
    files = {
        "config.json": b"{}", "model.bin": b"ct2", "preprocessor_config.json": b"{}",
        "tokenizer.json": b"{}", "vocabulary.json": b"{}", "README.md": b"#", "extra/model.bin": b"x",
    }
    info = SimpleNamespace(sha=SHA, siblings=[SimpleNamespace(rfilename=n, size=len(b)) for n, b in files.items()])
    api = Mock()
    api.model_info.return_value = info
    monkeypatch.setattr(huggingface_hub, "HfApi", lambda: api)
    monkeypatch.setattr("clip_factory.models.shutil.disk_usage", lambda p: SimpleNamespace(free=10**10))

    def download(repo, name, *, revision, local_dir, tqdm_class):
        assert repo == FW_REPO and revision == SHA
        (local_dir / name).write_bytes(files[name])

    transfer = Mock(side_effect=download)
    transfer.__signature__ = inspect.signature(huggingface_hub.hf_hub_download)
    monkeypatch.setattr(huggingface_hub, "hf_hub_download", transfer)
    assert models.download("job", "whisper-turbo")["installed"]
    api.model_info.assert_called_once_with(FW_REPO, revision=None, files_metadata=True)
    marker = json.loads((models.model_dir / "whisper-turbo" / ".complete").read_text())
    assert [f["name"] for f in marker["files"]] == [
        "config.json", "model.bin", "preprocessor_config.json", "tokenizer.json", "vocabulary.json",
    ]


# The Windows/Linux runtime: interpreter path, marker, probe, setup, integrity.


def test_windows_runtime_uses_the_scripts_interpreter(speech_host, models):
    speech_host("Windows", "AMD64")
    assert models.python == models.runtime / "Scripts" / "python.exe"
    speech_host("Linux", "x86_64")
    assert models.python == models.runtime / "bin" / "python"


@pytest.mark.parametrize(("system", "machine"), [("Windows", "AMD64"), ("Linux", "x86_64")])
def test_faster_whisper_runtime_marker_and_probe(speech_host, models, monkeypatch, system, machine):
    speech_host(system, machine)
    marker, run = fw_runtime(models, monkeypatch)
    assert marker == {
        "python": [3, 12], "machine": machine, "backend": "faster-whisper", "cuda": False, "packages": FW_VERSIONS,
    }
    assert models.ready() and models.ready(kind="asr", force=True)
    assert run.call_args.args[0][-1] == FW_PROBE  # Speech-only runtime: never the MLX import check.
    assert models.runtime_integrity() == {"state": "ok", "problems": []}


def test_faster_whisper_runtime_rejects_mismatches(speech_host, models, monkeypatch):
    speech_host("Windows", "AMD64")
    marker, _ = fw_runtime(models, monkeypatch)
    for mismatch in ({"machine": "ARM64"}, {"cuda": True}, {"packages": {**FW_VERSIONS, "av": "19.0.2"}},
                     {"system": "Linux"}):
        fw_runtime(models, monkeypatch, probe={**marker, "system": "Windows", **mismatch})
        assert not models.ready(force=True)
    # A Mac-shaped marker (MLX packages) is never ready on Windows.
    (models.runtime / ".ready").write_text(json.dumps({"python": [3, 12], "machine": "arm64", "packages": RUNTIME_VERSIONS}))
    assert not models.ready(force=True)


def test_missing_ctranslate2_package_is_damaged(speech_host, models, monkeypatch):
    speech_host("Linux", "x86_64")
    fw_runtime(models, monkeypatch)
    (models.runtime / "lib" / "python3.12" / "site-packages" / "ctranslate2").rmdir()
    assert models.runtime_integrity() == {"state": "damaged", "problems": ["ctranslate2"]}
    assert speech.classify(models)["code"] == "asr_damaged"


@pytest.mark.parametrize(("gpu", "cuda"), [(None, False), ("NVIDIA RTX 4090", True)])
def test_setup_installs_pinned_faster_whisper_and_cuda_only_with_a_gpu(speech_host, models, monkeypatch, gpu, cuda):
    speech_host("Linux", "x86_64", gpu=gpu)
    monkeypatch.setattr("clip_factory.models.shutil.which", lambda name: "/candidate/python")
    expected = runtime_marker(cuda)
    monkeypatch.setattr(
        "clip_factory.models.subprocess.run",
        Mock(side_effect=[SimpleNamespace(stdout="Linux x86_64 (3, 12)"),
                          SimpleNamespace(stdout=json.dumps({**expected, "system": "Linux"}))]),
    )

    def process(job, command, **kwargs):
        if "venv" in command:
            models.python.parent.mkdir(parents=True)
            models.python.touch()
        return "verified"

    models.jobs.process.side_effect = process
    assert models.setup("job")["runtime"] == "ready"
    assert json.loads((models.runtime / ".ready").read_text()) == expected
    install = models.jobs.process.call_args_list[1].args[1]
    assert {"faster-whisper==1.2.1", "ctranslate2==4.9.0", "av==18.0.0"} <= set(install)
    assert not any(arg.startswith(("mlx", "kokoro")) for arg in install)
    assert ("nvidia-cudnn-cu12==9.28.1.4" in install) is cuda
    assert ("nvidia-cublas-cu12==12.9.2.10" in install) is cuda
    assert models.jobs.process.call_args_list[2].args[1][-1] == FW_PROBE


# Transcription: the device, the CPU fallback, and the same transcript contract as MLX.


def test_speech_status_reports_the_device(speech_host, models, monkeypatch):
    speech_host("Darwin", "arm64")
    assert models.speech_status()["device"] == "gpu"
    speech_host("Windows", "AMD64")
    assert models.speech_status() | {"last_run": None} == {
        "backend": "faster-whisper", "label": "faster-whisper", "device": "cpu", "detail": "CPU", "gpu": None,
        "last_run": None,
    }
    speech_host("Windows", "AMD64", gpu="NVIDIA RTX 4070")
    assert models.speech_status()["device"] == "cpu"  # GPU present, CUDA libraries not installed
    fw_runtime(models, monkeypatch, cuda=True)
    assert models.speech_status()["device"] == "cuda"
    assert models.speech_status()["detail"] == "NVIDIA GPU (NVIDIA RTX 4070)"
    speech_host("Darwin", "x86_64")
    assert models.speech_status()["device"] is None


def test_run_sends_engine_and_device_and_records_what_ran(speech_host, models, monkeypatch, tmp_path):
    speech_host("Windows", "AMD64")
    fw_installed(models)
    fw_runtime(models, monkeypatch)
    monkeypatch.setattr("clip_factory.models.psutil.virtual_memory", lambda: SimpleNamespace(available=100 * 10**9))
    audio = tmp_path / "speech.wav"
    audio.write_bytes(b"RIFF")
    sent = {}

    def process(job, command, **kwargs):
        request, response = map(Path, command[-2:])
        assert command[0] == str(models.runtime / "Scripts" / "python.exe")
        sent.update(json.loads(request.read_text()))
        response.write_text(json.dumps({"text": " Hi", "language": "en", "segments": [], "device": "cpu",
                                        "compute_type": "float32"}))

    models.jobs.process.side_effect = process
    result = models.run("job", "whisper-turbo", "transcribe", audio=str(audio), language=None)
    assert sent["engine"] == "faster-whisper" and sent["device"] == "cpu"
    assert result == {"text": " Hi", "language": "en", "segments": []}
    assert models.speech_status()["last_run"] == {"device": "cpu", "compute_type": "float32"}


def test_worker_rejects_unknown_engine_or_device(tmp_path):
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"x")
    base = {"action": "transcribe", "model": str(tmp_path), "audio": str(audio)}
    inference_worker.validate_request({**base, "engine": "faster-whisper", "device": "cuda"})
    for bad in ({"engine": "whisper.cpp"}, {"device": "metal"}):
        with pytest.raises(ValueError):
            inference_worker.validate_request({**base, **bad})


def write_wav(path, seconds=0.5, rate=16000, channels=1):
    with wave.open(str(path), "wb") as output:
        output.setnchannels(channels)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(b"\x00\x10" * int(seconds * rate) * channels)


class FakeWhisper:
    """faster_whisper.WhisperModel without weights: records what the worker asked for."""

    calls: ClassVar[list] = []
    cuda_fails = False

    def __init__(self, path, *, device, compute_type, cpu_threads, local_files_only):
        self.device = device
        FakeWhisper.calls.append({"path": path, "device": device, "compute_type": compute_type,
                                  "threads": cpu_threads, "local_only": local_files_only})

    def transcribe(self, audio, **options):
        FakeWhisper.calls[-1].update(audio=audio, options=options)

        def segments():
            if self.device == "cuda" and FakeWhisper.cuda_fails:
                raise RuntimeError("Library cudnn_ops64_9.dll is not found")  # surfaces while decoding
            words = [SimpleNamespace(word=" Hello", start=0.5, end=0.9, probability=0.9),
                     SimpleNamespace(word=" there.", start=0.9, end=1.3, probability=0.8)]
            yield SimpleNamespace(start=0.5, end=1.3, text=" Hello there.", words=words,
                                  no_speech_prob=0.01, avg_logprob=-0.2)
            yield SimpleNamespace(start=2.0, end=2.4, text=" Bye.", words=None, no_speech_prob=None, avg_logprob=-0.4)

        return segments(), SimpleNamespace(language="en")


@pytest.fixture
def fake_whisper(monkeypatch):
    FakeWhisper.calls = []
    FakeWhisper.cuda_fails = False
    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=FakeWhisper))
    cuda = Mock()
    monkeypatch.setattr(inference_worker, "load_cuda_libraries", cuda)
    return cuda


def test_worker_transcript_contract_matches_mlx(fake_whisper, tmp_path):
    audio = tmp_path / "speech.wav"
    write_wav(audio)
    out = inference_worker.infer({"action": "transcribe", "model": str(tmp_path), "audio": str(audio),
                                  "engine": "faster-whisper", "device": "cpu", "language": "en"})
    assert out == {
        "text": " Hello there. Bye.",
        "language": "en",
        "segments": [
            {"start": 0.5, "end": 1.3, "text": " Hello there.",
             "words": [{"word": " Hello", "start": 0.5, "end": 0.9, "probability": 0.9},
                       {"word": " there.", "start": 0.9, "end": 1.3, "probability": 0.8}],
             "no_speech_prob": 0.01, "avg_logprob": -0.2},
            {"start": 2.0, "end": 2.4, "text": " Bye.", "words": [], "avg_logprob": -0.4},
        ],
        "device": "cpu",
        "compute_type": "float32",
    }
    call = FakeWhisper.calls[0]
    assert call["local_only"] is True and call["device"] == "cpu" and call["compute_type"] == "float32"
    # The app's 16 kHz mono WAV is decoded by the worker, not handed to PyAV as a path.
    assert not isinstance(call["audio"], str) and len(call["audio"]) == 8000 and call["audio"].dtype == "float32"
    assert call["options"] == {
        "language": "en", "word_timestamps": True, "beam_size": 1, "vad_filter": True,
        "condition_on_previous_text": False, "hallucination_silence_threshold": 2.0,
    }
    json.dumps(inference_worker.json_value(out), allow_nan=False)
    fake_whisper.assert_not_called()


def test_worker_falls_back_to_cpu_when_cuda_fails(fake_whisper, tmp_path):
    audio = tmp_path / "speech.wav"
    write_wav(audio)
    FakeWhisper.cuda_fails = True
    out = inference_worker.infer({"action": "transcribe", "model": str(tmp_path), "audio": str(audio),
                                  "engine": "faster-whisper", "device": "cuda"})
    assert [c["device"] for c in FakeWhisper.calls] == ["cuda", "cpu"]
    assert out["device"] == "cpu" and out["segments"][0]["text"] == " Hello there."
    fake_whisper.assert_called_once()


def test_worker_uses_cuda_when_it_works(fake_whisper, tmp_path):
    audio = tmp_path / "speech.wav"
    write_wav(audio)
    out = inference_worker.infer({"action": "transcribe", "model": str(tmp_path), "audio": str(audio),
                                  "engine": "faster-whisper", "device": "cuda"})
    assert (out["device"], out["compute_type"]) == ("cuda", "float16") and len(FakeWhisper.calls) == 1


def test_other_audio_formats_are_left_to_faster_whisper(fake_whisper, tmp_path):
    stereo = tmp_path / "stereo.wav"
    write_wav(stereo, channels=2, rate=44100)
    inference_worker.infer({"action": "transcribe", "model": str(tmp_path), "audio": str(stereo),
                            "engine": "faster-whisper"})
    assert FakeWhisper.calls[0]["audio"] == str(stereo)
    assert inference_worker.read_wav(tmp_path / "missing.wav") is None


# App-owned Python for Windows and Linux.


@pytest.mark.parametrize(
    ("system", "machine", "executable", "probe", "suffix"),
    [
        ("Windows", "AMD64", ("python.exe",), "Windows AMD64 (3, 12)", "x86_64-windows"),
        ("Linux", "x86_64", ("bin", "python3.12"), "Linux x86_64 (3, 12)", "x86_64-linux"),
        ("Darwin", "arm64", ("bin", "python3.12"), "Darwin arm64 (3, 12)", "arm64"),
    ],
)
def test_python_pins_per_platform(system, machine, executable, probe, suffix):
    pin = runtime.pin(system, machine)
    assert (pin["executable"], pin["probe"], pin["suffix"]) == (executable, probe, suffix)
    assert pin["url"].startswith("https://github.com/astral-sh/python-build-standalone/releases/download/20261110/")
    assert "3.12.16" in pin["url"] and len(pin["sha256"]) == 64 and pin["bytes"] > 10**7
    assert runtime.pin("Darwin", "x86_64") is None and runtime.pin("Linux", "aarch64") is None


def test_native_probe_expects_this_platform(speech_host, monkeypatch):
    speech_host("Windows", "AMD64")
    for answer, native in (("Windows AMD64 (3, 12)", True), ("Windows ARM64 (3, 12)", False),
                           ("Windows AMD64 (3, 11)", False), ("Darwin arm64 (3, 12)", False)):
        monkeypatch.setattr(runtime.subprocess, "run", Mock(return_value=SimpleNamespace(stdout=answer)))
        assert runtime.native_python("python.exe", {}) is native
    speech_host("Darwin", "x86_64")
    assert runtime.native_python("python3", {}) is False


def test_windows_python_is_installed_from_its_own_archive(speech_host, tmp_path, monkeypatch):
    speech_host("Windows", "AMD64")
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:  # The Windows build has no bin/ folder.
        for name in ("python/python.exe", "python/Lib/os.py"):
            item = tarfile.TarInfo(name)
            item.size = 6
            archive.addfile(item, io.BytesIO(b"binary"))
    data = output.getvalue()
    pin = runtime.OTHER_PINS[("Windows", "x86_64")]
    monkeypatch.setitem(runtime.OTHER_PINS, ("Windows", "x86_64"),
                        {**pin, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    response = io.BytesIO(data)
    response.geturl = lambda: pin["url"]
    network = Mock(return_value=response)
    monkeypatch.setattr(runtime.urllib.request, "urlopen", network)
    monkeypatch.setattr(runtime, "native_python", Mock(return_value=True))
    executable = runtime.bootstrap_python(tmp_path, Mock(), "job", {})
    target = tmp_path / "python" / "cpython-3.12.16-20261110-x86_64-windows"
    assert executable == target / "python.exe" and executable.read_bytes() == b"binary"
    assert network.call_args.args[0].full_url == pin["url"]
    assert json.loads((target / ".clip-factory-python.json").read_text()) == {
        "version": "3.12.16", "release": "20261110", "sha256": hashlib.sha256(data).hexdigest(),
    }
    assert runtime.bootstrap_python(tmp_path, Mock(), "job", {}) == executable  # reused, not re-downloaded
    network.assert_called_once()


def test_unsupported_platform_has_no_private_python(speech_host, tmp_path):
    speech_host("Linux", "aarch64")
    with pytest.raises(WorkError, match="No app-owned Python"):
        runtime.bootstrap_python(tmp_path, Mock(), "job", {})


# The app: /api/system and speech setup on each platform.


def test_system_reports_the_speech_engine(client, speech_host):
    speech_host("Linux", "x86_64")
    system = client.get("/api/system").json()
    assert system["speech"]["backend"] == "faster-whisper" and system["speech"]["device"] == "cpu"
    blocker = system["engine"]["blocker"]
    assert blocker["code"] == "asr_missing" and blocker["download_gb"] == 1.8
    assert [s["id"] for s in system["engine"]["steps"]] == ["runtime", "whisper-turbo"]


def test_unsupported_platform_app_offers_no_speech_setup(client, speech_host):
    speech_host("Darwin", "x86_64")
    system = client.get("/api/system").json()
    assert system["engine"]["blocker"]["code"] == "asr_unsupported"
    assert system["engine"]["blocker"]["action"] is None and system["engine"]["steps"] == []
    response = client.post("/api/speech/setup", json={"accept_license": True})
    assert response.status_code == 409 and "Local speech recognition needs" in response.json()["detail"]
