"""Explicitly opted-in Groq Whisper transcription, bounded in audio, memory and time.

The caller owns consent/settings and persistence. This adapter has no local fallback,
does not print provider bodies, and never invents word timestamps when they are absent.
Official contract: https://console.groq.com/docs/speech-to-text (checked 2026-11-14).
"""
from __future__ import annotations

import asyncio
import contextlib
import difflib
import json
import math
import re
import tempfile
import time
import wave
from pathlib import Path

import httpx

from .jobs import WorkError

KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT = "growth-factory-groq", "api-key"
ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions"
MODEL = "whisper-large-v3-turbo"
SAMPLE_RATE, SAMPLE_WIDTH, CHANNELS = 16000, 2, 1
CHUNK_SECONDS = 720
MAX_FILE_BYTES = 24_000_000  # Below Groq's 25 MB free-tier file ceiling.
MAX_RESPONSE_BYTES = 8 * 1024**2
MAX_SEGMENTS, MAX_WORDS = 10_000, 20_000
REQUEST_TIMEOUT = 120
PUBLISHED_USD_PER_HOUR = 0.04  # Estimate only; Groq may charge zero under a free allowance.


class CloudSpeechError(WorkError):
    def __init__(self, message: str, kind: str):
        super().__init__(message)
        self.kind = kind


class GroqSpeechSecrets:
    """Native Keychain only. No environment/file/plaintext fallback."""

    def _backend(self):
        from .meta import SecureTokenStore

        return SecureTokenStore._backend()

    def get(self) -> str | None:
        try:
            value = self._backend().get_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        except Exception:  # noqa: BLE001 - backend diagnostics may contain credential details
            raise WorkError("Cannot read the Groq key from macOS Keychain. Unlock it and retry.") from None
        value = value.strip() if isinstance(value, str) else None
        if value and (len(value) > 4096 or "\r" in value or "\n" in value):
            raise WorkError("The stored Groq key is malformed. Replace it in macOS Keychain.")
        return value or None

    def configured(self) -> bool:
        try:
            return bool(self.get())
        except WorkError:
            return False


def groq_configured() -> bool:
    return GroqSpeechSecrets().configured()


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


ROUNDING_TOLERANCE = 0.02
MAX_ALIGNMENT_REGRESSION = 1.0


def _times(row, duration):
    start, end = row.get("start"), row.get("end")
    if (not _number(start) or not _number(end)
            or not -ROUNDING_TOLERANCE <= start < end <= duration + ROUNDING_TOLERANCE):
        raise CloudSpeechError("Groq returned invalid audio timestamps. No transcript was saved.", "invalid")
    # Only measured floating-point rounding at the audio boundary is clamped.
    start, end = max(0.0, float(start)), min(duration, float(end))
    if start >= end:
        raise CloudSpeechError("Groq returned invalid audio timestamps. No transcript was saved.", "invalid")
    return start, end


def _tokens(text):
    return re.findall(r"\w+", text.casefold().replace("’", "'"))


def normalize_chunk(payload: dict, *, duration: float, offset: float) -> dict:
    """Preserve provider text order and measured times; exclude unsafe boundary fragments.

    Whisper word alignments can overlap and regress slightly. Lexical alignment to
    segment text determines ownership, never a temporal sort or synthetic timestamp.
    """
    if not _number(duration) or duration <= 0 or not _number(offset) or offset < 0:
        raise CloudSpeechError("Cloud speech chunk bounds are invalid.", "input")
    if not isinstance(payload, dict) or not isinstance(payload.get("segments"), list):
        raise CloudSpeechError("Groq did not return a timed transcript. No transcript was saved.", "invalid")
    raw_segments = payload["segments"]
    raw_words = payload.get("words")
    if len(raw_segments) > MAX_SEGMENTS or not isinstance(raw_words, list) or len(raw_words) > MAX_WORDS:
        raise CloudSpeechError("Groq did not return bounded word timestamps. No transcript was saved.", "invalid")
    if str(payload.get("text") or "").strip() and (not raw_segments or not raw_words):
        raise CloudSpeechError("Groq returned speech without timed words. No transcript was saved.", "invalid")
    segments, segment_tokens, token_owners = [], [], []
    previous = -1.0
    for index, row in enumerate(raw_segments):
        if not isinstance(row, dict) or not isinstance(row.get("text"), str):
            raise CloudSpeechError("Groq returned malformed speech segments. No transcript was saved.", "invalid")
        start, end = _times(row, duration)
        if start < previous:
            raise CloudSpeechError("Groq returned unordered speech segments. No transcript was saved.", "invalid")
        previous = start
        text = row["text"].strip()
        tokens = _tokens(text)
        segment_tokens.extend(tokens)
        token_owners.extend([index] * len(tokens))
        segment = {"start": start + offset, "end": end + offset, "text": text, "words": []}
        for key in ("avg_logprob", "no_speech_prob", "compression_ratio"):
            if row.get(key) is not None:
                if not _number(row[key]):
                    raise CloudSpeechError("Groq returned invalid speech metadata. No transcript was saved.", "invalid")
                segment[key] = row[key]
        if not 0 <= segment.get("no_speech_prob", 0) <= 1 or segment.get("compression_ratio", 0) < 0:
            raise CloudSpeechError("Groq returned invalid speech confidence metadata. No transcript was saved.", "invalid")
        segments.append(segment)
    word_tokens, word_spans = [], []
    for word in raw_words:
        if not isinstance(word, dict) or not isinstance(word.get("word"), str) or not word["word"].strip():
            raise CloudSpeechError("Groq returned malformed timed words. No transcript was saved.", "invalid")
        tokens = _tokens(word["word"])
        if not tokens:
            raise CloudSpeechError("Groq returned unalignable timed words. No transcript was saved.", "invalid")
        word_spans.append((len(word_tokens), len(word_tokens) + len(tokens)))
        word_tokens.extend(tokens)
    # Provider segment text occasionally omits real timed words (even contraction
    # suffixes). Allow insertions from the measured words, but no missing/replaced
    # segment tokens. Rebuild text from words below so negation is never discarded.
    aligned_owners = [None] * len(word_tokens)
    inserted = []
    for tag, first, last, word_first, word_last in difflib.SequenceMatcher(
            None, segment_tokens, word_tokens, autojunk=False).get_opcodes():
        if tag == "equal":
            aligned_owners[word_first:word_last] = token_owners[first:last]
        elif tag == "insert":
            inserted.append((word_first, word_last))
        else:
            raise CloudSpeechError("Groq timed words do not match its speech text. No transcript was saved.", "invalid")
    for first, last in inserted:
        before = aligned_owners[first - 1] if first else None
        after = aligned_owners[last] if last < len(aligned_owners) else None
        # Internal insertions have unambiguous lexical ownership. At boundaries,
        # use measured overlap among the neighboring lexical segment candidates.
        candidates = list(dict.fromkeys(i for i in (before, after) if i is not None))
        for token_index in range(first, last):
            aligned_owners[token_index] = tuple(candidates)
    previous, dropped = -1.0, {}
    for word, (first, last) in zip(raw_words, word_spans, strict=True):
        owners = []
        for value in aligned_owners[first:last]:
            if isinstance(value, tuple):
                if not value:
                    raise CloudSpeechError("Groq words lack matching speech segments. No transcript was saved.", "invalid")
                start, end = word.get("start"), word.get("end")
                if not _number(start) or not _number(end):
                    raise CloudSpeechError("Groq returned invalid audio timestamps. No transcript was saved.", "invalid")
                value = max(value, key=lambda i: min(end + offset, segments[i]["end"])
                            - max(start + offset, segments[i]["start"]))
            owners.append(value)
        owner = max(dict.fromkeys(owners), key=owners.count)
        segment = segments[owner]
        raw_start, raw_end = word.get("start"), word.get("end")
        # A word cut by the upload boundary is not safe caption evidence. Drop its
        # entire lexical segment, including text, so a lost negation cannot survive.
        boundary_fragment = (_number(raw_start) and _number(raw_end)
            and 0 <= raw_start < duration < raw_end <= duration + MAX_ALIGNMENT_REGRESSION
            and raw_end > duration + ROUNDING_TOLERANCE)
        if boundary_fragment:
            start, end = float(raw_start), float(raw_end)
            dropped[owner] = {"start": segment["start"], "end": segment["end"],
                              "reason": "Word extends beyond uploaded audio; entire boundary segment excluded."}
        else:
            start, end = _times(word, duration)
        if start < previous - MAX_ALIGNMENT_REGRESSION:
            raise CloudSpeechError("Groq returned a large timed-word reset. No transcript was saved.", "invalid")
        previous = max(previous, start)
        absolute_start, absolute_end = start + offset, end + offset
        overlap = min(absolute_end, segment["end"]) - max(absolute_start, segment["start"])
        if overlap <= 0:
            raise CloudSpeechError("Groq timed words do not match its speech segments. No transcript was saved.", "invalid")
        if not boundary_fragment:
            segment["words"].append({"word": word["word"], "start": absolute_start, "end": absolute_end})
            segment["start"] = min(segment["start"], absolute_start)
            segment["end"] = max(segment["end"], absolute_end)
    usable = [segment for index, segment in enumerate(segments) if index not in dropped]
    if any(s["text"] and not s["words"] for s in usable):
        raise CloudSpeechError("Groq returned speech without usable word timestamps. No transcript was saved.", "invalid")
    for segment in usable:
        segment["text"] = " ".join(word["word"].strip() for word in segment["words"])
    result = {"segments": usable, "text": " ".join(s["text"] for s in usable),
              "language": payload.get("language") if isinstance(payload.get("language"), str) else None}
    if dropped:
        result["dropped_boundary_segments"] = list(dropped.values())
    return result


class GroqSpeech:
    def __init__(self, *, secrets=None, transport=None, request_timeout=REQUEST_TIMEOUT):
        self.secrets = secrets or GroqSpeechSecrets()
        self.transport = transport
        self.request_timeout = request_timeout

    async def _upload(self, key, path, language, jobs, job_id):
        timeout = httpx.Timeout(60, connect=10, write=30, pool=10)
        async with httpx.AsyncClient(timeout=timeout, transport=self.transport,
                                     follow_redirects=False, trust_env=False) as client:
            data = {"model": MODEL, "response_format": "verbose_json", "temperature": "0",
                    "timestamp_granularities[]": ["word", "segment"]}
            if language:
                data["language"] = language
            with path.open("rb") as stream:
                async with client.stream("POST", ENDPOINT, headers={"Authorization": f"Bearer {key}"},
                                         data=data, files={"file": ("speech.wav", stream, "audio/wav")}) as response:
                    if response.status_code != 200:
                        kind = "auth" if response.status_code in {401, 403} else "rate" if response.status_code == 429 else "provider"
                        message = {"auth": "Groq rejected the speech key. Check its permission in macOS Keychain.",
                                   "rate": "Groq speech is rate-limited. Wait, then explicitly retry the transcription.",
                                   "provider": "Groq speech could not complete this request. No transcript was saved."}[kind]
                        raise CloudSpeechError(message, kind)
                    body = bytearray()
                    async for part in response.aiter_bytes():
                        jobs.check(job_id)
                        body.extend(part)
                        if len(body) > MAX_RESPONSE_BYTES:
                            raise CloudSpeechError("Groq returned an oversized transcript. No transcript was saved.", "invalid")
                    try:
                        return json.loads(body)
                    except (ValueError, UnicodeError):
                        raise CloudSpeechError("Groq returned unreadable speech data. No transcript was saved.", "invalid") from None

    async def _request(self, key, path, language, jobs, job_id):
        pending = asyncio.create_task(self._upload(key, path, language, jobs, job_id))
        try:
            async with asyncio.timeout(self.request_timeout):
                while not pending.done():
                    jobs.check(job_id)
                    await asyncio.wait({pending}, timeout=0.1)
                jobs.check(job_id)
                return await pending
        except (TimeoutError, httpx.HTTPError):
            raise CloudSpeechError("Groq speech timed out or lost its connection. Explicitly retry; no local fallback ran.", "network") from None
        finally:
            if not pending.done():
                pending.cancel()
            with contextlib.suppress(asyncio.CancelledError, CloudSpeechError, httpx.HTTPError):
                await pending

    def transcribe(self, jobs, job_id, audio: Path, language: str | None, duration: float) -> dict:
        jobs.check(job_id)
        if not _number(duration) or not 0 < duration <= 24 * 3600:
            raise CloudSpeechError("Cloud speech needs a positive source duration of at most 24 hours.", "input")
        language = language.strip() if isinstance(language, str) else ""
        if language and language != "auto" and not re.fullmatch(r"[a-z]{2}", language):
            raise CloudSpeechError("Use a two-letter speech language or automatic detection.", "input")
        language = None if language == "auto" or not language else language
        key = self.secrets.get()
        if not key:
            raise CloudSpeechError("Add a Groq API key to macOS Keychain before enabling cloud speech.", "auth")
        started, segments, calls, detected, dropped = time.monotonic(), [], [], [], []
        try:
            with wave.open(str(audio), "rb") as source:
                if (source.getframerate(), source.getsampwidth(), source.getnchannels(), source.getcomptype()) != (
                    SAMPLE_RATE, SAMPLE_WIDTH, CHANNELS, "NONE"):
                    raise CloudSpeechError("Cloud speech needs the app’s 16 kHz mono PCM audio extraction.", "input")
                frames = source.getnframes()
                actual_duration = frames / SAMPLE_RATE
                if not 0 < actual_duration <= duration + 0.1:
                    raise CloudSpeechError("Extracted speech duration does not match the source bounds.", "input")
                total = math.ceil(frames / (CHUNK_SECONDS * SAMPLE_RATE))
                with tempfile.TemporaryDirectory(prefix="groq-speech-", dir=Path(audio).parent) as temporary:
                    for index in range(total):
                        jobs.check(job_id)
                        offset_frames = index * CHUNK_SECONDS * SAMPLE_RATE
                        count = min(CHUNK_SECONDS * SAMPLE_RATE, frames - offset_frames)
                        raw = source.readframes(count)
                        if len(raw) != count * SAMPLE_WIDTH:
                            raise CloudSpeechError("The extracted audio is truncated. Re-extract it before retrying.", "input")
                        path = Path(temporary) / "chunk.wav"
                        with wave.open(str(path), "wb") as chunk:
                            chunk.setparams((CHANNELS, SAMPLE_WIDTH, SAMPLE_RATE, 0, "NONE", "not compressed"))
                            chunk.writeframes(raw)
                        if path.stat().st_size > MAX_FILE_BYTES:
                            raise CloudSpeechError("The speech upload chunk exceeded the file limit.", "input")
                        jobs.update(job_id, progress=12 + round(80 * index / total),
                                    message=f"Groq speech: transcribing part {index + 1} of {total}")
                        payload = asyncio.run(self._request(key, path, language, jobs, job_id))
                        jobs.check(job_id)
                        seconds = count / SAMPLE_RATE
                        result = normalize_chunk(payload, duration=min(seconds, duration - offset_frames / SAMPLE_RATE),
                                                 offset=offset_frames / SAMPLE_RATE)
                        segments.extend(result["segments"])
                        dropped.extend(result.get("dropped_boundary_segments", []))
                        if result["language"]:
                            detected.append(result["language"])
                        calls.append({"part": index + 1, "offset_seconds": offset_frames / SAMPLE_RATE,
                                      "audio_seconds": seconds, "bytes": path.stat().st_size, "status": "completed"})
                        path.unlink()
        except (wave.Error, EOFError, OSError):
            raise CloudSpeechError("The extracted speech audio could not be read. Re-extract it before retrying.", "input") from None
        jobs.check(job_id)
        receipt = {"provider": "groq", "model": MODEL, "status": "completed", "chunks": calls,
                   "audio_seconds": actual_duration, "elapsed_seconds": round(time.monotonic() - started, 3),
                   "actual_cost_usd": None, "estimated_cost_usd": round(sum(max(10, c["audio_seconds"]) for c in calls)
                       / 3600 * PUBLISHED_USD_PER_HOUR, 6), "cost_basis": "Estimate at published USD 0.04/audio hour; free allowance and actual billing unknown.",
                   "pricing_checked": "2026-11-14", "word_timestamps": True,
                   "chunking": "Nonoverlapping audio chunks; boundary fragments with out-of-audio words are excluded.",
                   "dropped_boundary_segments": dropped}
        return {"text": " ".join(s["text"] for s in segments), "segments": segments,
                "language": language or (detected[0] if detected else None), "duration": actual_duration,
                "provider": "groq", "model": MODEL, "cloud_receipt": receipt}


def transcribe(jobs, job_id, audio: Path, language: str | None, duration: float) -> dict:
    return GroqSpeech().transcribe(jobs, job_id, audio, language, duration)
