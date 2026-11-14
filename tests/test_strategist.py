"""Strategist: deterministic math, tagging, portfolio, model contract, cadence and proposal-only effects."""
import json
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException

from clip_factory.campaigns import Campaigns
from clip_factory.jobs import WorkError
from clip_factory.store import Store
from clip_factory.strategist import (
    GUIDANCE_CLOSE,
    GUIDANCE_OPEN,
    MemoryStore,
    Strategist,
    account_baseline,
    beta_confidence,
    evaluate_belief,
    measured_posts,
    merge_guidance,
    plan_portfolio,
    rule_changes,
    selection_guidance,
    simulate,
    tag_clip,
    validate_hypotheses,
)

T0 = datetime(2026, 11, 1, tzinfo=UTC)
DIRECTION = {"angles": [], "moment_selection": "Complete thoughts.", "hooks": [], "pacing": "Source pacing.",
             "duration_seconds": 30, "framing": "fit", "caption_style": "standard", "editing_preferences": "Readable.",
             "measurement_questions": [], "next_experiments": [], "evidence_refs": [], "limitations": "Untested.",
             "confidence": "low"}


class Clock:
    def __init__(self):
        self.now = T0 + timedelta(days=30)

    def __call__(self):
        return self.now


def seed_world(store, *, campaign_archived=False):
    store.put("profiles", {"id": "p", "name": "Profile", "primary_metric": "views"})
    store.put("strategy_versions", {"id": "v1", "campaign_id": "c", "version": 1, "status": "approved",
                                    "directions": {"p": dict(DIRECTION)}, "base_version_id": None})
    store.put("campaigns", {"id": "c", "name": "C", "profile_ids": ["p"], "video_ids": [], "brief": {},
                            "active_strategy_id": "v1", "archived_at": "2026-11-02T00:00:00+00:00" if campaign_archived else None})
    store.put("learning_policies", {"id": "pol", "profile_id": "p", "campaign_id": "c", "account_id": "a", "enabled": True})


def add_post(store, n, *, hook="Would you?", hypothesis="story", seconds=30, views=100, hour=19, collected=None,
             snapshots=None):
    clip = {"id": f"clip{n}", "hook": hook, "hypothesis": hypothesis,
            "edit_plan": {"start": 0, "end": seconds, "hook": hook, "opening_treatment": "text_overlay",
                          "caption_style": "standard", "framing": "fit"}}
    published = (T0 + timedelta(days=n)).replace(hour=hour)
    store.put("clips", clip)
    store.put("learning_publications", {"id": f"pub{n}", "policy_id": "pol", "clip_id": clip["id"],
                                        "published_at": published.isoformat()})
    for index, value in enumerate(snapshots or [views]):
        store.put("learning_snapshots", {"id": f"snap{n}-{index}", "policy_id": "pol", "publication_id": f"pub{n}",
                                         "metrics": {"views": value},
                                         "collected_at": (collected or published + timedelta(hours=24 + index)).isoformat()})


# ---------------------------------------------------------------- confidence math

def test_confidence_is_bounded_and_monotone():
    assert beta_confidence(0, 0) == 0.5
    previous = 0.5
    for beats in range(1, 30):
        value = beta_confidence(beats, 0)
        assert previous < value < 1
        previous = value
    for misses in range(1, 30):
        assert 0 < beta_confidence(3, misses) < beta_confidence(3, misses - 1)
    assert beta_confidence(5, 5) == pytest.approx(0.5)


def belief(**overrides):
    return {"id": "b", "variable": "hook_style", "value": "question", "direction": "increase", "metric": "views",
            "status": "proposed", "created_at": T0.isoformat(), **overrides}


def test_null_baseline_and_null_metrics_never_count_as_zero():
    posts = [{"publication_id": "x", "snapshot_id": "s", "clip_id": "c", "published_at": T0.isoformat(),
              "tags": {"hook_style": "question"}, "metrics": {"views": None}}]
    result = evaluate_belief(belief(), posts, {"metrics": {"views": 100.0}})
    assert result["counts"]["matching"] == 0 and result["status"] == "proposed"
    posts[0]["metrics"]["views"] = 500
    unknown = evaluate_belief(belief(), posts, {"metrics": {"views": None}})
    assert unknown["counts"]["matching"] == 0 and unknown["confidence"] == 0.5 and unknown["baseline_value"] is None


def test_latest_cumulative_snapshot_is_used_never_summed(tmp_path):
    store = Store(tmp_path)
    seed_world(store)
    add_post(store, 1, snapshots=[100, 400, 900])
    posts = measured_posts(store, "p")
    assert len(posts) == 1 and posts[0]["metrics"]["views"] == 900 and posts[0]["snapshot_id"] == "snap1-2"
    assert account_baseline(store, "p")["metrics"]["views"] == 900  # not 1400


def test_support_requires_evidence_after_the_belief_was_named():
    posts = [{"publication_id": f"p{i}", "snapshot_id": f"s{i}", "clip_id": "c",
              "published_at": (T0 + timedelta(days=i)).isoformat(), "tags": {"hook_style": "question"},
              "metrics": {"views": 300}} for i in range(4)]
    early = evaluate_belief(belief(created_at=(T0 + timedelta(days=10)).isoformat()), posts, {"metrics": {"views": 100}})
    assert early["confidence"] > 0.9 and early["status"] == "testing" and early["counts"]["prospective"] == 0
    later = evaluate_belief(belief(created_at=(T0 + timedelta(days=2, hours=1)).isoformat()), posts, {"metrics": {"views": 100}})
    assert later["status"] == "supported"
    assert all(e["ratio"] == 3.0 for e in later["evidence"])
    weak = evaluate_belief(belief(direction="decrease"), posts, {"metrics": {"views": 100}})
    assert weak["status"] == "weakened"


# ---------------------------------------------------------------- tagging

def test_tags_are_deterministic_and_unknown_stays_null():
    clip = {"hook": "3 rules for founders", "hypothesis": "humor",
            "edit_plan": {"start": 2, "end": 50, "caption_style": "pop", "framing": "blur", "hook": "3 rules for founders",
                          "hook_overlay": True, "opening_treatment": None}}
    publication = {"published_at": "2026-11-14T19:30:00+00:00"}
    first = tag_clip(clip, publication)
    assert first == tag_clip(json.loads(json.dumps(clip)), dict(publication))
    assert first == {"hook_style": "number", "duration_bucket": "long", "opening_type": "text_overlay",
                     "caption_style": "pop", "framing": "blur", "moment_type": "humor", "speaker_role": None,
                     "posting_window": "evening", "day_type": "weekend"}
    bare = tag_clip({"id": "legacy"})
    assert all(value is None for value in bare.values())
    assert tag_clip({"hook": "Why rates matter?", "hypothesis": "invented"})["moment_type"] is None
    assert tag_clip({"hook": "Why rates matter?"})["hook_style"] == "question"


# ---------------------------------------------------------------- portfolio

def make_beliefs():
    rows = []
    for index, (status, confidence, uncertainty, variable) in enumerate([
        ("supported", 0.9, 0.4, "hook_style"), ("supported", 0.85, 0.5, "moment_type"),
        ("testing", 0.6, 0.8, "duration_bucket"), ("proposed", 0.5, 1.0, "caption_style"),
        ("weakened", 0.1, 0.4, "framing"), ("retired", 0.95, 0.2, "opening_type")]):
        rows.append({"id": f"b{index}", "status": status, "confidence": confidence, "uncertainty": uncertainty,
                     "variable": variable, "value": "v", "direction": "increase", "layer": "craft",
                     "statement": f"Belief {index}.", "counts": {"matching": 4}})
    return rows


def test_portfolio_ratio_and_determinism():
    beliefs = make_beliefs()
    plan = plan_portfolio(beliefs, slots=4, seed="p:1")
    assert (plan["exploit"], plan["explore"]) == (3, 1)
    assert {s["belief_id"] for s in plan["slots"] if s["mode"] == "exploit"} <= {"b0", "b1"}
    assert next(s for s in plan["slots"] if s["mode"] == "explore")["belief_id"] == "b2"  # 0.8*0.8 > 1.0*0.6
    assert plan == plan_portfolio(list(reversed(beliefs)), slots=4, seed="p:1")
    assert all(s["belief_id"] not in {"b4", "b5"} for s in plan["slots"])
    eight = plan_portfolio(beliefs, slots=8, seed="x")
    assert (eight["exploit"], eight["explore"]) == (6, 2)
    only_new = plan_portfolio([b for b in beliefs if b["status"] in {"testing", "proposed"}], slots=4, seed="x")
    assert only_new["explore"] == 4 and only_new["exploit"] == 0
    assert plan_portfolio([], slots=4)["slots"] == []


# ---------------------------------------------------------------- model contract

def good_output(**overrides):
    item = {"layer": "craft", "variable": "hook_style", "value": "question", "direction": "increase",
            "statement": "Question hooks tend to beat the median.", "rationale": "Both question posts sat above the median.",
            "evidence_ids": ["pub1"], **overrides}
    return json.dumps({"status": "hypotheses", "hypotheses": [item], "limitations": "Few posts."})


@pytest.mark.parametrize("override,message", [
    ({"layer": "campaign", "variable": "posting_window", "value": "evening"}, "not being reviewed"),
    ({"variable": "moment_type", "value": "story"}, "not allowed for the craft"),
    ({"value": "shouting"}, "not allowed for hook_style"),
    ({"evidence_ids": ["made-up"]}, "evidence ID"),
    ({"statement": "Question hooks give 40% more views."}, "numbers"),
    ({"rationale": "This proves question hooks work best for us."}, "numbers"),
])
def test_hypothesis_validation_rejects_unmapped_or_numeric_output(override, message):
    with pytest.raises(WorkError, match=message):
        validate_hypotheses(good_output(**override), layers=["craft"], evidence_ids={"pub1"}, existing=set())


def test_hypothesis_validation_rejects_model_set_confidence_and_drops_duplicates():
    payload = json.loads(good_output())
    payload["hypotheses"][0]["confidence"] = 0.99
    with pytest.raises(WorkError):
        validate_hypotheses(json.dumps(payload), layers=["craft"], evidence_ids={"pub1"}, existing=set())
    result = validate_hypotheses(good_output(), layers=["craft"], evidence_ids={"pub1"},
                                 existing={("hook_style", "question", "increase")})
    assert result["hypotheses"] == []


class FakeModel:
    def __init__(self, outputs, held=()):
        self.outputs, self.held, self.prompts, self.admissions = list(outputs), list(held), [], 0

    def admit(self):
        self.admissions += 1
        return self.held.pop(0) if self.held else []

    def generate(self, prompt):
        self.prompts.append(prompt)
        return self.outputs.pop(0)


def world(tmp_path, model=None, **kwargs):
    store = Store(tmp_path)
    seed_world(store, **kwargs)
    campaigns = Campaigns(store)
    clock = Clock()
    engine = Strategist(store, propose_rules=campaigns.propose_from_beliefs,
                        model_factory=(lambda job_id: model) if model else None, clock=clock)
    return store, engine, clock


def test_model_repair_then_belief_with_model_rationale_but_code_confidence(tmp_path):
    model = FakeModel(["not json", good_output()])
    store, engine, _ = world(tmp_path, model)
    for n in range(1, 4):
        add_post(store, n, views=100 * n)
    receipt = engine.run("p", layers=["craft"])
    assert receipt["model"]["status"] == "proposed" and receipt["model"]["attempts"] == 2
    assert model.admissions == 2 and len(receipt["model"]["validation_failures"]) == 1
    created = [b for b in engine.beliefs("p") if b["origin"] == "model"]
    assert len(created) == 1 and created[0]["rationale"].startswith("Both question")
    assert created[0]["confidence"] == round(beta_confidence(created[0]["counts"]["beats"], created[0]["counts"]["misses"]), 4)
    assert "pub1" in model.prompts[0] and len(model.prompts[0].encode()) + 900 + 256 <= 8192


def test_invalid_after_one_repair_abstains_without_fabrication(tmp_path):
    model = FakeModel(["{}", good_output(value="shouting")])
    store, engine, _ = world(tmp_path, model)
    for n in range(1, 4):
        add_post(store, n)
    receipt = engine.run("p", layers=["craft"])
    assert receipt["model"]["status"] == "abstained" and len(model.prompts) == 2
    assert not [b for b in engine.beliefs("p") if b["origin"] == "model"]
    assert receipt["status"] == "completed"  # deterministic parts still ran


def test_admission_hold_skips_inference_but_deterministic_layers_run(tmp_path):
    model = FakeModel([good_output()], held=[["Learning is paused: about 6.0 GiB available memory is required."]])
    store, engine, _ = world(tmp_path, model)
    for n in range(1, 5):
        add_post(store, n, views=100 + n)
    receipt = engine.run("p")
    assert receipt["model"]["status"] == "held" and receipt["model"]["label"] == "model held: insufficient memory"
    assert model.prompts == [] and receipt["status"] == "completed"
    assert engine.beliefs("p") and all(b["origin"] == "pattern_scan" for b in engine.beliefs("p"))
    assert receipt["portfolio"] is not None


def test_repair_is_admitted_again_before_inference(tmp_path):
    model = FakeModel(["bad"], held=[[], ["Learning is paused because this Mac reports warning memory pressure."]])
    store, engine, _ = world(tmp_path, model)
    for n in range(1, 4):
        add_post(store, n)
    receipt = engine.run("p", layers=["craft"])
    assert receipt["model"]["status"] == "held" and len(model.prompts) == 1


# ---------------------------------------------------------------- cadence

def test_layer_cadence_triggers(tmp_path):
    store, engine, _clock = world(tmp_path)
    assert engine.due_layers("p") == []
    add_post(store, 1)
    assert engine.due_layers("p") == ["craft"]
    engine.run("p", layers=engine.due_layers("p"), trigger="schedule")
    assert engine.due_layers("p") == []
    add_post(store, 2)
    add_post(store, 3)
    assert engine.due_layers("p") == ["craft", "selection"]
    engine.run("p", layers=["craft", "selection"], trigger="schedule")
    for n in range(4, 9):
        add_post(store, n)
    assert engine.due_layers("p") == ["craft", "selection", "campaign"]


# ---------------------------------------------------------------- proposals and guards

def supported_world(tmp_path, *, hypothesis="story"):
    store, engine, clock = world(tmp_path)
    for n in range(1, 3):
        add_post(store, n, hook="Plain claim", hypothesis="lesson", views=100, seconds=30)
    add_post(store, 3, hook="Would you?", hypothesis=hypothesis, views=300)
    add_post(store, 4, hook="Would you?", hypothesis=hypothesis, views=320)
    engine.run("p")
    clock.now += timedelta(days=30)
    for n in range(40, 43):  # published after the beliefs were named (clock was T0+30d)
        add_post(store, n, hook="Would you?", hypothesis=hypothesis, views=400 + n)
    return store, engine, clock


def test_supported_beliefs_are_proposed_never_approved(tmp_path):
    store, engine, _ = supported_world(tmp_path)
    receipt = engine.run("p")
    supported = [b for b in engine.beliefs("p") if b["status"] == "supported"]
    assert supported and receipt["proposals"]
    versions = [v for v in store.all("strategy_versions") if v.get("source") == "strategist"]
    assert versions and all(v["status"] == "proposed" and v["approved_at"] is None for v in versions)
    assert store.get("campaigns", "c")["active_strategy_id"] == "v1"
    selection = next(v for v in versions if v["learning"]["layer"] == "selection")
    text = selection["directions"]["p"]["moment_selection"]
    assert text.startswith("Complete thoughts.") and GUIDANCE_OPEN in text and "story" in text
    campaign_records = store.all("campaign_strategy_proposals")
    assert all(r["status"] == "proposed" and r["approved"] is False for r in campaign_records)
    again = engine.run("p")
    assert not [p for p in again["proposals"] if p["status"] == "proposed"]  # pending proposals are not duplicated


def test_archived_campaign_and_profile_are_rejected(tmp_path):
    store, engine, _ = world(tmp_path, campaign_archived=True)
    with pytest.raises(HTTPException) as caught:
        engine.run("p")
    assert caught.value.status_code == 409
    store.patch("campaigns", "c", archived_at=None)
    store.patch("profiles", "p", archived_at="2026-11-02T00:00:00+00:00")
    with pytest.raises(HTTPException) as caught:
        engine.run("p")
    assert caught.value.status_code == 409
    with pytest.raises(HTTPException):
        engine.view("missing")


def test_campaign_proposal_needs_explicit_human_decision(tmp_path):
    store, engine, _ = world(tmp_path)
    record = engine._campaign_proposal("p", store.get("campaigns", "c"), [
        {"id": "b", "variable": "posting_window", "value": "evening", "direction": "increase", "statement": "S.",
         "confidence": 0.9, "counts": {"matching": 5}, "evidence": []}])
    assert store.get("campaign_strategy_proposals", record["id"])["status"] == "proposed"
    decided = engine.decide_campaign_proposal(record["id"], approve=True, reason="Looks right")
    assert decided["status"] == "approved"
    with pytest.raises(HTTPException):
        engine.decide_campaign_proposal(record["id"], approve=False)


def test_retire_is_sticky(tmp_path):
    store, engine, _ = world(tmp_path)
    for n in range(1, 4):
        add_post(store, n, views=100 * n)
    engine.run("p")
    target = engine.beliefs("p")[0]
    engine.retire(target["id"], "Not useful")
    engine.run("p")
    assert store.get("beliefs", target["id"])["status"] == "retired"


def test_guidance_is_bounded_replaceable_and_read_from_approved_direction():
    beliefs = [{"id": f"b{i}", "variable": "moment_type", "value": "story", "direction": "increase", "confidence": 0.9,
                "counts": {"matching": 5}} for i in range(40)]
    changes = rule_changes("selection", beliefs)
    assert len(changes["guidance"]) <= 600 and changes["guidance"].endswith(GUIDANCE_CLOSE)
    merged = merge_guidance("Creator words.", changes["guidance"])
    assert merge_guidance(merged, changes["guidance"]).count(GUIDANCE_OPEN) == 1
    assert selection_guidance({"moment_selection": merged}) == changes["guidance"]
    assert selection_guidance({"moment_selection": "Creator words."}) is None


# ---------------------------------------------------------------- simulation

def test_simulation_is_synthetic_deterministic_and_in_memory(tmp_path):
    store = Store(tmp_path)
    seed_world(store)
    dump = (lambda: store.connect().execute("SELECT kind, id, data FROM records ORDER BY kind, id").fetchall())
    before = dump()
    first = simulate(store.get("profiles", "p"), seed=3, steps=12)
    assert first == simulate(store.get("profiles", "p"), seed=3, steps=12)
    assert first["simulated"] is True and all(step["simulated"] is True for step in first["steps"])
    assert first["banner"].startswith("Simulation")
    assert dump() == before
    assert not store.all("beliefs") and not store.all("strategist_runs")


def test_memory_store_matches_store_interface():
    memory = MemoryStore()
    memory.put("k", {"id": "a", "v": 1})
    memory.put("k", {"id": "b", "v": 2})
    assert [r["id"] for r in memory.all("k")] == ["b", "a"]
    assert memory.patch("k", "a", v=3)["v"] == 3 and memory.get("k", "a")["v"] == 3
