"""Editing craft: deterministic edit decisions layered on the renderer (no model calls).

Every option here is an explicit, validated edit-plan field with a default. The renderer
(`media.render(edit=...)`) resolves each one against the real transcript and records what it
did in the clip's `craft` provenance, so the learning loop and the Strategist can treat each
choice as a testable variable. Nothing here invents words: jump cuts and teasers only cut on
word boundaries Whisper (or an imported transcript) measured, and emphasis only restyles words
that were said.
"""

from __future__ import annotations

import re
import uuid
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, field_validator, model_validator

OUTPUT_FPS = 30
# Social platforms normalise to about -14 LUFS; -1.5 dBTP leaves headroom for AAC encoding.
LOUDNESS_TARGET = {"integrated": -14.0, "true_peak": -1.5, "lra": 11.0}
LOUDNESS_TOLERANCE = 2.0

# Jump cuts.
SILENCE_MIN = 0.55          # a pause longer than this is tightened
CUT_PAD = 0.15              # breath kept before/after speech at each cut
MIN_SEGMENT = 0.8           # never leave a kept piece shorter than this
MAX_REMOVED_SHARE = 0.35    # never remove more than this share of the chosen range
MAX_PIECES = 40             # bounded filter graph
MIN_WORDS_PER_SECOND = 1.0  # only talky ranges are tightened (action footage keeps its pauses)
FILLERS = {"um", "uh", "umm", "uhh", "erm", "er", "hmm", "uhm", "ah", "mm"}
# Words that are fillers only when set off by commas ("so, like, it was"; "you know,").
SOFT_FILLERS = {"like"}

# Hook-first structure.
TEASER_MAX = 3.0
TEASER_MIN = 0.8
SETUP_MIN = 4.0             # the payoff must start this long after the range start
PAYOFF_ADJACENT = 10.0      # a planner payoff may end this far after the chosen range
PAYOFF_MAX = 30.0

# Title card, punch-ins, end card.
TITLE_CARD_SECONDS = 2.0
OVERLAY_SECONDS = 3.0
PUNCH_ZOOM = 0.08
PUNCH_RISE = 0.3
PUNCH_HOLD = 1.5
PUNCH_GAP = 2.5
PUNCH_MAX = 3
TRANSITION_ZOOM = 0.06
TRANSITION_SECONDS = 0.25
FLASH_SECONDS = 0.15
END_CARD_SECONDS = 1.6

DEFAULT_PRIMARY = "#111111"
DEFAULT_ACCENT = "#FFD400"
POP_EMPHASIS = "#5CF2A0"     # pop already lights the spoken word yellow
HEX = r"^#[0-9A-Fa-f]{6}$"

NUMBER_WORDS = {
    "hundred", "thousand", "million", "billion", "trillion", "percent", "half", "double", "triple",
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "twenty",
    "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
}
STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "so", "to", "of", "in", "on", "at", "for", "with", "is",
    "it", "that", "this", "was", "are", "be", "i", "you", "we", "they", "he", "she", "my", "your",
    "because", "actually", "basically", "something", "everything", "anything", "really", "through",
}

# Stored plans saved before these options existed were rendered without them.
LEGACY_PLAN = {
    "loudness": "off",
    "jump_cuts": "off",
    "hook_format": "overlay",
    "caption_emphasis": "off",
    "emphasis_words": [],
    "punch_in": "off",
    "cover": "first_frame",
    "end_card": "none",
    "cta_text": "",
    "brand_kit": None,
    "structure": "linear",
    "payoff_start": None,
    "payoff_end": None,
    "transition": "cut",
}
VARIABLES = ("hook", "opening_treatment", "caption_style", "hook_format", "structure")
VARIANT_VALUES = {
    "opening_treatment": {"text_overlay", "cold_open", "none"},
    "caption_style": {"standard", "high_contrast", "pop"},
    "hook_format": {"overlay", "title_card"},
    "structure": {"linear", "hook_first"},
}


def plain(value: str) -> str:
    return re.sub(r"[\x00-\x1f\\{}]", " ", value).strip()


class BrandKit(BaseModel):
    """A workspace's visual identity. Files are local paths checked (magic bytes, size) at render."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    font_family: str = Field(default="", max_length=80, pattern=r"^[A-Za-z0-9 _.-]*$")
    font_file: str | None = Field(default=None, max_length=1024)
    primary_color: str = Field(default=DEFAULT_PRIMARY, pattern=HEX)
    accent_color: str = Field(default=DEFAULT_ACCENT, pattern=HEX)
    logo_file: str | None = Field(default=None, max_length=1024)

    @model_validator(mode="after")
    def files(self):
        if self.font_file:
            if not self.font_family.strip():
                raise ValueError("A brand font file needs its font family name (as installed fonts name it).")
            if Path(self.font_file).suffix.lower() not in {".ttf", ".otf"} or not Path(self.font_file).is_absolute():
                raise ValueError("The brand font must be an absolute path to a .ttf or .otf file.")
        if self.logo_file and (
            Path(self.logo_file).suffix.lower() != ".png" or not Path(self.logo_file).is_absolute()
        ):
            raise ValueError("The brand logo must be an absolute path to a .png file.")
        return self


class Variants(BaseModel):
    """2–3 versions of one moment that differ in exactly one edit variable (an A/B test)."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    variable: Literal["hook", "opening_treatment", "caption_style", "hook_format", "structure"]
    values: list[str] = Field(min_length=2, max_length=3)

    @model_validator(mode="after")
    def distinct(self):
        values = [v.strip() for v in self.values]
        if len(set(values)) != len(values) or any(not v for v in values):
            raise ValueError("Variant values must be distinct and non-empty.")
        allowed = VARIANT_VALUES.get(self.variable)
        if allowed is not None and not set(values) <= allowed:
            raise ValueError(f"{self.variable} variants must be among: {', '.join(sorted(allowed))}.")
        if self.variable == "hook" and any(len(v) > 250 or plain(v) != v for v in values):
            raise ValueError("Variant hooks must be plain text of at most 250 characters.")
        self.values = values
        return self


class CraftOptions(BaseModel):
    """Editing-craft fields shared by every render request (direct, campaign and revisions)."""

    # EBU R128 loudness normalisation to -14 LUFS (two-pass loudnorm).
    loudness: Literal["off", "normalize"] = "normalize"
    # Tighten pauses (and optionally um/uh fillers) on measured word boundaries.
    jump_cuts: Literal["off", "silences", "silences_and_fillers"] = "silences"
    # How a rendered hook looks: the plain 3 s strip or a big 2 s title card.
    hook_format: Literal["overlay", "title_card"] = "title_card"
    # Keyword emphasis in captions (planner words, or numbers/names/key-phrase words).
    caption_emphasis: Literal["off", "keywords"] = "keywords"
    emphasis_words: list[str] = Field(default_factory=list, max_length=12)
    # Subtle 1.0→1.08 zooms on emphasised words.
    punch_in: Literal["off", "emphasis"] = "off"
    cover: Literal["first_frame", "best_frame"] = "best_frame"
    end_card: Literal["none", "cta"] = "none"
    cta_text: str = Field(default="", max_length=80)
    brand_kit: BrandKit | None = None
    # auto: hook_first when a sentence-aligned payoff exists, otherwise linear.
    structure: Literal["auto", "linear", "hook_first"] = "auto"
    payoff_start: float | None = Field(default=None, ge=0)
    payoff_end: float | None = Field(default=None, gt=0)
    # From the teaser back to the setup.
    transition: Literal["cut", "zoom", "flash"] = "zoom"
    variants: Variants | None = None
    # Set on each expanded variant copy (group id, variable, value); never part of the plan.
    _variant: dict = PrivateAttr(default_factory=dict)

    @field_validator("emphasis_words")
    @classmethod
    def words(cls, value: list[str]) -> list[str]:
        cleaned = []
        for item in value:
            text = plain(str(item))
            if not 1 <= len(text) <= 40:
                raise ValueError("Each emphasis word or phrase must be 1–40 plain characters.")
            cleaned.append(text)
        return cleaned

    @field_validator("cta_text")
    @classmethod
    def cta(cls, value: str) -> str:
        return plain(value)

    @model_validator(mode="after")
    def craft_consistency(self):
        if self.end_card == "cta" and not self.cta_text:
            raise ValueError("A CTA end card needs cta_text.")
        if (self.payoff_start is None) != (self.payoff_end is None):
            raise ValueError("Give both payoff_start and payoff_end, or neither.")
        if self.payoff_start is not None and not 0 < self.payoff_end - self.payoff_start <= PAYOFF_MAX:
            raise ValueError(f"The payoff span must be a positive range of at most {PAYOFF_MAX:g} seconds.")
        if self.structure == "linear" and self.payoff_start is not None:
            raise ValueError("A payoff span is only used with the hook_first or auto structure.")
        if self.punch_in != "off" and getattr(self, "motion", "static") == "push_in":
            raise ValueError("Choose either the slow push-in or emphasis punch-ins, not both.")
        if (
            self.variants
            and self.variants.variable == "opening_treatment"
            and "cold_open" in self.variants.values
            and (getattr(self, "cold_open_start", None) is None or getattr(self, "cold_open_end", None) is None)
        ):
            raise ValueError("A cold-open variant needs cold_open_start and cold_open_end.")
        return self


CRAFT_FIELDS = frozenset(CraftOptions.model_fields)
# Request shape, not an edit decision of any one version.
PLAN_REQUEST_ONLY = frozenset({"variants"})


def with_legacy(plan: dict) -> dict:
    """A stored plan from before these options existed, filled with what was actually rendered."""
    return {**{k: v for k, v in LEGACY_PLAN.items() if k not in plan}, **plan}


def inherit(body, parent_plan: dict) -> None:
    """A revision keeps its parent's craft decisions unless the request sets them explicitly.

    Without this, revising a clip rendered before an option existed would silently change that
    option too, and the revision would no longer differ from its parent in one variable.
    """
    parent = with_legacy(parent_plan or {})
    for key in CRAFT_FIELDS - PLAN_REQUEST_ONLY:
        if key not in body.model_fields_set and key in parent:
            value = parent[key]
            if key == "brand_kit" and isinstance(value, dict):
                value = BrandKit.model_validate(value)
            setattr(body, key, value)


def expand_variants(body) -> list:
    """One request per variant value; each differs from the others in exactly one field."""
    spec = body.variants
    if not spec:
        return [body]
    group = "vg_" + uuid.uuid4().hex[:12]
    copies = []
    for index, value in enumerate(spec.values):
        update = {spec.variable: value, "variants": None}
        if spec.variable == "opening_treatment" and value != "cold_open":
            update.update(cold_open_start=None, cold_open_end=None)
        if spec.variable == "hook":
            update["hook_overlay"] = True
        if not getattr(body, "changed_variable", "").strip():
            update["changed_variable"] = spec.variable
        copy = body.model_copy(update=update, deep=True)
        copy._variant = {
            "variant_group": group,
            "variant_variable": spec.variable,
            "variant_value": value,
            "variant_index": index + 1,
            "variant_count": len(spec.values),
        }
        copies.append(copy)
    return copies


def variant_of(body) -> dict:
    return dict(getattr(body, "_variant", None) or {})


# --------------------------------------------------------------------------- words


def norm(text: str) -> str:
    return re.sub(r"[^\w%$']+", "", str(text).lower()).strip("'")


def range_words(transcript: dict | None, start: float, end: float, foreground, usable_words) -> list[dict]:
    """Measured words whose midpoint lies inside [start, end), in time order."""
    words = []
    for segment in foreground(transcript):
        for word in usable_words(segment.get("words")):
            if start <= (word["start"] + word["end"]) / 2 < end:
                words.append(word)
    words.sort(key=lambda w: w["start"])
    return words


def sentences(words: list[dict]) -> list[list[dict]]:
    groups: list[list[dict]] = []
    for word in words:
        if (
            not groups
            or groups[-1][-1]["text"].endswith((".", "?", "!"))
            or word["start"] - groups[-1][-1]["end"] > 0.7
        ):
            groups.append([word])
        else:
            groups[-1].append(word)
    return groups


# --------------------------------------------------------------------------- jump cuts


def _is_filler(words: list[dict], index: int) -> bool:
    word = norm(words[index]["text"])
    if word in FILLERS:
        return True
    raw = words[index]["text"].strip()
    previous = words[index - 1]["text"].strip() if index else ""
    if word in SOFT_FILLERS and raw.endswith(",") and (not previous or previous.endswith(",")):
        return True
    # "you know," as an aside.
    return word == "know" and raw.endswith(",") and index and norm(previous) == "you"


def plan_jump_cuts(words: list[dict], start: float, end: float, mode: str) -> dict:
    """Kept source pieces of [start, end) after tightening pauses (and fillers).

    Guards: a cut never falls inside a kept word, every kept piece is at least MIN_SEGMENT long,
    at most MAX_REMOVED_SHARE of the range is removed (largest removals win), and ranges with
    sparse speech are left alone. Returns {"keeps": [(a, b)], "removed": [...], ...}.
    """
    span = end - start
    result = {"mode": mode, "keeps": [(start, end)], "removed": [], "fillers_removed": [], "reason": None}
    if mode == "off":
        result["reason"] = "Jump cuts are off."
        return result
    if not words:
        result["reason"] = "No word timings in this range, so no cut can be placed safely."
        return result
    if len(words) / max(span, 1e-6) < MIN_WORDS_PER_SECOND:
        result["reason"] = "Speech is sparse here; pauses are kept so action and reactions stay intact."
        return result
    removals: list[tuple[float, float, str]] = []
    fillers = (
        {i for i in range(len(words)) if _is_filler(words, i)} if mode == "silences_and_fillers" else set()
    )
    kept = [w for i, w in enumerate(words) if i not in fillers]
    if not kept:
        result["reason"] = "Only filler words in this range; nothing was cut."
        return result
    # Pauses between kept words, plus lead-in/out silence of the range. Cuts stay inside the
    # pause with a breath of padding on each side that touches speech.
    bounds = [start, *[x for w in kept for x in (w["start"], w["end"])], end]
    for gap_start, gap_end in zip(bounds[0::2], bounds[1::2]):
        if gap_end - gap_start <= SILENCE_MIN:
            continue
        a = gap_start + (CUT_PAD if gap_start > start else 0.0)
        b = gap_end - (CUT_PAD if gap_end < end else 0.0)
        if b - a >= 0.2:
            # A pause that swallowed a filler is recorded as a filler cut.
            inside = any(a <= words[i]["start"] and words[i]["end"] <= b for i in fillers)
            removals.append((a, b, "filler" if inside else "silence"))
    # A filler between two kept words with a short gap: cut it from word end to word start.
    for i in sorted(fillers):
        word = words[i]
        previous = max((w["end"] for w in kept if w["end"] <= word["start"] + 1e-6), default=start)
        following = min((w["start"] for w in kept if w["start"] >= word["end"] - 1e-6), default=end)
        a = max(previous + 0.04, word["start"] - 0.04) if previous > start else max(start, word["start"] - 0.04)
        b = min(following - 0.04, word["end"] + 0.04) if following < end else min(end, word["end"] + 0.04)
        if b - a >= 0.1 and not any(r[0] <= a and b <= r[1] for r in removals):
            removals.append((a, b, "filler"))
    removals = _merge(removals)
    # Largest removals first until the cap; never more than MAX_PIECES pieces.
    budget = MAX_REMOVED_SHARE * span
    chosen: list[tuple[float, float, str]] = []
    for removal in sorted(removals, key=lambda r: r[1] - r[0], reverse=True):
        if len(chosen) + 1 >= MAX_PIECES:
            break
        if sum(r[1] - r[0] for r in chosen) + (removal[1] - removal[0]) <= budget:
            chosen.append(removal)
    chosen.sort()
    # Restore removals that would leave a kept piece shorter than MIN_SEGMENT.
    while True:
        keeps = _complement(chosen, start, end)
        short = next((i for i, (a, b) in enumerate(keeps) if b - a < MIN_SEGMENT), None)
        if short is None or not chosen:
            break
        # keeps[i] lies between chosen[i-1] and chosen[i]; restore the smaller neighbour.
        neighbours = [j for j in (short - 1, short) if 0 <= j < len(chosen)]
        smallest = min(neighbours, key=lambda j: chosen[j][1] - chosen[j][0])
        chosen.pop(smallest)
    keeps = _complement(chosen, start, end)
    removed = sum(b - a for a, b, _ in chosen)
    result.update(
        keeps=keeps,
        removed=[{"start": round(a, 3), "end": round(b, 3), "kind": kind} for a, b, kind in chosen],
        fillers_removed=[
            words[i]["text"] for i in sorted(fillers) if any(a <= words[i]["start"] and words[i]["end"] <= b for a, b, _ in chosen)
        ],
        removed_seconds=round(removed, 3),
        removed_share=round(removed / span, 3) if span else 0.0,
        reason=None if chosen else "No pause in this range was long enough to tighten.",
    )
    return result


def _merge(items: list[tuple[float, float, str]]) -> list[tuple[float, float, str]]:
    merged: list[list] = []
    for a, b, kind in sorted(items):
        if merged and a <= merged[-1][1] + 1e-6:
            merged[-1][1] = max(merged[-1][1], b)
            if kind == "filler":
                merged[-1][2] = "filler"
        else:
            merged.append([a, b, kind])
    return [tuple(m) for m in merged]


def _complement(removals, start: float, end: float) -> list[tuple[float, float]]:
    keeps, cursor = [], start
    for a, b, _ in removals:
        if a > cursor:
            keeps.append((cursor, a))
        cursor = max(cursor, b)
    if end > cursor:
        keeps.append((cursor, end))
    return keeps


def snap(keeps: list[tuple[float, float]], origin: float) -> list[tuple[float, float]]:
    """Kept pieces on the output frame grid relative to `origin`, so audio and video cut alike."""
    snapped = []
    for a, b in keeps:
        ra, rb = round((a - origin) * OUTPUT_FPS) / OUTPUT_FPS, round((b - origin) * OUTPUT_FPS) / OUTPUT_FPS
        if rb > ra:
            snapped.append((ra, rb))
    return snapped


# --------------------------------------------------------------------------- emphasis


def _sentence_initial(previous: str | None) -> bool:
    return previous is None or previous.rstrip().endswith((".", "?", "!"))


def emphasis_rank(word: str, previous: str | None, key_terms: set[str], planner: list[list[str]] | None = None) -> int:
    """3 = number, 2 = proper noun, 1 = long word from the key phrase, 0 = not emphasised."""
    token = norm(word)
    if not token or token in STOPWORDS:
        return 0
    if re.search(r"\d", token) or token in NUMBER_WORDS or "%" in word or "$" in word:
        return 3
    raw = word.strip().strip("\"'“”‘’(")
    if raw[:1].isupper() and token not in {"i", "i'm", "i've", "i'll", "i'd"} and not _sentence_initial(previous):
        return 2
    if len(token) >= 7 and token in key_terms:
        return 1
    return 0


def key_terms(*texts: str) -> set[str]:
    return {norm(t) for text in texts for t in str(text or "").split() if len(norm(t)) >= 7}


def choose_emphasis(entries: list[dict], planner: list[str], key_phrase: str) -> dict:
    """At most one emphasised word per caption cue: planner words first, then the heuristic.

    Returns {"marks": {(entry_index, word_index)}, "words": [...], "source": ..., "ignored": [...]}.
    """
    phrases = [[norm(p) for p in item.split() if norm(p)] for item in planner]
    phrases = [p for p in phrases if p]
    terms = key_terms(key_phrase)
    marks: set[tuple[int, int]] = set()
    chosen_words, matched = [], set()
    previous = None
    for e_index, entry in enumerate(entries):
        timed = entry.get("timed") or []
        tokens = [norm(w["text"]) for w in timed]
        best = None
        for w_index, word in enumerate(timed):
            for p_index, phrase in enumerate(phrases):
                if tokens[w_index : w_index + len(phrase)] == phrase:
                    best = (9, w_index)
                    matched.add(p_index)
                    break
            if best and best[0] == 9:
                break
            if not phrases:
                rank = emphasis_rank(word["text"], previous if w_index == 0 else timed[w_index - 1]["text"], terms)
                if rank and (best is None or rank > best[0]):
                    best = (rank, w_index)
        if best:
            marks.add((e_index, best[1]))
            chosen_words.append(timed[best[1]]["text"])
        if timed:
            previous = timed[-1]["text"]
    return {
        "marks": marks,
        "words": chosen_words,
        "source": "planner" if phrases else "heuristic",
        "ignored": [" ".join(p) for i, p in enumerate(phrases) if i not in matched],
    }


def punch_times(entries: list[dict], marks: set[tuple[int, int]], total: float, *, after: float = 0.0) -> list[float]:
    times = []
    for e_index, w_index in sorted(marks):
        at = entries[e_index]["timed"][w_index]["start"]
        if at < max(after, 0.5) or at > total - 1.0:
            continue
        if times and at - times[-1] < PUNCH_GAP + PUNCH_HOLD:
            continue
        times.append(round(at, 3))
        if len(times) >= PUNCH_MAX:
            break
    return times


def zoom_expression(punches: list[float], transition_at: float | None) -> str | None:
    """Per-frame zoom factor: eased punch-ins plus a short settle after the teaser cut."""
    terms = []
    for at in punches:
        top = at + PUNCH_RISE + PUNCH_HOLD
        terms.append(
            f"{PUNCH_ZOOM}*clip((t-{at:.3f})/{PUNCH_RISE},0,1)*clip(({top + PUNCH_RISE:.3f}-t)/{PUNCH_RISE},0,1)"
        )
    if transition_at is not None:
        terms.append(
            f"{TRANSITION_ZOOM}*gte(t,{transition_at:.3f})*clip(1-(t-{transition_at:.3f})/{TRANSITION_SECONDS},0,1)"
        )
    return "1+" + "+".join(terms) if terms else None


# --------------------------------------------------------------------------- hook-first structure


def _scene_score(at: float, moment: dict | None) -> tuple[float, float]:
    """(loudness rank 0..1, highlight 0..1) around a source time from the stored storyboard."""
    moment = moment or {}
    loud, interval = moment.get("loudness") or [], moment.get("interval") or 0
    level = 0.5
    if loud and interval:
        index = min(len(loud) - 1, max(0, int(at // interval)))
        value = loud[index]
        level = float(value) if isinstance(value, (int, float)) else 0.5
    highlight = 0.5
    for scene in moment.get("scenes") or []:
        if scene.get("start", 0) <= at < scene.get("end", 0) and isinstance(scene.get("highlight"), (int, float)):
            highlight = scene["highlight"] / 10
    return level, highlight


def teaser_from(words: list[dict], pstart: float, pend: float) -> tuple[float, float, list[dict]] | None:
    """The first ≤3 s of measured words in the payoff, cut on word boundaries with a breath."""
    inside = [w for w in words if pstart - 0.05 <= w["start"] and w["end"] <= pend + 0.05]
    if not inside:
        return None
    chosen = []
    for word in inside:
        if word["end"] - inside[0]["start"] > TEASER_MAX - 0.15:
            break
        chosen.append(word)
    # Prefer ending the teaser on a phrase break (comma or sentence end) when one exists.
    for cut in range(len(chosen) - 1, 0, -1):
        if chosen[cut]["text"].rstrip().endswith((",", ".", "?", "!", ";", ":")) and (
            chosen[cut]["end"] - chosen[0]["start"] >= TEASER_MIN + 0.5
        ):
            chosen = chosen[: cut + 1]
            break
    if not chosen or chosen[-1]["end"] - chosen[0]["start"] < TEASER_MIN:
        return None
    index = words.index(chosen[0])
    before = words[index - 1]["end"] if index else chosen[0]["start"] - 0.1
    after_index = words.index(chosen[-1]) + 1
    after = words[after_index]["start"] if after_index < len(words) else chosen[-1]["end"] + 0.12
    a = max(before, chosen[0]["start"] - 0.06)
    b = min(after, chosen[-1]["end"] + 0.1)
    return a, b, chosen


def plan_structure(
    words: list[dict],
    start: float,
    end: float,
    *,
    requested: str,
    payoff: tuple[float, float] | None,
    moment: dict | None,
    key_phrase: str,
    planner: list[str],
    cold_open: bool,
) -> dict:
    """Linear, or hook-first: a ≤3 s teaser of the payoff, then the setup, then the full payoff.

    The payoff is the planner's span (snapped to measured words) or, without one, the sentence in
    the range scoring highest on storyboard loudness/highlight plus emphasis words. Hook-first
    needs real words in the teaser and at least SETUP_MIN seconds of setup before the payoff, so
    the teaser is never immediately repeated.
    """
    result: dict = {"requested": requested, "resolved": "linear", "payoff": None, "teaser": None, "reason": None}
    if requested == "linear":
        result["reason"] = "Linear structure requested."
        return result
    if cold_open:
        result["reason"] = "A cold open already opens this clip; hook-first is not combined with it."
        return result
    if not words:
        result["reason"] = "No word timings, so a payoff teaser cannot be cut on word boundaries."
        return result
    if payoff:
        pstart, pend = payoff
        if not (start <= pstart and pend <= end + PAYOFF_ADJACENT):
            result["reason"] = "The planner's payoff span is not inside or just after the chosen range."
            return result
        inside = [w for w in words if pstart - 0.25 <= w["start"] and w["end"] <= pend + 0.25]
        if not inside:
            result["reason"] = "No measured words fall inside the planner's payoff span."
            return result
        best = {"start": inside[0]["start"], "end": inside[-1]["end"], "words": inside, "source": "planner"}
    else:
        terms = key_terms(key_phrase)
        planned = {norm(p) for item in planner for p in item.split()}
        candidates = []
        for group in sentences(words):
            if len(group) < 3 or group[0]["start"] < start + SETUP_MIN:
                continue
            middle = (group[0]["start"] + group[-1]["end"]) / 2
            level, highlight = _scene_score(middle, moment)
            previous = None
            emphasis = 0
            for word in group:
                emphasis += 1 if norm(word["text"]) in planned else bool(emphasis_rank(word["text"], previous, terms))
                previous = word["text"]
            position = (middle - start) / max(end - start, 1e-6)
            score = 0.35 * level + 0.3 * highlight + 0.25 * min(1.0, emphasis / 3) + 0.1 * position
            candidates.append({
                "start": group[0]["start"], "end": group[-1]["end"], "words": group, "source": "deterministic",
                "score": round(score, 3),
                "signals": {"loudness": round(level, 3), "highlight": round(highlight, 3), "emphasis": emphasis,
                            "position": round(position, 3)},
            })
        if not candidates:
            result["reason"] = f"No full sentence starts {SETUP_MIN:g}s or more into the range to tease."
            return result
        best = max(candidates, key=lambda c: (c["score"], -c["start"]))
    if best["start"] < start + SETUP_MIN:
        result["reason"] = f"The payoff starts within {SETUP_MIN:g}s of the clip start; a teaser would stutter."
        return result
    teaser = teaser_from(words, best["start"], best["end"])
    if not teaser:
        result["reason"] = f"The payoff has no {TEASER_MIN:g}–{TEASER_MAX:g}s run of measured words to tease."
        return result
    a, b, chosen = teaser
    result.update(
        resolved="hook_first",
        payoff={
            "start": round(best["start"], 3),
            "end": round(best["end"], 3),
            "text": " ".join(w["text"] for w in best["words"])[:400],
            "source": best["source"],
            **({"score": best["score"], "signals": best["signals"]} if "score" in best else {}),
        },
        teaser={"start": round(a, 3), "end": round(b, 3), "text": " ".join(w["text"] for w in chosen)},
        extend_end=round(best["end"] + 0.2, 3) if best["end"] > end else None,
    )
    return result


# --------------------------------------------------------------------------- ASS styling


def ass_color(hex_color: str, alpha: int = 0) -> str:
    value = hex_color.lstrip("#")
    return f"&H{alpha:02X}{value[4:6]}{value[2:4]}{value[0:2]}".upper()


ASS_HEADER = (
    "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\nScaledBorderAndShadow: yes\n"
    "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
    "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
    "MarginL, MarginR, MarginV, Encoding\n"
)
EVENTS = "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"


def ass_stamp(seconds: float) -> str:
    centiseconds = max(0, round(seconds * 100))
    return (
        f"{centiseconds // 360000}:{centiseconds // 6000 % 60:02}:{centiseconds // 100 % 60:02}.{centiseconds % 100:02}"
    )


def caption_ass(entries: list[dict], style: str, marks: set[tuple[int, int]], *, font: str, accent: str) -> str:
    """Burned captions as ASS so single words can be restyled; same verbatim text and timings."""
    if style == "pop":
        line = f"Style: Cap,{font},78,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,1,0,0,0,100,100,0,0,1,6,2,2,90,90,380,1"
    elif style == "high_contrast":
        line = f"Style: Cap,{font},60,&H00FFFFFF,&H00FFFFFF,&H80000000,&H80000000,0,0,0,0,100,100,0,0,3,3,0,2,72,72,144,1"
    else:
        line = f"Style: Cap,{font},52,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,2,72,72,144,1"
    emphasis = ass_color(accent)
    lines = [ASS_HEADER + line, EVENTS.rstrip("\n")]
    for e_index, entry in enumerate(entries):
        words = entry.get("timed") or []
        if not words:
            text = entry["text"].upper() if style == "pop" else entry["text"]
            lines.append(f"Dialogue: 0,{ass_stamp(entry['start'])},{ass_stamp(entry['end'])},Cap,,0,0,0,,{text}")
            continue

        def render(spoken: int | None, words=words, e_index=e_index) -> str:
            parts = []
            for n, word in enumerate(words):
                text = word["text"].upper() if style == "pop" else word["text"]
                marked = (e_index, n) in marks
                if n == spoken:
                    color = emphasis if marked else "&H0000E5FF&"
                    parts.append(f"{{\\c{color.rstrip('&')}&\\fscx112\\fscy112}}{text}{{\\r}}")
                elif marked:
                    scale = "" if style == "pop" else "\\fscx115\\fscy115"
                    parts.append(f"{{\\c{emphasis.rstrip('&')}&\\b1{scale}}}{text}{{\\r}}")
                else:
                    parts.append(text)
            return " ".join(parts)

        if style != "pop":
            lines.append(f"Dialogue: 0,{ass_stamp(entry['start'])},{ass_stamp(entry['end'])},Cap,,0,0,0,,{render(None)}")
            continue
        for index, word in enumerate(words):
            begin = entry["start"] if index == 0 else word["start"]
            finish = words[index + 1]["start"] if index + 1 < len(words) else entry["end"]
            if finish > begin:
                lines.append(f"Dialogue: 0,{ass_stamp(begin)},{ass_stamp(finish)},Cap,,0,0,0,,{render(index)}")
    return "\n".join(lines) + "\n"


def title_card_size(text: str) -> int:
    return 96 if len(text) <= 24 else 84 if len(text) <= 48 else 72 if len(text) <= 90 else 60


def overlay_ass(
    *,
    hook: str,
    hook_format: str,
    hook_seconds: float,
    font: str,
    primary: str,
    accent: str,
    flash_at: float | None,
    end_card: tuple[float, float, str] | None,
) -> str:
    """Hook (plain strip or title card), teaser flash and CTA end card in one ASS script.

    The title card sits in the upper-middle of the 9:16 safe area (clear of the top bar and the
    bottom caption/UI band), on a brand-coloured box, and pops in over 160 ms.
    """
    box = ass_color(primary)
    styles = [
        f"Style: Hook,{font},54,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,3,3,0,8,80,80,140,1",
        f"Style: Card,{font},{title_card_size(hook)},&H00FFFFFF,&H00FFFFFF,{box},{box},1,0,0,0,100,100,0,0,3,26,0,5,90,90,0,1",
        f"Style: Flash,{font},10,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
        f"Style: Dim,{font},10,&H60000000,&H60000000,&H60000000,&H60000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
        f"Style: Cta,{font},76,&H00FFFFFF,&H00FFFFFF,{ass_color(accent)},{ass_color(accent)},1,0,0,0,100,100,0,0,3,24,0,5,90,90,0,1",
    ]
    events = []
    if hook:
        if hook_format == "title_card":
            events.append(
                f"Dialogue: 2,0:00:00.00,{ass_stamp(hook_seconds)},Card,,0,0,0,,"
                f"{{\\an5\\pos(540,700)\\fad(0,180)\\fscx88\\fscy88\\t(0,160,\\fscx100\\fscy100)}}{hook}"
            )
        else:
            events.append(f"Dialogue: 1,0:00:00.00,{ass_stamp(hook_seconds)},Hook,,0,0,0,,{hook}")
    if flash_at is not None:
        events.append(
            f"Dialogue: 3,{ass_stamp(flash_at)},{ass_stamp(flash_at + FLASH_SECONDS)},Flash,,0,0,0,,"
            f"{{\\an7\\pos(0,0)\\fad(0,{int(FLASH_SECONDS * 1000) - 20})\\p1}}m 0 0 l 1080 0 1080 1920 0 1920{{\\p0}}"
        )
    if end_card:
        begin, finish, text = end_card
        events.append(
            f"Dialogue: 4,{ass_stamp(begin)},{ass_stamp(finish)},Dim,,0,0,0,,"
            "{\\an7\\pos(0,0)\\fad(200,0)\\p1}m 0 0 l 1080 0 1080 1920 0 1920{\\p0}"
        )
        events.append(
            f"Dialogue: 5,{ass_stamp(begin)},{ass_stamp(finish)},Cta,,0,0,0,,"
            f"{{\\an5\\pos(540,1000)\\fad(200,0)\\fscx90\\fscy90\\t(0,200,\\fscx100\\fscy100)}}{text}"
        )
    return ASS_HEADER + "\n".join(styles) + "\n" + EVENTS + "".join(e + "\n" for e in events)


def hook_grounding(hook: str, transcript_text: str) -> dict:
    """How much of the on-screen hook the source supports, recorded next to the critic's verdict.

    Numbers in a hook that the source never says are the riskiest overclaim, so they are listed.
    """
    said = {norm(t) for t in transcript_text.split()}
    tokens = [norm(t) for t in hook.split() if norm(t) and norm(t) not in STOPWORDS]
    numbers = [t for t in tokens if re.search(r"\d", t)]
    return {
        "content_words": len(tokens),
        "found_in_source": sum(t in said for t in tokens),
        "unsupported_numbers": [n for n in numbers if n not in said],
    }


# --------------------------------------------------------------------------- brand assets


def checked_file(path: str | None, kind: str) -> Path | None:
    """A brand asset that exists, is small and has the right magic bytes; None when unset."""
    if not path:
        return None
    file = Path(path)
    limits = {"font": 20 * 1024 * 1024, "logo": 5 * 1024 * 1024}
    try:
        size = file.stat().st_size
        with file.open("rb") as handle:
            head = handle.read(8)
    except OSError:
        raise ValueError(f"The brand {kind} file could not be read: {file.name}") from None
    if not 0 < size <= limits[kind]:
        raise ValueError(f"The brand {kind} file is empty or too large.")
    if kind == "logo" and head != b"\x89PNG\r\n\x1a\n":
        raise ValueError("The brand logo is not a PNG file.")
    if kind == "font" and head[:4] not in {b"\x00\x01\x00\x00", b"OTTO", b"true"}:
        raise ValueError("The brand font is not a TrueType/OpenType file.")
    return file
