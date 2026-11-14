"""One-click learning-loop demo: real clips, SIMULATED Instagram results, real belief math, real re-edit.

Nothing here posts, approves or writes metrics. Simulated observations live only in the
returned payload; beliefs are computed with the production ``strategist.evaluate_belief``
over those observations in memory. The optional re-edit is a real, unapproved render that
changes one creative variable, the hook (a question or punchline spoken in the
clip opens it, with a matching title card), through the existing growth-loop path.
"""
from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException

from . import craft, media
from .strategist import evaluate_belief, tag_clip

SCHEMA = "growth-factory-learning-demo@1"
METRIC = "completion_rate"
HOLD = "hold_3s"
BASELINE = {"views": 1600, "completion_rate": 0.41, HOLD: 0.52}
# Deterministic simulated outcomes: winner, steady, underperformer (completion, 3-second hold, views).
SHAPES = ((0.62, 0.72, 2400), (0.47, 0.55, 1850), (0.29, 0.36, 1300))


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


QUESTION_WORDS = {"what", "why", "how", "who", "when", "where", "which", "is", "are", "was", "were", "do",
                  "does", "did", "can", "could", "would", "should", "will", "has", "have", "isn't", "aren't"}
NEGATION = re.compile(r"\b(not|no|never|nobody|nothing|cannot)\b|n['’]t\b", re.IGNORECASE)
LEAD_IN = {"and", "so", "okay", "ok", "well", "now", "but", "yeah", "like"}
HOOK_WORDS = 8
LABELS = {"question": "Question hooks hold viewers", "punchline": "Punchline openers hold viewers"}


def _opening_text(clip: dict) -> str:
    """What is heard in the first ~2 s: the rendered teaser, else the hook text."""
    structure = (clip.get("craft") or {}).get("structure") or {}
    teaser = structure.get("teaser") if structure.get("resolved") == "hook_first" else None
    return str((teaser or {}).get("text") or (clip.get("edit_plan") or {}).get("hook") or clip.get("hook") or "")


def opening(clip: dict) -> str:
    """question | punchline | setup, from the clip's actual opening words."""
    text = _opening_text(clip).strip()
    if "?" in text:
        return "question"
    if NEGATION.search(text) and text[:1].isupper():
        return "punchline"
    return "setup"


def pacing(clip: dict) -> str:
    """tight when the render really cut pauses (at least two jump cuts), else loose."""
    cuts = (clip.get("craft") or {}).get("jump_cuts") or {}
    return "tight" if len(cuts.get("removed") or []) >= 2 else "loose"


def _clean(group: list[dict]) -> tuple[list[dict], str] | None:
    """Trim lead-in words and, for questions, keep the final question clause. Source words only."""
    words = list(group)
    if words[-1]["text"].rstrip().endswith("?"):
        for i in range(len(words) - 2, -1, -1):
            if words[i]["text"].rstrip().endswith(","):
                words = words[i + 1:]
                break
    while len(words) > 3 and craft.norm(words[0]["text"]) in LEAD_IN:
        words = words[1:]
    if not 3 <= len(words) <= HOOK_WORDS:
        return None
    text = " ".join(w["text"].strip() for w in words).strip()
    return words, text[:1].upper() + text[1:]


def hook_line(clip: dict, video: dict | None) -> dict | None:
    """A question (or contrarian punchline) sentence actually spoken in the clip, short enough for a title."""
    plan = clip.get("edit_plan") or {}
    transcript = (video or {}).get("transcript")
    if not transcript or plan.get("cold_open_start") is not None:
        return None
    words = craft.range_words(transcript, plan["start"], plan["end"], media.foreground, media.usable_words)
    found = []
    for group in craft.sentences(words):
        if len(group) < 3 or group[0]["start"] < plan["start"] + craft.SETUP_MIN:
            continue
        cleaned = _clean(group)
        if not cleaned:
            continue
        kept, text = cleaned
        if text.endswith("?") and craft.norm(kept[0]["text"]) in QUESTION_WORDS:
            kind = "question"
        elif NEGATION.search(text) and text.endswith((".", "!")):
            kind, text = "punchline", text.rstrip(".!")
        else:
            continue
        if not craft.teaser_from(words, kept[0]["start"], kept[-1]["end"]):
            continue
        found.append({"kind": kind, "text": text, "payoff_start": round(kept[0]["start"], 2),
                      "payoff_end": round(kept[-1]["end"], 2)})
    return min(found, key=lambda f: (f["kind"] != "question", len(f["text"]))) if found else None


def pick(clips: list[dict], videos: dict | None = None) -> tuple[list[dict], dict | None]:
    """Winner opened on a question/punchline; the underperformer opened on setup and has a better line inside."""
    if len(clips) < 3:
        raise HTTPException(409, "Make at least 3 clips first — the demo uses your real clips.")
    videos = videos or {}
    rank = {"question": 0, "punchline": 1, "setup": 2}
    strong = sorted((c for c in clips if opening(c) != "setup"),
                    key=lambda c: (rank[opening(c)], pacing(c) != "tight"))
    winner = (strong or clips)[0]
    lines = {c["id"]: hook_line(c, videos.get(c.get("video_id"))) for c in clips if c["id"] != winner["id"]}
    candidates = sorted((c for c in clips if lines.get(c["id"])),
                        key=lambda c: (opening(c) != "setup", pacing(c) != "loose",
                                       lines[c["id"]]["kind"] != "question"))
    loser = candidates[0] if candidates else next(c for c in clips[::-1] if c["id"] != winner["id"])
    steady = next(c for c in clips if c["id"] not in {winner["id"], loser["id"]})
    return [winner, steady, loser], lines.get(loser["id"])


def build(store, profile_id: str, root=None) -> dict:
    profile = store.get("profiles", profile_id)
    if not profile:
        raise HTTPException(404, "Brand not found.")
    pool = eligible(store, profile_id, root)
    videos = {v: store.get("videos", v) for v in {c.get("video_id") for c in pool}}
    chosen, line = pick(pool, videos)
    if not line:
        raise HTTPException(409, "None of these clips has a question or punchline line to lead with yet.")
    video = videos.get(chosen[0].get("video_id")) or {}
    start = datetime.now(UTC).replace(microsecond=0)
    posts, cards = [], []
    for index, (clip, (rate, hold, views)) in enumerate(zip(chosen, SHAPES, strict=True)):
        seed = f"{clip['id']}:{index}"
        rate = round(rate + _jitter(seed, 0.02), 3)
        hold = round(hold + _jitter(seed + "h", 0.015), 3)
        views = int(views * (1 + _jitter(seed + "v", 0.08)))
        tags = {**tag_clip(clip), "opening": opening(clip), "pacing": pacing(clip)}
        observation = {"id": f"sim-observation-{index + 1}", "simulated": True, "window_days": 3,
                       "metrics": {"views": views, METRIC: rate, HOLD: hold}}
        posts.append({"publication_id": f"sim-post-{index + 1}", "snapshot_id": observation["id"],
                      "clip_id": clip["id"], "published_at": (start - timedelta(days=3)).isoformat(),
                      "tags": tags, "metrics": observation["metrics"], "trigger": "simulated"})
        cards.append({"clip_id": clip["id"], "hook": str(clip["edit_plan"].get("hook") or clip.get("hook") or ""),
                      "score": (clip.get("rank") or {}).get("score"), "seconds": round(_seconds(clip), 1),
                      "opening": tags["opening"], "pacing": tags["pacing"],
                      "media_url": f"/api/clips/{clip['id']}/media", "cover_url": f"/api/clips/{clip['id']}/cover",
                      "simulated": observation, "outcome": "win" if index == 0 else "loss" if index == 2 else "steady"})
    baseline = {"metrics": dict(BASELINE), "posts": 12, "simulated": True}
    winner_open = posts[0]["tags"]["opening"]
    value = winner_open if winner_open in LABELS else "question"
    specs = [("opening", value, HOLD, LABELS[value]), ("pacing", "tight", METRIC, "Tighter pacing wins")]
    beliefs = []
    for variable, value, metric, headline in specs:
        belief = {"variable": variable, "value": value, "direction": "increase", "metric": metric,
                  "created_at": (start - timedelta(days=4)).isoformat()}
        scored = evaluate_belief(belief, posts, baseline)
        lift = round((posts[0]["metrics"][HOLD] / BASELINE[HOLD] - 1) * 100)
        detail = f"+{lift}% 3-sec hold" if metric == HOLD else "Jump cuts on pauses"
        beliefs.append({"id": f"sim-belief-{variable}-{value}", "headline": headline, **belief, "detail": detail,
                        "confidence": scored["confidence"], "status": scored["status"], "counts": scored["counts"],
                        "evidence": [{"clip_id": e["clip_id"], "value": e["value"], "baseline": e["baseline"],
                                      "outcome": e["outcome"]} for e in scored["evidence"]]})
    loser = chosen[2]
    return {
        "schema": SCHEMA, "simulated": True, "profile_id": profile_id, "metric": HOLD,
        "baseline": baseline, "clips": cards, "clip_count": len(pool),
        "source_minutes": round(float(video.get("duration") or 0) / 60, 1) or None, "beliefs": beliefs,
        "recut": {"clip_id": loser["id"], "variable": "hook", "before_kind": opening(loser),
                  "before_hook": str(loser["edit_plan"].get("hook") or ""),
                  "before_opening": _opening_text(loser), "after_kind": line["kind"], "after_hook": line["text"],
                  "payoff_start": line["payoff_start"], "payoff_end": line["payoff_end"],
                  "rule": beliefs[0]["headline"], "next_test": "Jump cuts"},
        "engine": "strategist.evaluate_belief (production Beta-Bernoulli math) over simulated observations",
        "honesty": "Simulated Instagram results. Nothing posted. No synthetic metric is stored.",
    }
