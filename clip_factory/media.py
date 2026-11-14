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

from . import craft, extensions, reframe
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
# HLG (iPhone, broadcast) and PQ sources look washed out unless mapped into SDR before H.264/JPEG output.
HDR_TRANSFERS = {"arib-std-b67", "smpte2084"}
TONEMAP = (
    "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,"
    "zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
)
FRAME_SIZE = 768


def probe(path: Path) -> dict:
    tool = find_tool("ffprobe")
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
        if rotation(stream) % 180 == 90:
            # Phones store portrait video as rotated landscape; report what players actually show.
            width, height = height, width
        return {
            "duration": duration,
            "width": width,
            "height": height,
            "has_audio": any(s.get("codec_type") == "audio" for s in data["streams"]),
            "hdr": stream.get("color_transfer") in HDR_TRANSFERS,
        }
    except (ValueError, KeyError, subprocess.SubprocessError):
        raise WorkError(
            "This file is not a readable video with a known duration. Try an MP4 or MOV export."
        ) from None


def rotation(stream: dict) -> int:
    """Display rotation in degrees (0/90/180/270) from stream side data or the legacy rotate tag."""
    values = [side.get("rotation") for side in stream.get("side_data_list") or [] if isinstance(side, dict)]
    values.append((stream.get("tags") or {}).get("rotate"))
    for value in values:
        try:
            return round(float(value)) % 360
        except (TypeError, ValueError):
            continue
    return 0


def is_hdr(path: Path) -> bool:
    """Best-effort check for sources imported before the HDR flag was recorded."""
    try:
        return bool(probe(path).get("hdr"))
    except (WorkError, OSError, TypeError):
        return False


def filters() -> str:
    try:
        return subprocess.run(
            [ffmpeg(), "-hide_banner", "-filters"], capture_output=True, text=True, timeout=10, check=False
        ).stdout or ""
    except (OSError, subprocess.SubprocessError):
        return ""


def can_tonemap(listing: str | None = None) -> bool:
    listing = filters() if listing is None else listing
    return " zscale " in listing and " tonemap " in listing


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
    tool = find_tool("ffprobe")
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


# Homebrew's default ffmpeg ships without libass/drawtext, so it cannot burn captions.
# The keg-only ffmpeg-full formula can; prefer it (ffmpeg and ffprobe together) when installed.
FULL_FFMPEG_DIRS = ("/opt/homebrew/opt/ffmpeg-full/bin", "/usr/local/opt/ffmpeg-full/bin")


def find_tool(name: str) -> str | None:
    for directory in FULL_FFMPEG_DIRS:
        if found := shutil.which(f"{directory}/{name}"):
            return found
    return shutil.which(name)


def ffmpeg() -> str:
    tool = find_tool("ffmpeg")
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
        for item in foreground(transcript):
            words = usable_words(item.get("words"))
            if words:
                inside = [w for w in words if start <= (w["start"] + w["end"]) / 2 < end]
                for chunk in chunk_words(inside):
                    a, b = max(start, chunk[0]["start"]), min(end, chunk[-1]["end"])
                    text = clean_caption(" ".join(w["text"] for w in chunk))
                    if b > a and text:
                        timed = [
                            {
                                "text": clean_caption(w["text"]),
                                "start": max(a, w["start"]) - start,
                                "end": min(b, w["end"]) - start,
                            }
                            for w in chunk
                        ]
                        local.append(
                            {"start": a - start, "end": b - start, "text": text, "words": True, "timed": timed}
                        )
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
            placed = {"start": entry["start"] + offset, "end": entry["end"] + offset, "text": entry["text"]}
            if entry.get("timed"):
                placed["timed"] = [
                    {"text": w["text"], "start": w["start"] + offset, "end": w["end"] + offset}
                    for w in entry["timed"]
                ]
            entries.append(placed)
        offset += span_out
    return entries


def srt_text(entries: list[dict]) -> str:
    return "\n".join(
        f"{index + 1}\n{stamp(entry['start'])} --> {stamp(entry['end'])}\n{entry['text']}\n"
        for index, entry in enumerate(entries)
    )


def ass_stamp(seconds: float) -> str:
    centiseconds = max(0, round(seconds * 100))
    return f"{centiseconds // 360000}:{centiseconds // 6000 % 60:02}:{centiseconds // 100 % 60:02}.{centiseconds % 100:02}"


def pop_captions(entries: list[dict]) -> str:
    """Word-by-word captions: the cue stays on screen while the word being spoken lights up.

    Same verbatim words and timings as the plain captions; only the presentation differs. Cues
    without word timings are shown whole.
    """
    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        "PlayResX: 1080",
        "PlayResY: 1920",
        "WrapStyle: 0",
        "[V4+ Styles]",
        (
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, "
            "Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
            "MarginL, MarginR, MarginV, Encoding"
        ),
        "Style: Pop,Arial,78,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,1,0,0,0,100,100,0,0,1,6,2,2,90,90,380,1",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for entry in entries:
        words = entry.get("timed") or []
        if not words:
            text = entry["text"].upper()
            lines.append(f"Dialogue: 0,{ass_stamp(entry['start'])},{ass_stamp(entry['end'])},Pop,,0,0,0,,{text}")
            continue
        for index, word in enumerate(words):
            begin = entry["start"] if index == 0 else word["start"]
            finish = words[index + 1]["start"] if index + 1 < len(words) else entry["end"]
            if finish <= begin:
                continue
            text = " ".join(
                # The spoken word: warm yellow and slightly larger; the rest stay white.
                f"{{\\c&H00E5FF&\\fscx112\\fscy112}}{w['text'].upper()}{{\\r}}" if n == index else w["text"].upper()
                for n, w in enumerate(words)
            )
            lines.append(f"Dialogue: 0,{ass_stamp(begin)},{ass_stamp(finish)},Pop,,0,0,0,,{text}")
    return "\n".join(lines) + "\n"


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


# Phrases speech recognizers are known to produce over silence, music and noise.
PHANTOM_PHRASES = {
    "thank you",
    "thanks",
    "thank you very much",
    "thank you for watching",
    "thanks for watching",
    "bye",
    "bye bye",
    "you",
    "so",
    "okay",
    "please subscribe",
    "subscribe",
}


def clean_transcript(result: dict) -> dict:
    """Remove recognizer output that is almost certainly not speech.

    Speech models invent phrases over music, crowd noise and ball sounds: the same line again and
    again ("Thank you."), one word looping inside a segment ("no, no, no, ..."), or text with no
    duration. Burning those in as captions misrepresents the source. A segment is dropped when the
    recognizer's own confidence was low, when its timing is impossible for speech, when it repeats
    itself, or when it is a stock phantom phrase standing alone. Nothing is rewritten; kept
    segments are verbatim. Uncertain interjections are lost with the noise; that is the safer error.
    """
    segments = [s for s in result.get("segments", []) if isinstance(s, dict)]

    def normal(segment) -> str:
        return re.sub(r"[^\w]+", " ", str(segment.get("text", "")).lower()).strip()

    texts = [normal(segment) for segment in segments]
    counts: dict[str, int] = {}
    for text in texts:
        counts[text] = counts.get(text, 0) + 1
    looped = {
        text
        for text, count in counts.items()
        if text and count >= 4 and count >= 0.2 * len(segments) and len(text.split()) <= 6
    }
    # The same short line three or more times in a row is the recognizer stuck, not a speaker.
    rejected: set[int] = set()
    run_start = 0
    for index in range(1, len(segments) + 1):
        if index == len(segments) or texts[index] != texts[run_start]:
            if index - run_start >= 3 and texts[run_start] and len(texts[run_start].split()) <= 6:
                rejected.update(range(run_start, index))
            run_start = index
    spans = []
    for position, (segment, text) in enumerate(zip(segments, texts)):
        words = text.split()
        timed = segment.get("words") if isinstance(segment.get("words"), list) else []
        confidence = [
            w["probability"] for w in timed if isinstance(w, dict) and isinstance(w.get("probability"), (int, float))
        ]
        certainty = sum(confidence) / len(confidence) if confidence else None
        start, end = number(segment.get("start")), number(segment.get("end"))
        span = (end - start) if start is not None and end is not None else None
        spans.append((start, end))
        logprob = number(segment.get("avg_logprob"))
        if (
            not text
            or text in looped
            or (certainty is not None and certainty < 0.5)
            or (logprob is not None and logprob < -1.0)
            or (span is not None and span >= 12 and len(words) <= 4)
            # More than twelve words a second, or words with no duration, was never spoken.
            or (span is not None and len(words) >= 2 and len(words) > 12 * max(span, 0.0))
            or (len(words) >= 8 and len(set(words)) <= 0.35 * len(words))
        ):
            rejected.add(position)
    for position, text in enumerate(texts):
        if position in rejected or text not in PHANTOM_PHRASES:
            continue
        start, end = spans[position]
        timed = segments[position].get("words") if isinstance(segments[position].get("words"), list) else []
        confidence = [w.get("probability") for w in timed if isinstance(w, dict)]
        confident = bool(confidence) and all(isinstance(p, (int, float)) and p >= 0.7 for p in confidence)
        # In conversation these phrases are real; alone in a quiet stretch, or doubted by the
        # recognizer itself, they are its favourite inventions.
        accompanied = start is not None and any(
            other not in rejected
            and other != position
            and spans[other][0] is not None
            and abs(spans[other][0] - start) <= 8
            for other in range(len(segments))
        )
        if not (accompanied and (confident or not confidence)):
            rejected.add(position)
    kept = [segment for position, segment in enumerate(segments) if position not in rejected]
    cleaned = {**result, "segments": kept}
    if rejected:
        cleaned["text"] = " ".join(str(s.get("text", "")).strip() for s in kept)
        cleaned["removed_segments"] = len(segments) - len(kept)
    return cleaned


SPARSE_WORDS_PER_MINUTE = 20.0
DENSE_WORDS_PER_SECOND = 1.2


def classify_speech(transcript: dict, duration: float) -> dict:
    """Mark where speech carries the footage and where it is only background chatter.

    Footage of a game, a workout or a street has stray exclamations but no speech worth captioning
    or reasoning from. When a source has few words per minute overall, only stretches where someone
    is clearly talking (dense words over about thirty seconds) stay in the foreground; everything
    else is flagged `background` and ignored by captions, evidence and cut snapping. Sources with
    real speech throughout are left untouched.
    """
    segments = [dict(s) for s in transcript.get("segments", []) if isinstance(s, dict)]
    spoken = []
    for segment in segments:
        segment.pop("background", None)
        start, end = number(segment.get("start")), number(segment.get("end"))
        middle = (start + end) / 2 if start is not None and end is not None else None
        spoken.append((middle, len(str(segment.get("text", "")).split())))
    total = sum(count for _, count in spoken)
    if total >= SPARSE_WORDS_PER_MINUTE * max(duration, 1.0) / 60:
        return {**transcript, "segments": segments, "speech": "throughout"}
    foreground = 0
    for segment, (middle, _) in zip(segments, spoken):
        nearby = sum(count for at, count in spoken if middle is not None and at is not None and abs(at - middle) <= 15)
        if nearby >= DENSE_WORDS_PER_SECOND * 30:
            foreground += 1
        else:
            segment["background"] = True
    return {**transcript, "segments": segments, "speech": "in places" if foreground else "none"}


def foreground(transcript: dict | None) -> list[dict]:
    """Transcript segments that are speech to act on (not background chatter)."""
    return [
        s for s in (transcript or {}).get("segments", []) if isinstance(s, dict) and not s.get("background")
    ]


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
    loudness_target: float | None = None,
) -> dict:
    """Objective playback/format and caption checks, reported separately from creative review.

    loudness_target: LUFS the audio was normalised to; the integrated loudness is then measured
    (EBU R128) and reported as a warning when it misses by more than craft.LOUDNESS_TOLERANCE.
    """
    playback: list[dict] = []
    captions: list[dict] = []
    integrated = None

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
            if loudness_target is not None:
                lufs = integrated_loudness(jobs, job_id, path)
                integrated = lufs
                add(
                    playback,
                    "loudness",
                    f"Loudness {loudness_target:g} LUFS",
                    "warn" if lufs is None or abs(lufs - loudness_target) > craft.LOUDNESS_TOLERANCE else "pass",
                    "Integrated loudness could not be measured."
                    if lufs is None
                    else f"Integrated {lufs:.1f} LUFS (EBU R128) against a {loudness_target:g} LUFS target.",
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
        **({"integrated_loudness": integrated} if loudness_target is not None else {}),
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
    hdr: bool | None = None,
    crop_width: float | None = None,
    report: bool = True,
    motion: str = "static",
    edit: dict | None = None,
    moment: dict | None = None,
    max_duration: float = 180.0,
) -> dict:
    """report=False: the caller owns the job's progress line (several clips rendering at once).

    edit: resolved editing-craft options (`craft.CraftOptions` fields). None keeps the legacy
    single-pass graph exactly; a dict renders through `render_crafted`. moment: the source's
    storyboard signals ({"interval", "loudness", "scenes"}) used to pick a hook-first payoff.
    """
    output.parent.mkdir(parents=True, exist_ok=True)
    # "fit" and "blur" keep the complete source frame instead of silently cropping subjects/products.
    if (
        framing not in {"fit", "fill", "blur"}
        or caption_style not in {"standard", "high_contrast", "pop"}
        or motion not in {"static", "push_in"}
    ):
        raise WorkError("Unsupported framing, caption style or motion.")
    if not 0 <= float(focus_x) <= 1:
        raise WorkError("Crop focus must be between 0 (left) and 1 (right).")
    if crop_width is not None and not 0.2 <= float(crop_width) <= 1:
        raise WorkError("The kept width must be between 0.2 and 1 of the source.")
    segments = []
    if cold_open:
        segments.append({"role": "cold_open", "start": float(cold_open[0]), "end": float(cold_open[1])})
    segments.append({"role": "main", "start": float(start), "end": float(end)})
    if any(s["start"] < 0 or s["end"] <= s["start"] for s in segments):
        raise WorkError("Each source segment must start at or after 0 and end after it starts.")
    available = filters()
    # Map HLG/PQ sources into SDR after scaling (cheaper than tone mapping full-resolution frames).
    tone_mapped = bool(is_hdr(source) if hdr is None else hdr) and can_tonemap(available)
    tone = f"{TONEMAP}," if tone_mapped else ""
    contain = "scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2"
    cover = "scale=1080:1920:force_original_aspect_ratio=increase:force_divisible_by=2"

    # Optional zoom for fit/blur: keep a full-height slice of the source around the action.
    zoom = (
        f"crop=iw*{float(crop_width):.4f}:ih:(iw-ow)*{float(focus_x):.4f}:0,"
        if crop_width is not None and float(crop_width) < 0.999 and framing != "fill"
        else ""
    )

    def layout_for(tag: str = "") -> str:
        """Filter chain from one source input to a 1080x1920 frame; tag keeps graph labels unique."""
        if framing == "fit":
            return f"{zoom}{contain},{tone}pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
        if framing == "blur":
            # The kept picture stays whole over a blurred, darkened copy of itself instead of black bars.
            return (
                f"{zoom}{contain},{tone}split[fg{tag}][bgsrc{tag}];"
                f"[bgsrc{tag}]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=8:2,"
                f"scale=1080:1920,eq=brightness=-0.12:saturation=0.9[bg{tag}];"
                f"[bg{tag}][fg{tag}]overlay=(W-w)/2:(H-h)/2,setsar=1"
            )
        crop = (
            "crop=1080:1920" if focus_x == 0.5 else f"crop=1080:1920:(iw-ow)*{float(focus_x):.4f}:(ih-oh)/2"
        )
        return f"{cover},{crop},{tone}setsar=1"

    if edit is not None:
        return render_crafted(
            jobs,
            job_id,
            source,
            output,
            start=float(start),
            end=float(end),
            transcript=transcript,
            burn_subtitles=burn_subtitles,
            framing=framing,
            caption_style=caption_style,
            hook=hook,
            cold_open=cold_open,
            focus_x=float(focus_x),
            crop_width=float(crop_width) if zoom else None,
            has_audio=has_audio,
            tone_mapped=tone_mapped,
            available=available,
            layout_for=layout_for,
            report=report,
            motion=motion,
            edit=edit,
            moment=moment,
            max_duration=max_duration,
        )
    total = sum(s["end"] - s["start"] for s in segments)
    srt = output.with_suffix(".srt")
    hook_file = output.with_suffix(".hook.ass")
    entries = caption_entries(transcript, segments) if burn_subtitles else []
    caption_text = srt_text(entries)
    if caption_text:
        srt.write_text(caption_text, encoding="utf-8")

    overlays = ""
    if caption_text or hook:
        if " subtitles " not in available:
            srt.unlink(missing_ok=True)
            raise WorkError(
                "This FFmpeg build lacks libass, so captions cannot be burned in. Run `brew install ffmpeg-full` and restart Clip Factory, or render without captions."
            )
        # cwd is output directory; filename consists exclusively of generated hexadecimal IDs.
        if caption_text and caption_style == "pop":
            pop_file = output.with_suffix(".pop.ass")
            pop_file.write_text(pop_captions(entries), encoding="utf-8")
            overlays += f",subtitles={pop_file.name}"
        elif caption_text:
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
    # A slow push toward the centre keeps a static shot alive. Applied under the text, which stays put.
    push = (
        f",scale=w='trunc(1080*(1+0.07*t/{total:.3f})/2)*2':h='trunc(1920*(1+0.07*t/{total:.3f})/2)*2':eval=frame,"
        "crop=1080:1920"
        if motion == "push_in" and len(segments) == 1
        else ""
    )
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
            # First audio track only: phones add spatial-audio tracks FFmpeg cannot decode.
            "-map",
            "0:a:0?",
            "-vf",
            layout_for() + push + overlays,
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
                f"[{index}:v:0]{layout_for(str(index))},fps={OUTPUT_FPS},trim=duration={span:.6f},"
                f"setpts=PTS-STARTPTS[v{index}]"
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
    if report:
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
        if report:
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
            "crop_width": float(crop_width) if zoom else None,
            "motion": "push_in" if push else "static",
            "tone_mapped": tone_mapped,
            "width": actual["width"],
            "height": actual["height"],
            "duration": actual["duration"],
            "source_segments": segments,
            "caption_cues": len(entries),
            "technical_checks": checks,
            "encoder": dict(ENCODER),
            "ffmpeg_version": ffmpeg_version(),
            "warning": None
            if caption_text or not burn_subtitles or transcript is not None
            else "No transcript: clip rendered without invented captions.",
        }
    finally:
        temporary.unlink(missing_ok=True)
        if not completed:
            srt.unlink(missing_ok=True)
            hook_file.unlink(missing_ok=True)
            output.with_suffix(".pop.ass").unlink(missing_ok=True)


LOUDNORM_JSON = re.compile(r"\{[^{}]*\"input_i\"[^{}]*\}", re.DOTALL)


def loudnorm_filter(measured: dict | None) -> str:
    target = craft.LOUDNESS_TARGET
    base = f"loudnorm=I={target['integrated']:g}:TP={target['true_peak']:g}:LRA={target['lra']:g}"
    if not measured:
        return base + ",aresample=48000"
    return (
        f"{base}:measured_I={measured['input_i']}:measured_TP={measured['input_tp']}"
        f":measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}"
        f":offset={measured['target_offset']}:linear=true,aresample=48000"
    )


def integrated_loudness(jobs: Jobs, job_id: str, path: Path) -> float | None:
    """EBU R128 integrated loudness (LUFS) of a file's first audio track."""
    try:
        raw = jobs.process(
            job_id,
            [ffmpeg(), "-nostdin", "-hide_banner", "-nostats", "-i", str(path), "-map", "0:a:0",
             "-af", "ebur128", "-f", "null", "-"],
            timeout=600,
            failure="Loudness measurement failed.",
        )
    except WorkError:
        return None
    summary = raw.rsplit("Summary:", 1)[-1]
    match = re.search(r"I:\s*(-?[\d.]+|-inf)\s*LUFS", summary)
    if not match or match[1] == "-inf":
        return None
    return float(match[1])


def render_crafted(
    jobs: Jobs,
    job_id: str,
    source: Path,
    output: Path,
    *,
    start: float,
    end: float,
    transcript: dict | None,
    burn_subtitles: bool,
    framing: str,
    caption_style: str,
    hook: str,
    cold_open: tuple[float, float] | None,
    focus_x: float,
    crop_width: float | None,
    has_audio: bool | None,
    tone_mapped: bool,
    available: str,
    layout_for,
    report: bool,
    motion: str,
    edit: dict,
    moment: dict | None,
    max_duration: float,
) -> dict:
    """Render with editing craft: hook-first teaser, jump cuts, emphasis, cards, loudness.

    One FFmpeg input per source window (teaser, cold open, main range). Inside a window, kept
    pieces are chosen with frame-exact `select` on the 30 fps grid (one decoder, bounded memory)
    and the audio is cut at the same instants with 6 ms fades, so picture and sound stay in sync
    across every cut. Captions are placed on the re-ordered, cut timeline from measured words.
    """
    options = {**craft.LEGACY_PLAN, **edit}
    info = probe(source)
    if has_audio is None:
        has_audio = info["has_audio"]
    duration = info["duration"]
    hook = re.sub(r"[\\{}\x00-\x1f]", " ", hook or "").strip()[:250]
    try:
        kit = craft.BrandKit.model_validate(options.get("brand_kit") or {})
        font_file = craft.checked_file(kit.font_file, "font")
        logo_file = craft.checked_file(kit.logo_file, "logo")
    except ValueError as exc:
        raise WorkError(str(exc).splitlines()[-1][:300]) from None
    font = kit.font_family.strip() or "Arial"
    record: dict = {"version": "craft-v1"}

    # 1. Structure: linear, or a payoff teaser before the setup.
    payoff = (
        (float(options["payoff_start"]), float(options["payoff_end"]))
        if options.get("payoff_start") is not None and options.get("payoff_end") is not None
        else None
    )
    search_end = min(duration, end + craft.PAYOFF_ADJACENT) if payoff else end
    structure = craft.plan_structure(
        craft.range_words(transcript, start, search_end, foreground, usable_words),
        start,
        end,
        requested=options["structure"] if options["structure"] in {"auto", "hook_first"} else "linear",
        payoff=payoff,
        moment=moment,
        key_phrase=hook,
        planner=options.get("emphasis_words") or [],
        cold_open=bool(cold_open),
    )
    teaser = structure.get("teaser")
    main_end = end
    if teaser and structure.get("extend_end"):
        main_end = min(duration, structure["extend_end"])
        if main_end - start > max_duration:
            structure.update(resolved="linear", teaser=None, reason="Including the payoff would exceed the duration limit.")
            teaser, main_end = None, end

    # 2. Jump cuts inside the main range only.
    cuts = craft.plan_jump_cuts(
        craft.range_words(transcript, start, main_end, foreground, usable_words), start, main_end, options["jump_cuts"]
    )

    def windows(with_teaser: bool) -> list[dict]:
        groups = []
        if with_teaser and teaser:
            span = round((teaser["end"] - teaser["start"]) * OUTPUT_FPS) / OUTPUT_FPS
            groups.append({"role": "teaser", "start": teaser["start"], "keeps": [(0.0, span)]})
        if cold_open:
            span = round((float(cold_open[1]) - float(cold_open[0])) * OUTPUT_FPS) / OUTPUT_FPS
            groups.append({"role": "cold_open", "start": float(cold_open[0]), "keeps": [(0.0, span)]})
        groups.append({"role": "main", "start": start, "keeps": craft.snap(cuts["keeps"], start)})
        return [g for g in groups if g["keeps"]]

    groups = windows(True)
    total = sum(b - a for g in groups for a, b in g["keeps"])
    if teaser and total > max_duration + 1e-6:
        structure.update(resolved="linear", teaser=None, reason="The teaser would push the clip past its duration limit.")
        teaser = None
        groups = windows(False)
        total = sum(b - a for g in groups for a, b in g["keeps"])
    if options["structure"] == "hook_first" and structure["resolved"] != "hook_first":
        raise WorkError(f"Hook-first structure was requested but cannot be built: {structure['reason']}")
    segments = [
        {"role": g["role"], "start": round(g["start"] + a, 4), "end": round(g["start"] + b, 4)}
        for g in groups
        for a, b in g["keeps"]
    ]
    teaser_seconds = groups[0]["keeps"][0][1] if teaser else 0.0

    # Speaker/face-aware crop path for 9:16 crops of wider sources (fixed focus_x otherwise).
    reframe_filters: list[str] | None = None
    if framing == "fill" and options.get("crop_focus") == "auto_face":
        if report:
            jobs.update(job_id, progress=12, message="Following the speaker for the 9:16 crop")
        scenes = (moment or {}).get("scenes") or []
        framed = reframe.plan(
            ffmpeg(),
            source,
            [{"start": g["start"], "span": g["keeps"][-1][1] + 0.05} for g in groups],
            width=info["width"],
            height=info["height"],
            scene_cuts=[float(s["start"]) for s in scenes if isinstance(s, dict) and isinstance(s.get("start"), (int, float))],
            default=focus_x,
        )
        applied = framed["status"] == "applied"
        reframe_filters = framed["filters"] if applied else None
        record["reframe"] = {"status": framed["status"], **framed["summary"],
                             "fallback": None if applied else f"fixed crop at focus_x {focus_x:.3f}"}
        jobs.check(job_id)
    else:
        record["reframe"] = {"mode": options.get("crop_focus", "fixed") if framing == "fill" else None, "status": "off"}

    # 3. Captions on the cut timeline, emphasis and punch-ins.
    timeline = caption_entries(transcript, segments)
    entries = timeline if burn_subtitles else []
    key_phrase = hook or ((structure.get("payoff") or {}).get("text") or "")
    emphasis = (
        craft.choose_emphasis(timeline, options.get("emphasis_words") or [], key_phrase)
        if options["caption_emphasis"] == "keywords" or options["punch_in"] == "emphasis"
        else {"marks": set(), "words": [], "source": None, "ignored": []}
    )
    marks = emphasis["marks"] if options["caption_emphasis"] == "keywords" and entries else set()
    hook_seconds = (
        teaser_seconds
        if teaser and options["hook_format"] == "title_card"
        else min(craft.TITLE_CARD_SECONDS if options["hook_format"] == "title_card" else craft.OVERLAY_SECONDS, total)
    )
    punches = (
        craft.punch_times(timeline, emphasis["marks"], total, after=hook_seconds if hook else teaser_seconds)
        if options["punch_in"] == "emphasis"
        else []
    )
    transition_at = teaser_seconds if teaser else None
    zoom = craft.zoom_expression(punches, transition_at if options["transition"] == "zoom" else None)
    if motion == "push_in":
        motion_chain = (
            f"scale=w='trunc(1080*(1+0.07*t/{total:.3f})/2)*2':h='trunc(1920*(1+0.07*t/{total:.3f})/2)*2':eval=frame,"
            "crop=1080:1920,"
        )
    elif zoom:
        motion_chain = f"scale=w='trunc(1080*({zoom})/2)*2':h='trunc(1920*({zoom})/2)*2':eval=frame,crop=1080:1920,"
    else:
        motion_chain = ""
    end_card = None
    if options["end_card"] == "cta" and options.get("cta_text"):
        begin = max(total - craft.END_CARD_SECONDS, total / 2)
        end_card = (begin, total, re.sub(r"[\\{}\x00-\x1f]", " ", options["cta_text"]).strip())

    # 4. Files the filter graph reads (generated names only; cwd is the output directory).
    srt = output.with_suffix(".srt")
    caption_file = output.with_suffix(".captions.ass")
    hook_file = output.with_suffix(".hook.ass")
    ext_file = output.with_suffix(".ext.ass")
    fonts_dir = output.with_name(output.stem + ".fonts")
    logo_copy = output.with_name(output.stem + ".logo.png")
    temporary = output.with_name(output.stem + ".partial.mp4")
    scratch = [caption_file, hook_file, ext_file, logo_copy]
    needs_ass = bool(entries) or bool(hook) or end_card is not None or (teaser and options["transition"] == "flash")
    if needs_ass and " subtitles " not in available:
        raise WorkError(
            "This FFmpeg build lacks libass, so captions and titles cannot be burned in. Install an FFmpeg "
            "with libass and restart Clip Factory, or render without captions."
        )
    completed = False
    try:
        fontsdir = ""
        if font_file:
            fonts_dir.mkdir(exist_ok=True)
            shutil.copyfile(font_file, fonts_dir / ("brand" + font_file.suffix.lower()))
            fontsdir = f":fontsdir={fonts_dir.name}"
        overlays = []
        if entries:
            srt.write_text(srt_text(entries), encoding="utf-8")
            if marks or caption_style == "pop" or font != "Arial":
                caption_file.write_text(
                    craft.caption_ass(
                        entries,
                        caption_style,
                        marks,
                        font=font,
                        accent=kit.accent_color
                        if options.get("brand_kit") or caption_style != "pop"
                        else craft.POP_EMPHASIS,
                    ),
                    encoding="utf-8",
                )
                overlays.append(f"subtitles={caption_file.name}{fontsdir}")
            else:
                size = 52 if caption_style == "standard" else 60
                style = (
                    f"PlayResX=1080,PlayResY=1920,FontName=Arial,FontSize={size},"
                    "MarginL=72,MarginR=72,MarginV=144,Outline=3,Shadow=0,Alignment=2"
                )
                if caption_style == "high_contrast":
                    style += ",BorderStyle=3,BackColour=&H80000000"
                overlays.append(f"subtitles={srt.name}:force_style='{style}'")
        flash_at = transition_at if options["transition"] == "flash" else None
        if hook or flash_at is not None or end_card:
            hook_file.write_text(
                craft.overlay_ass(
                    hook=hook,
                    hook_format=options["hook_format"],
                    hook_seconds=hook_seconds,
                    font=font,
                    primary=kit.primary_color,
                    accent=kit.accent_color,
                    flash_at=flash_at,
                    end_card=end_card,
                ),
                encoding="utf-8",
            )
            overlays.append(f"subtitles={hook_file.name}{fontsdir}")
        # Merged renderer extensions the plan names (none by default), drawn on top of everything.
        if options.get("extensions"):
            elapsed = itertools.accumulate(s["end"] - s["start"] for s in segments)
            try:
                ext = extensions.apply(
                    options["extensions"], duration=total, hook_seconds=hook_seconds if hook else 0.0,
                    end_card_start=end_card[0] if end_card else None, cuts=tuple(list(elapsed)[:-1]),
                )
            except extensions.ExtensionError as exc:
                raise WorkError(f"Renderer extension refused: {exc}"[:600]) from None
            if ext["ass"]:
                if " subtitles " not in available:
                    raise WorkError("This FFmpeg build lacks libass, so the selected renderer extension cannot be drawn.")
                ext_file.write_text(ext["ass"], encoding="utf-8")
                overlays.append(f"subtitles={ext_file.name}")
            overlays.extend(ext["filters"])
            record["extensions"] = ext["applied"]

        # 5. Filter graph.
        inputs: list[str] = []
        video_graph: list[str] = []
        audio_graph: list[str] = []
        vjoin = ajoin = ""
        pieces = 0
        half = 0.5 / OUTPUT_FPS
        for index, group in enumerate(groups):
            span = group["keeps"][-1][1]
            inputs += ["-ss", f"{group['start']:.6f}", "-t", f"{span + 0.05:.6f}", "-i", str(source)]
            pick = "+".join(f"between(t,{a - half:.6f},{b - half:.6f})" for a, b in group["keeps"])
            video_graph.append(
                f"[{index}:v:0]fps={OUTPUT_FPS},{reframe_filters[index] if reframe_filters else ''}"
                f"select='{pick}',setpts=N/{OUTPUT_FPS}/TB,"
                f"{layout_for(str(index))}[v{index}]"
            )
            vjoin += f"[v{index}]"
            if has_audio:
                chain = (
                    f"[{index}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
                    f"apad,atrim=0:{span:.6f},asetpts=PTS-STARTPTS"
                )
                count = len(group["keeps"])
                labels = [f"[s{index}_{n}]" for n in range(count)]
                audio_graph.append(chain + (f",asplit={count}" if count > 1 else "") + "".join(labels))
                for n, (a, b) in enumerate(group["keeps"]):
                    fade = min(0.006, (b - a) / 4)
                    audio_graph.append(
                        f"{labels[n]}atrim={a:.6f}:{b:.6f},asetpts=PTS-STARTPTS,afade=t=in:d={fade:.4f},"
                        f"afade=t=out:st={b - a - fade:.6f}:d={fade:.4f}[a{index}_{n}]"
                    )
                    ajoin += f"[a{index}_{n}]"
                    pieces += 1
        video_graph.append(f"{vjoin}concat=n={len(groups)}:v=1:a=0[joined]")
        if has_audio:
            audio_graph.append(f"{ajoin}concat=n={pieces}:v=0:a=1[acat]")
        finish = motion_chain + ",".join(overlays)
        if logo_file and end_card:
            shutil.copyfile(logo_file, logo_copy)
            video_graph.append(f"[joined]{finish.rstrip(',') or 'null'}[base]")
            video_graph.append(f"movie={logo_copy.name},scale=240:-1,format=rgba[logo]")
            video_graph.append(f"[base][logo]overlay=(W-w)/2:620:enable='gte(t,{end_card[0]:.3f})'[vout]")
        else:
            video_graph.append(f"[joined]{finish.rstrip(',') or 'null'}[vout]")

        # 6. Loudness: measure the cut audio first, then normalise linearly to the target.
        loud: dict = {"mode": options["loudness"], **({"target": craft.LOUDNESS_TARGET} if options["loudness"] != "off" else {})}
        audio_out = "anull"
        if has_audio and options["loudness"] == "normalize":
            if report:
                jobs.update(job_id, progress=15, message="Measuring loudness")
            measured = None
            try:
                raw = jobs.process(
                    job_id,
                    [ffmpeg(), "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", *inputs,
                     "-filter_complex", ";".join([*audio_graph, f"[acat]{loudnorm_filter(None).split(',')[0]}:print_format=json[aout]"]),
                     "-map", "[aout]", "-f", "null", "-"],
                    timeout=600,
                    failure="Loudness measurement failed.",
                )
                found = LOUDNORM_JSON.findall(raw)
                measured = json.loads(found[-1]) if found else None
            except (WorkError, ValueError):
                measured = None
            if measured and str(measured.get("input_i")) in {"-inf", "inf"}:
                loud.update(method="skipped", reason="The audio is silent; nothing to normalise.")
            else:
                audio_out = loudnorm_filter(measured)
                loud.update(
                    method="two_pass" if measured else "single_pass",
                    measured_input_lufs=number((measured or {}).get("input_i")),
                    measured_input_true_peak=number((measured or {}).get("input_tp")),
                )
        elif not has_audio:
            loud.update(method="skipped", reason="No audio track.")
        graph = [*video_graph, *([f"[acat]{audio_out},aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=N/SR/TB[aout]"] + audio_graph if has_audio else [])]
        command = [
            ffmpeg(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y", *inputs,
            "-filter_complex", ";".join(graph),
            "-map", "[vout]", *(["-map", "[aout]"] if has_audio else []),
            "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-movflags", "+faststart", str(temporary),
        ]
        if report:
            jobs.update(job_id, progress=20, message="Rendering 1080 × 1920 H.264 clip")
        jobs.process(
            job_id, command, cwd=output.parent, failure="FFmpeg render failed. Check disk space and source compatibility."
        )
        actual = probe(temporary)
        if report:
            jobs.update(job_id, progress=80, message="Checking playback, format, captions and loudness")
        checks = verify(
            jobs,
            job_id,
            temporary,
            source=source,
            segments=segments,
            entries=entries,
            captions_requested=bool(burn_subtitles),
            has_audio=has_audio,
            loudness_target=craft.LOUDNESS_TARGET["integrated"] if loud.get("method") in {"two_pass", "single_pass"} else None,
        )
        if not checks["playback_format_passed"]:
            failed = "; ".join(
                f"{c['label']}: {c['detail']}" for c in checks["playback_format"] if c["status"] == "fail"
            )
            raise WorkError(f"Rendered file failed playback/format checks, so no clip was saved. {failed}"[:1200])
        loud["output_lufs"] = checks.get("integrated_loudness")
        jobs.check(job_id)
        temporary.replace(output)
        completed = True
    finally:
        temporary.unlink(missing_ok=True)
        logo_copy.unlink(missing_ok=True)
        shutil.rmtree(fonts_dir, ignore_errors=True)
        if not completed:
            for path in [srt, *scratch]:
                path.unlink(missing_ok=True)
    main_seconds = cuts["keeps"][-1][1] - cuts["keeps"][0][0] if cuts["keeps"] else 0.0
    record.update(
        loudness=loud,
        jump_cuts={k: v for k, v in cuts.items() if k != "keeps"} | {"pieces": len(cuts["keeps"]), "range_seconds": round(main_seconds, 3)},
        structure={k: v for k, v in structure.items() if k != "extend_end"} | {"main_end": round(main_end, 3)},
        hook={
            "format": options["hook_format"] if hook else None,
            "text": hook or None,
            "seconds": round(hook_seconds, 3) if hook else 0.0,
            "grounding": craft.hook_grounding(hook, " ".join(e["text"] for e in timeline)) if hook else None,
        },
        caption_emphasis={
            "mode": options["caption_emphasis"],
            "source": emphasis["source"] if marks else None,
            "words": [entries[e]["timed"][w]["text"] for e, w in sorted(marks)],
            "ignored_planner_words": emphasis["ignored"],
        },
        punch_in={"mode": options["punch_in"], "times": punches},
        transition={"mode": options["transition"] if teaser else None, "at": round(transition_at, 3) if transition_at else None},
        end_card={"mode": options["end_card"], "text": end_card[2] if end_card else None,
                  "start": round(end_card[0], 3) if end_card else None, "logo": bool(logo_file and end_card)},
        brand_kit={"font_family": font, "font_file": bool(font_file), "primary_color": kit.primary_color,
                   "accent_color": kit.accent_color, "logo": bool(logo_file)} if options.get("brand_kit") else None,
        output_seconds=round(total, 3),
    )
    return {
        "subtitles_burned": bool(entries),
        "hook_rendered": bool(hook),
        "framing": framing,
        "caption_style": caption_style,
        "focus_x": focus_x,
        "crop_width": crop_width,
        "motion": "push_in" if motion == "push_in" else ("punch_in" if punches else "static"),
        "tone_mapped": tone_mapped,
        "width": actual["width"],
        "height": actual["height"],
        "duration": actual["duration"],
        "source_segments": segments,
        "caption_cues": len(entries),
        "technical_checks": checks,
        "encoder": dict(ENCODER),
        "ffmpeg_version": ffmpeg_version(),
        "structure": structure["resolved"],
        "craft": record,
        "warning": None
        if entries or not burn_subtitles or transcript is not None
        else "No transcript: clip rendered without invented captions.",
    }


def frame_scores(data: bytes, width: int, height: int) -> list[dict]:
    """Sharpness (mean neighbour difference), stillness and brightness per raw gray frame."""
    size = width * height
    scores, previous = [], None
    for offset in range(0, len(data) - size + 1, size):
        frame = data[offset : offset + size]
        horizontal = sum(abs(a - b) for a, b in itertools.pairwise(frame))
        vertical = sum(abs(a - b) for a, b in zip(frame, frame[width:]))
        sharp = (horizontal + vertical) / (2 * size)
        change = sum(abs(a - b) for a, b in zip(frame, previous)) / size if previous else 0.0
        scores.append({"sharpness": sharp, "change": change, "brightness": sum(frame) / size})
        previous = frame
    return scores


def write_cover(
    jobs: Jobs, job_id: str, clip: Path, cover: Path, *, mode: str = "first_frame", avoid: list[tuple[float, float]] | None = None
) -> dict:
    """Cover still at 540×960: frame 0, or the sharpest, stillest well-lit candidate frame.

    best_frame samples the rendered clip at 2 fps as tiny grayscale frames (no model) and scores
    0.65·sharpness + 0.35·stillness, skipping dark frames, the first/last half second and any
    `avoid` windows (teaser flash, end card).
    """
    chosen = {"mode": mode, "time": 0.0}
    if mode == "best_frame":
        width, height, step = 108, 192, 0.5
        raw = cover.with_name(cover.stem + ".frames.gray")
        try:
            jobs.process(
                job_id,
                [ffmpeg(), "-nostdin", "-v", "error", "-y", "-i", str(clip), "-an", "-sn",
                 "-vf", f"fps={1 / step:g},scale={width}:{height},format=gray", "-f", "rawvideo", "-pix_fmt", "gray", str(raw)],
                timeout=120,
                failure="Cover analysis failed.",
            )
            scores = frame_scores(raw.read_bytes(), width, height)
        except (WorkError, OSError):
            scores = []
        finally:
            raw.unlink(missing_ok=True)
        length = len(scores) * step
        candidates = []
        top_sharp = max((s["sharpness"] for s in scores), default=0) or 1.0
        for index, score in enumerate(scores):
            at = index * step + step / 2
            if at < 0.5 or at > length - 0.5 or score["brightness"] < 24:
                continue
            if any(a <= at <= b for a, b in avoid or []):
                continue
            value = 0.65 * score["sharpness"] / top_sharp + 0.35 * max(0.0, 1 - score["change"] / 32)
            candidates.append((round(value, 4), at))
        if candidates:
            value, at = max(candidates, key=lambda c: (c[0], -c[1]))
            chosen.update(time=round(at, 3), score=value, candidates=len(candidates))
        else:
            chosen.update(mode="first_frame", reason="No well-lit candidate frame was found.")
    jobs.process(
        job_id,
        [ffmpeg(), "-nostdin", "-v", "error", "-y", "-ss", f"{chosen['time']:.3f}", "-i", str(clip),
         "-frames:v", "1", "-vf", "scale=540:960", str(cover)],
        timeout=60,
        failure="Cover extraction failed.",
    )
    return chosen


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
            "-map",
            "0:a:0",
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


def extract_frames(
    jobs: Jobs,
    job_id: str,
    source: Path,
    targets: list[tuple[float, Path]],
    *,
    hdr: bool = False,
    size: int = FRAME_SIZE,
) -> list[dict]:
    """Grab several timestamped stills in one FFmpeg process (tone mapped when the source is HDR)."""
    if not targets:
        return []
    chain = f"scale=w={size}:h={size}:force_original_aspect_ratio=decrease:force_divisible_by=2"
    if hdr and can_tonemap():
        chain += f",{TONEMAP}"
    command = [ffmpeg(), "-nostdin", "-v", "error", "-y"]
    for at, _ in targets:
        command += ["-ss", f"{max(0.0, at):.3f}", "-i", str(source)]
    for index, (_, target) in enumerate(targets):
        target.parent.mkdir(parents=True, exist_ok=True)
        command += ["-map", f"{index}:v:0", "-frames:v", "1", "-vf", chain, "-q:v", "4", str(target)]
    jobs.process(job_id, command, timeout=60 + 20 * len(targets), failure="Frame sampling failed.")
    return [{"time": round(at, 2), "path": str(target)} for at, target in targets if target.exists()]


METADATA_TIME = re.compile(r"pts_time:(-?[\d.]+)")


def read_metadata(path: Path, key: str) -> list[tuple[float, float]]:
    """Parse `metadata=print` output: one timestamp line followed by key=value lines."""
    series: list[tuple[float, float]] = []
    at = None
    try:
        with path.open(encoding="utf-8", errors="replace") as file:
            for line in file:
                match = METADATA_TIME.search(line)
                if match:
                    at = number(match[1])
                    continue
                if at is not None and line.startswith(key + "="):
                    value = line.split("=", 1)[1].strip()
                    parsed = -120.0 if value in {"-inf", "inf", "nan", "-nan"} else number(value)
                    if parsed is not None:
                        series.append((at, parsed))
    except OSError:
        return []
    return series


def signals(jobs: Jobs, job_id: str, source: Path, work: Path, *, duration: float, has_audio: bool) -> dict:
    """Whole-source picture change and loudness over time; deterministic, no model.

    Picture change is FFmpeg's scene score between consecutive decoded frames. Keyframes alone are
    decoded first (seconds, even for long sources); sources with sparse keyframes fall back to one
    full-decode frame per second.
    """
    work.mkdir(parents=True, exist_ok=True)
    budget = max(180, int(duration))

    def picture(dense: bool) -> list[tuple[float, float]]:
        target = work / "motion.txt"
        target.unlink(missing_ok=True)
        chain = ("fps=1," if dense else "") + "scale=160:-2,select='gte(scene,0)',metadata=print:file=motion.txt"
        command = [ffmpeg(), "-nostdin", "-hide_banner", "-v", "error"]
        if not dense:
            command += ["-skip_frame", "nokey"]
        command += ["-i", str(source), "-an", "-sn", "-vf", chain, "-f", "null", "-"]
        try:
            jobs.process(job_id, command, cwd=work, timeout=budget, failure="Picture analysis failed.")
            return read_metadata(target, "lavfi.scene_score")
        except WorkError:
            return []
        finally:
            target.unlink(missing_ok=True)

    motion = picture(dense=False)
    method = "keyframes"
    if len(motion) < duration / 4:
        dense = picture(dense=True)
        if len(dense) > len(motion):
            motion, method = dense, "one frame per second"
    loudness: list[tuple[float, float]] = []
    if has_audio:
        target = work / "loudness.txt"
        target.unlink(missing_ok=True)
        try:
            level = (
                "aresample=8000,asetnsamples=n=4000:p=0,astats=metadata=1:reset=1,"
                "ametadata=print:key=lavfi.astats.Overall.RMS_level:file=loudness.txt"
            )
            command = [ffmpeg(), "-nostdin", "-hide_banner", "-v", "error", "-i", str(source)]
            command += ["-map", "0:a:0", "-vn", "-sn", "-af", level, "-f", "null", "-"]
            jobs.process(
                job_id,
                command,
                cwd=work,
                timeout=budget,
                failure="Loudness analysis failed.",
            )
            loudness = read_metadata(target, "lavfi.astats.Overall.RMS_level")
        except WorkError:
            loudness = []
        finally:
            target.unlink(missing_ok=True)
    return {"motion": motion, "loudness": loudness, "method": method if motion else "unavailable"}


# Crop shapes tried from tightest to widest, as width:height of the kept source region.
ACTION_ASPECTS = (9 / 16, 3 / 4, 1.0, 4 / 3)


def action_window(
    jobs: Jobs, job_id: str, source: Path, work: Path, *, start: float, end: float, width: int, height: int
) -> dict | None:
    """The tightest full-height region of a landscape source that still holds the action.

    A vertical clip of landscape footage either shows the whole frame small or crops into it. This
    measures frame-to-frame change in a tiny grayscale copy of the range and returns the narrowest
    crop (9:16, 3:4, 1:1 or 4:3 of the source height) containing at least 90% of the movement:
    {"crop_width": fraction of source width kept, "focus_x": crop position 0..1, "share": movement
    inside it}. None means keep the whole frame: portrait sources, footage without real movement,
    or action spread edge to edge.
    """
    if width <= 0 or height <= 0 or end <= start or width <= height:
        return None
    columns, rows = 64, 36
    work.mkdir(parents=True, exist_ok=True)
    target = work / "movement.gray"
    target.unlink(missing_ok=True)
    try:
        jobs.process(
            job_id,
            [
                ffmpeg(), "-nostdin", "-v", "error", "-y",
                "-ss", f"{max(0.0, start):.3f}", "-t", f"{min(end - start, 45.0):.3f}", "-i", str(source),
                "-an", "-sn",
                "-vf", f"fps=4,scale={columns}:{rows},format=gray,tblend=all_mode=difference",
                "-f", "rawvideo", "-pix_fmt", "gray", str(target),
            ],
            timeout=120,
            failure="Movement analysis failed.",
        )
        data = target.read_bytes()
    except (WorkError, OSError):
        return None
    finally:
        target.unlink(missing_ok=True)
    size = columns * rows
    frames = len(data) // size
    if frames < 2:
        return None
    energy = [0] * columns
    for offset in range(0, frames * size, columns):
        for column, value in enumerate(data[offset : offset + columns]):
            if value > 12:  # below this is sensor noise and compression shimmer
                energy[column] += value
    total = sum(energy)
    if total < 40 * frames:
        return None
    for aspect in ACTION_ASPECTS:
        kept = aspect / (width / height)
        if kept >= 0.95:
            break
        window = max(1, round(kept * columns))
        sums = [sum(energy[i : i + window]) for i in range(columns - window + 1)]
        # Several positions can hold the action equally well: take the middle one, so the
        # subject sits in the centre of the crop rather than against its edge.
        peak = max(sums)
        holding = [i for i, value in enumerate(sums) if value >= 0.999 * peak]
        best = holding[len(holding) // 2]
        share = sums[best] / total
        # Conservative: cutting a subject out of frame is worse than showing the scene small.
        if share >= 0.9:
            centre = (best + window / 2) / columns
            focus = min(1.0, max(0.0, (centre - kept / 2) / (1 - kept)))
            return {"crop_width": round(kept, 4), "focus_x": round(focus, 3), "share": round(share, 3)}
    return None
