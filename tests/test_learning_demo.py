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


def clip(identifier, hook, seconds, score):
    return {"id": identifier, "profile_id": "p", "campaign_id": "c", "sha256": "x" * 64, "duration": seconds,
            "rank": {"score": score}, "edit_plan": {"start": 10.0, "end": 10.0 + seconds - 2, "hook": hook}}


def test_build_picks_real_clips_and_learns_with_production_math():
    store = FakeStore({"profiles": [{"id": "p", "name": "Brand"}], "clips": [
        clip("a", "Why now? Why at all?", 34.0, 80),
        clip("b", "You can't reverse engineer chips", 28.5, 79),
        clip("c", "Silicon Valley is open about plans", 29.0, 77),
        clip("d", "Something else entirely here", 27.0, 60),
        {**clip("child", "Derived", 25.0, 99), "parent_clip_id": "b"},
    ]})
    plan = build(store, "p")
    ids = [c["clip_id"] for c in plan["clips"]]
    assert ids == ["b", "c", "a"] and "child" not in ids
    assert [c["outcome"] for c in plan["clips"]] == ["win", "steady", "loss"]
    rates = [c["simulated"]["metrics"]["completion_rate"] for c in plan["clips"]]
    assert rates[0] > plan["baseline"]["metrics"]["completion_rate"] > rates[2]
    assert all(c["simulated"]["simulated"] for c in plan["clips"])
    assert plan["beliefs"] and all(0 < b["confidence"] < 1 for b in plan["beliefs"])
    assert plan["recut"]["clip_id"] == "a" and plan["recut"]["target_main_seconds"] < plan["recut"]["main_seconds"]
    assert plan["recut"]["rule"] == "Under 30 seconds holds viewers"
    assert build(store, "p")["clips"][0]["simulated"] == plan["clips"][0]["simulated"]  # deterministic
    assert store.writes == 0


def test_build_needs_three_clips():
    store = FakeStore({"profiles": [{"id": "p"}], "clips": [clip("a", "Hook", 30, 70)]})
    with pytest.raises(HTTPException) as caught:
        build(store, "p")
    assert caught.value.status_code == 409
