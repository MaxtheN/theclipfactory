"""Transcript evidence stays inside the prompt budget and still spans the whole source."""

import itertools
import json

import pytest

from clip_factory.evidence import TRANSCRIPT_BUDGET, bounded_transcript, selected_transcript


def stream(hours=3.4, every=2.0):
    # Roughly a Ludwig-style stream: thousands of short, chatty segments.
    total, rows, t = hours * 3600, [], 0.0
    while t < total:
        rows.append(
            {
                "start": t + 0.0000001,
                "end": t + every * 0.9,
                "text": f" talking at {int(t)} seconds, chat says hi",
            }
        )
        t += every
    return rows


def size(rows):
    return sum(len(json.dumps(r, ensure_ascii=False)) + 24 for r in rows)


def test_short_transcript_passes_through_with_rounded_times():
    rows, merged = bounded_transcript(
        [{"start": 1.0000001, "end": 2.5399999999997, "text": "  hello   there "}]
    )
    assert not merged and rows == [{"start": 1.0, "end": 2.54, "text": "hello there"}]


def test_long_stream_is_windowed_within_budget_and_covers_the_end():
    segments = stream()
    rows, merged = bounded_transcript(segments)
    assert merged and size(rows) <= TRANSCRIPT_BUDGET
    assert rows[0]["start"] < 60 and rows[-1]["end"] > 3.3 * 3600  # not just the first minutes
    assert all(a["end"] <= b["start"] + 1e-6 for a, b in itertools.pairwise(rows))
    assert sum(r["segments"] for r in rows) == len(segments)


def test_invalid_segments_are_ignored():
    rows, _ = bounded_transcript(
        [
            {"start": "x", "end": 1, "text": "a"},
            {"start": 3, "end": 2, "text": "b"},
            "junk",
            {"start": 0, "end": 1, "text": " "},
        ]
    )
    assert rows == []


def test_selected_speech_preserves_late_exact_words_cue_times_and_source_identity():
    original = [{"start": s, "end": s + 1, "text": f"ACTUAL WORDS AT {s} " + "detail " * 15} for s in range(0, 7200, 2)]
    discovery, merged = bounded_transcript(original)
    assert merged and discovery[0]["end"] > 100 and "AT 106" not in discovery[0]["text"]
    exact = selected_transcript(original, [{"start": 104, "end": 120}], "source-a")
    item = exact["transcript:selected:0"]
    assert item["video_id"] == "source-a" and item["type"] == "selected_transcript"
    assert [cue["text"] for cue in item["segments"]] == [r["text"].strip() for r in original if 104 <= r["start"] < 120]
    assert item["segments"][0] == {"source_index": 52, **original[52], "text": original[52]["text"].strip()}
    assert all(cue["start"] >= 104 and cue["end"] <= 120 for cue in item["segments"])


def test_selected_speech_rejects_oversize_evidence_instead_of_truncating_words():
    with pytest.raises(ValueError, match="evidence budget"):
        selected_transcript([{"start": 0, "end": 30, "text": "speech " * 1000}], [{"start": 0, "end": 30}], "source", budget=300)
