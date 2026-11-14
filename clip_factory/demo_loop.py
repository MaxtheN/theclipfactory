"""Ephemeral rehearsal of the production rubric and observation-to-next-plan loop.

No media is rendered and no approval, publication, provider call or persistent write is
available here. Synthetic observations use the SAME bounded comparison function as the
real growth-loop service. Quality is an editorial proxy, never an engagement prediction.
"""

from __future__ import annotations

import copy
import math
import random
from datetime import UTC, datetime, timedelta

from . import ranking
from .growth_loop import compare_observations
from .strategist import simulate as simulate_strategist

SCHEMA = "growth-factory-demo-loop@1"
BANNER = "Simulation — synthetic clips, reviewer choices and Instagram metrics. No real posts or renders."
SCENARIOS = {"mixed", "decline", "sparse", "no_signal"}
LABELS = {
    "strength": "Moment strength", "payoff": "Verified payoff", "complete": "Complete thought",
    "brief": "Brand brief fit", "moment": "Scene interest", "technical": "Technical checks",
    "critic": "Critic grounding", "hook": "Hook length",
}
SOURCES = (
    ("Hiring", "Here is the thing that everyone tends to get wrong about hiring",
     ("Would you hire them twice?", "Hiring is a system, not a feeling")),
    ("Pricing", "Let me explain the one thing we learned about setting the right price",
     ("What would you pay for certainty?", "Price the problem you solve")),
    ("Focus", "I want to talk about why our team stopped chasing every single channel",
     ("Which channel earns your next hour?", "One channel deserves your full attention")),
)


def rubric() -> dict:
    return {
        "version": ranking.RANK_VERSION,
        "scale": [0, 100],
        "dimensions": [{"key": key, "label": LABELS[key], "weight": weight}
                       for key, weight in ranking.WEIGHTS.items()],
        "meaning": "Recorded editorial signals weighted by the production ranking code.",
        "caveat": "A proxy score, not a probability of engagement, causal lift, or permission to publish.",
    }


def _clip(index: int) -> dict:
    topic, hook, alternatives = SOURCES[index]
    return {
        "id": f"sim-clip-{index + 1}-v1", "synthetic": True, "topic": topic,
        "source_id": f"sim-source-{index + 1}", "start": 60 * index, "end": 60 * index + 30,
        "duration": 30, "hook": hook, "approved": False, "render_status": "not_rendered",
        "subtitles_burned": True, "caption_style": "standard", "caption_cues": 24,
        "brief_serves": ["M1"], "scene_refs": [f"scene:{index}"],
        "team_review_status": "not_applicable", "technical_checks": {"playback_format_passed": True},
        "swarm": {"strength": 6.5 + index * 0.5, "payoff_verified": True, "speech_source": True,
                  "spoken": True, "duration": {"ends_on_sentence": True, "band": [22.5, 37.5]}},
        "craft": {"structure": {"resolved": "hook_first"}},
        "synthetic_transcript": ". ".join((hook, *alternatives)) + ".",
        "plan": {"source_id": f"sim-source-{index + 1}", "start": 60 * index, "end": 60 * index + 30,
                 "hook": hook, "caption_style": "standard", "framing": "fill"},
    }


def _scorecard(clip: dict) -> dict:
    board = {"scenes": [{"index": i, "score": 0.6 + i * 0.05} for i in range(3)]}
    score, signals = ranking.score(clip, board, {"key_messages": ["A practical decision"]}, speech_source=True)
    return {
        "clip_id": clip["id"], "synthetic": True, "score": score,
        "rubric_version": ranking.RANK_VERSION,
        "dimensions": [{"key": key, "label": LABELS[key], "weight": weight,
                        "signal": signals[key], "points": round(weight * signals[key] * 100, 2)}
                       for key, weight in ranking.WEIGHTS.items()],
        "assessment_kind": "production_ranking_on_synthetic_metadata",
        "unknowns": ["No actual file, transcript model, or vision model was assessed in this rehearsal."],
    }


def _snapshot(identifier: str, views: int | None, rate: float | None, day: datetime) -> dict:
    if views is None or rate is None:
        metrics = {key: None for key in ("views", "likes", "comments", "shares", "saves", "completions", "link_clicks")}
    else:
        metrics = {"views": views, "likes": int(views * rate * 0.5), "comments": int(views * rate * 0.08),
                   "shares": int(views * rate * 0.2), "saves": int(views * rate * 0.22),
                   "completions": min(views, int(views * min(0.95, 0.25 + rate * 3))),
                   "link_clicks": int(views * rate * 0.12)}
    return {"id": identifier, "simulated": True, "source": "synthetic_instagram",
            "collected_at": day.isoformat(), "window_days": 3, "cumulative": True, "metrics": metrics}


def simulate_loop(profile: dict, *, seed: int = 7, rounds: int = 3, scenario: str = "mixed",
                  metric: str = "completion_rate") -> dict:
    """Three candidate reels per loop; one grounded hook variable per comparison.

    Synthetic state advances only inside this return value. A favorable comparison
    schedules a *simulated* reviewer accepting a next plan; actual app rules are untouched.
    """
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 1_000_000:
        raise ValueError("seed must be an integer between 0 and 1000000")
    if isinstance(rounds, bool) or not isinstance(rounds, int) or not 1 <= rounds <= 6:
        raise ValueError("rounds must be an integer between 1 and 6")
    if scenario not in SCENARIOS:
        raise ValueError("Unknown simulation scenario")
    if metric not in {"views", "engagement_rate", "completion_rate", "click_rate"}:
        raise ValueError("Unknown comparison metric")
    rng = random.Random(seed)
    clips = [_clip(i) for i in range(3)]
    timeline = []
    start = datetime(2026, 1, 5, tzinfo=UTC)
    for round_index in range(rounds):
        day = start + timedelta(days=3 * (round_index + 1))
        pairs = []
        for index, parent in enumerate(clips):
            alternatives = SOURCES[index][2]
            hook = next(h for h in (alternatives[round_index % 2], alternatives[(round_index + 1) % 2])
                        if h != parent["hook"])
            child = copy.deepcopy(parent)
            child.update(id=f"sim-clip-{index + 1}-loop-{round_index + 1}", parent_clip_id=parent["id"], hook=hook)
            child["plan"]["hook"] = hook
            group_id = f"sim-group-{round_index + 1}-{index + 1}"
            proposal_id = f"sim-proposal-{round_index + 1}-{index + 1}"
            before_score, after_score = _scorecard(parent), _scorecard(child)
            base_views = rng.randint(500, 1800)
            base_rate = rng.uniform(0.055, 0.105)
            # Hidden scenario effects are disclosed. Noise can overturn the expected direction.
            effect = 0.65 if scenario == "decline" else (1.14 if "?" in hook else 0.96)
            if scenario == "no_signal":
                variant_views, variant_rate = base_views, base_rate
            else:
                variant_views = max(1, int(base_views * effect * math.exp(rng.gauss(0, 0.27))))
                variant_rate = max(0.005, min(0.2, base_rate * effect * math.exp(rng.gauss(0, 0.25))))
            before = _snapshot(f"sim-snapshot-{round_index + 1}-{index + 1}-a", base_views, base_rate, day)
            after = _snapshot(f"sim-snapshot-{round_index + 1}-{index + 1}-b",
                              None if scenario == "sparse" else variant_views,
                              None if scenario == "sparse" else variant_rate, day)
            comparison = compare_observations(before, after, metric=metric, min_views=100,
                                              window_complete=scenario != "sparse")
            advance = comparison["status"] == "favors_variant"
            proposal = {
                "id": proposal_id, "simulated": True, "status": "proposed",
                "parent_clip_id": parent["id"], "variant_clip_id": child["id"],
                "changed_variable": "hook", "before": parent["hook"], "after": child["hook"],
                "evidence_ids": [before["id"], after["id"]],
                "reason": "Test one shorter source-backed hook; inspect both rubric and audience evidence.",
                "source_quote": hook, "source_id": parent["source_id"],
            }
            pairs.append({
                "id": group_id, "simulated": True, "before": copy.deepcopy(parent), "after": child,
                "quality_before": before_score, "quality_after": after_score,
                "quality_difference": after_score["score"] - before_score["score"],
                "observations": [before, after], "evaluation": comparison, "proposal": proposal,
                "next_action": "simulate_reviewer_accepts_plan" if advance else "wait" if scenario == "sparse" else "keep_parent",
                "simulated_reviewer": {"accepted": advance, "real_approval": False},
                "next_plan": copy.deepcopy(child["plan"] if advance else parent["plan"]),
                "render": {"status": "not_rendered", "artifact": None, "job_id": None},
            })
            if advance:
                clips[index] = child
        timeline.append({"id": f"sim-loop-{round_index + 1}", "number": round_index + 1,
                         "simulated": True, "synthetic_day": (day - start).days, "pairs": pairs})
    return {
        "schema": SCHEMA, "simulated": True, "ephemeral": True, "banner": BANNER,
        "profile_name": str(profile.get("name") or "Demo brand")[:80], "seed": seed, "scenario": scenario,
        "metric": metric, "rubric": rubric(), "loops": timeline,
        "strategist_replay": simulate_strategist(profile, seed=seed, steps=min(40, max(4, rounds * 6))),
        "synthetic_truth": {"variant_effect": "decline=0.65; mixed question=1.14, statement=0.96, with noise; no_signal=identical",
                            "note": "Scenario assumptions generate synthetic outcomes. The evaluator does not receive them."},
        "model": {"status": "not_used", "cost_usd": 0, "basis": "No model call or real render in this rehearsal."},
        "limits": ["Quality scores use synthetic metadata, not a vision assessment of a real reel.",
                   "All Instagram metrics and elapsed days are synthetic; none are written to the real account.",
                   "A higher rubric score can accompany lower engagement. No 10x, causal-lift, or trained-model claim.",
                   "Actual revised videos require the real render job and fresh human publication approval."],
    }
