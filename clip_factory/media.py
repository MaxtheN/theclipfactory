"""Deterministic media operations: safe inputs, source-preserving vertical layout, real captions."""

from __future__ import annotations

import hashlib
import itertools
import json
import math
import re
import shutil
import subprocess
from pathlib import Path

from .jobs import Jobs, WorkError
from .store import now

OUTPUT_WIDTH, OUTPUT_HEIGHT, OUTPUT_FPS = 1080, 1920, 30
ENCODER = {
    "container": "mp4",
    "width": OUTPUT_WIDTH,
    "height": OUTPUT_HEIGHT,
    "frame_rate": OUTPUT_FPS,
    "video_codec": "libx264",
    "preset": "veryfast",
    "crf": 22,
    "pix_fmt": "yuv420p",
    "audio_codec": "aac",
    "audio_bitrate": "128k",
    "movflags": "+faststart",
}
# Readable vertical captions: about two lines of the burned style per cue.
CAPTION_MAX_CHARS = 32
CAPTION_MAX_WORDS = 7
CAPTION_WORD_GAP = 0.6
CAPTION_MIN_DISPLAY = 0.5
CAPTION_SHORT_SECONDS = 0.3
CAPTION_LONG_CHARS = 84
COLD_OPEN_LIMITS = (0.5, 10.0)


def probe(path: Path) -> dict:
    tool = shutil.which("ffprobe")
    if not tool:
        raise WorkError("Install FFmpeg (including ffprobe) before importing videos.")
    try:
        result = subprocess.run(
            [tool, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
            capture_output=True,
            timeout=30,
            check=True,
        )
        data = json.loads(result.stdout)
        streams = [
            s
            for s in data["streams"]
            if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")
        ]
        if not streams:
            raise ValueError()
        stream = streams[0]
        duration = float(data.get("format", {}).get("duration") or stream.get("duration") or 0)
        width, height = int(stream["width"]), int(stream["height"])
        if not math.isfinite(duration) or duration <= 0 or width <= 0 or height <= 0:
            raise ValueError()
        return {
            "duration": duration,
            "width": width,
            "height": height,
            "has_audio": any(s.get("codec_type") == "audio" for s in data["streams"]),
        }
    except (ValueError, KeyError, subprocess.SubprocessError):
        raise WorkError(
            "This file is not a readable video with a known duration. Try an MP4 or MOV export."
        ) from None


def number(value) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def rate(value) -> float | None:
    numerator, _, denominator = str(value or "").partition("/")
    try:
        result = float(numerator) / float(denominator or 1)
    except (ValueError, ZeroDivisionError):
        return None
    return result if math.isfinite(result) and result > 0 else None


def inspect(path: Path) -> dict:
    """Stream facts used by technical checks; unlike probe(), audio-only or odd files are reported."""
    tool = shutil.which("ffprobe")
    if not tool:
        raise WorkError("Install FFmpeg (including ffprobe) before checking media.")
    try:
        result = subprocess.run(
            [tool, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
            capture_output=True,
            timeout=30,
            check=True,
        )
        data = json.loads(result.stdout)
    except (ValueError, subprocess.SubprocessError):
        raise WorkError("The media file could not be inspected with ffprobe.") from None
    streams = data.get("streams") or []
    video = next(
        (
            s
            for s in streams
            if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")
        ),
        None,
    )
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    frames = str((video or {}).get("nb_frames", ""))
    return {
        "format_name": str(data.get("format", {}).get("format_name", "")),
        "duration": number(data.get("format", {}).get("duration")),
        "video": None
        if not video
        else {
            "codec": video.get("codec_name"),
            "pix_fmt": video.get("pix_fmt"),
            "width": video.get("width"),
            "height": video.get("height"),
            "frame_rate": rate(video.get("avg_frame_rate")) or rate(video.get("r_frame_rate")),
            "duration": number(video.get("duration")),
            "frames": int(frames) if frames.isdigit() else None,
        },
        "audio": None
        if not audio
        else {
            "codec": audio.get("codec_name"),
            "channels": audio.get("channels"),
            "duration": number(audio.get("duration")),
        },
    }


def ffmpeg() -> str:
    tool = shutil.which("ffmpeg")
    if not tool:
        raise WorkError("Install FFmpeg before processing media.")
    return tool


def ffmpeg_version() -> str | None:
    try:
        output = subprocess.run(
            [ffmpeg(), "-hide_banner", "-version"], capture_output=True, text=True, timeout=10, check=False
        ).stdout
    except (OSError, subprocess.SubprocessError, WorkError):
        return None
    lines = (output or "").splitlines()
    return lines[0][:200] if lines else None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while chunk := file.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def moov_before_mdat(path: Path) -> bool | None:
    """Walk top-level MP4 boxes: True when metadata precedes media data (progressive playback)."""
    try:
        total = path.stat().st_size
        with path.open("rb") as file:
            offset = 0
            for _ in range(64):
                file.seek(offset)
                header = file.read(8)
                if len(header) < 8:
                    return None
                size, kind = int.from_bytes(header[:4], "big"), header[4:8]
                if size == 1:
                    size = int.from_bytes(file.read(8), "big")
                elif size == 0:
                    size = total - offset
                if kind == b"moov":
                    return True
                if kind == b"mdat":
                    return False
                if size < 8:
                    return None
                offset += size
    except OSError:
        return None
    return None


def stamp(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, rem = divmod(milliseconds, 3600000)
    minutes, rem = divmod(rem, 60000)
    whole, ms = divmod(rem, 1000)
    return f"{hours:02}:{minutes:02}:{whole:02},{ms:03}"


def clean_caption(value) -> str:
    text = re.sub(r"\s*\n\s*", " ", str(value).replace("\x00", "").replace("\r", "")).strip()
    # Exclude ASS control sequences; libass should not interpret injected override tags.
    return text.replace("{", "(").replace("}", ")").replace("\\", "/").replace("-->", "→")


def usable_words(words) -> list[dict]:
    """Word timings from Whisper/imported JSON; any malformed word falls back to segment timing."""
    if not isinstance(words, list) or not words:
        return []
    result = []
    for word in words:
        if not isinstance(word, dict):
            return []
        start, end = number(word.get("start")), number(word.get("end"))
        text = str(word.get("word", word.get("text", "")) or "").strip()
        if start is None or end is None or end < start or start < 0:
            return []
        if text:
            result.append({"text": text, "start": start, "end": end})
    return result


def chunk_words(words: list[dict]) -> list[list[dict]]:
    chunks: list[list[dict]] = []
    for word in words:
        current = chunks[-1] if chunks else None
        if (
            current is None
            or len(current) >= CAPTION_MAX_WORDS
            or len(" ".join(w["text"] for w in current)) + 1 + len(word["text"]) > CAPTION_MAX_CHARS
            or word["start"] - current[-1]["end"] > CAPTION_WORD_GAP
            or current[-1]["text"].endswith((".", "?", "!"))
        ):
            chunks.append([word])
        else:
            current.append(word)
    return chunks


def caption_entries(transcript: dict | None, segments: list[dict]) -> list[dict]:
    """Verbatim transcript text placed on the output timeline of the rendered source segments.

    With word timings, only words spoken inside a segment are captioned, in short readable cues.
    Without them, whole transcript segments overlapping the range are used (clipped in time).
    """
    entries: list[dict] = []
    offset = 0.0
    for segment in segments:
        start, end = float(segment["start"]), float(segment["end"])
        span_out = end - start
        local: list[dict] = []
        for item in (transcript or {}).get("segments", []):
            words = usable_words(item.get("words"))
            if words:
                inside = [w for w in words if start <= (w["start"] + w["end"]) / 2 < end]
                for chunk in chunk_words(inside):
                    a, b = max(start, chunk[0]["start"]), min(end, chunk[-1]["end"])
                    text = clean_caption(" ".join(w["text"] for w in chunk))
                    if b > a and text:
                        local.append({"start": a - start, "end": b - start, "text": text, "words": True})
            else:
                a = max(start, number(item.get("start")) or 0.0)
                b = min(end, number(item.get("end")) or 0.0)
                text = clean_caption(item.get("text", ""))
                if b > a and text:
                    local.append({"start": a - start, "end": b - start, "text": text, "words": False})
        for index, entry in enumerate(local):
            # Very short word cues flash; hold them until the next cue (never past the segment).
            if entry["words"] and entry["end"] - entry["start"] < CAPTION_MIN_DISPLAY:
                following = local[index + 1]["start"] if index + 1 < len(local) else span_out
                entry["end"] = max(
                    entry["end"], min(entry["start"] + CAPTION_MIN_DISPLAY, following, span_out)
                )
            entries.append(
                {"start": entry["start"] + offset, "end": entry["end"] + offset, "text": entry["text"]}
            )
        offset += span_out
    return entries


def srt_text(entries: list[dict]) -> str:
    return "\n".join(
        f"{index + 1}\n{stamp(entry['start'])} --> {stamp(entry['end'])}\n{entry['text']}\n"
        for index, entry in enumerate(entries)
    )


def subtitles(transcript: dict | None, start: float, end: float) -> str:
    return srt_text(caption_entries(transcript, [{"start": start, "end": end}]))


CUE_TIMING = re.compile(
    r"^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})"
)


def parse_timestamp(value: str) -> float:
    parts = value.replace(",", ".").split(":")
    hours = int(parts[-3]) if len(parts) == 3 else 0
    return hours * 3600 + int(parts[-2]) * 60 + float(parts[-1])


def parse_transcript(kind: str, content: str, duration: float) -> dict:
    """Validate an imported SRT/VTT/JSON transcript against the source duration (no text invented)."""
    rows: list[dict] = []
    language = None
    if kind == "json":
        try:
            value = json.loads(content)
        except ValueError:
            raise WorkError("The transcript is not valid JSON.") from None
        items = value.get("segments") if isinstance(value, dict) else value
        if not isinstance(items, list):
            raise WorkError("Transcript JSON needs a list of segments with start, end and text.")
        if isinstance(value, dict) and isinstance(value.get("language"), str):
            language = value["language"][:12]
        for item in items:
            if not isinstance(item, dict):
                raise WorkError("Each transcript segment needs start, end and text.")
            rows.append(item)
    else:
        normalized = content.replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff")
        for block in re.split(r"\n\s*\n", normalized):
            lines = [line for line in block.split("\n") if line.strip()]
            index = next((i for i, line in enumerate(lines) if "-->" in line), None)
            if index is None:
                continue  # WEBVTT header, NOTE/STYLE blocks, stray numbering
            match = CUE_TIMING.match(lines[index])
            if not match:
                raise WorkError(f"Unreadable cue timing: {lines[index][:80]}")
            text = " ".join(re.sub(r"<[^>]+>", "", line).strip() for line in lines[index + 1 :])
            rows.append({"start": parse_timestamp(match[1]), "end": parse_timestamp(match[2]), "text": text})
    segments = []
    for row in rows:
        start, end = number(row.get("start")), number(row.get("end"))
        if start is None or end is None or start < 0 or end <= start:
            raise WorkError("Each transcript cue needs a start time before its end time.")
        if start >= duration or end > duration + 0.5:
            raise WorkError("Transcript cues must fall within the source video's duration.")
        text = str(row.get("text") or "").strip()
        if not text:
            continue
        segment = {"start": round(start, 3), "end": round(min(end, duration), 3), "text": text[:2000]}
        words = usable_words(row.get("words"))
        if words:
            segment["words"] = [{"word": w["text"], "start": w["start"], "end": w["end"]} for w in words]
        segments.append(segment)
    if not segments:
        raise WorkError("The transcript contains no timed text.")
    if len(segments) > 20000:
        raise WorkError("The transcript has too many cues for one source video.")
    segments.sort(key=lambda s: s["start"])
    return {"language": language, "text": " ".join(s["text"] for s in segments), "segments": segments}


def peak_level(jobs: Jobs, job_id: str, path: Path) -> float | None:
    try:
        raw = jobs.process(
            job_id,
            [
                ffmpeg(),
                "-nostdin",
                "-hide_banner",
                "-nostats",
                "-i",
                str(path),
                "-map",
                "0:a:0",
                "-af",
                "volumedetect",
                "-f",
                "null",
                "-",
            ],
            timeout=600,
            failure="Audio level check failed.",
        )
    except WorkError:
        return None
    match = re.search(r"max_volume:\s*(-?inf|-?[\d.]+) dB", raw)
    if not match:
        return None
    return -math.inf if match[1] in {"-inf", "inf"} else float(match[1])


def verify(
    jobs: Jobs,
    job_id: str,
    path: Path,
    *,
    source: Path,
    segments: list[dict],
    entries: list[dict],
    captions_requested: bool,
    has_audio: bool | None = None,
) -> dict:
    """Objective playback/format and caption checks, reported separately from creative review."""
    playback: list[dict] = []
    captions: list[dict] = []

    def add(group, key, label, status, detail):
        group.append({"id": key, "label": label, "status": status, "detail": detail})

    src, out = inspect(source), inspect(path)
    source_fps = (src["video"] or {}).get("frame_rate") or OUTPUT_FPS
    expect_audio = src["audio"] is not None if has_audio is None else has_audio
    boundary = max(1 / OUTPUT_FPS, 1 / source_fps)
    try:
        errors = jobs.process(
            job_id,
            [ffmpeg(), "-nostdin", "-v", "error", "-i", str(path), "-f", "null", "-"],
            timeout=900,
            failure="FFmpeg could not decode the rendered file.",
        ).strip()
    except WorkError as exc:
        errors = str(exc)
    add(
        playback,
        "decode",
        "Full decode",
        "fail" if errors else "pass",
        errors.splitlines()[0][:200] if errors else "Every frame and audio packet decoded without errors.",
    )
    add(
        playback,
        "container",
        "MP4 container",
        "pass" if "mp4" in out["format_name"].split(",") else "fail",
        out["format_name"] or "unknown",
    )
    layout = moov_before_mdat(path)
    add(
        playback,
        "faststart",
        "Progressive playback",
        "pass" if layout else "fail",
        "Metadata precedes media data."
        if layout
        else "Metadata is not at the start of the file; some players must download it fully.",
    )
    video = out["video"]
    if not video:
        add(playback, "video_stream", "Video stream", "fail", "The rendered file has no video stream.")
    else:
        add(
            playback,
            "codec",
            "H.264 video, yuv420p",
            "pass" if video["codec"] == "h264" and video["pix_fmt"] == "yuv420p" else "fail",
            f"{video['codec']} / {video['pix_fmt']}",
        )
        add(
            playback,
            "dimensions",
            "1080 × 1920 vertical",
            "pass" if (video["width"], video["height"]) == (OUTPUT_WIDTH, OUTPUT_HEIGHT) else "fail",
            f"{video['width']} × {video['height']}",
        )
        fps = video["frame_rate"]
        add(
            playback,
            "frame_rate",
            "30 fps",
            "pass" if fps and abs(fps - OUTPUT_FPS) < 0.01 else "fail",
            f"{fps:.3f} fps" if fps else "unknown",
        )
    expected = sum(s["end"] - s["start"] for s in segments)
    measured = (video or {}).get("duration") or out["duration"]
    allowed = 2 * len(segments) * boundary
    if measured is None:
        add(playback, "duration", "Source timing", "fail", "Rendered duration is unknown.")
    else:
        delta = measured - expected
        add(
            playback,
            "duration",
            "Source timing",
            "pass" if abs(delta) <= allowed + 1e-6 else "fail",
            f"{measured:.3f}s rendered vs {expected:.3f}s of requested source (Δ {delta * 1000:+.0f} ms; "
            f"allowed ±{allowed * 1000:.0f} ms = one frame at each of {2 * len(segments)} cut boundaries).",
        )
    if expect_audio:
        audio = out["audio"]
        add(
            playback,
            "audio_stream",
            "AAC source audio",
            "pass" if audio and audio["codec"] == "aac" else "fail",
            f"{audio['codec']}, {audio['channels']} ch"
            if audio
            else "Source has audio but the output has none.",
        )
        if audio:
            level = peak_level(jobs, job_id, path)
            add(
                playback,
                "audio_level",
                "Audible audio",
                "warn" if level is None or level <= -70 else "pass",
                "Audio level could not be measured."
                if level is None
                else f"Peak {level:.1f} dB" + (" — audio may be silent." if level <= -70 else ""),
            )
            if audio["duration"] is not None and measured is not None:
                gap = abs(audio["duration"] - measured)
                add(
                    playback,
                    "av_length",
                    "Audio/video length",
                    "pass" if gap <= 0.1 else "warn",
                    f"Audio and video lengths differ by {gap * 1000:.0f} ms.",
                )
    else:
        add(playback, "audio_stream", "AAC source audio", "not_applicable", "The source has no audio track.")

    if not captions_requested:
        add(captions, "source", "Transcript captions", "not_applicable", "Captions were not requested.")
    elif not entries:
        if expect_audio:
            add(
                captions,
                "source",
                "Transcript captions",
                "warn",
                "No captions were burned: no transcript text falls within these source ranges.",
            )
        else:
            add(
                captions,
                "source",
                "Transcript captions",
                "not_applicable",
                "The source has no audio track, so no captions were burned.",
            )
    else:
        add(
            captions,
            "source",
            "Transcript captions",
            "pass",
            f"{len(entries)} cues, verbatim transcript text; no generated words.",
        )
        limit = (measured or expected) + boundary
        out_of_range = [
            e for e in entries if e["start"] < -1e-6 or e["end"] <= e["start"] or e["end"] > limit
        ]
        ordered = sorted(entries, key=lambda e: e["start"])
        overlaps = sum(1 for a, b in itertools.pairwise(ordered) if b["start"] < a["end"] - 1e-3)
        add(
            captions,
            "timing",
            "Caption timing",
            "fail" if out_of_range or overlaps else "pass",
            f"{len(out_of_range)} cues outside the clip, {overlaps} overlapping cues."
            if out_of_range or overlaps
            else "All cues fall inside the clip without overlapping.",
        )
        short = sum(1 for e in entries if e["end"] - e["start"] < CAPTION_SHORT_SECONDS)
        add(
            captions,
            "display_time",
            "Readable display time",
            "warn" if short else "pass",
            f"{short} cues are shown for under {CAPTION_SHORT_SECONDS:.1f}s."
            if short
            else f"Every cue stays on screen for at least {CAPTION_SHORT_SECONDS:.1f}s.",
        )
        long = sum(1 for e in entries if len(e["text"]) > CAPTION_LONG_CHARS)
        add(
            captions,
            "length",
            "Caption length",
            "warn" if long else "pass",
            f"{long} cues exceed {CAPTION_LONG_CHARS} characters and may cover the frame."
            if long
            else f"Every cue is at most {CAPTION_LONG_CHARS} characters.",
        )
    return {
        "checked_at": now(),
        "playback_format": playback,
        "captions": captions,
        "playback_format_passed": not any(c["status"] == "fail" for c in playback),
        "caption_issues": [c["id"] for c in captions if c["status"] in {"fail", "warn"}],
        "boundary_tolerance_seconds": round(boundary, 4),
    }


def render(
    jobs: Jobs,
    job_id: str,
    source: Path,
    output: Path,
    *,
    start: float,
    end: float,
    transcript: dict | None = None,
    burn_subtitles=True,
    framing="fit",
    caption_style="standard",
    hook="",
    cold_open: tuple[float, float] | None = None,
    focus_x: float = 0.5,
    has_audio: bool | None = None,
) -> dict:
    output.parent.mkdir(parents=True, exist_ok=True)
    # Preserve the complete source frame instead of silently cropping subjects/products.
    if framing not in {"fit", "fill"} or caption_style not in {"standard", "high_contrast"}:
        raise WorkError("Unsupported framing or caption style.")
    if not 0 <= float(focus_x) <= 1:
        raise WorkError("Crop focus must be between 0 (left) and 1 (right).")
    segments = []
    if cold_open:
        segments.append({"role": "cold_open", "start": float(cold_open[0]), "end": float(cold_open[1])})
    segments.append({"role": "main", "start": float(start), "end": float(end)})
    if any(s["start"] < 0 or s["end"] <= s["start"] for s in segments):
        raise WorkError("Each source segment must start at or after 0 and end after it starts.")
    total = sum(s["end"] - s["start"] for s in segments)
    srt = output.with_suffix(".srt")
    hook_file = output.with_suffix(".hook.ass")
    entries = caption_entries(transcript, segments) if burn_subtitles else []
    caption_text = srt_text(entries)
    if caption_text:
        srt.write_text(caption_text, encoding="utf-8")
    if framing == "fit":
        layout = (
            "scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,"
            "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
        )
    else:
        crop = (
            "crop=1080:1920" if focus_x == 0.5 else f"crop=1080:1920:(iw-ow)*{float(focus_x):.4f}:(ih-oh)/2"
        )
        layout = f"scale=1080:1920:force_original_aspect_ratio=increase:force_divisible_by=2,{crop},setsar=1"
    overlays = ""
    filters = subprocess.run(
        [ffmpeg(), "-hide_banner", "-filters"], capture_output=True, text=True, timeout=10, check=False
    )
    if caption_text or hook:
        if " subtitles " not in filters.stdout:
            srt.unlink(missing_ok=True)
            raise WorkError(
                "This FFmpeg build lacks libass subtitles. Install full Homebrew FFmpeg or render without captions."
            )
        # cwd is output directory; filename consists exclusively of generated hexadecimal IDs.
        if caption_text:
            # Use output-pixel coordinates instead of libass's small default script canvas.
            font_size = 52 if caption_style == "standard" else 60
            style = (
                f"PlayResX=1080,PlayResY=1920,FontName=Arial,FontSize={font_size},"
                "MarginL=72,MarginR=72,MarginV=144,Outline=3,Shadow=0,Alignment=2"
            )
            if caption_style == "high_contrast":
                style += ",BorderStyle=3,BackColour=&H80000000"
            overlays += f",subtitles={srt.name}:force_style='{style}'"
        if hook:
            # Hook is creator/strategy text, not a fabricated source transcript.
            # Remove ASS control syntax and write only to a generated local filename.
            safe_hook = re.sub(r"[\\{}\x00-\x1f]", " ", hook).strip()[:250]
            duration = min(3.0, total)
            centiseconds = round(duration * 100)
            timestamp = f"0:00:{centiseconds // 100:02}.{centiseconds % 100:02}"
            hook_file.write_text(
                "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n"
                "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
                "Style: Hook,Arial,54,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,3,3,0,8,80,80,140,1\n"
                "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
                f"Dialogue: 1,0:00:00.00,{timestamp},Hook,,0,0,0,,{safe_hook}\n",
                encoding="utf-8",
            )
            overlays += f",subtitles={hook_file.name}"
    temporary = output.with_name(output.stem + ".partial.mp4")
    encode = [
        "-r",
        "30",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        str(temporary),
    ]
    base = [ffmpeg(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
    if len(segments) == 1:
        command = [
            *base,
            "-ss",
            str(start),
            "-i",
            str(source),
            "-t",
            str(end - start),
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-vf",
            layout + overlays,
            *encode,
        ]
    else:
        if has_audio is None:
            has_audio = probe(source)["has_audio"]
        inputs, graph, joins = [], [], ""
        for index, segment in enumerate(segments):
            span = segment["end"] - segment["start"]
            inputs += ["-ss", str(segment["start"]), "-t", f"{span:.6f}", "-i", str(source)]
            graph.append(
                f"[{index}:v:0]{layout},fps={OUTPUT_FPS},trim=duration={span:.6f},setpts=PTS-STARTPTS[v{index}]"
            )
            joins += f"[v{index}]"
            if has_audio:
                # Pad/trim each segment's audio to its video length so later cuts stay in sync.
                graph.append(
                    f"[{index}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
                    f"apad,atrim=0:{span:.6f},asetpts=PTS-STARTPTS[a{index}]"
                )
                joins += f"[a{index}]"
        graph.append(
            f"{joins}concat=n={len(segments)}:v=1:a={1 if has_audio else 0}[joined]"
            + ("[aout]" if has_audio else "")
        )
        graph.append(f"[joined]{overlays.lstrip(',') or 'null'}[vout]")
        command = [
            *base,
            *inputs,
            "-filter_complex",
            ";".join(graph),
            "-map",
            "[vout]",
            *(["-map", "[aout]"] if has_audio else []),
            *encode,
        ]
    jobs.update(job_id, progress=20, message="Rendering 1080 × 1920 H.264 clip")
    completed = False
    try:
        jobs.process(
            job_id,
            command,
            cwd=output.parent,
            failure="FFmpeg render failed. Check disk space and source compatibility.",
        )
        actual = probe(temporary)
        jobs.update(job_id, progress=80, message="Checking playback, format and captions")
        checks = verify(
            jobs,
            job_id,
            temporary,
            source=source,
            segments=segments,
            entries=entries,
            captions_requested=bool(burn_subtitles),
            has_audio=has_audio,
        )
        if not checks["playback_format_passed"]:
            failed = "; ".join(
                f"{c['label']}: {c['detail']}" for c in checks["playback_format"] if c["status"] == "fail"
            )
            raise WorkError(
                f"Rendered file failed playback/format checks, so no clip was saved. {failed}"[:1200]
            )
        jobs.check(job_id)
        temporary.replace(output)
        completed = True
        return {
            "subtitles_burned": bool(caption_text),
            "hook_rendered": bool(hook),
            "framing": framing,
            "caption_style": caption_style,
            "focus_x": float(focus_x),
            "width": actual["width"],
            "height": actual["height"],
            "duration": actual["duration"],
            "source_segments": segments,
            "caption_cues": len(entries),
            "technical_checks": checks,
            "encoder": dict(ENCODER),
            "ffmpeg_version": ffmpeg_version(),
            "warning": None
            if caption_text or not burn_subtitles
            else "No transcript: clip rendered without invented captions.",
        }
    finally:
        temporary.unlink(missing_ok=True)
        if not completed:
            srt.unlink(missing_ok=True)
            hook_file.unlink(missing_ok=True)


def extract_audio(jobs: Jobs, job_id: str, source: Path, output: Path):
    jobs.process(
        job_id,
        [
            ffmpeg(),
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-i",
            str(source),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            str(output),
        ],
        failure="Audio extraction failed. Verify that this video has a readable audio track.",
    )


def sample_frames(
    jobs: Jobs, job_id: str, source: Path, directory: Path, duration: float, times: list[float] | None = None
) -> list[dict]:
    directory.mkdir(parents=True, exist_ok=True)
    frames = []
    # Bounded sampling is intentional: analysis is approximate, not exhaustive temporal recall.
    count = min(12, max(1, math.ceil(duration / 10)))
    points = times[:12] if times is not None else [(i + 0.5) * duration / count for i in range(count)]
    for i, point in enumerate(points):
        at = min(duration - 0.05, max(0.0, point))
        target = directory / f"frame-{i:02}.jpg"
        jobs.process(
            job_id,
            [
                ffmpeg(),
                "-nostdin",
                "-v",
                "error",
                "-y",
                "-ss",
                str(max(0, at)),
                "-i",
                str(source),
                "-frames:v",
                "1",
                "-vf",
                "scale=640:-2",
                str(target),
            ],
            timeout=60,
            failure="Frame sampling failed.",
        )
        if target.exists():
            frames.append({"time": round(at, 2), "path": str(target)})
    return frames
