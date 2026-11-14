"""Rank a production run's clips: score, merge near-duplicates, and set a quality floor.

Swarm runs make as many clips as the source supports (coverage, not a cap). This pass turns
that volume into a review list that is best first:

* every clip gets a 0-100 score from signals the factory already recorded: the scout's honest
  strength rating (is it funny, sharp, quotable?), a verified payoff line teased first, completeness
  (whole sentences, finished length inside the target band), whether it serves the campaign brief,
  the storyboard's interest in the clip's scenes, the critic's verdict, technical checks or a cached
  quality rubric, and a short hook;
* on a speech source a clip without burned captions, or without speech, is below the bar
  whatever its score (speechless clips also lose most of their score);
* near-duplicates (ranges overlapping by more than half of the shorter clip, or the same
  payoff sentence) are merged by keeping the better-scored clip;
* clips under the floor, and merged duplicates, are marked ``below_bar``. Nothing is deleted;
  the review screen hides them by default.

The brief's ``deliverables.clip_count`` only says how many clips are marked as top picks. It
never limits how many are made. The pass is deterministic: the same inputs give the same order.
"""

from __future__ import annotations

import re

from .brief import normalize_brief

RANK_VERSION = 2
FLOOR = 50
DUPLICATE_OVERLAP = 0.5
DEFAULT_TOP_PICKS = 5
WEIGHTS = {
    "strength": 0.25, "payoff": 0.15, "complete": 0.15, "brief": 0.15,
    "moment": 0.10, "technical": 0.10, "critic": 0.05, "hook": 0.05,
}
NO_SPEECH_FACTOR = 0.4
NO_CAPTIONS_REASON = "No captions on a speech source"
NO_SPEECH_REASON = "No speech in this clip"
CRITIC = {"pass": 1.0, "not_applicable": 0.6, None: 0.6, "unknown": 0.4, "fail": 0.1}


def _scene_index(ref) -> int | None:
    match = re.fullmatch(r"scene:(\d+)", str(ref or ""))
    return int(match.group(1)) if match else None


def moment_signal(clip: dict, board: dict | None) -> float | None:
    """The storyboard's best score among the clip's scenes (0-1), or None when unknown."""
    scenes = {s.get("index"): s for s in (board or {}).get("scenes") or [] if isinstance(s, dict)}
    indexes = [i for i in (_scene_index(r) for r in clip.get("scene_refs") or []) if i is not None]
    if not indexes and scenes:
        # No cited scene: use the scenes the clip's range overlaps.
        start, end = float(clip.get("start") or 0), float(clip.get("end") or 0)
        indexes = [i for i, s in scenes.items() if min(end, s.get("end", 0)) > max(start, s.get("start", 0))]
    values = [scenes[i].get("score") for i in indexes if i in scenes and isinstance(scenes[i].get("score"), (int, float))]
    return max(0.0, min(1.0, max(values))) if values else None


def brief_signal(clip: dict, brief: dict | None) -> float:
    serves = [s for s in clip.get("brief_serves") or [] if s and s != "none"]
    if serves:
        return 1.0
    has_brief = bool(brief and (brief.get("key_messages") or brief.get("must_include")))
    return 0.0 if has_brief else 0.5


def critic_signal(clip: dict) -> float:
    findings = clip.get("team_findings") or []
    if any(isinstance(f, dict) and f.get("severity") == "error" for f in findings):
        return 0.0
    return CRITIC.get(clip.get("team_review_status"), 0.4)


def technical_signal(clip: dict, report: dict | None) -> float:
    rubric = (report or {}).get("rubric") or {}
    if isinstance(rubric.get("technical"), (int, float)):
        return max(0.0, min(1.0, rubric["technical"] / 5))
    passed = (clip.get("technical_checks") or {}).get("playback_format_passed")
    value = 1.0 if passed is not False else 0.0
    if clip.get("subtitles_burned") is not True or clip.get("warning"):
        value -= 0.4
    return max(0.0, value)


def hook_signal(clip: dict) -> float:
    words = len(str(clip.get("hook") or "").split())
    return 0.0 if not words else 1.0 if words <= 8 else 0.7 if words <= 10 else 0.3


def strength_signal(clip: dict) -> float:
    """The scout's own 0-10 rating of how funny/sharp/quotable the moment is (neutral when unknown)."""
    value = (clip.get("swarm") or {}).get("strength")
    return max(0.0, min(1.0, value / 10)) if isinstance(value, (int, float)) else 0.5


def payoff_signal(clip: dict) -> float:
    """A payoff line actually said (located in the words) and teased first scores highest."""
    record = clip.get("swarm") or {}
    hook_first = ((clip.get("craft") or {}).get("structure") or {}).get("resolved") == "hook_first"
    if "payoff_verified" not in record:
        return 1.0 if hook_first else 0.5
    if not record["payoff_verified"]:
        return 0.0 if record.get("speech_source") else 0.5
    return 1.0 if hook_first else 0.6


def complete_signal(clip: dict) -> float:
    """Whole sentences and a finished length inside the target band (a reasoned short clip: partial)."""
    sizing = (clip.get("swarm") or {}).get("duration")
    if not isinstance(sizing, dict):
        return 0.5
    value = 0.4 if sizing.get("ends_on_sentence") else 0.0
    low, high = (sizing.get("band") or [None, None])[:2]
    length = clip.get("duration")
    if isinstance(length, (int, float)) and isinstance(low, (int, float)) and isinstance(high, (int, float)):
        if low <= length <= high + 0.5:
            value += 0.6
        elif length < low and str(sizing.get("note") or "").startswith("Kept short by the scout"):
            value += 0.35
        elif length > high:
            value += 0.3
    return value


def speechless_clip(clip: dict, speech_source: bool) -> bool:
    """A clip from a talk in which nothing is said."""
    record = clip.get("swarm") or {}
    return bool(speech_source) and record.get("spoken") is False


def score(clip: dict, board: dict | None, brief: dict | None, report: dict | None = None,
          speech_source: bool = False) -> tuple[int, dict]:
    moment = moment_signal(clip, board)
    signals = {
        "strength": strength_signal(clip),
        "payoff": payoff_signal(clip),
        "complete": complete_signal(clip),
        "brief": brief_signal(clip, brief),
        "moment": 0.5 if moment is None else moment,
        "technical": technical_signal(clip, report),
        "critic": critic_signal(clip),
        "hook": hook_signal(clip),
    }
    total = sum(WEIGHTS[k] * v for k, v in signals.items())
    if speechless_clip(clip, speech_source):
        total *= NO_SPEECH_FACTOR
    return round(100 * total), {k: round(v, 3) for k, v in signals.items()}


def bar_reason(clip: dict, speech_source: bool) -> str | None:
    """A hard rule that puts a clip under the bar whatever its score, or None."""
    if not speech_source:
        return None
    if speechless_clip(clip, speech_source):
        return NO_SPEECH_REASON
    if clip.get("subtitles_burned") is not True:
        return NO_CAPTIONS_REASON
    return None


def payoff_key(clip: dict) -> str | None:
    payoff = (((clip.get("craft") or {}).get("structure") or {}).get("payoff") or {}).get("text")
    words = re.findall(r"[a-z0-9']+", str(payoff or "").lower())
    return " ".join(words) if len(words) >= 3 else None


def overlaps(a: dict, b: dict) -> bool:
    a0, a1, b0, b1 = float(a["start"]), float(a["end"]), float(b["start"]), float(b["end"])
    shorter = min(a1 - a0, b1 - b0)
    return shorter > 0 and min(a1, b1) - max(a0, b0) > DUPLICATE_OVERLAP * shorter


def why(clip: dict, brief: dict | None) -> str:
    """One plain line: the brief message the clip serves, else its hook."""
    brief = normalize_brief(brief) if brief else None
    for tag in clip.get("brief_serves") or []:
        match = re.fullmatch(r"([MT])(\d+)", str(tag))
        if brief and match:
            items = brief["key_messages"] if match.group(1) == "M" else brief["must_include"]
            index = int(match.group(2)) - 1
            if 0 <= index < len(items) and str(items[index]).strip():
                return f"Says: {str(items[index]).strip()}"[:160]
    reason = str((clip.get("swarm") or {}).get("why") or "").strip()
    if reason:
        return reason[:160]
    hook = str(clip.get("hook") or "").strip()
    return f"Hook: {hook}"[:160] if hook else "No hook"


def rank(clips: list[dict], *, board: dict | None = None, brief: dict | None = None,
         reports: dict | None = None, top_picks: int | None = None, floor: int = FLOOR,
         speech_source: bool = False) -> dict[str, dict]:
    """A rank record per clip id. Pure: callers store the records; no clip is removed.

    speech_source: the clips come from footage with speech, so captions and speech are required.
    """
    reports = reports or {}
    picks = top_picks if isinstance(top_picks, int) and top_picks > 0 else DEFAULT_TOP_PICKS
    scored = []
    for clip in clips:
        value, signals = score(clip, board, brief, reports.get(clip["id"]), speech_source)
        scored.append((value, clip, signals))
    # Best first; ties by earlier start, then id, so the order never depends on render timing.
    scored.sort(key=lambda row: (-row[0], float(row[1].get("start") or 0), str(row[1]["id"])))
    kept: list[dict] = []
    records: dict[str, dict] = {}
    for value, clip, signals in scored:
        key = payoff_key(clip)
        twin = next((k for k in kept if overlaps(clip, k) or (key and key == payoff_key(k))), None)
        rule = bar_reason(clip, speech_source)
        record = {
            "version": RANK_VERSION,
            "score": value,
            "signals": signals,
            "why": why(clip, brief),
            "duplicate_of": twin["id"] if twin else None,
            "below_bar": bool(twin) or value < floor or bool(clip.get("made_without_speech")) or bool(rule),
            "reason": (
                "Similar to a better clip"
                if twin
                else SPEECHLESS_REASON
                if clip.get("made_without_speech")
                else rule
                if rule
                else f"Score under {floor}"
                if value < floor
                else None
            ),
            "floor": floor,
        }
        if not twin and not clip.get("made_without_speech") and not rule:
            kept.append(clip)
        records[clip["id"]] = record
    position = 0
    for value, clip, _ in scored:
        record = records[clip["id"]]
        if not record["below_bar"]:
            position += 1
            record["position"] = position
            record["top_pick"] = position <= picks
        else:
            record["position"] = None
            record["top_pick"] = False
    return records


SPEECHLESS_REASON = "Made without speech"


def speechless(record: dict | None) -> dict:
    """A rank record for a clip cut without its speech: kept, but always under the bar."""
    record = dict(record or {"version": RANK_VERSION, "score": None, "signals": {}, "why": "", "floor": FLOOR})
    record.update(below_bar=True, top_pick=False, position=None, reason=SPEECHLESS_REASON)
    record.setdefault("duplicate_of", None)
    return record


def summary(records: dict[str, dict], top_picks: int | None = None) -> dict:
    above = [r for r in records.values() if not r["below_bar"]]
    return {
        "ranked": len(records),
        "above_bar": len(above),
        "below_bar": len(records) - len(above),
        "duplicates": sum(1 for r in records.values() if r["duplicate_of"]),
        "top_picks": sum(1 for r in above if r["top_pick"]),
        "review_target": top_picks or DEFAULT_TOP_PICKS,
    }
