"""Pre-post quality gate: deterministic checks plus the existing critic's verdict (read-only).

Output is ``pass`` or ``hold`` with reasons, the individual checks, and a 0–5 rubric.
Rubric items that nothing measured are ``None``, never guessed. Posting a held clip
needs an explicit human override reason (enforced by the publisher, not here).
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from collections.abc import Callable
from pathlib import Path

from . import creative_score, media
from .jobs import WorkError
from .posting_server import MAX_VIDEO_BYTES
from .ranking import caption_checks
from .store import now

WIDTH, HEIGHT = 1080, 1920
MIN_SECONDS, MAX_SECONDS = 7.0, 90.0
BLACK_SECONDS, FROZEN_SECONDS = 1.0, 2.0
VIDEO_CODECS = {"h264", "hevc"}
GATE_VERSION = 4
MAX_BYTES = MAX_VIDEO_BYTES  # the smallest platform limit (Instagram Reels)


def detect_black_frozen(path: Path, *, timeout: float = 120) -> dict | None:
    """One bounded FFmpeg decode with blackdetect + freezedetect. None when FFmpeg is unavailable."""
    tool = media.find_tool("ffmpeg")
    if not tool:
        return None
    command = [tool, "-hide_banner", "-nostats", "-threads", "2", "-i", str(path), "-an",
               "-vf", f"blackdetect=d={BLACK_SECONDS}:pix_th=0.10,freezedetect=n=-60dB:d={FROZEN_SECONDS}",
               "-f", "null", "-"]
    try:
        result = subprocess.run(command, capture_output=True, timeout=timeout, check=False)
    except (subprocess.SubprocessError, OSError):
        return None
    if result.returncode:
        return None
    log = result.stderr.decode("utf-8", errors="replace")[-200000:]
    black = [float(m) for m in re.findall(r"black_duration:\s*([0-9.]+)", log)]
    frozen = [float(m) for m in re.findall(r"freeze_duration:\s*([0-9.]+)", log)]
    # A freeze that runs to the end has a start but no duration line.
    open_freeze = log.count("freeze_start") > log.count("freeze_end")
    return {"black_segments": black, "frozen_segments": frozen, "frozen_until_end": open_freeze}


def _check(identifier, label, status, detail, *, technical=True):
    return {"id": identifier, "label": label, "status": status, "detail": detail, "technical": technical}


def context_identity(clip: dict, source_video: dict | None = None) -> str:
    """Cache text/renderer context separately from immutable media bytes."""
    context = {"evidence": creative_score.evidence_for(clip, source_video or {}),
               "metadata": {key: clip.get(key) for key in (
                   "video_id", "sha256", "technical_checks", "team_review_status", "team_checks",
                   "approval_override", "subtitles_burned", "caption_style", "caption_cues", "warning")}}
    return hashlib.sha256(json.dumps(context, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def evaluate(clip: dict, path: Path, *, expected_sha256: str | None = None,
             source_video: dict | None = None,
             inspect: Callable[[Path], dict] = media.inspect,
             sha256: Callable[[Path], str] = media.sha256_file,
             detect: Callable[[Path], dict | None] = detect_black_frozen) -> dict:
    checks: list[dict] = []
    attribution = creative_score.source_attribution_guard(clip, source_video or {})
    for finding in attribution["findings"]:
        checks.append(_check("source_attribution", "Source attribution", "fail",
                             f"{finding['source']}: “{finding['quote']}” — {finding['reason']}", technical=False))
    facts = None
    try:
        facts = inspect(path)
    except (WorkError, OSError):
        facts = None
    video = (facts or {}).get("video")
    if not facts or not video:
        checks.append(_check("decodes", "File decodes", "fail", "ffprobe could not read a video stream."))
    else:
        codec = video.get("codec")
        checks.append(_check("decodes", "File decodes", "pass" if codec in VIDEO_CODECS else "fail",
                             f"Video codec {codec or 'unknown'} (Instagram accepts H.264/HEVC)."))
        width, height = video.get("width"), video.get("height")
        checks.append(_check("aspect", "9:16 at 1080×1920",
                             "pass" if (width, height) == (WIDTH, HEIGHT) else "fail",
                             f"{width}×{height}"))
        duration = facts.get("duration") or video.get("duration")
        ok = isinstance(duration, (int, float)) and MIN_SECONDS <= duration <= MAX_SECONDS
        checks.append(_check("duration", "Duration 7–90 s", "pass" if ok else "fail",
                             f"{duration:.1f} s" if isinstance(duration, (int, float)) else "Unknown duration"))
        audio = facts.get("audio")
        checks.append(_check("audio", "Audio present", "pass" if audio else "fail",
                             f"{audio.get('codec')} audio" if audio else "No audio stream."))
    if clip.get("subtitles_burned") is True:
        checks.append(_check("captions", "Captions burned in", "pass",
                             f"{clip.get('caption_cues') or 'Some'} caption cues, style {clip.get('caption_style') or 'standard'}.",
                             technical=False))
    else:
        checks.append(_check("captions", "Captions burned in", "fail",
                             clip.get("warning") or "No burned captions in this render.", technical=False))
    recorded_captions = caption_checks(clip)
    for check in recorded_captions:
        status = check.get("status")
        checks.append(_check("caption_" + str(check.get("id") or "unknown"),
                             str(check.get("label") or "Caption renderer check"),
                             status if status in {"pass", "fail", "warn", "not_applicable"} else "unknown",
                             str(check.get("detail") or "No check detail recorded.")))
    timing_known = any(c.get("id") == "timing" and c.get("status") in {"pass", "fail"}
                       for c in recorded_captions)
    if clip.get("subtitles_burned") is True and not timing_known:
        checks.append(_check("caption_timing_unmeasured", "Caption timing", "unknown",
                             "Caption timing was not checked for this render; burned captions alone do not verify it."))
    try:
        size = path.stat().st_size
        checks.append(_check("size", "Within 300 MB posting limit", "pass" if 0 < size <= MAX_BYTES else "fail",
                             f"{size / 1048576:.1f} MB"))
    except OSError:
        checks.append(_check("size", "Within 300 MB posting limit", "fail", "File is unreadable."))
    playback = (clip.get("technical_checks") or {}).get("playback_format_passed")
    if playback is not None:
        checks.append(_check("playback", "Render playback checks", "pass" if playback else "fail",
                             "Recorded by the renderer."))
    try:
        actual = sha256(path)
    except OSError:
        actual = None
    recorded = (clip.get("sha256") or "").lower()
    expected = (expected_sha256 or recorded).lower()
    same = bool(actual) and actual == recorded == expected
    checks.append(_check("hash", "Matches the approved revision", "pass" if same else "fail",
                         "SHA-256 matches." if same else "File bytes differ from the approved revision."))
    if facts and video:
        frames = detect(path)
        if frames is None:
            checks.append(_check("frames", "No black or frozen stretches", "unknown",
                                 "FFmpeg frame scan unavailable."))
        else:
            black = [s for s in frames["black_segments"] if s >= BLACK_SECONDS]
            frozen = [s for s in frames["frozen_segments"] if s >= FROZEN_SECONDS]
            bad = black or frozen or frames.get("frozen_until_end")
            detail = (f"{len(black)} black, {len(frozen) + int(bool(frames.get('frozen_until_end')))} frozen stretch(es)."
                      if bad else "None detected.")
            checks.append(_check("frames", "No black or frozen stretches", "fail" if bad else "pass", detail))

    critic_status = clip.get("team_review_status")
    team_checks = clip.get("team_checks") if isinstance(clip.get("team_checks"), dict) else {}
    holds, notes = [], []
    notes.extend(f"{c['label']}: {c['detail']}" for c in checks if c["status"] in {"warn", "unknown"})
    if critic_status in {"fail", "unknown"} and not clip.get("approval_override"):
        holds.append("Critic review is unresolved (" + critic_status + "). Recheck or approve over it.")
    elif critic_status in {"fail", "unknown"}:
        notes.append("Critic findings were explicitly overridden at approval.")

    failing = [c for c in checks if c["status"] == "fail"]
    reasons = [f"{c['label']}: {c['detail']}" for c in failing] + holds
    technical = [c for c in checks if c["technical"]]
    tech_fail = sum(c["status"] == "fail" for c in technical)
    tech_unknown = sum(c["status"] == "unknown" for c in technical)
    rubric_technical = max(0, 5 - tech_fail) if tech_fail else (4 if tech_unknown else 5)

    style = clip.get("caption_style") or "standard"
    legibility = (5 if style in {"high_contrast", "pop"} else 4) if clip.get("subtitles_burned") is True else 1
    if any(c.get("status") == "fail" for c in recorded_captions):
        legibility = 1
    elif clip.get("subtitles_burned") is True and not timing_known:
        legibility = None
    elif any(c.get("status") == "warn" for c in recorded_captions):
        legibility = min(legibility, 3)

    def critic_score(*keys):
        values = [team_checks.get(k) for k in keys]
        if not team_checks or critic_status in {None, "not_applicable"}:
            return None
        if any(v == "fail" for v in values):
            return 1
        if all(v == "pass" for v in values):
            return 5 if len(keys) == 1 else 4
        return None

    hook = (clip.get("hook") or "").strip()
    rubric = {
        "hook_clarity": 0 if not hook else critic_score("claims", "context"),
        "standalone_context": critic_score("context"),
        "caption_legibility": legibility,
        "technical": rubric_technical,
    }
    return {
        "clip_id": clip.get("id"),
        "context_identity": context_identity(clip, source_video),
        "source_attribution": attribution,
        "sha256": actual,
        "verdict": "pass" if not reasons else "hold",
        "reasons": reasons,
        "notes": notes,
        "checks": checks,
        "rubric": rubric,
        "rubric_sources": {
            "hook_clarity": "Proxy from the critic's claims/context checks (it does not score clarity); 0 when no hook.",
            "standalone_context": "Critic context check.",
            "caption_legibility": "Proxy from burned caption style and renderer timing/display checks; not a visual readability assessment. Missing timing is unknown; warnings cap the proxy at 3/5.",
            "technical": "Deterministic file checks.",
        },
        "critic": {"status": critic_status, "checks": team_checks or None,
                   "overridden_at_approval": bool(clip.get("approval_override"))},
        "gate_version": GATE_VERSION,
        "evaluated_at": now(),
    }
