"""Posting windows are measured in the creator's time zone (WO-39)."""
import os
import time
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from clip_factory.app import create_app
from clip_factory.store import Store
from clip_factory.strategist import (
    Strategist,
    _posting,
    describe,
    measured_posts,
    posting_zone,
    tag_clip,
    zone_label,
)
from tests.test_strategist import Clock, seed_world

LA = ZoneInfo("America/Los_Angeles")
LONDON = ZoneInfo("Europe/London")


def at(text: str) -> str:
    return datetime.fromisoformat(text).astimezone(UTC).isoformat()


def test_windows_follow_the_local_hour_and_day_not_utc():
    # Monday 05:00 UTC is Sunday 21:00 in Los Angeles.
    stamp = at("2026-11-16T05:00:00+00:00")
    assert _posting(stamp) == ("morning", "weekday")
    assert _posting(stamp, LA) == ("evening", "weekend")
    # Tuesday 02:00 UTC is Monday 18:00 in Los Angeles.
    assert _posting(at("2026-11-17T02:00:00+00:00"), LA) == ("evening", "weekday")
    publication = {"published_at": stamp}
    assert tag_clip({"id": "c"}, publication, LA)["posting_window"] == "evening"
    assert tag_clip({"id": "c"}, publication)["posting_window"] == "morning"  # library default stays UTC


@pytest.mark.parametrize(("zone", "before", "after", "expected"), [
    # Los Angeles leaves daylight time on 1 Nov 2026: 19:30 UTC is 12:30 PDT, then 11:30 PST.
    (LA, "2026-10-30T19:30:00+00:00", "2026-11-03T19:30:00+00:00", ("afternoon", "morning")),
    # London leaves summer time on 25 Oct 2026: 16:30 UTC is 17:30 BST, then 16:30 GMT.
    (LONDON, "2026-10-23T16:30:00+00:00", "2026-10-27T16:30:00+00:00", ("evening", "afternoon")),
])
def test_windows_follow_daylight_saving_changes(zone, before, after, expected):
    assert (_posting(at(before), zone)[0], _posting(at(after), zone)[0]) == expected


@pytest.mark.skipif(not hasattr(time, "tzset"), reason="tzset is POSIX-only")
def test_no_zone_uses_the_system_rules(monkeypatch):
    previous = os.environ.get("TZ")
    monkeypatch.setenv("TZ", "America/New_York")
    time.tzset()
    try:
        # 22:30 UTC is 17:30 EST in New York.
        assert _posting(at("2026-11-16T22:30:00+00:00"), None) == ("evening", "weekday")
        # Daylight time in New York until 1 Nov 2026: 15:30 UTC is 11:30 EDT.
        assert _posting(at("2026-10-28T15:30:00+00:00"), None) == ("morning", "weekday")
    finally:
        if previous is None:
            monkeypatch.delenv("TZ")
        else:
            monkeypatch.setenv("TZ", previous)
        time.tzset()


def test_zone_names_resolve_or_fall_back_to_the_system():
    assert posting_zone("America/Los_Angeles") == LA
    assert posting_zone("") is None
    assert posting_zone(None) is None
    assert posting_zone("Mars/Olympus_Mons") is None
    assert posting_zone("../../etc/passwd") is None
    assert zone_label(LA) == "America/Los_Angeles"
    assert zone_label(None) == "local time"
    assert zone_label(UTC) == "UTC"
    assert describe("campaign", "posting_window", "evening", "increase", "views", "Europe/London") == (
        "Posts with posting in the evening (Europe/London) tend to beat this account's median views.")


def post(store, n, *, published: datetime, views: int):
    clip = {"id": f"clip{n}", "hook": "Would you?", "hypothesis": "story",
            "edit_plan": {"start": 0, "end": 30, "hook": "Would you?", "opening_treatment": "text_overlay",
                          "caption_style": "standard", "framing": "fit"}}
    store.put("clips", clip)
    store.put("learning_publications", {"id": f"pub{n}", "policy_id": "pol", "clip_id": clip["id"],
                                        "published_at": published.isoformat()})
    store.put("learning_snapshots", {"id": f"snap{n}", "policy_id": "pol", "publication_id": f"pub{n}",
                                     "metrics": {"views": views},
                                     "collected_at": (published + timedelta(hours=24)).isoformat()})


def test_strategist_measures_and_names_windows_in_the_creator_zone(tmp_path):
    store = Store(tmp_path)
    seed_world(store)
    engine = Strategist(store, clock=Clock(), zone=lambda: LA)
    # Wednesdays to Fridays in mid-November (PST, UTC-8). 03:00 UTC is 19:00 the previous evening
    # in Los Angeles ("night" in UTC); 17:00 UTC is 09:00 there ("evening" in UTC).
    days = [datetime(2026, 11, d, tzinfo=UTC) for d in (5, 6, 12, 13)]
    for n, day in enumerate(days):
        post(store, n, published=day.replace(hour=3), views=1000 + n)
        post(store, n + 10, published=day.replace(hour=17), views=10 + n)
    windows = {p["tags"]["posting_window"] for p in measured_posts(store, "p", LA)}
    assert windows == {"evening", "morning"}
    assert {p["tags"]["posting_window"] for p in measured_posts(store, "p")} == {"night", "evening"}
    engine.run("p", layers=["campaign"])
    named = [b for b in engine.beliefs("p") if b["variable"] == "posting_window"]
    assert named, "the scan should name a posting-window belief"
    assert all(b["value"] in {"evening", "morning"} for b in named)
    assert all("(America/Los_Angeles)" in b["statement"] for b in named)
    evening = [b for b in named if b["value"] == "evening"]
    assert not evening or evening[0]["direction"] == "increase"


def test_time_zone_setting_is_validated_and_used(tmp_path):
    app = create_app(tmp_path, token="local-test")
    with TestClient(app, base_url="http://127.0.0.1", headers={"X-Clip-Token": "local-test"}) as session:
        assert session.get("/api/settings").json()["time_zone"] == ""
        assert app.state.strategist.zone() is None  # empty: this computer's zone
        refused = session.patch("/api/settings", json={"time_zone": "Mars/Olympus_Mons"})
        assert refused.status_code == 422
        saved = session.patch("/api/settings", json={"time_zone": "Europe/London"})
        assert saved.status_code == 200, saved.text
        assert session.get("/api/settings").json()["time_zone"] == "Europe/London"
        assert app.state.strategist.zone() == LONDON
        assert session.patch("/api/settings", json={"time_zone": ""}).status_code == 200
        assert app.state.strategist.zone() is None
