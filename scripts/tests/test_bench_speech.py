"""The speech benchmark's scoring, audio preparation and report, without a speech model."""
import importlib.util
import json
import os
import sys
import wave
from pathlib import Path

import pytest

from clip_factory import models as models_module
from clip_factory import speech_backend

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("bench_speech", REPO / "scripts/bench-speech.py")
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


def write_wav(path, seconds=1.0, rate=16000, channels=1):
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(channels)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(b"\0\0" * channels * int(rate * seconds))
    return path


def test_words_ignore_case_punctuation_and_quotes():
    assert bench.words("Mr. Smith’s “best” idea, 'tis   TRUE!") == ["mr", "smith's", "best", "idea", "tis", "true"]


def test_word_error_rate_counts_substitutions_insertions_and_deletions():
    assert bench.wer(["a", "b", "c", "d"], ["a", "x", "c"]) == 0.5  # b->x substituted, d deleted
    assert bench.wer(["a", "b"], ["a", "b", "c"]) == 0.5
    assert bench.wer(["a"], ["a"]) == 0.0
    assert bench.wer([], []) == 0.0 and bench.wer([], ["a"]) == 1.0


def test_the_digest_changes_with_the_words_or_timing_not_with_float_noise():
    def transcript(start=1.0, text="Hi."):
        return {"segments": [{"start": start, "end": 2.0, "text": text}]}

    assert bench.digest(transcript()) == bench.digest(transcript(start=1.001))
    assert bench.digest(transcript()) != bench.digest(transcript(start=1.5))
    assert bench.digest(transcript()) != bench.digest(transcript(text="Hi!"))


def test_the_apps_own_wav_is_read_directly_and_anything_else_goes_through_ffmpeg(tmp_path, monkeypatch):
    ready = write_wav(tmp_path / "ready.wav")
    stereo = write_wav(tmp_path / "stereo.wav", rate=44100, channels=2)
    (tmp_path / "talk.mp4").write_bytes(b"not audio")
    assert bench.app_wav(ready) and not bench.app_wav(stereo) and not bench.app_wav(tmp_path / "talk.mp4")

    commands = []
    monkeypatch.setattr(bench.subprocess, "run", lambda command, check: commands.append(command))
    monkeypatch.setattr("clip_factory.media.ffmpeg", lambda: "ffmpeg")
    assert bench.prepare(ready, tmp_path, None) == ready and commands == []
    assert bench.prepare(ready, tmp_path, 30) == tmp_path / "audio.wav"
    assert bench.prepare(stereo, tmp_path, None) == tmp_path / "audio.wav"
    cut, whole = commands
    assert cut[cut.index("-t") + 1] == "30" and "-t" not in whole
    assert whole[-7:] == ["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(tmp_path / "audio.wav")]


def test_a_worker_that_fails_is_reported_not_raised(tmp_path):
    outcome = bench.measure(Path(sys.executable), {"action": "unknown"}, tmp_path, dict(os.environ))
    assert outcome["failed"] == "worker exited with 1" and "result" not in outcome


def test_it_stops_when_the_app_has_no_speech_model(tmp_path):
    with pytest.raises(SystemExit, match="No speech model"):
        bench.main([str(write_wav(tmp_path / "a.wav")), "--data-dir", str(tmp_path)])


@pytest.fixture
def installed(tmp_path, monkeypatch):
    """A data folder with the speech model, a faster-whisper CPU runtime and a worker that echoes its batch size."""
    (tmp_path / "models" / "whisper-turbo").mkdir(parents=True)
    monkeypatch.setattr(models_module.Models, "python", property(lambda self: Path(sys.executable)))
    monkeypatch.setattr(models_module.Models, "speech_status", lambda self: {
        "backend": speech_backend.FASTER_WHISPER, "label": "faster-whisper", "device": "cpu", "detail": "CPU",
    })
    requests = []

    def measure(python, request, folder, env):
        requests.append(request)
        segments = [{"start": 0.0, "end": 1.0, "text": " Hello world."}]
        result = {"text": " Hello world.", "segments": segments, "batch_size": request["batch_size"],
                  "device": "cpu"}
        return {"seconds": 10.0, "peak_gb": 1.5, "result": result}

    monkeypatch.setattr(bench, "measure", measure)
    return tmp_path, requests


def test_each_batch_size_is_run_and_reported_with_its_accuracy(installed, capsys):
    root, requests = installed
    audio = write_wav(root / "talk.wav", seconds=20)
    (root / "talk.txt").write_text("Hello there, world.", encoding="utf-8")
    log = root / "runs.jsonl"
    bench.main([str(audio), "--reference", str(root / "talk.txt"), "--batch", "1", "8", "--repeat", "2",
                "--data-dir", str(root), "--json", str(log)])

    assert [r["batch_size"] for r in requests] == [1, 1, 8, 8]
    assert {r["engine"] for r in requests} == {speech_backend.FASTER_WHISPER}
    assert {r["model"] for r in requests} == {str(root / "models" / "whisper-turbo")}
    rows = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
    assert [(r["setting"], r["run"]) for r in rows] == [("batch 1", 1), ("batch 1", 2), ("batch 8", 1), ("batch 8", 2)]
    assert {(r["realtime"], r["words"], r["lines"], r["sentences"], r["wer"], r["same"]) for r in rows} == {
        (2.0, 2, 1, 1, 0.3333, True)
    }
    report = capsys.readouterr().out
    assert "20.0 s of audio" in report and "33.33%" in report


def test_batch_sizes_the_worker_refuses_are_a_usage_error(installed, capsys):
    root, requests = installed
    with pytest.raises(SystemExit) as stopped:
        bench.main([str(write_wav(root / "a.wav")), "--batch", "0", "--data-dir", str(root)])
    assert stopped.value.code == 2 and "--batch takes 1 to 32" in capsys.readouterr().err and requests == []
