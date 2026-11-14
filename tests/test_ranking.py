import random

from clip_factory import ranking
from clip_factory.campaigns import AgentProduction

BOARD = {
    "scenes": [
        {"index": 0, "start": 0.0, "end": 60.0, "score": 0.9},
        {"index": 1, "start": 60.0, "end": 120.0, "score": 0.5},
        {"index": 2, "start": 120.0, "end": 180.0, "score": 0.05},
    ]
}
BRIEF = {"key_messages": ["Sleep beats supplements"], "must_include": ["Morning light"]}


def clip(identifier, start, end, scene, **extra):
    return {
        "id": identifier,
        "start": start,
        "end": end,
        "hook": "A short specific hook",
        "scene_refs": [f"scene:{scene}"],
        "subtitles_burned": True,
        "technical_checks": {"playback_format_passed": True},
        "team_review_status": "not_applicable",
        **extra,
    }


def sample():
    return [
        clip("a", 5, 35, 0, brief_serves=["M1"]),
        clip("b", 10, 38, 0, brief_serves=["none"]),  # overlaps a by more than half
        clip("c", 62, 90, 1, brief_serves=["T1"],
             craft={"structure": {"payoff": {"text": "Light in the morning resets you."}}}),
        clip("d", 130, 160, 2, brief_serves=["none"]),  # weak scene, serves nothing: under the floor
        # No overlap with c, but the same payoff sentence: one clip, whatever the range.
        clip("e", 92, 118, 1, brief_serves=["none"],
             craft={"structure": {"payoff": {"text": "light in the MORNING resets you"}}}),
    ]


def test_default_production_strategy_is_swarm_and_team_stays_selectable():
    base = {"video_id": "v1", "profile_id": "p1"}
    assert AgentProduction(**base).strategy == "swarm"
    assert AgentProduction(**base, strategy="team").strategy == "team"


def test_ranking_is_best_first_and_deterministic_whatever_the_input_order():
    first = ranking.rank(sample(), board=BOARD, brief=BRIEF, top_picks=2)
    for seed in range(5):
        shuffled = sample()
        random.Random(seed).shuffle(shuffled)
        assert ranking.rank(shuffled, board=BOARD, brief=BRIEF, top_picks=2) == first
    above = sorted((r["position"], key) for key, r in first.items() if not r["below_bar"])
    assert [key for _, key in above] == ["a", "c"]
    scores = [first[key]["score"] for _, key in above]
    assert scores == sorted(scores, reverse=True)
    assert first["a"]["why"] == "Says: Sleep beats supplements"
    assert first["c"]["why"] == "Says: Morning light"


def test_near_duplicates_merge_into_the_best_and_the_floor_hides_without_deleting():
    clips = sample()
    records = ranking.rank(clips, board=BOARD, brief=BRIEF)
    # Every clip still has a record: nothing is removed, only marked.
    assert set(records) == {c["id"] for c in clips}
    assert records["b"]["duplicate_of"] == "a" and records["b"]["below_bar"]
    assert records["b"]["reason"] == "Similar to a better clip"
    # Same payoff sentence, different range: the better one is kept.
    assert records["e"]["duplicate_of"] == "c"
    assert records["d"]["below_bar"] and records["d"]["duplicate_of"] is None
    assert records["d"]["score"] < ranking.FLOOR and records["d"]["reason"] == f"Score under {ranking.FLOOR}"
    assert all(r["position"] is None and not r["top_pick"] for r in records.values() if r["below_bar"])
    totals = ranking.summary(records)
    assert (totals["ranked"], totals["above_bar"], totals["below_bar"], totals["duplicates"]) == (5, 2, 3, 2)


def test_clip_count_is_a_soft_target_for_top_picks_not_a_cap():
    many = [clip(f"c{i}", i * 60.0, i * 60.0 + 30, 0, brief_serves=["M1"]) for i in range(12)]
    board = {"scenes": [{"index": 0, "start": 0.0, "end": 1000.0, "score": 0.8}]}
    records = ranking.rank(many, board=board, brief=BRIEF, top_picks=3)
    above = [r for r in records.values() if not r["below_bar"]]
    assert len(above) == 12  # every good clip stays in the review list
    assert sum(r["top_pick"] for r in above) == 3
    assert ranking.summary(records, 3)["review_target"] == 3
    # Without a target the default number of top picks is marked.
    default = ranking.rank(many, board=board, brief=BRIEF)
    assert sum(r["top_pick"] for r in default.values()) == ranking.DEFAULT_TOP_PICKS


def test_score_uses_critic_findings_and_a_cached_quality_rubric_when_available():
    good = clip("g", 0, 30, 0, brief_serves=["M1"])
    failed = {**good, "id": "h", "team_review_status": "fail",
              "team_findings": [{"severity": "error", "message": "Claim not supported"}]}
    assert ranking.score(failed, BOARD, BRIEF)[0] < ranking.score(good, BOARD, BRIEF)[0]
    weak_file = ranking.score(good, BOARD, BRIEF, {"rubric": {"technical": 1}})
    assert weak_file[1]["technical"] == 0.2 and weak_file[0] < ranking.score(good, BOARD, BRIEF)[0]
    # No brief at all: serving nothing is neutral, not a penalty.
    assert ranking.score({**good, "brief_serves": []}, BOARD, None)[1]["brief"] == 0.5


def swarm_clip(identifier, start, end, **swarm):
    record = {"payoff_verified": True, "spoken": True, "speech_source": True, "strength": 8,
              "duration": {"band": [22.5, 37.5], "ends_on_sentence": True, "note": None}, **swarm}
    return clip(identifier, start, end, 0, brief_serves=["M1"], duration=end - start, swarm=record,
                craft={"structure": {"resolved": "hook_first"}})


def test_a_speech_source_clip_without_captions_is_below_the_bar_whatever_its_score():
    good = swarm_clip("good", 0, 30)
    bare = {**swarm_clip("bare", 100, 130), "subtitles_burned": False}
    records = ranking.rank([good, bare], board=BOARD, brief=BRIEF, speech_source=True)
    assert records["bare"]["score"] >= ranking.FLOOR  # a strong moment...
    assert records["bare"]["below_bar"] and records["bare"]["reason"] == ranking.NO_CAPTIONS_REASON
    assert not records["good"]["below_bar"]
    # Footage without speech is not held to the caption rule.
    assert not ranking.rank([bare], board=BOARD, brief=BRIEF)["bare"]["below_bar"]


def test_speechless_clips_from_a_talk_lose_most_of_their_score_and_the_bar():
    silent = swarm_clip("silent", 0, 30, spoken=False, payoff_verified=False)
    value, _ = ranking.score(silent, BOARD, BRIEF, speech_source=True)
    assert value < 0.5 * ranking.score(swarm_clip("s", 0, 30), BOARD, BRIEF, speech_source=True)[0]
    record = ranking.rank([silent], board=BOARD, brief=BRIEF, speech_source=True)["silent"]
    assert record["below_bar"] and record["reason"] == ranking.NO_SPEECH_REASON


def test_strength_payoff_and_completeness_order_the_clips():
    best = swarm_clip("best", 0, 30)
    weak = swarm_clip("weak", 200, 230, strength=4)
    no_payoff = swarm_clip("nopay", 300, 330, payoff_verified=False)
    clipped = swarm_clip("short", 400, 412)  # 12 s against a 22.5-37.5 s band, no reason given
    excused = swarm_clip("excused", 500, 512,
                         duration={"band": [22.5, 37.5], "ends_on_sentence": True, "note": "Kept short by the scout: x"})
    scores = {c["id"]: ranking.score(c, BOARD, BRIEF, speech_source=True)[0]
              for c in (best, weak, no_payoff, clipped, excused)}
    assert scores["best"] > scores["excused"] > scores["short"]
    assert scores["best"] > scores["weak"] and scores["best"] > scores["nopay"]
    assert ranking.score(no_payoff, BOARD, BRIEF, speech_source=True)[1]["payoff"] == 0.0
    # The scout's reason is the review line when no brief message is named.
    assert ranking.why({**best, "brief_serves": [], "swarm": {"why": "Sharp reversal"}}, BRIEF) == "Sharp reversal"


def test_hooks_over_eight_words_score_lower():
    short = ranking.hook_signal({"hook": "Who pulled the pin?"})
    long = ranking.hook_signal({"hook": "This is the story of who pulled the pin on it all"})
    assert short == 1.0 and long < short


def test_caption_timing_failure_holds_a_strong_clip_despite_playback_and_cached_rubric():
    good = swarm_clip("good", 0, 30)
    good["technical_checks"]["captions"] = [{"id": "timing", "status": "pass"}]
    broken = {**swarm_clip("broken", 100, 130), "technical_checks": {
        "playback_format_passed": True,
        "captions": [{"id": "timing", "status": "fail", "detail": "2 overlapping cues"}],
    }}
    cached = {"broken": {"rubric": {"technical": 5}}}
    records = ranking.rank([good, broken], board=BOARD, brief=BRIEF, reports=cached, speech_source=True)
    assert not records["good"]["below_bar"] and records["good"]["signals"]["technical"] == 1
    assert records["broken"]["signals"]["technical"] == 0
    assert records["broken"]["score"] >= ranking.FLOOR  # Good content cannot erase a render defect.
    assert records["broken"]["below_bar"] and not records["broken"]["top_pick"]
    assert records["broken"]["position"] is None
    assert records["broken"]["reason"] == ranking.CAPTION_CHECK_REASON


def test_unmeasured_caption_timing_is_not_a_technical_pass_and_warning_lowers_proxy():
    legacy = swarm_clip("legacy", 0, 30)
    assert 0 < ranking.technical_signal(legacy, {"rubric": {"technical": 5}}) < 1
    warned = {**legacy, "technical_checks": {"playback_format_passed": True, "captions": [
        {"id": "timing", "status": "pass"}, {"id": "display_time", "status": "warn"}]}}
    assert ranking.technical_signal(warned, None) < ranking.technical_signal(legacy, None)
    assert ranking.technical_signal({"subtitles_burned": True}, None) < 1
    assert ranking.bar_reason(legacy, True) is None  # Legacy unknown is not fabricated failure.
