"""Mocked probe validation plus tiny real FFmpeg renders (no network)."""
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path
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
    assert media.probe(path) == {
        "duration": 3.25, "width": 320, "height": 180, "has_audio": True, "hdr": False,
    }
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
    [(False, "standard"), (True, "standard"), (True, "high_contrast"), (True, "pop")],
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
            caption_style=caption_style, motion="push_in" if caption_style == "pop" else "static",
            framing="blur" if caption_style == "pop" else "fit"))
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


def spoken(start, text, *probabilities, length=1.0):
    words = [{"word": w, "start": start, "end": start + length, "probability": p}
             for w, p in zip(text.split(), probabilities)]
    return {"start": start, "end": start + length, "text": f" {text}", "words": words}


def test_transcript_cleaning_drops_invented_speech_and_keeps_real_lines_verbatim():
    real = [spoken(500, "Come on, come on.", 0.9, 0.95, 0.9, 0.97), spoken(1200, "Can I challenge this table?", 0.6, 0.9, 0.98, 0.9, 1.0)]
    invented = (
        [spoken(30 * i, "Thank you.", 0.03, 0.99) for i in range(1, 12)]  # the same phrase looping through the file
        + [spoken(400, "aiton gotta do that", 0.0, 0.0, 0.03, 0.14)]  # the recognizer did not believe its own words
        + [spoken(1213, "How do you play?", 0.9, 0.9, 0.9, 0.9, length=17.0)]  # four words stretched over 17 seconds
        + [{"start": 1054.8, "end": 1054.8, "text": ""}]
    )
    result = media.clean_transcript({"language": "en", "text": "raw", "segments": invented + real})
    assert [s["text"] for s in result["segments"]] == [" Come on, come on.", " Can I challenge this table?"]
    assert result["removed_segments"] == len(invented)
    assert result["text"] == "Come on, come on. Can I challenge this table?"
    assert result["language"] == "en"


def test_transcript_cleaning_drops_a_line_stuck_on_repeat_but_not_ordinary_repetition():
    stuck = [spoken(1100 + 3 * i, "I'm gonna move.", 0.9, 0.9, 0.9) for i in range(7)]
    twice = [spoken(838, "Oh wow.", 0.9, 0.9), spoken(845, "Oh wow.", 0.9, 0.9)]
    talk = [spoken(10 * i, f"Sentence number {i}.", 0.9, 0.9, 0.9) for i in range(30)]
    result = media.clean_transcript({"segments": talk + twice + stuck})
    assert len(result["segments"]) == 32 and result["removed_segments"] == 7
    assert not any("gonna move" in s["text"] for s in result["segments"])


def test_transcript_cleaning_leaves_confident_speech_and_wordless_imports_untouched():
    transcript = {"language": "en", "text": "Hello there. Yes.", "segments": [
        spoken(0, "Hello there.", 0.97, 0.99), {"start": 2, "end": 3, "text": "Yes."},
    ]}
    assert media.clean_transcript(transcript) == transcript


def test_probe_reports_rotated_phone_footage_as_displayed_and_flags_hdr(tmp_path, monkeypatch):
    mock_probe(monkeypatch, {"format": {"duration": "10"}, "streams": [{
        "codec_type": "video", "width": 1920, "height": 1080, "color_transfer": "arib-std-b67",
        "side_data_list": [{"side_data_type": "Display Matrix", "rotation": -90}],
    }]})
    assert media.probe(tmp_path / "phone.mov") == {
        "duration": 10.0, "width": 1080, "height": 1920, "has_audio": False, "hdr": True,
    }
    mock_probe(monkeypatch, {"format": {"duration": "10"}, "streams": [{
        "codec_type": "video", "width": 1920, "height": 1080, "tags": {"rotate": "180"},
    }]})
    info = media.probe(tmp_path / "upside-down.mov")
    assert (info["width"], info["height"], info["hdr"]) == (1920, 1080, False)


def test_metadata_parser_pairs_values_with_timestamps_and_treats_silence_as_floor(tmp_path):
    log = tmp_path / "levels.txt"
    log.write_text(
        "frame:0    pts:0       pts_time:0\nlavfi.astats.Overall.RMS_level=-28.5\n"
        "frame:1    pts:4000    pts_time:0.5\nlavfi.astats.Overall.RMS_level=-inf\n"
        "frame:2    pts:8000    pts_time:1\nlavfi.other=3\n"
        "frame:3    pts:12000   pts_time:1.5\nlavfi.astats.Overall.RMS_level=garbage\n"
    )
    assert media.read_metadata(log, "lavfi.astats.Overall.RMS_level") == [(0.0, -28.5), (0.5, -120.0)]
    assert media.read_metadata(tmp_path / "missing.txt", "x") == []


def test_speech_is_classified_as_carrying_the_footage_or_as_background():
    def line(start, text):
        return {"start": start, "end": start + 2, "text": text}

    talk = {"segments": [line(3 * i, "Six words are spoken right here.") for i in range(40)]}
    assert media.classify_speech(talk, 120.0)["speech"] == "throughout"
    assert media.foreground(media.classify_speech(talk, 120.0)) == talk["segments"]
    # A twenty-minute game with stray exclamations: nothing to caption or reason from.
    gym = {"segments": [line(60 * i, "Oh wow.") for i in range(18)]}
    quiet = media.classify_speech(gym, 1200.0)
    assert quiet["speech"] == "none" and all(s["background"] for s in quiet["segments"])
    assert media.foreground(quiet) == [] and media.subtitles(quiet, 0, 1200) == ""
    # The same game with a real conversation near the end: only that stretch counts.
    chat = [line(1100 + 2.5 * i, "They have a ping pong table at work.") for i in range(12)]
    mixed = media.classify_speech({"segments": gym["segments"] + chat}, 1200.0)
    assert mixed["speech"] == "in places"
    assert [s["text"] for s in media.foreground(mixed)] == [c["text"] for c in chat]
    # Reclassifying is stable and never mutates its input.
    again = media.classify_speech(mixed, 1200.0)
    assert again == mixed and "background" not in gym["segments"][0]
    assert media.classify_speech({"segments": []}, 60.0)["speech"] == "none"


class Recorder:
    """Stands in for the job runner: records commands and writes what FFmpeg would have."""

    def __init__(self, write=None):
        self.commands = []
        self.write = write

    def process(self, job, command, **options):
        self.commands.append(command)
        if self.write:
            self.write(command)
        return ""


def movement(columns_with_action, frames=8):
    """Raw 64x36 grayscale difference frames with movement in the given columns."""
    row = bytes(200 if column in columns_with_action else 3 for column in range(64))
    return row * 36 * frames


@pytest.mark.parametrize(
    "columns,expected",
    [
        (range(28, 36), {"crop_width": 0.3164, "focus_x": 0.5}),  # a centred subject fills the screen
        (range(8), {"crop_width": 0.3164, "focus_x": 0.0}),  # a subject at the left edge
        (range(56, 64), {"crop_width": 0.3164, "focus_x": 1.0}),  # and at the right edge
        (range(16, 50), {"crop_width": 0.5625, "focus_x": 0.536}),  # two players apart: a square crop
        (range(4, 60), None),  # action across the frame: keep all of it
    ],
)
def test_action_window_is_the_tightest_crop_that_keeps_the_movement(tmp_path, monkeypatch, columns, expected):
    monkeypatch.setattr(media, "ffmpeg", lambda: "ffmpeg")
    jobs = Recorder(lambda command: Path(command[-1]).write_bytes(movement(set(columns))))
    window = media.action_window(jobs, "job", tmp_path / "v.mov", tmp_path / "w", start=10, end=40, width=1920, height=1080)
    if expected is None:
        assert window is None
    else:
        assert window["crop_width"] == expected["crop_width"] and window["share"] >= 0.9
        assert window["focus_x"] == pytest.approx(expected["focus_x"], abs=0.04)
    command = jobs.commands[0]
    assert command[command.index("-ss") + 1] == "10.000" and command[command.index("-t") + 1] == "30.000"
    assert not (tmp_path / "w" / "movement.gray").exists()  # scratch is removed


def test_action_window_keeps_the_whole_frame_when_unsure(tmp_path, monkeypatch):
    monkeypatch.setattr(media, "ffmpeg", lambda: "ffmpeg")
    still = Recorder(lambda command: Path(command[-1]).write_bytes(bytes(64 * 36 * 8)))
    assert media.action_window(still, "j", tmp_path / "v", tmp_path / "w", start=0, end=9, width=1920, height=1080) is None
    portrait = Recorder()
    assert media.action_window(portrait, "j", tmp_path / "v", tmp_path / "w", start=0, end=9, width=1080, height=1920) is None
    assert not portrait.commands

    def broken(command):
        raise WorkError("Movement analysis failed.")

    assert media.action_window(Recorder(broken), "j", tmp_path / "v", tmp_path / "w", start=0, end=9, width=1920, height=1080) is None


def test_frames_are_extracted_in_one_process_and_tone_mapped_for_hdr(tmp_path, monkeypatch):
    monkeypatch.setattr(media, "ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(media, "can_tonemap", lambda listing=None: True)
    jobs = Recorder(lambda command: [Path(part).write_bytes(b"jpg") for part in command if str(part).endswith(".jpg")])
    targets = [(1.5, tmp_path / "a.jpg"), (-2, tmp_path / "b.jpg")]
    frames = media.extract_frames(jobs, "job", tmp_path / "source.mov", targets, hdr=True)
    assert frames == [{"time": 1.5, "path": str(tmp_path / "a.jpg")}, {"time": -2, "path": str(tmp_path / "b.jpg")}]
    command = jobs.commands[0]
    assert len(jobs.commands) == 1 and command.count("-i") == 2
    assert [command[i + 1] for i, part in enumerate(command) if part == "-ss"] == ["1.500", "0.000"]
    assert all("tonemap" in command[i + 1] for i, part in enumerate(command) if part == "-vf")
    monkeypatch.setattr(media, "can_tonemap", lambda listing=None: False)
    media.extract_frames(jobs, "job", tmp_path / "source.mov", targets[:1], hdr=True)
    assert "tonemap" not in " ".join(jobs.commands[1])  # a build without the filters still yields frames
    assert media.extract_frames(jobs, "job", tmp_path / "source.mov", []) == [] and len(jobs.commands) == 2


def test_render_rejects_an_impossible_crop(tmp_path):
    for crop in (0.1, 1.5):
        with pytest.raises(WorkError, match="kept width"):
            media.render(Mock(), "job", tmp_path / "s.mp4", tmp_path / "o.mp4", start=0, end=1, crop_width=crop)
    with pytest.raises(WorkError, match="framing"):
        media.render(Mock(), "job", tmp_path / "s.mp4", tmp_path / "o.mp4", start=0, end=1, framing="tilt")


def test_word_by_word_captions_highlight_the_spoken_word_with_the_same_verbatim_text():
    transcript = {"segments": [{"start": 10.0, "end": 12.0, "text": "it is {really} good", "words": [
        {"word": "it", "start": 10.0, "end": 10.3}, {"word": "is", "start": 10.3, "end": 10.6},
        {"word": "{really}", "start": 10.6, "end": 11.4}, {"word": "good", "start": 11.4, "end": 12.0},
    ]}, {"start": 13.0, "end": 14.0, "text": "No word timings here"}]}
    entries = media.caption_entries(transcript, [{"start": 10.0, "end": 15.0}])
    script = media.pop_captions(entries)
    events = [line.split(",,0,0,0,,", 1) for line in script.splitlines() if line.startswith("Dialogue:")]
    # One event per spoken word; the cue text is identical each time, only the highlight moves.
    assert [text.replace("{\\c&H00E5FF&\\fscx112\\fscy112}", "[").replace("{\\r}", "]") for _, text in events] == [
        "[IT] IS (REALLY) GOOD", "IT [IS] (REALLY) GOOD", "IT IS [(REALLY)] GOOD", "IT IS (REALLY) [GOOD]",
        "NO WORD TIMINGS HERE",
    ]
    assert [head.split(",")[1:3] for head, _ in events] == [
        ["0:00:00.00", "0:00:00.30"], ["0:00:00.30", "0:00:00.60"], ["0:00:00.60", "0:00:01.40"],
        ["0:00:01.40", "0:00:02.00"], ["0:00:03.00", "0:00:04.00"],
    ]
    # Source braces cannot open an override tag: only the highlight uses them.
    assert script.count("{") == 2 * 4 and "PlayResY: 1920" in script
    assert media.srt_text(entries).count("-->") == 2  # the sidecar captions are unchanged
    assert media.pop_captions([]).count("Dialogue:") == 0


def test_find_tool_uses_the_copy_bundled_in_the_packaged_app(tmp_path, monkeypatch):
    import sys as _sys

    from clip_factory import media as _media

    bundled = tmp_path / "bin"
    bundled.mkdir()
    tool = bundled / ("ffprobe.exe" if sys.platform == "win32" else "ffprobe")
    tool.write_text("#!/bin/sh\nexit 0\n")
    tool.chmod(0o755)
    monkeypatch.setattr(_media, "FULL_FFMPEG_DIRS", ())
    monkeypatch.setattr(_media, "HOMEBREW_BIN_DIRS", ())  # the runner may have Homebrew FFmpeg
    monkeypatch.setenv("PATH", "")  # a double-clicked app gets a bare PATH
    monkeypatch.setattr(_sys, "frozen", True, raising=False)
    monkeypatch.setattr(_sys, "_MEIPASS", str(tmp_path), raising=False)
    assert Path(_media.find_tool("ffprobe")) == tool
    monkeypatch.setattr(_sys, "frozen", False, raising=False)
    assert _media.find_tool("ffprobe") is None


@pytest.mark.skipif(sys.platform == "win32", reason="Homebrew does not exist on Windows; per-OS install help is WO-28")
def test_find_tool_finds_homebrew_ffmpeg_with_a_bare_path(tmp_path, monkeypatch):
    from clip_factory import media as _media

    brew = tmp_path / "homebrew-bin"
    brew.mkdir()
    tool = brew / "ffmpeg"
    tool.write_text("#!/bin/sh\nexit 0\n")
    tool.chmod(0o755)
    monkeypatch.setattr(_media, "FULL_FFMPEG_DIRS", ())
    monkeypatch.setattr(_media, "HOMEBREW_BIN_DIRS", (str(brew),))
    monkeypatch.setenv("PATH", "/usr/bin:/bin")  # launchd PATH for a double-clicked app
    assert _media.find_tool("ffmpeg") == str(tool)
    assert "brew install ffmpeg" in _media.INSTALL_FFMPEG
