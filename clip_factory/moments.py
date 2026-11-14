"""Shape a proposed moment into a postable clip from measured words.

The swarm's scouts propose a range, a verbatim payoff line and a hook. This module turns that
into something an editor would post:

* ``shape_range`` sizes the range to the approved target duration (±25%) on whole sentences,
  extending across neighbouring scenes to complete the thought and never cutting mid-sentence.
  The length that counts is what the viewer sees: the range after jump cuts plus the teaser.
* ``locate_quote`` finds the scout's payoff line in the measured words (it must really be said).
* ``punch_span`` narrows that line to the teaser-sized punch at its end (punchlines land last).
* ``tidy_hook`` keeps on-screen hooks short (≤8 words), source-faithful and about what is said.

Everything here is pure and deterministic; nothing calls a model.
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher

from . import craft

BAND = 0.25                 # target ± this share is the acceptable finished length
SHORT_FLOOR = 10.0          # a "complete and strong" short moment still needs this much
TEASER_ESTIMATE = 2.5       # seconds a hook-first teaser usually adds
MAX_SENTENCE_GAP = 4.0      # a longer silence between sentences is a different thought
MAX_UNIT_SECONDS = 20.0     # an unpunctuated run is split at pauses beyond this
HOOK_WORDS = 8
QUOTE_MATCH = 0.72          # share of the quote's words that must be found, in order
# The renderer re-reads the teaser with a 0.25 s word tolerance and keeps ≤ TEASER_MAX - 0.15 s, so a
# span this long survives intact (a neighbouring word cannot push its last word out).
PUNCH_SECONDS = craft.TEASER_MAX - 0.5
# Filler and hedges carry no point, so they never win a teaser on their own.
HEDGES = {"would", "argue", "think", "mean", "like", "just", "kind", "sort", "guess", "know", "yeah", "okay",
          "right", "well", "going", "gonna", "said", "say", "says", "very", "there's", "it's", "i'm"}
HOOK_GROUNDING = 0.4         # share of a hook's content words the clip must say (a sharp paraphrase passes)
WEAK_OPENERS = {"and", "but", "so", "that", "which", "because", "or", "then", "of", "to", "the", "a"}
VISUAL_HOOK = re.compile(
    r"\b(sitting|seated|wearing|smil(?:es|ing)|gestur\w*|on screen|on-screen|camera|footage|studio|"
    r"microphones?|headphones|in a suit|shirt|background|frame|scene|shown|looks at|nods?|nodding)\b",
    re.IGNORECASE,
)


def band(target: float, limit: float | None = None) -> tuple[float, float, float]:
    """(target, low, high) for a finished clip; a brief's max duration caps all three."""
    target = float(target)
    if limit:
        target = min(target, float(limit))
    high = target * (1 + BAND)
    if limit:
        high = min(high, float(limit))
    return target, target * (1 - BAND), max(high, target)


def sentence_units(words: list[dict]) -> list[dict]:
    """Whole sentences from measured words: a unit ends on . ? ! or before a long pause."""
    units: list[dict] = []
    current: list[dict] = []
    for word in words:
        if current and word["start"] - current[-1]["end"] > MAX_SENTENCE_GAP:
            units.append(current)
            current = []
        current.append(word)
        if str(word["text"]).rstrip().endswith((".", "?", "!")):
            units.append(current)
            current = []
    if current:
        units.append(current)
    units = [piece for unit in units for piece in _split(unit)]
    return [
        {"start": u[0]["start"], "end": u[-1]["end"], "words": u, "text": " ".join(str(w["text"]).strip() for w in u)}
        for u in units
    ]


def _split(unit: list[dict]) -> list[list[dict]]:
    """An unpunctuated run longer than MAX_UNIT_SECONDS is split at its clearest pause or comma."""
    if len(unit) < 2 or unit[-1]["end"] - unit[0]["start"] <= MAX_UNIT_SECONDS:
        return [unit]
    def weight(i: int) -> float:
        gap = unit[i + 1]["start"] - unit[i]["end"]
        return gap + (0.3 if str(unit[i]["text"]).rstrip().endswith((",", ";", ":")) else 0.0)
    cut = max(range(len(unit) - 1), key=weight) + 1
    return _split(unit[:cut]) + _split(unit[cut:])


def kept_seconds(words: list[dict], start: float, end: float, jump_cuts: str = "silences") -> float:
    """How long [start, end) plays after the renderer's own jump cuts."""
    inside = [w for w in words if start <= (w["start"] + w["end"]) / 2 < end]
    plan = craft.plan_jump_cuts(inside, start, end, jump_cuts)
    return max(0.0, (end - start) - float(plan.get("removed_seconds") or 0.0))


def shape_range(
    start: float,
    end: float,
    words: list[dict],
    *,
    target: float,
    low: float,
    high: float,
    payoff: tuple[float, float] | None = None,
    keep_short: str = "",
    jump_cuts: str = "silences",
) -> tuple[float, float, dict] | None:
    """Fit a proposal to whole sentences and the target length. None when there are no words.

    ``words`` are the measured words the clip may draw on (the stretch plus a target's worth of
    context on each side). The range only ever grows or shrinks by whole sentences. With a payoff,
    the clip keeps it and at least craft.SETUP_MIN seconds of setup before it, and prefers to end on
    it. A clip stays shorter than ``low`` only when the scout said why it is complete (``keep_short``)
    or the source has no more of the thought to give; the reason is recorded.
    """
    units = sentence_units(sorted(words, key=lambda w: w["start"]))
    if not units:
        return None
    # Never begin or end inside a sentence: widen to the sentences the proposal touches.
    first = next((i for i, u in enumerate(units) if u["end"] > start), len(units) - 1)
    last = max((i for i, u in enumerate(units) if u["start"] < end), default=first)
    last = max(last, first)
    pay_first = pay_last = None
    if payoff:
        pay_first = next((i for i, u in enumerate(units) if u["end"] > payoff[0]), None)
        pay_last = max((i for i, u in enumerate(units) if u["start"] < payoff[1]), default=None)
        if pay_first is None or pay_last is None:
            payoff = None
        else:
            first, last = min(first, pay_first), max(last, pay_last)
            # Room for a setup before the payoff, so the teaser is not repeated straight away.
            while first > 0 and payoff[0] - units[first]["start"] < craft.SETUP_MIN:
                first -= 1
    teaser = TEASER_ESTIMATE if payoff else 0.0

    def length(a: int, b: int) -> float:
        return kept_seconds(words, units[a]["start"], units[b]["end"], jump_cuts) + teaser

    def joined(a: int, b: int) -> bool:
        return 0 <= a and b < len(units) and units[b]["start"] - units[a]["end"] <= MAX_SENTENCE_GAP

    note = None
    extended = 0
    measured = length(first, last)
    if keep_short.strip() and measured >= SHORT_FLOOR:
        note = f"Kept short by the scout: {keep_short.strip()[:160]}"
    else:
        while measured < target * 0.95:
            ends_on_payoff = payoff is not None and last == pay_last
            forward = (first, last + 1) if joined(last, last + 1) else None
            backward = (first - 1, last) if joined(first - 1, first) else None
            options = [backward, forward] if ends_on_payoff else [forward, backward]
            grown = None
            for option in options:
                if option and length(*option) <= high:
                    grown = option
                    break
            if grown is None:
                break
            first, last = grown
            measured = length(first, last)
            extended += 1
    # Too long: drop whole sentences, never the payoff or its setup.
    while measured > high and last > first:
        if payoff is None or (first + 1 < len(units) and payoff[0] - units[first + 1]["start"] >= craft.SETUP_MIN):
            first += 1
        elif last > pay_last:
            last -= 1
        else:
            break
        measured = length(first, last)
    if measured < low and note is None:
        note = "Source has no more of this thought within reach; kept shorter than the target."
    a = units[first]["start"] - 0.12
    if first > 0:
        a = max(a, units[first - 1]["end"])
    b = units[last]["end"] + 0.2
    if last + 1 < len(units):
        b = min(b, units[last + 1]["start"])
    record = {
        "target": round(target, 1),
        "band": [round(low, 1), round(high, 1)],
        "estimated_seconds": round(measured, 1),
        "sentences": last - first + 1,
        "extended_sentences": extended,
        "ends_on_sentence": True,
        "ends_on_payoff": payoff is not None and last == pay_last,
        "note": note,
    }
    return round(max(0.0, a), 3), round(b, 3), record


def _tokens(text: str) -> list[str]:
    return [t for t in (craft.norm(x) for x in str(text).split()) if t]


def locate_quote(quote: str, words: list[dict]) -> list[dict] | None:
    """The measured words that say ``quote`` (in order, tolerant of ASR slips), or None."""
    wanted = _tokens(quote)
    if len(wanted) < 2 or not words:
        return None
    said = [craft.norm(w["text"]) for w in words]
    best, best_score = None, 0.0
    size = len(wanted)
    for width in dict.fromkeys((size, max(2, size - 2), size + 2)):  # ties keep the exact width
        width = min(width, len(said))
        for index in range(len(said) - width + 1):
            window = said[index : index + width]
            matcher = SequenceMatcher(None, window, wanted, autojunk=False)
            found = sum(block.size for block in matcher.get_matching_blocks())
            score = found / size
            if score > best_score + 1e-9:
                best, best_score = (index, index + width), score
    if best is None or best_score < QUOTE_MATCH:
        return None
    a, b = best
    # Trim unmatched words at the edges of the window.
    while a < b and said[a] not in wanted:
        a += 1
    while b > a and said[b - 1] not in wanted:
        b -= 1
    if b > a and not str(words[b - 1]["text"]).rstrip().endswith((".", "?", "!")):
        # ASR split or dropped the quote's last words: finish the sentence it was quoting.
        for extra in range(b, min(len(words), b + 4)):
            if words[extra]["start"] - words[extra - 1]["end"] > 1.0:
                break
            if str(words[extra]["text"]).rstrip().endswith((".", "?", "!")):
                b = extra + 1
                break
    return words[a:b] or None


def punch_span(quote_words: list[dict]) -> tuple[float, float]:
    """A teaser-sized span of the payoff line: the run of words that carries the point.

    Short lines are used whole. In a longer line every run of words that fits the teaser is scored
    on its content words, with credit for ending where the line (or a clause) ends and for starting
    at a clause break; ties go to the later run, since a punchline usually lands last.
    """
    if quote_words[-1]["end"] - quote_words[0]["start"] <= PUNCH_SECONDS:
        return quote_words[0]["start"], quote_words[-1]["end"]
    breaks = (",", ";", ":", "—", "-", ".", "?", "!")
    best, best_score = None, None
    for i in range(len(quote_words)):
        for j in range(i, len(quote_words)):
            span = quote_words[j]["end"] - quote_words[i]["start"]
            if span > PUNCH_SECONDS:
                break
            if span < craft.TEASER_MIN:
                continue
            tokens = [craft.norm(w["text"]) for w in quote_words[i : j + 1]]
            content = sum(1 for t in tokens if t and t not in craft.STOPWORDS and t not in WEAK_OPENERS and t not in HEDGES)
            ends = j == len(quote_words) - 1 or str(quote_words[j]["text"]).rstrip().endswith(breaks)
            starts = i == 0 or str(quote_words[i - 1]["text"]).rstrip().endswith(breaks)
            # Ending on a break matters most: a teaser that stops mid-clause sounds cut off.
            score = content + (3.0 if ends else -1.0) + (0.75 if starts else 0.0) + 0.01 * i
            if best_score is None or score > best_score:
                best, best_score = (i, j), score
    if best is None:
        return quote_words[0]["start"], quote_words[-1]["end"]
    i, j = best
    return quote_words[i]["start"], quote_words[j]["end"]


def _clean_hook(text: str) -> str:
    text = re.sub(r"#\w+", " ", str(text))
    text = re.sub(r"[^\w\s'’?!.,:%$&-]", " ", text)  # emoji, quotes, symbols
    return " ".join(text.split()).strip(" .,:;-")


def hook_from_quote(quote: str) -> str:
    """A ≤8-word hook cut from the payoff line itself: its most pointed short clause, else its last words."""
    quote = _clean_hook(quote)
    clauses = [c.strip() for c in re.split(r"[,;:—]|(?<=[.?!])\s|\s-\s", quote) if c.strip()]
    def content(text: str) -> int:
        return sum(1 for t in _tokens(text) if t not in craft.STOPWORDS and t not in WEAK_OPENERS and t not in HEDGES)

    fitting = [(content(c), i, c) for i, c in enumerate(clauses) if 3 <= len(c.split()) <= HOOK_WORDS]
    if fitting and max(fitting)[0] > 0:
        clause = max(fitting)[2]  # the clause carrying the most point; later wins ties
        return clause[0].upper() + clause[1:]
    words = quote.split()
    if len(words) > HOOK_WORDS:
        # The punch is at the end of a line: keep its last words, without a dangling connector.
        words = words[-HOOK_WORDS:]
        while len(words) > 3 and craft.norm(words[0]) in WEAK_OPENERS:
            words = words[1:]
    text = " ".join(words)
    return text[:1].upper() + text[1:]


def _stem(token: str) -> str:
    return token[:4]


def grounded_share(hook: str, speech: str) -> float:
    """Share of the hook's content words the speech says (same stem: chip/chips, pull/pulled)."""
    said = {_stem(t) for t in _tokens(speech)}
    content = [t for t in _tokens(hook) if t not in craft.STOPWORDS and len(t) > 2]
    if not content:
        return 1.0
    return sum(_stem(t) in said for t in content) / len(content)


def tidy_hook(hook: str, quote: str, speech: str) -> tuple[str, str]:
    """(hook, source): the scout's hook when short, faithful and about what is said, else one cut
    from the payoff quote. Source is "scout", "payoff_quote" or "scout_unchecked" (no quote)."""
    cleaned = _clean_hook(hook)
    words = cleaned.split()
    if len(words) > HOOK_WORDS:
        # A scout hook a word or two over: articles go first, never meaning words.
        trimmed = [w for w in words if craft.norm(w) not in {"a", "an", "the"}]
        if len(trimmed) <= HOOK_WORDS:
            cleaned, words = " ".join(trimmed), trimmed
    grounding = craft.hook_grounding(cleaned, speech)
    good = (
        0 < len(words) <= HOOK_WORDS
        and grounded_share(cleaned, speech) >= HOOK_GROUNDING
        and not grounding["unsupported_numbers"]
        and not VISUAL_HOOK.search(cleaned)
    )
    if good:
        return cleaned, "scout"
    if quote.strip():
        return hook_from_quote(quote), "payoff_quote"
    if words:
        return " ".join(words[:HOOK_WORDS]), "scout_unchecked"
    return "", "none"
