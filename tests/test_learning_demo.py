"""Learning-loop demo: real clips, simulated results, production belief math, nothing stored."""
import pytest
from fastapi import HTTPException

from clip_factory.learning_demo import build


class FakeStore:
    def __init__(self, rows):
        self.rows = rows
        self.writes = 0

    def get(self, kind, identifier):
        return next((r for r in self.rows.get(kind, []) if r["id"] == identifier), None)

    def all(self, kind):
        return list(self.rows.get(kind, []))

    def put(self, *_):  # pragma: no cover - must never be called
        self.writes += 1


def word(text, at):
    return {"text": text, "start": at, "end": at + 0.3}


def clip(identifier, hook, seconds, score, teaser=None, removed=0):
    row = {"id": identifier, "profile_id": "p", "campaign_id": "c", "sha256": "x" * 64, "duration": seconds,
           "video_id": "v", "rank": {"score": score},
           "edit_plan": {"start": 10.0, "end": 10.0 + seconds - 2, "hook": hook},
           "craft": {"jump_cuts": {"removed": [{}] * removed}}}
    if teaser:
        row["craft"]["structure"] = {"resolved": "hook_first", "teaser": {"text": teaser}}
    return row


SPOKEN = "So what was the reaction to that? It was loud."
TRANSCRIPT = {"segments": [{"start": 0, "end": 60, "words": [
    word(text, 20.0 + 0.35 * i) for i, text in enumerate(SPOKEN.split())]}]}


def test_build_tells_the_hook_story_with_production_math():
    store = FakeStore({"profiles": [{"id": "p", "name": "Brand"}], "videos": [{"id": "v", "transcript": TRANSCRIPT}],
                       "clips": [
        clip("a", "Why now? Why at all?", 31.0, 80, teaser="is why at all? And why now?", removed=2),
        clip("b", "You can't reverse engineer chips", 28.5, 79, teaser="You cannot reverse engineer"),
        clip("c", "NY Post covered it", 32.0, 75, teaser="with its cover called Fang"),
        {**clip("child", "Derived", 25.0, 99), "parent_clip_id": "b"},
    ]})
    plan = build(store, "p")
    ids = [c["clip_id"] for c in plan["clips"]]
    assert ids[0] == "a" and ids[2] == "c" and "child" not in ids
    assert [c["opening"] for c in plan["clips"]] == ["question", "punchline", "setup"]
    holds = [c["simulated"]["metrics"]["hold_3s"] for c in plan["clips"]]
    assert holds[0] > plan["baseline"]["metrics"]["hold_3s"] > holds[2]
    assert all(c["simulated"]["simulated"] for c in plan["clips"])
    assert [b["headline"] for b in plan["beliefs"]] == ["Question hooks hold viewers", "Tighter pacing wins"]
    assert plan["beliefs"][0]["detail"].endswith("3-sec hold") and 0 < plan["beliefs"][0]["confidence"] < 1
    recut = plan["recut"]
    assert recut["clip_id"] == "c" and recut["before_kind"] == "setup" and recut["after_kind"] == "question"
    assert recut["after_hook"] == "What was the reaction to that?"  # source words, lead-in dropped
    assert recut["payoff_start"] >= 10.0 + 4 and recut["next_test"] == "Jump cuts"
    assert build(store, "p")["clips"][0]["simulated"] == plan["clips"][0]["simulated"]  # deterministic
    assert store.writes == 0


def test_build_needs_three_clips():
    store = FakeStore({"profiles": [{"id": "p"}], "clips": [clip("a", "Hook", 30, 70)]})
    with pytest.raises(HTTPException) as caught:
        build(store, "p")
    assert caught.value.status_code == 409
