"""Mocked probe validation plus tiny real FFmpeg renders (no network)."""
import json
import shutil
import subprocess
import time
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from clip_factory import media
from clip_factory.jobs import Jobs, WorkError
from clip_factory.store import Store


def mock_probe(monkeypatch, payload):
    monkeypatch.setattr(media.shutil, "which", lambda _: "/mock/ffprobe")
    run = Mock(return_value=SimpleNamespace(stdout=json.dumps(payload).encode()))
    monkeypatch.setattr(media.subprocess, "run", run)
    return run


def test_probe_uses_argument_list_and_ignores_cover_art(tmp_path, monkeypatch):
    path = tmp_path / "video ; touch bad.mp4"
    run = mock_probe(monkeypatch, {"format": {"duration": "3.25"}, "streams": [
        {"codec_type": "video", "width": 1, "height": 1, "disposition": {"attached_pic": 1}},
        {"codec_type": "video", "width": 320, "height": 180}, {"codec_type": "audio"},
    ]})
    assert media.probe(path) == {"duration": 3.25, "width": 320, "height": 180, "has_audio": True}
    assert run.call_args.args[0][-1] == str(path)
    assert run.call_args.kwargs["timeout"] == 30
    assert run.call_args.kwargs["check"] is True
    assert "shell" not in run.call_args.kwargs


@pytest.mark.parametrize("duration,width", [("NaN", 100), ("Infinity", 100), ("0", 100), ("-1", 100), ("1", 0)])
def test_probe_rejects_invalid_dimensions_duration(tmp_path, monkeypatch, duration, width):
    mock_probe(monkeypatch, {"format": {"duration": duration}, "streams": [
        {"codec_type": "video", "width": width, "height": 100}]})
    with pytest.raises(WorkError, match="not a readable video"):
        media.probe(tmp_path / "bad.mp4")


@pytest.mark.parametrize("payload", [{}, {"streams": []}, {"streams": [{"codec_type": "audio"}]}])
def test_probe_rejects_no_video(tmp_path, monkeypatch, payload):
    mock_probe(monkeypatch, payload)
    with pytest.raises(WorkError):
        media.probe(tmp_path / "bad.mp4")


def test_missing_tools_are_actionable(monkeypatch, tmp_path):
    monkeypatch.setattr(media.shutil, "which", lambda _: None)
    with pytest.raises(WorkError, match="ffprobe"):
        media.probe(tmp_path / "video.mp4")
    with pytest.raises(WorkError, match="FFmpeg"):
        media.ffmpeg()


def test_subtitles_clip_rebase_and_neutralize_control_sequences():
    transcript = {"segments": [
        {"start": 0, "end": 1, "text": "outside"},
        {"start": 1, "end": 3, "text": r" {\an8}Hello --> world" + "\x00\r"},
        {"start": 3, "end": 5, "text": "last"},
        {"start": 2, "end": 3, "text": " "},
    ]}
    text = media.subtitles(transcript, 2, 4)
    assert "00:00:00,000 --> 00:00:01,000" in text
    assert "00:00:01,000 --> 00:00:02,000" in text
    assert "(/an8)Hello → world" in text
    assert "outside" not in text
    assert "{" not in text and "\\" not in text and "\x00" not in text
    assert media.subtitles(None, 0, 2) == ""
    assert media.stamp(3661.125) == "01:01:01,125"
    assert media.stamp(-1) == "00:00:00,000"


@pytest.fixture
def sample(tmp_path, request):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("FFmpeg/ffprobe not installed")
    audio = request.param
    path = tmp_path / "source.mp4"
    command = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
               "color=c=blue:s=160x90:r=10:d=0.6"]
    if audio:
        command += ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.6", "-c:a", "aac", "-shortest"]
    command += ["-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)]
    subprocess.run(command, check=True, capture_output=True, timeout=20)
    return path, audio


@pytest.mark.parametrize(
    "sample,caption_style",
    [(False, "standard"), (True, "standard"), (True, "high_contrast")],
    indirect=["sample"],
)
def test_real_render_preserves_audio_and_truthful_subtitles(tmp_path, sample, caption_style):
    source, audio = sample
    before = media.probe(source)
    assert before["has_audio"] is audio
    store, output = Store(tmp_path), tmp_path / "clips" / "abc123.mp4"
    jobs = Jobs(store)
    transcript = {"segments": [{"start": 0.1, "end": 0.5, "text": "Actual words"}]} if audio else None
    if audio:
        filters = subprocess.run([media.ffmpeg(), "-hide_banner", "-filters"], capture_output=True, text=True, timeout=10, check=True)
        if " subtitles " not in filters.stdout:
            jobs.close()
            pytest.skip("FFmpeg lacks libass")
    try:
        job = jobs.submit("render", lambda identifier: media.render(
            jobs, identifier, source, output, start=0.1, end=0.5, transcript=transcript,
            caption_style=caption_style))
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            final = store.get("jobs", job["id"])
            if final["status"] in {"completed", "failed", "cancelled"}:
                break
            time.sleep(0.02)
        assert final["status"] == "completed", final
        actual = media.probe(output)
        assert (actual["width"], actual["height"]) == (1080, 1920)
        assert actual["has_audio"] is audio
        assert actual["duration"] == pytest.approx(0.4, abs=0.12)
        assert final["result"]["subtitles_burned"] is audio
        checks = final["result"]["technical_checks"]
        assert checks["playback_format_passed"], checks
        statuses = {c["id"]: c["status"] for c in checks["playback_format"]}
        assert statuses["audio_stream"] == ("pass" if audio else "not_applicable")
        assert final["result"]["source_segments"] == [{"role": "main", "start": 0.1, "end": 0.5}]
        if audio:
            assert "Actual words" in output.with_suffix(".srt").read_text()
            assert final["result"]["warning"] is None
            frame = subprocess.run(
                ["ffmpeg", "-nostdin", "-v", "error", "-i", str(output), "-frames:v", "1",
                 "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
                capture_output=True, check=True, timeout=15,
            ).stdout
            # The source is solid blue; white pixels belong to the burned caption.
            caption_rows = [
                index // 1080
                for index, rgb in enumerate(zip(frame[0::3], frame[1::3], frame[2::3]))
                if min(rgb) > 220
            ]
            assert caption_rows
            assert min(caption_rows) >= 1440
            assert max(caption_rows) - min(caption_rows) < 120
        else:
            assert "without invented captions" in final["result"]["warning"]
            assert not output.with_suffix(".srt").exists()
        assert not list(output.parent.glob("*.partial.mp4"))
    finally:
        jobs.close()


def test_render_failure_removes_partial_output(tmp_path, monkeypatch):
    output = tmp_path / "abc.mp4"
    jobs = Mock()
    monkeypatch.setattr(media, "ffmpeg", lambda: "/mock/ffmpeg")
    monkeypatch.setattr(media.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout=""))

    def fail(*args, **kwargs):
        output.with_name("abc.partial.mp4").write_bytes(b"broken")
        raise WorkError("render failed")

    jobs.process.side_effect = fail
    with pytest.raises(WorkError, match="render failed"):
        media.render(jobs, "job", tmp_path / "source.mp4", output, start=0, end=1)
    assert not output.exists()
    assert not output.with_name("abc.partial.mp4").exists()


def test_find_tool_prefers_keg_only_ffmpeg_full(monkeypatch):
    present = {"/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg", "/opt/homebrew/bin/ffprobe"}

    def which(name):
        if name in present:
            return name
        return f"/opt/homebrew/bin/{name}" if f"/opt/homebrew/bin/{name}" in present else None

    monkeypatch.setattr(media.shutil, "which", which)
    assert media.find_tool("ffmpeg") == "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"
    assert media.find_tool("ffprobe") == "/opt/homebrew/bin/ffprobe"  # falls back to PATH
    present.clear()
    assert media.find_tool("ffmpeg") is None
