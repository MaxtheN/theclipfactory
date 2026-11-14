from clip_factory import moments


def talk(sentences, *, start=0.0, rate=0.4, pause=0.3):
    """Measured words for a list of sentences: one word every `rate` seconds, `pause` between sentences."""
    words, at = [], start
    for sentence in sentences:
        for token in sentence.split():
            words.append({"text": token, "start": round(at, 3), "end": round(at + rate - 0.05, 3)})
            at += rate
        at += pause
    return words


# Twelve 10-word sentences of ~4.3 s each.
LINES = [f"Sentence {n} has exactly ten words in it right here." for n in range(12)]
WORDS = talk(LINES)
UNITS = moments.sentence_units(WORDS)


def test_units_are_whole_sentences():
    assert len(UNITS) == 12 and UNITS[3]["text"] == LINES[3]


def test_band_is_target_plus_minus_a_quarter_capped_by_the_brief():
    assert moments.band(30) == (30.0, 22.5, 37.5)
    assert moments.band(30, 25) == (25.0, 18.75, 25.0)


def test_a_short_proposal_grows_by_whole_sentences_to_the_target():
    # The scout proposed 10 s starting mid-sentence; the clip starts on that sentence and grows.
    start, end, record = moments.shape_range(
        UNITS[2]["start"] + 1.0, UNITS[4]["end"] - 1.0, WORDS, target=30, low=22.5, high=37.5
    )
    assert start == round(UNITS[2]["start"] - 0.12, 3)
    assert any(abs(end - (u["end"] + 0.2)) < 0.31 for u in UNITS)  # ends just after a sentence
    assert 22.5 <= record["estimated_seconds"] <= 37.5
    assert record["extended_sentences"] >= 3 and record["ends_on_sentence"]


def test_never_cuts_mid_sentence_even_when_the_proposal_does():
    start, end, _ = moments.shape_range(
        UNITS[5]["start"] + 2.0, UNITS[10]["start"] + 2.0, WORDS, target=30, low=22.5, high=37.5
    )
    starts = [round(u["start"] - 0.12, 3) for u in UNITS]
    ends = [u["end"] for u in UNITS]
    assert start in starts
    assert any(0 <= end - e <= 0.21 for e in ends)


def test_too_long_drops_sentences_but_keeps_the_payoff_and_its_setup():
    payoff = (UNITS[9]["start"], UNITS[9]["end"])
    start, end, record = moments.shape_range(
        UNITS[0]["start"], UNITS[11]["end"], WORDS, target=30, low=22.5, high=37.5, payoff=payoff
    )
    assert record["estimated_seconds"] <= 37.5
    assert start <= payoff[0] - 4.0 and end >= payoff[1]


def test_extension_prefers_setup_before_a_payoff_that_ends_the_clip():
    payoff = (UNITS[8]["start"], UNITS[8]["end"])
    start, end, record = moments.shape_range(
        UNITS[7]["start"], UNITS[8]["end"], WORDS, target=30, low=22.5, high=37.5, payoff=payoff
    )
    assert record["ends_on_payoff"] and end <= UNITS[8]["end"] + 0.21
    assert start < UNITS[7]["start"]


def test_a_complete_short_moment_stays_short_with_the_reason_recorded():
    _, _, record = moments.shape_range(
        UNITS[3]["start"], UNITS[5]["end"], WORDS, target=30, low=22.5, high=37.5,
        keep_short="One-line joke, complete",
    )
    assert record["extended_sentences"] == 0 and record["estimated_seconds"] < 22.5
    assert record["note"].startswith("Kept short by the scout: One-line joke")


def test_the_source_running_out_is_recorded_not_hidden():
    few = talk(LINES[:3])
    _, _, record = moments.shape_range(0.0, 3.0, few, target=30, low=22.5, high=37.5)
    assert record["estimated_seconds"] < 22.5 and "no more of this thought" in record["note"]


def test_the_scouts_quote_is_found_in_the_words_despite_asr_slips():
    words = talk(["It's not the type of IP that you're going to convey over pillow talk."], start=100)
    found = moments.locate_quote("it is not the type of IP you're going to convey over pillow talk", words)
    assert found and found[-1]["text"] == "talk."
    assert moments.locate_quote("chips are made of potatoes in Idaho", words) is None


def test_the_teaser_is_the_end_of_the_line_where_it_lands():
    words = talk(["It's not the type of IP that you're going to convey, over pillow talk."], start=100)
    a, b = moments.punch_span(words)
    assert b == words[-1]["end"] and b - a <= moments.PUNCH_SECONDS
    assert "pillow" in " ".join(w["text"] for w in words if a <= w["start"] < b)
    # When the point sits early in the line, the teaser is the words that carry it, not the tail.
    words = talk(["There's kind of two paths for the future, I would argue."], start=50)
    a, b = moments.punch_span(words)
    picked = " ".join(w["text"] for w in words if a <= w["start"] < b)
    assert "two paths" in picked and not picked.endswith("argue.")
    short = talk(["Useful idiot."])
    assert moments.punch_span(short) == (short[0]["start"], short[-1]["end"])


def test_hooks_are_short_faithful_and_about_what_is_said():
    speech = "He said she might be a useful idiot, not a spy."
    assert moments.tidy_hook("She might be a useful idiot", "He said she might be a useful idiot.", speech) == (
        "She might be a useful idiot", "scout")
    # Too long, a description of the picture, or not grounded in the speech: cut from the quote instead.
    for bad in ("A man in a suit sitting at a desk talks", "This is the most shocking spy story of the entire year",
                "Elon reveals secret Mars base"):
        hook, source = moments.tidy_hook(bad, "He said she might be a useful idiot.", speech)
        assert source == "payoff_quote" and len(hook.split()) <= moments.HOOK_WORDS
    long = moments.hook_from_quote("It's not the type of IP that you're going to convey over pillow talk.")
    assert len(long.split()) <= 8 and long.endswith("pillow talk") and not long.lower().startswith("that")
    assert moments.tidy_hook("🔥 Who pulled the pin? #ai", "", "Who pulled the pin on this grenade?") == (
        "Who pulled the pin?", "scout")


def test_a_talk_is_scouted_in_stretches_of_whole_minutes_not_camera_cuts():
    from clip_factory.team import TeamEngine

    scenes = [{"index": i, "start": 12.5 * i, "end": 12.5 * (i + 1), "score": 0.1 * (i % 5), "usable": i != 9}
              for i in range(16)]
    stretches = TeamEngine.swarm_stretches({"scenes": scenes}, 60.0)["scenes"]
    # 12.5 s camera cuts become ~60 s stretches; an unusable scene breaks a stretch; a short tail joins.
    assert [(s["start"], s["end"]) for s in stretches] == [(0.0, 62.5), (62.5, 112.5), (125.0, 200.0)]
    assert stretches[0]["scene_indexes"] == [0, 1, 2, 3, 4] and stretches[0]["score"] == 0.4


def test_a_hook_a_word_over_loses_articles_and_a_sharp_paraphrase_passes():
    speech = "You cannot reverse engineer the design of a chip by getting a hold of the wafer."
    assert moments.tidy_hook("You can't reverse engineer a chip from a wafer", "", speech) == (
        "You can't reverse engineer chip from wafer", "scout")
    # Invented framing ("gossip", "chose") is not what was said: the quote is used instead.
    _, source = moments.tidy_hook("Leakers chose jail time, not gossip", "willing to risk going to jail.",
                                     "They're willing to risk going to jail.")
    assert source == "payoff_quote"


def test_a_quote_cut_short_by_asr_is_finished_to_its_sentence_end():
    words = talk(["They could be very, very low-level.", "Next thought here."])
    found = moments.locate_quote("They could be very, very", words)
    assert found[-1]["text"] == "low-level."
