"""Scout swarm: chunk coverage, untrusted-output validation, diversity-first selection."""

import json

from clip_factory import scouts


def video(minutes=60, silent=()):
    segments = []
    for second in range(0, minutes * 60, 5):
        if any(lo <= second < hi for lo, hi in silent):
            continue
        segments.append({"start": second, "end": second + 4, "text": f"line at {second}"})
    return {"id": "v", "duration": minutes * 60.0, "transcript": {"segments": segments}}


class Fake:
    """Scouts answer from a per-window script; the selector answers with `pick`."""

    def __init__(self, per_window=None, pick=None):
        self.per_window, self.pick, self.prompts = per_window or {}, pick, []

    def __call__(self, prompt, images, max_tokens):
        self.prompts.append((prompt, list(images), max_tokens))
        if prompt.startswith("Scouts reviewed"):
            return json.dumps(self.pick) if self.pick is not None else "no idea"
        lo = float(prompt.split("You only see seconds ", 1)[1].split("-", 1)[0])
        return json.dumps(self.per_window.get(lo, []))


def frames(index, times):
    return [{"time": t, "path": f"chunk{index}-{i}.jpg"} for i, t in enumerate(times)]


def test_short_or_untranscribed_sources_are_not_long():
    assert not scouts.is_long(video(minutes=15))
    assert not scouts.is_long({"duration": 7200, "transcript": None})
    assert scouts.is_long(video(minutes=30))


def test_chunks_cover_the_source_and_cap_count():
    assert scouts.chunks(3600) == [(i * 600.0, (i + 1) * 600.0) for i in range(6)]
    long = scouts.chunks(12 * 3600)
    assert len(long) <= scouts.MAX_CHUNKS and long[-1][1] == 12 * 3600 and long[0][0] == 0


def test_parse_scout_rejects_untrusted_output():
    rows = scouts._rows(video())
    raw = json.dumps(
        [
            {"start": 100, "end": 140, "hook": "ok", "score": 99},  # score clamped to 10
            {"start": 120, "end": 150},  # overlaps the first
            {"start": "x", "end": 5},
            {"start": 700, "end": 720},  # outside the window: clamped to empty
            {"start": 300, "end": 500, "hook": "long"},  # trimmed to 60 s
        ]
    )
    out = scouts.parse_scout(raw, rows, 0, 600, limit=5)
    assert [(m["start"], m["end"]) for m in out] == [(100, 140), (300, 360)]
    assert out[0]["score"] == 10
    assert scouts.parse_scout("```json\nnot json", rows, 0, 600) == []


def test_silent_windows_are_skipped_and_moments_need_speech():
    v = video(minutes=30, silent=[(600, 1200)])
    fake = Fake(
        {0.0: [{"start": 10, "end": 40, "score": 6}], 1200.0: [{"start": 1210, "end": 1240, "score": 8}]}
    )
    result = scouts.scout(generate=fake, video=v, frames_for=frames, count=3)
    assert result["chunks"] == 3 and result["skipped"] == 1
    assert len(fake.prompts) == 2  # no scout for the silent window, no selector for <= count
    assert [m["start"] for m in result["moments"]] == [10, 1210]
    assert all(len(images) == scouts.FRAMES_PER_CHUNK for _, images, _ in fake.prompts)


def test_shortlist_takes_each_chunks_best_before_a_second_from_any_chunk():
    pool = [
        {"start": 1, "end": 20, "score": 9, "chunk": 0},
        {"start": 30, "end": 50, "score": 9, "chunk": 0},
        {"start": 700, "end": 720, "score": 4, "chunk": 1},
    ]
    assert [p["start"] for p in scouts.shortlist(pool, size=2)] == [1, 700]


def test_selector_choice_is_used_and_bad_selector_falls_back_to_scores():
    windows = {
        lo: [{"start": lo + 10, "end": lo + 40, "score": 3 + i}] for i, lo in enumerate(range(0, 3600, 600))
    }
    picked = scouts.scout(
        generate=Fake(windows, {"picks": [0, 0, 5, 99]}), video=video(), frames_for=frames, count=2
    )
    assert picked["selector"] == "selector" and len(picked["moments"]) == 2
    fallback = scouts.scout(generate=Fake(windows, None), video=video(), frames_for=frames, count=2)
    assert fallback["selector"] == "scores"
    assert [m["start"] for m in fallback["moments"]] == [2410, 3010]  # two highest scores, in time order


def test_campaign_direction_and_brand_reach_scouts_as_data():
    fake = Fake()
    scouts.scout(
        generate=fake, video=video(minutes=25), frames_for=frames, brand="Acme", direction={"tone": "dry"}
    )
    assert '"approved_campaign_direction": {"tone": "dry"}' in fake.prompts[0][0]
    assert "untrusted source data" in fake.prompts[0][0]
