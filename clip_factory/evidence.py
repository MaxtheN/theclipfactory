"""Bound transcript evidence so prompts fit the worker limit while still covering the whole source."""

from __future__ import annotations

import json
import math

# Serialized characters (keys, timestamps and text) allowed for transcript evidence in one prompt.
TRANSCRIPT_BUDGET = 24_000
# Target excerpt length per merged window; fewer, richer windows beat many one-word slivers.
WINDOW_TEXT = 300
ENTRY_OVERHEAD = 24  # '"transcript:1234": ' plus separators


def _size(rows: list[dict]) -> int:
    return sum(len(json.dumps(row, ensure_ascii=False)) + ENTRY_OVERHEAD for row in rows)


def _clip(text: str, limit: int) -> str:
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    cut = text[: max(0, limit - 1)].rsplit(" ", 1)[0] or text[: max(0, limit - 1)]
    return cut + "…"


def bounded_transcript(segments, budget: int = TRANSCRIPT_BUDGET) -> tuple[list[dict], bool]:
    """Return (rows, merged).

    Short transcripts pass through segment-for-segment (timestamps rounded). Long ones, such as
    multi-hour streams, become evenly spaced time windows spanning the full source, each holding an
    excerpt of the speech inside it. Truncating to the first N segments would hide everything after
    the opening minutes from the model.
    """
    rows = []
    for segment in segments or []:
        if not isinstance(segment, dict):
            continue
        start, end = segment.get("start"), segment.get("end")
        if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (start, end)) or end < start:
            continue
        text = " ".join(str(segment.get("text", "")).split())[:2000]
        if text:
            rows.append({"start": round(float(start), 2), "end": round(float(end), 2), "text": text})
    if _size(rows) <= budget:
        return rows, False
    count = max(1, min(len(rows), budget // (WINDOW_TEXT + 60)))
    first, last = rows[0]["start"], max(r["end"] for r in rows)
    width = max((last - first) / count, 1e-6)
    buckets: list[list[dict]] = [[] for _ in range(count)]
    for row in rows:
        buckets[min(count - 1, int((row["start"] - first) / width))].append(row)
    windows = [
        {
            "start": bucket[0]["start"],
            "end": max(r["end"] for r in bucket),
            "text": " ".join(r["text"] for r in bucket),
            "segments": len(bucket),
        }
        for bucket in buckets
        if bucket
    ]
    limit = WINDOW_TEXT
    while True:
        result = [{**w, "text": _clip(w["text"], limit)} for w in windows]
        if _size(result) <= budget or limit <= 40:
            return result, True
        limit = int(limit * 0.8)
