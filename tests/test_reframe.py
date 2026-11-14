"""Speaker/face-aware 9:16 reframing: path shaping, expressions, fallbacks and receipts."""

from __future__ import annotations

import itertools
import re
import shutil
import subprocess
from pathlib import Path
from unittest.mock import Mock

import pytest

from clip_factory import craft, media, reframe

HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def at(keys, t):
    """Evaluate a keyframe path like FFmpeg evaluates `expression` (piecewise linear)."""
    for (t0, x0), (t1, x1) in itertools.pairwise(keys):
        if t0 <= t <= t1:
            return x0 + (x1 - x0) * ((t - t0) / (t1 - t0) if t1 > t0 else 1)
    return keys[-1][1] if t > keys[-1][0] else keys[0][1]


def evaluate(expr: str, t: float) -> float:
    """The generated expression evaluated in Python (clip -> min/max)."""
    python = re.sub(r"clip\(", "_clip(", expr)
    return eval(python, {"_clip": lambda v, lo, hi: min(hi, max(lo, v)), "t": t})


# ----------------------------------------------------------------- pure path shaping


def test_hold_carries_brief_misses_and_backfills_the_opening():
    targets = [(0.0, None), (0.4, 0.3), (0.8, None), (1.2, None), (1.6, 0.32), (2.0, None), (5.0, None)]
    held = reframe.hold(targets, seconds=2.0)
    assert [x for _, x in held] == [0.3, 0.3, 0.3, 0.3, 0.32, 0.32, None]


def test_dead_zone_keeps_a_steady_subject_perfectly_still():
    times = [i * 0.4 for i in range(30)]
    jitter = [0.5 + (0.015 if i % 2 else -0.015) for i in range(30)]  # within the dead zone
    path = reframe.follow(times, jitter)
    assert max(path) - min(path) < 1e-9


def test_follow_respects_the_maximum_pan_speed_and_settles_without_overshoot():
    times = [i * 0.4 for i in range(40)]
    targets = [0.3] * 5 + [0.7] * 35
    path = reframe.follow(times, targets)
    speeds = [abs(b - a) / (t1 - t0) for (a, b, t0, t1) in zip(path, path[1:], times, times[1:])]
    assert max(speeds) <= reframe.MAX_SPEED + 1e-9
    assert path[-1] == pytest.approx(0.7, abs=0.01) and max(path) <= 0.7 + 1e-6


def test_median_drops_a_single_sample_outlier():
    assert reframe.median([0.4, 0.4, 0.9, 0.4, 0.4]) == [0.4] * 5


def test_cuts_snap_instead_of_panning():
    times = [i * 0.4 for i in range(20)]
    targets = [(t, 0.3 if t < 4.0 else 0.7) for t in times]
    keys = reframe.build_path(targets, [3.9], crop=0.32)
    assert at(keys, 3.89) == pytest.approx(0.3, abs=1e-3)
    assert at(keys, 3.9) == pytest.approx(0.7, abs=1e-3)
    # Without the cut the same jump is a speed-limited pan.
    panned = reframe.build_path(targets, [], crop=0.32)
    assert at(panned, 4.4) < 0.6


def test_centres_stay_inside_the_frame():
    keys = reframe.build_path([(i * 0.4, 0.02) for i in range(10)], [], crop=0.32)
    assert all(x == pytest.approx(0.16) for _, x in keys)


def test_long_misses_return_to_the_fixed_focus():
    keys = reframe.build_path([(0.0, None)] * 1 + [(i * 0.4, None) for i in range(1, 10)], [], crop=0.32, default=0.42)
    assert all(x == pytest.approx(0.42) for _, x in keys)


def test_simplify_bounds_keyframes_and_keeps_the_ends():
    keys = [(i * 0.1, 0.5 + 0.2 * ((i * 7919) % 13) / 13) for i in range(400)]
    out = reframe.simplify(keys, limit=20)
    assert len(out) <= 20 and out[0] == keys[0] and out[-1] == keys[-1]
    straight = [(i * 0.4, 0.3 + 0.01 * i) for i in range(30)]
    assert len(reframe.simplify(straight)) == 2


def test_expression_is_flat_piecewise_linear_and_matches_the_path():
    keys = [(0.0, 0.3), (2.0, 0.3), (3.0, 0.5), (5.0, 0.5), (5.001, 0.7), (8.0, 0.7)]
    expr = reframe.expression(keys)
    assert "if(" not in expr and expr.count("clip(") == 2
    for t in (0.0, 1.0, 2.5, 3.0, 4.9, 5.0005, 6.0, 9.0):
        assert evaluate(expr, t) == pytest.approx(at(keys, t), abs=1e-3)
    crop = reframe.crop_filter(keys)
    assert crop.startswith("crop=w='2*trunc(ih*9/32)':h=ih:x='max(0,min(iw-ow,(") and crop.endswith(":y=0,")


def test_choose_prefers_the_talking_face_with_hysteresis_and_frames_close_pairs():
    still = {"x": 0.25, "w": 0.12, "h": 0.2, "mouth": 0.05}
    samples = []
    for i in range(12):
        talker = {"x": 0.75, "w": 0.1, "h": 0.18, "mouth": 0.05 + (0.12 if i % 2 else 0.0)}
        samples.append((i * 0.4, {"faces": [dict(still), talker]}))
    picks = reframe.choose(samples, crop=0.32)
    assert picks[0][1] == pytest.approx(0.25)          # larger face first
    assert picks[-1][1] == pytest.approx(0.75)         # the talker takes over...
    first_switch = next(i for i, (_, x, _) in enumerate(picks) if x == pytest.approx(0.75))
    assert first_switch >= reframe.SWITCH_SAMPLES       # ...only after winning several samples
    pair = [(0.0, {"faces": [{"x": 0.45, "w": 0.08, "h": 0.15, "mouth": None},
                             {"x": 0.58, "w": 0.08, "h": 0.15, "mouth": None}]})]
    assert reframe.choose(pair, crop=0.32)[0][1] == pytest.approx(0.515)
    person = [(0.0, {"faces": [], "people": [{"x": 0.6, "w": 0.2, "h": 0.6, "mouth": None}]})]
    assert reframe.choose(person, crop=0.32)[0][1:] == (0.6, "person")


def test_split_jpegs_and_cut_parsing():
    stream = b"\xff\xd8aa\xff\xd9" + b"\xff\xd8bb\xff\xd9"
    assert reframe.split_jpegs(stream) == [b"\xff\xd8aa\xff\xd9", b"\xff\xd8bb\xff\xd9"]
    text = "frame:12 pts:6006 pts_time:4.2042\nlavfi.scene_score=0.61\nframe:40 pts:1 pts_time:9.5\n"
    assert reframe.parse_cuts(text) == [4.2042, 9.5]


# ----------------------------------------------------------------- plan(): fallbacks and summary


def fake_sample(face_x):
    def sample(ffmpeg, source, start, span):
        count = int(span * reframe.SAMPLE_FPS)
        return [(i / reframe.SAMPLE_FPS, f"{start + i / reframe.SAMPLE_FPS}".encode()) for i in range(count)], [5.0]
    return sample


def test_plan_applies_records_summary_and_uses_storyboard_cuts(monkeypatch):
    monkeypatch.setattr(reframe, "sample", fake_sample(None))
    detector = lambda jpeg: {"faces": [{"x": 0.3 if float(jpeg) < 5 else 0.7, "w": 0.1, "h": 0.2, "mouth": None}]}
    result = reframe.plan("ffmpeg", Path("s.mp4"), [{"start": 0.0, "span": 10.0}], width=1280, height=720,
                          scene_cuts=[7.5, 40.0], detector=detector)
    assert result["status"] == "applied" and len(result["filters"]) == 1
    summary = result["summary"]
    assert summary["samples"] == 25 and summary["face_share"] == 1.0 and summary["cuts"] == 2
    assert summary["crop_width"] == pytest.approx(0.3164, abs=1e-4)
    keys = summary["path"][0]
    assert keys[0][1] == pytest.approx(0.3, abs=0.01) and keys[-1][1] == pytest.approx(0.7, abs=0.01)


def test_plan_falls_back_with_reasons(monkeypatch):
    monkeypatch.setattr(reframe, "sample", fake_sample(None))
    windows = [{"start": 0.0, "span": 10.0}]
    none = reframe.plan("ffmpeg", Path("s.mp4"), windows, width=1280, height=720, detector=lambda j: {"faces": []})
    assert none["status"] == "fallback" and "0%" in none["summary"]["reason"] and "filters" not in none
    portrait = reframe.plan("ffmpeg", Path("s.mp4"), windows, width=1080, height=1920, detector=lambda j: {})
    assert portrait["status"] == "skipped"
    long = reframe.plan("ffmpeg", Path("s.mp4"), [{"start": 0.0, "span": 200.0}], width=1280, height=720,
                        detector=lambda j: {})
    assert long["status"] == "skipped" and "180" in long["summary"]["reason"]
    broken = reframe.plan("ffmpeg", Path("s.mp4"), windows, width=1280, height=720,
                          detector=Mock(side_effect=RuntimeError("Vision error")))
    assert broken["status"] == "fallback" and "Vision error" in broken["summary"]["reason"]
    monkeypatch.setattr(reframe, "available", lambda: (False, "Apple Vision is not available (ImportError)."))
    missing = reframe.plan("ffmpeg", Path("s.mp4"), windows, width=1280, height=720)
    assert missing["status"] == "unavailable" and "Vision" in missing["summary"]["reason"]


# ----------------------------------------------------------------- renderer wiring (mocked FFmpeg)


def fill_render(tmp_path, monkeypatch, *, planned, framing="fill", **edit):
    commands, calls = [], []
    monkeypatch.setattr(media, "probe", lambda _: {"duration": 12.0, "width": 1280, "height": 720, "has_audio": False})
    monkeypatch.setattr(media, "filters", lambda: " subtitles ")
    monkeypatch.setattr(media, "ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(media, "ffmpeg_version", lambda: "ffmpeg version test")
    monkeypatch.setattr(media, "verify", lambda *a, **k: {"playback_format_passed": True, "playback_format": [], "captions": []})

    def plan(*args, **kwargs):
        calls.append(kwargs)
        return planned

    monkeypatch.setattr(reframe, "plan", plan)

    def process(job, command, **kwargs):
        commands.append(command)
        Path(command[-1]).write_bytes(b"mp4")
        return ""

    jobs = Mock()
    jobs.process.side_effect = process
    options = craft.CraftOptions(loudness="off", jump_cuts="off", structure="linear", **edit).model_dump(exclude={"variants"})
    result = media.render(jobs, "job", tmp_path / "s.mp4", tmp_path / "out" / "c.mp4", start=1.0, end=11.0,
                          framing=framing, focus_x=0.4, edit=options, moment={"scenes": [{"start": 0.0}, {"start": 6.5}]})
    graph = commands[-1][commands[-1].index("-filter_complex") + 1]
    return graph, result, calls


def test_auto_face_is_the_default_and_puts_the_crop_path_before_the_frame_select(tmp_path, monkeypatch):
    path_filter = reframe.crop_filter([(0.0, 0.3), (4.0, 0.6)])
    planned = {"status": "applied", "filters": [path_filter], "summary": {"mode": "auto_face", "samples": 25, "face_share": 0.96}}
    graph, result, calls = fill_render(tmp_path, monkeypatch, planned=planned)
    assert craft.CraftOptions().crop_focus == "auto_face" and craft.LEGACY_PLAN["crop_focus"] == "fixed"
    assert f"[0:v:0]fps=30,{path_filter}select='" in graph
    assert calls[0]["width"] == 1280 and calls[0]["scene_cuts"] == [0.0, 6.5] and calls[0]["default"] == 0.4
    record = result["craft"]["reframe"]
    assert record["status"] == "applied" and record["samples"] == 25 and record["fallback"] is None


def test_unavailable_detector_keeps_the_fixed_crop_and_says_so(tmp_path, monkeypatch):
    planned = {"status": "unavailable", "summary": {"mode": "auto_face", "reason": "Apple Vision is not available."}}
    graph, result, _ = fill_render(tmp_path, monkeypatch, planned=planned)
    assert "trunc(ih*9/32)" not in graph and "crop=1080:1920:(iw-ow)*0.4000" in graph
    record = result["craft"]["reframe"]
    assert record["status"] == "unavailable" and record["fallback"] == "fixed crop at focus_x 0.400"


def test_fixed_focus_and_non_crop_framing_never_run_the_detector(tmp_path, monkeypatch):
    _, result, calls = fill_render(tmp_path, monkeypatch, planned=None, crop_focus="fixed")
    assert not calls and result["craft"]["reframe"] == {"mode": "fixed", "status": "off"}
    _, result, calls = fill_render(tmp_path, monkeypatch, planned=None, framing="blur")
    assert not calls and result["craft"]["reframe"] == {"mode": None, "status": "off"}


# ----------------------------------------------------------------- real FFmpeg (expression parses in 4.4)


@pytest.mark.skipif(not HAS_FFMPEG, reason="FFmpeg is not installed")
def test_real_ffmpeg_accepts_the_crop_expression_and_samples_with_cuts(tmp_path):
    source = tmp_path / "wide.mp4"
    subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=3",
         "-f", "lavfi", "-i", "color=c=red:s=640x360:r=30:d=3", "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]",
         "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(source)],
        check=True, capture_output=True, timeout=60,
    )
    frames, cuts = reframe.sample("ffmpeg", source, 0.0, 6.0)
    assert len(frames) == pytest.approx(15, abs=1) and all(f.startswith(b"\xff\xd8") for _, f in frames)
    assert any(abs(c - 3.0) < 0.1 for c in cuts)
    chain = reframe.crop_filter([(0.0, 0.25), (2.999, 0.25), (3.0, 0.75), (6.0, 0.75)])
    out = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", str(source), "-vf", chain + "null", "-f", "rawvideo",
         "-pix_fmt", "gray", "-"],
        check=True, capture_output=True, timeout=60,
    )
    width = 2 * int(360 * 9 / 32)
    assert len(out.stdout) == width * 360 * 180
