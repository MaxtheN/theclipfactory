"""One-click learning-loop demo: real clips, SIMULATED Instagram results, real belief math, real re-edit.

Nothing here posts, approves or writes metrics. Simulated observations live only in the
returned payload; beliefs are computed with the production ``strategist.evaluate_belief``
over those observations in memory. The optional re-edit is a real, unapproved render that
changes exactly one variable (length) through the existing growth-loop path.
"""
from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException

from .strategist import evaluate_belief, tag_clip

SCHEMA = "growth-factory-learning-demo@1"
METRIC = "completion_rate"
BASELINE = {"views": 1600, "completion_rate": 0.41}
# Deterministic simulated outcomes: winner, steady, underperformer (rate, views).
SHAPES = ((0.62, 2400), (0.47, 1850), (0.29, 1300))


def _jitter(seed: str, spread: float) -> float:
    digest = int(hashlib.sha256(seed.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    return (digest - 0.5) * 2 * spread


def _seconds(clip: dict) -> float:
    value = clip.get("duration")
    if isinstance(value, (int, float)) and value > 0:
        return float(value)
    plan = clip.get("edit_plan") or {}
    return float(plan.get("end", 0) - plan.get("start", 0))


def eligible(store, profile_id: str, root=None) -> list[dict]:
    clips = []
    for clip in store.all("clips"):
        plan = clip.get("edit_plan")
        rank = clip.get("rank") or {}
        if (clip.get("profile_id") != profile_id or not isinstance(plan, dict) or not clip.get("sha256")
                or rank.get("below_bar") or clip.get("made_without_speech") or clip.get("parent_clip_id")
                or not clip.get("campaign_id") or clip.get("archived_at")):
            continue
        if root is not None and not (root / str(clip.get("path") or "")).is_file():
            continue
        clips.append(clip)
    return sorted(clips, key=lambda c: (-((c.get("rank") or {}).get("score") or 0), c["id"]))


def pick(clips: list[dict]) -> list[dict]:
    """Winner and steady from clips at or under 30 s; the underperformer is a longer one."""
    if len(clips) < 3:
        raise HTTPException(409, "Make at least 3 clips first — the demo uses your real clips.")
    short = [c for c in clips if _seconds(c) <= 30.5]
    long = [c for c in clips if _seconds(c) > 30.5]
    question = [c for c in short if "?" in str(c["edit_plan"].get("hook") or "")]
    winner = (question or short or clips)[0]
    steady = next((c for c in (short or clips) if c["id"] != winner["id"]), None)
    taken = {winner["id"], steady["id"] if steady else None}
    loser = next((c for c in (long or clips[::-1]) if c["id"] not in taken), None)
    if steady is None or loser is None:
        rest = [c for c in clips if c["id"] != winner["id"]]
        steady, loser = rest[0], rest[-1]
    return [winner, steady, loser]


def _length(seconds: float) -> str:
    return "under_30s" if seconds <= 30.5 else "30s_plus"


HEADLINES = {
    ("length", "under_30s", "increase"): "Under 30 seconds holds viewers",
    ("length", "30s_plus", "decrease"): "Long clips lose viewers",
    ("hook_style", "question", "increase"): "Question hooks win",
    ("hook_style", "statement", "increase"): "Plain-claim hooks win",
    ("hook_style", "statement", "decrease"): "Flat statements underperform",
    ("hook_style", "question", "decrease"): "Question hooks underperform",
    ("hook_style", "number", "increase"): "Numbers in hooks win",
}


def build(store, profile_id: str, root=None) -> dict:
    profile = store.get("profiles", profile_id)
    if not profile:
        raise HTTPException(404, "Brand not found.")
    pool = eligible(store, profile_id, root)
    chosen = pick(pool)
    video = store.get("videos", chosen[0].get("video_id")) or {}
    start = datetime.now(UTC).replace(microsecond=0)
    posts, cards = [], []
    for index, (clip, (rate, views)) in enumerate(zip(chosen, SHAPES, strict=True)):
        seed = f"{clip['id']}:{index}"
        rate = round(rate + _jitter(seed, 0.02), 3)
        views = int(views * (1 + _jitter(seed + "v", 0.08)))
        seconds = round(_seconds(clip), 1)
        tags = {**tag_clip(clip), "length": _length(seconds)}
        observation = {"id": f"sim-observation-{index + 1}", "simulated": True, "window_days": 3,
                       "metrics": {"views": views, METRIC: rate}}
        posts.append({"publication_id": f"sim-post-{index + 1}", "snapshot_id": observation["id"],
                      "clip_id": clip["id"], "published_at": (start - timedelta(days=3)).isoformat(),
                      "tags": tags, "metrics": observation["metrics"], "trigger": "simulated"})
        cards.append({"clip_id": clip["id"], "hook": str(clip["edit_plan"].get("hook") or clip.get("hook") or ""),
                      "score": (clip.get("rank") or {}).get("score"), "seconds": seconds,
                      "media_url": f"/api/clips/{clip['id']}/media", "cover_url": f"/api/clips/{clip['id']}/cover",
                      "simulated": observation, "outcome": "win" if index == 0 else "loss" if index == 2 else "steady"})
    baseline = {"metrics": dict(BASELINE), "posts": 12, "simulated": True}
    beliefs = []
    for (variable, value, direction), headline in HEADLINES.items():
        if not any(p["tags"].get(variable) == value for p in posts):
            continue
        belief = {"variable": variable, "value": value, "direction": direction, "metric": METRIC,
                  "created_at": (start - timedelta(days=4)).isoformat()}
        scored = evaluate_belief(belief, posts, baseline)
        if scored["counts"]["beats"] < 1 or scored["counts"]["misses"]:
            continue
        beliefs.append({"id": f"sim-belief-{variable}-{value}", "headline": headline, **belief,
                        "confidence": scored["confidence"], "status": scored["status"], "counts": scored["counts"],
                        "evidence": [{"clip_id": e["clip_id"], "value": e["value"], "baseline": e["baseline"],
                                      "outcome": e["outcome"]} for e in scored["evidence"]]})
    beliefs.sort(key=lambda b: (-b["confidence"], b["variable"] != "length", b["id"]))
    beliefs = beliefs[:3]
    loser = chosen[2]
    plan = loser["edit_plan"]
    main = float(plan["end"] - plan["start"])
    target = round(max(15.0, min(main - 4.0, 24.0)), 1)
    return {
        "schema": SCHEMA, "simulated": True, "profile_id": profile_id, "metric": METRIC,
        "baseline": baseline, "clips": cards, "clip_count": len(pool),
        "source_minutes": round(float(video.get("duration") or 0) / 60, 1) or None, "beliefs": beliefs,
        "recut": {"clip_id": loser["id"], "variable": "duration_seconds", "main_seconds": round(main, 1),
                  "target_main_seconds": target, "before_seconds": round(_seconds(loser), 1),
                  "rule": next((b["headline"] for b in beliefs if b["variable"] == "length"), "Shorter cuts hold viewers")},
        "engine": "strategist.evaluate_belief (production Beta-Bernoulli math) over simulated observations",
        "honesty": "Simulated Instagram results. Nothing posted. No synthetic metric is stored.",
    }
