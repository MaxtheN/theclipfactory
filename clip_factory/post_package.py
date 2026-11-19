"""The Instagram "post package" around an approved Reel: caption features, limits and cover.

Pinned against the Composio tool ``INSTAGRAM_POST_IG_USER_MEDIA`` version ``20261112_00``
(``additionalProperties: false``). It accepts ``caption``, ``share_to_feed``, ``cover_url``
(``^https?://``), ``thumb_offset`` (integer milliseconds), ``location_id``, ``user_tags``,
``audio_name`` and others, but **no** ``collaborators`` field, so collaborator invites cannot be
sent through this connection even though the Graph API supports up to three.

Instagram limits (Graph API IG User Media reference): caption ≤ 2,200 characters, ≤ 30
hashtags, ≤ 20 @mentions; Reel cover JPEG ≤ 8 MB, 9:16 recommended; ``cover_url`` wins over
``thumb_offset``. Pure helpers plus one FFmpeg still extraction; no network.
"""

from __future__ import annotations

import hashlib
import re
import subprocess
from collections.abc import Callable
from pathlib import Path

from . import media

CAPTION_MAX = 2200
HASHTAG_MAX = 30
MENTION_MAX = 20
COLLABORATORS_MAX = 3
# The pinned Composio tool schema has no `collaborators` parameter (additionalProperties false).
COLLABORATORS_SUPPORTED = False
COVER_MAX_BYTES = 8 * 1024 * 1024
CANDIDATES = 6
CTA_LINK_IN_BIO = "link in bio"

_HASHTAG = re.compile(r"(?:^|(?<=\s))#(\w+)", re.UNICODE)
_MENTION = re.compile(r"(?:^|(?<=\s))@([A-Za-z0-9_.]+)")
_HANDLE = re.compile(r"^[A-Za-z0-9_.]{1,30}$")


def limits() -> dict:
    return {"caption_chars": CAPTION_MAX, "hashtags": HASHTAG_MAX, "mentions": MENTION_MAX,
            "collaborators": COLLABORATORS_MAX, "collaborators_supported": COLLABORATORS_SUPPORTED,
            "cover_bytes": COVER_MAX_BYTES}


def hashtags(caption: str) -> list[str]:
    return _HASHTAG.findall(caption or "")


def mentions(caption: str) -> list[str]:
    return _MENTION.findall(caption or "")


def caption_sha256(caption: str) -> str:
    return hashlib.sha256((caption or "").encode("utf-8")).hexdigest()


def caption_features(caption: str) -> dict:
    """What the Strategist can later use as variables; derived from the exact text sent."""
    tags, people = hashtags(caption), mentions(caption)
    return {"caption_sha256": caption_sha256(caption), "caption_chars": len(caption or ""),
            "hashtags": tags, "hashtag_count": len(tags), "mentions": people, "mention_count": len(people),
            "cta": "link_in_bio" if CTA_LINK_IN_BIO in (caption or "").lower() else None}


def limit_problems(caption: str) -> list[str]:
    problems = []
    if len(caption or "") > CAPTION_MAX:
        problems.append("Instagram captions are limited to 2,200 characters.")
    if len(hashtags(caption)) > HASHTAG_MAX:
        problems.append("Instagram allows at most 30 hashtags.")
    if len(mentions(caption)) > MENTION_MAX:
        problems.append("Instagram allows at most 20 mentions.")
    return problems


def clean_collaborators(values) -> list[str]:
    """Usernames without @; ≤ 3. Raises ValueError with a person-readable message."""
    names = []
    for value in values or []:
        name = (value or "").strip().lstrip("@") if isinstance(value, str) else ""
        if not _HANDLE.fullmatch(name):
            raise ValueError("Collaborators must be Instagram usernames (letters, numbers, _ and .).")
        if name.lower() not in {n.lower() for n in names}:
            names.append(name)
    if len(names) > COLLABORATORS_MAX:
        raise ValueError("Instagram allows at most 3 collaborators.")
    return names


# ---------------------------------------------------------------------------- cover

def duration_of(clip: dict) -> float | None:
    for value in (clip.get("duration"), (clip.get("end") or 0) - (clip.get("start") or 0)):
        if isinstance(value, (int, float)) and value > 0:
            return float(value)
    return None


def auto_cover(clip: dict) -> dict:
    """The render's own cover choice (craft.cover), as source + millisecond time."""
    craft = clip.get("craft") if isinstance(clip.get("craft"), dict) else {}
    cover = craft.get("cover") if isinstance(craft.get("cover"), dict) else {}
    seconds = cover.get("time") if isinstance(cover.get("time"), (int, float)) else 0.0
    mode = cover.get("mode") if cover.get("mode") in {"best_frame", "first_frame"} else "first_frame"
    return {"source": f"auto_{mode}", "time_ms": max(0, round(seconds * 1000))}


def candidate_times(clip: dict, count: int = CANDIDATES) -> list[int]:
    """Six evenly spaced frames inside the clip (skipping the first/last half second), always
    including the render's own cover time, in milliseconds, sorted and unique."""
    chosen = auto_cover(clip)["time_ms"]
    length = duration_of(clip)
    if not length or length <= 1.2:
        return [chosen]
    lo, hi = 500, int(length * 1000) - 500
    step = (hi - lo) / (count - 1)
    times = {round(lo + i * step) for i in range(count)}
    # Replace the nearest generated time with the auto cover so it is one of the six.
    nearest = min(times, key=lambda t: abs(t - chosen))
    times.discard(nearest)
    times.add(min(max(chosen, 0), int(length * 1000)))
    return sorted(times)


def ffmpeg_still(clip_path: Path, time_ms: int, output: Path, *, timeout: float = 60) -> None:
    """One 1080×1920 JPEG at `time_ms` (Instagram's recommended Reel cover size)."""
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_suffix(".part.jpg")
    command = [media.ffmpeg(), "-nostdin", "-v", "error", "-y", "-ss", f"{time_ms / 1000:.3f}",
               "-i", str(clip_path), "-frames:v", "1", "-vf",
               "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2",
               "-q:v", "3", str(partial)]
    try:
        subprocess.run(command, check=True, capture_output=True, timeout=timeout)
        partial.replace(output)
    except (OSError, subprocess.SubprocessError) as error:
        partial.unlink(missing_ok=True)
        raise ValueError("The cover frame could not be extracted.") from error


class Covers:
    """Cover stills for posting. The auto cover is the render's own ``<clip>.jpg``; a frame the
    person picks is extracted once into ``publish_covers/<clip id>/<clip sha16>-<ms>.jpg``."""

    def __init__(self, root: Path, *, extract: Callable[[Path, int, Path], None] = ffmpeg_still):
        self.root, self.extract = Path(root), extract

    def frame_path(self, clip: dict, time_ms: int) -> Path:
        sha = (clip.get("sha256") or "unknown")[:16]
        return self.root / "publish_covers" / clip["id"] / f"{sha}-{int(time_ms)}.jpg"

    def check_time(self, clip: dict, time_ms) -> int:
        length = duration_of(clip)
        if type(time_ms) is not int or time_ms < 0 or (length and time_ms > int(length * 1000)):
            raise ValueError("Pick a cover frame inside the clip.")
        return time_ms

    def frame(self, clip: dict, clip_path: Path, time_ms: int) -> Path:
        time_ms = self.check_time(clip, time_ms)
        path = self.frame_path(clip, time_ms)
        if not path.is_file():
            self.extract(clip_path, time_ms, path)
        return path

    def resolve(self, clip: dict, clip_path: Path, cover_time_ms: int | None) -> dict:
        """The cover that goes out: a still file (sha256, bytes) plus its frame time for the
        ``thumb_offset`` fallback. Never raises for a missing auto cover: falls back to offset."""
        if cover_time_ms is None:
            choice = auto_cover(clip)
            path = clip_path.with_suffix(".jpg")
        else:
            choice = {"source": "chosen_frame", "time_ms": self.check_time(clip, cover_time_ms)}
            path = self.frame(clip, clip_path, choice["time_ms"])
        record = {**choice, "local_path": None, "sha256": None, "bytes": None}
        if path.is_file() and 0 < path.stat().st_size <= COVER_MAX_BYTES:
            record.update(local_path=path.resolve().relative_to(self.root.resolve()).as_posix(),
                          sha256=media.sha256_file(path), bytes=path.stat().st_size)
        return record
