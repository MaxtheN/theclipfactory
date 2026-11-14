"""Quality gate cases with mocked ffprobe/FFmpeg results; no media tools are run."""

import hashlib

import pytest

from clip_factory import quality


def facts(width=1080, height=1920, duration=30.0, audio=True, codec="h264"):
    return {"duration": duration,
            "video": {"codec": codec, "width": width, "height": height, "duration": duration},
            "audio": {"codec": "aac", "channels": 2} if audio else None}


@pytest.fixture
def clip(tmp_path):
    path = tmp_path / "c.mp4"
    path.write_bytes(b"approved")
    record = {"id": "c", "sha256": hashlib.sha256(b"approved").hexdigest(), "subtitles_burned": True,
              "caption_cues": 9, "caption_style": "high_contrast", "hook": "Why this works",
              "technical_checks": {"playback_format_passed": True}}
    return record, path


def run(record, path, info=None, frames=None, **kw):
    clean = {"black_segments": [], "frozen_segments": [], "frozen_until_end": False}
    return quality.evaluate(record, path, inspect=lambda p: info or facts(),
                            detect=lambda p: clean if frames is None else frames, **kw)


def ids(report, status="fail"):
    return {c["id"] for c in report["checks"] if c["status"] == status}


def test_clean_clip_passes_with_deterministic_rubric(clip):
    report = run(*clip)
    assert report["verdict"] == "pass" and report["reasons"] == []
    assert report["rubric"] == {"hook_clarity": None, "standalone_context": None,
                                "caption_legibility": 5, "technical": 5}
    assert report["sha256"] == clip[0]["sha256"]


@pytest.mark.parametrize("info,failing", [
    (facts(width=1920, height=1080), "aspect"),
    (facts(duration=5.0), "duration"),
    (facts(duration=91.0), "duration"),
    (facts(audio=False), "audio"),
    (facts(codec="prores"), "decodes"),
])
def test_deterministic_failures_hold(clip, info, failing):
    report = run(*clip, info=info)
    assert report["verdict"] == "hold" and failing in ids(report)
    assert report["rubric"]["technical"] == 4


def test_unreadable_file_holds(clip):
    def broken(_):
        raise quality.WorkError("bad")

    report = quality.evaluate(clip[0], clip[1], inspect=broken, detect=lambda p: None)
    assert report["verdict"] == "hold" and "decodes" in ids(report)
    assert "frames" not in {c["id"] for c in report["checks"]}


def test_missing_captions_and_hash_mismatch(clip):
    record, path = clip
    report = run({**record, "subtitles_burned": False}, path)
    assert "captions" in ids(report) and report["rubric"]["caption_legibility"] == 1
    report = run(record, path, expected_sha256="a" * 64)
    assert "hash" in ids(report) and report["verdict"] == "hold"
    path.write_bytes(b"tampered")
    assert "hash" in ids(run(record, path))


def test_black_and_frozen_frames(clip):
    report = run(*clip, frames={"black_segments": [1.5], "frozen_segments": [], "frozen_until_end": False})
    assert "frames" in ids(report)
    report = run(*clip, frames={"black_segments": [], "frozen_segments": [], "frozen_until_end": True})
    assert "frames" in ids(report)


def test_frame_scan_unavailable_is_unknown_not_failure(clip):
    report = quality.evaluate(clip[0], clip[1], inspect=lambda p: facts(), detect=lambda p: None)
    assert report["verdict"] == "pass" and "frames" in ids(report, "unknown")
    assert report["rubric"]["technical"] == 4


def test_critic_data_drives_rubric_and_holds(clip):
    record, path = clip
    passed = run({**record, "team_review_status": "pass",
                  "team_checks": {"context": "pass", "claims": "pass", "captions": "pass", "duplicates": "pass"}},
                 path)
    assert passed["rubric"]["standalone_context"] == 5 and passed["rubric"]["hook_clarity"] == 4
    failed = run({**record, "team_review_status": "fail",
                  "team_checks": {"context": "fail", "claims": "pass"}}, path)
    assert failed["verdict"] == "hold" and any("Critic" in r for r in failed["reasons"])
    assert failed["rubric"]["standalone_context"] == 1 and failed["rubric"]["hook_clarity"] == 1
    overridden = run({**record, "team_review_status": "fail", "approval_override": {"at": "x"},
                      "team_checks": {"context": "fail", "claims": "pass"}}, path)
    assert overridden["verdict"] == "pass" and overridden["notes"]
    no_hook = run({**record, "hook": ""}, path)
    assert no_hook["rubric"]["hook_clarity"] == 0


def test_oversize_file_holds(clip, monkeypatch):
    monkeypatch.setattr(quality, "MAX_BYTES", 3)
    report = run(*clip)
    assert "size" in ids(report)
