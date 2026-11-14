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
