"""Deterministic media operations: safe inputs, source-preserving vertical layout, real captions."""
from __future__ import annotations

import json
import math
import shutil
import subprocess
from pathlib import Path

from .jobs import Jobs, WorkError


def probe(path: Path) -> dict:
    tool = shutil.which("ffprobe")
    if not tool:
        raise WorkError("Install FFmpeg (including ffprobe) before importing videos.")
    try:
        result = subprocess.run([tool, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
                                capture_output=True, timeout=30, check=True)
        data = json.loads(result.stdout)
        streams = [s for s in data["streams"] if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")]
        if not streams:
            raise ValueError()
        stream = streams[0]
        duration = float(data.get("format", {}).get("duration") or stream.get("duration") or 0)
        width, height = int(stream["width"]), int(stream["height"])
        if not math.isfinite(duration) or duration <= 0 or width <= 0 or height <= 0:
            raise ValueError()
        return {"duration": duration, "width": width, "height": height,
                "has_audio": any(s.get("codec_type") == "audio" for s in data["streams"])}
    except (ValueError, KeyError, subprocess.SubprocessError):
        raise WorkError("This file is not a readable video with a known duration. Try an MP4 or MOV export.") from None


def ffmpeg() -> str:
    tool = shutil.which("ffmpeg")
    if not tool:
        raise WorkError("Install FFmpeg before processing media.")
    return tool


def stamp(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, rem = divmod(milliseconds, 3600000)
    minutes, rem = divmod(rem, 60000)
    whole, ms = divmod(rem, 1000)
    return f"{hours:02}:{minutes:02}:{whole:02},{ms:03}"


def subtitles(transcript: dict | None, start: float, end: float) -> str:
    entries = []
    for segment in (transcript or {}).get("segments", []):
        a, b = max(start, float(segment.get("start", 0))), min(end, float(segment.get("end", 0)))
        text = str(segment.get("text", "")).replace("\x00", "").replace("\r", "").strip()
        # Exclude ASS control sequences; libass should not interpret injected override tags.
        text = text.replace("{", "(").replace("}", ")").replace("\\", "/").replace("-->", "→")
        if b > a and text:
            entries.append(f"{len(entries)+1}\n{stamp(a-start)} --> {stamp(b-start)}\n{text}\n")
    return "\n".join(entries)


def render(jobs: Jobs, job_id: str, source: Path, output: Path, *, start: float, end: float,
           transcript: dict | None = None, burn_subtitles=True) -> dict:
    output.parent.mkdir(parents=True, exist_ok=True)
    srt = output.with_suffix(".srt")
    caption_text = subtitles(transcript, start, end) if burn_subtitles else ""
    if caption_text:
        srt.write_text(caption_text, encoding="utf-8")
    # Preserve the complete source frame instead of silently cropping subjects/products.
    vf = "scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
    filters = subprocess.run([ffmpeg(), "-hide_banner", "-filters"], capture_output=True, text=True, timeout=10)
    if caption_text:
        if " subtitles " not in filters.stdout:
            raise WorkError("This FFmpeg build lacks libass subtitles. Install full Homebrew FFmpeg or render without captions.")
        # cwd is output directory; filename consists exclusively of generated hexadecimal IDs.
        vf += f",subtitles={srt.name}:force_style='FontName=Arial,FontSize=18,MarginV=60,Outline=2'"
    temporary = output.with_name(output.stem + ".partial.mp4")
    jobs.update(job_id, progress=20, message="Rendering 1080 × 1920 H.264 clip")
    try:
        jobs.process(job_id, [ffmpeg(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", str(start),
                             "-i", str(source), "-t", str(end-start), "-map", "0:v:0", "-map", "0:a?",
                             "-vf", vf, "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
                             "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
                             str(temporary)], cwd=output.parent, failure="FFmpeg render failed. Check disk space and source compatibility.")
        actual = probe(temporary)
        jobs.check(job_id)
        temporary.replace(output)
        return {"subtitles_burned": bool(caption_text), "width": actual["width"], "height": actual["height"],
                "duration": actual["duration"], "warning": None if caption_text or not burn_subtitles else "No transcript: clip rendered without invented captions."}
    finally:
        temporary.unlink(missing_ok=True)


def extract_audio(jobs: Jobs, job_id: str, source: Path, output: Path):
    jobs.process(job_id, [ffmpeg(), "-nostdin", "-v", "error", "-y", "-i", str(source), "-vn", "-ac", "1", "-ar", "16000", str(output)],
                 failure="Audio extraction failed. Verify that this video has a readable audio track.")


def sample_frames(jobs: Jobs, job_id: str, source: Path, directory: Path, duration: float) -> list[dict]:
    directory.mkdir(parents=True, exist_ok=True)
    frames = []
    # Bounded sampling is intentional: analysis is approximate, not exhaustive temporal recall.
    count = min(12, max(1, math.ceil(duration / 10)))
    for i in range(count):
        at = min(duration - 0.05, (i + 0.5) * duration / count)
        target = directory / f"frame-{i:02}.jpg"
        jobs.process(job_id, [ffmpeg(), "-nostdin", "-v", "error", "-y", "-ss", str(max(0, at)), "-i", str(source),
                             "-frames:v", "1", "-vf", "scale=640:-2", str(target)], timeout=60,
                     failure="Frame sampling failed.")
        if target.exists():
            frames.append({"time": round(at, 2), "path": str(target)})
    return frames
