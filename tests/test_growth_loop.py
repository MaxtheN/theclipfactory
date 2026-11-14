"""Offline growth-loop contracts; no provider, publication, or model calls."""
import hashlib
import time
from copy import deepcopy

import pytest
from fastapi import HTTPException

from clip_factory.campaigns import Campaigns, Direction
from clip_factory.growth_loop import GrowthLoop, compare_observations, personalize_rankings, preference_model
from clip_factory.jobs import Jobs
from clip_factory.store import Store


@pytest.fixture
def setup(tmp_path):
    store = Store(tmp_path)
    store.put("profiles", {"id": "p", "name": "Brand", "active_strategy_id": "v1"})
    store.put("profiles", {"id": "other", "name": "Other", "active_strategy_id": None})
    direction = Direction().model_dump()
    store.put("strategy_versions", {"id": "v1", "version": 1, "status": "approved", "scope": "workspace",
                                     "profile_id": "p", "directions": {"p": direction}})
    store.put("campaigns", {"id": "camp", "profile_ids": ["p"], "video_ids": ["video"],
                            "objective": "awareness", "primary_metric": "views", "brief": {}})
    store.put("videos", {"id": "video", "duration": 200})
    for index in range(4):
        path = tmp_path / f"clip{index}.mp4"
        path.write_bytes(f"offline fixture {index}".encode())
        plan = {"start": index * 35., "end": index * 35. + 30, "hook": "An honest source quote",
                "caption": "Source-backed post copy.", "subtitles": True, "framing": "fit",
                "caption_style": "standard", "opening_treatment": "text_overlay", "hook_format": "title_card"}
        store.put("clips", {"id": f"c{index}", "profile_id": "p", "campaign_id": "camp", "video_id": "video",
                            "path": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                            "edit_plan": plan, "strategy_snapshot": deepcopy(direction), "strategy_version_id": "v1",
                            "team_run_id": "run", "approved": False, "start": plan["start"], "end": plan["end"],
                            "rank": {"score": 75, "position": index + 1, "below_bar": False, "top_pick": index < 3,
                                     "signals": {"strength": 0.9 if index < 2 else 0.2, "hook": 1.0}}})
    calls = []

    def render(campaign_id, body, *, experiment_id, provenance):
        # Real submission semantics: no same-source job can queue concurrently.
        assert not any(j["status"] in {"running", "queued"} for j in store.all("jobs"))
        job = {"id": f"job{len(calls)}", "status": "queued", "kind": "render",
               "context": {"video_id": body.video_id, "experiment_id": experiment_id}}
        calls.append((campaign_id, body, experiment_id, provenance))
        store.put("jobs", job)
        return job

    loop = GrowthLoop(store, Campaigns(store), render, root=tmp_path)
    return loop, store, calls


def complete(store, calls, index):
    _, body, _, provenance = calls[index]
    store.patch("jobs", f"job{index}", status="completed")
    store.put("clips", {"id": f"out{index}", "parent_clip_id": body.parent_clip_id,
                        "profile_id": body.profile_id,
                        "approved": False, "sha256": "d" * 64, "edit_plan": body.model_dump(), **provenance})


@pytest.mark.parametrize("field,previous", [("framing", "fill"), ("caption_style", "high_contrast")])
def test_recut_rejects_rule_that_already_matches_actual_parent_before_reserving(setup, field, previous):
    loop, store, calls = setup
    clip = store.get("clips", "c0")
    old = {**clip["strategy_snapshot"], field: previous}
    store.patch("clips", "c0", strategy_snapshot=old)
    current = {**old, field: clip["edit_plan"][field]}
    store.put("strategy_versions", {"id": "v2", "version": 2, "status": "approved", "scope": "workspace",
                                    "profile_id": "p", "directions": {"p": current}})
    store.patch("profiles", "p", active_strategy_id="v2")
    with pytest.raises(HTTPException) as error:
        loop.recut("p", request_id="already-rendered", clip_ids=["c0"], expected_strategy_version_id="v2")
    assert error.value.status_code == 422
    assert not store.all("growth_loops") and not calls


def test_stale_passing_rank_cannot_bypass_current_caption_failure(setup):
    loop, store, calls = setup
    store.patch("clips", "c0", technical_checks={"playback_format_passed": True,
                "captions": [{"id": "timing", "status": "fail", "detail": "Overlapping captions"}]})
    with pytest.raises(HTTPException) as error:
        loop.start_ab("p", request_id="held-captions", clip_ids=["c0"], expected_strategy_version_id="v1")
    assert error.value.status_code == 409
    assert not store.all("growth_loops") and not calls


def test_top_three_ab_queues_serially_and_preserves_human_approval(setup):
    loop, store, calls = setup
    receipt = loop.start_ab("p", request_id="ab1", clip_ids=["c0", "c1", "c2"],
                            expected_strategy_version_id="v1")
    assert len(calls) == 1
    assert [s["status"] for s in receipt["slots"]] == ["queued", "prepared", "prepared"]
    for index in range(3):
        body = calls[index][1]
        assert body.hook_format == "overlay" and body.changed_variable == "hook_format"
        assert body.hook == store.get("clips", body.parent_clip_id)["edit_plan"]["hook"]
        complete(store, calls, index)
        loop.tick()
    receipt = loop.view("p")["loops"][0]
    assert receipt["status"] == "completed"
    assert len({s["variant_group"] for s in receipt["slots"]}) == 3
    assert all(s["approved"] is False for s in receipt["slots"])
    assert not store.all("learning_publications")
    repeated = loop.start_ab("p", request_id="ab1", clip_ids=["c0", "c1", "c2"],
                             expected_strategy_version_id="v1")
    assert repeated["id"] == receipt["id"] and len(calls) == 3


def test_busy_production_defers_and_opt_in_is_required(setup):
    loop, store, calls = setup
    store.put("team_runs", {"id": "run"})
    store.put("jobs", {"id": "production", "status": "running", "context": {"video_id": "video"}})
    assert loop.after_ranking("run") is None
    assert not store.all("growth_loops")
    loop.policy("p", auto_ab=True)
    receipt = loop.after_ranking("run")
    assert all(s["status"] == "prepared" for s in receipt["slots"]) and not calls
    store.patch("jobs", "production", status="completed")
    loop.tick()
    assert len(calls) == 1


def test_unknown_submissions_reconcile_never_blind_retry(setup):
    loop, store, calls = setup
    original = loop.render

    def interrupted(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("Interrupted after queue submission")

    loop.render = interrupted
    receipt = loop.start_ab("p", request_id="unknown", clip_ids=["c0"], expected_strategy_version_id="v1")
    assert receipt["slots"][0]["job_id"] == "job0"
    assert len(calls) == 1
    loop.tick()
    assert len(calls) == 1
    complete(store, calls, 0)
    assert loop.reconcile(receipt["id"])["status"] == "completed"


def test_accepted_request_retry_precedes_mutable_rule_file_and_archive_checks(setup):
    loop, store, calls = setup
    receipt = loop.start_ab("p", request_id="lost-response", clip_ids=["c0"],
                            expected_strategy_version_id="v1")
    store.patch("profiles", "p", active_strategy_id="new-rule", archived_at="2026-11-14T00:00:00+00:00")
    (loop.root / store.get("clips", "c0")["path"]).unlink()
    retry = loop.start_ab("p", request_id="lost-response", clip_ids=["c0"],
                          expected_strategy_version_id="v1")
    assert retry["id"] == receipt["id"] and len(calls) == 1
    with pytest.raises(HTTPException) as error:
        loop.start_ab("p", request_id="lost-response", clip_ids=["c1"], expected_strategy_version_id="v1")
    assert error.value.status_code == 409


@pytest.mark.parametrize("scenario,decision,count", [("mixed", "test", 1), ("decline", "keep", 0), ("sparse", "wait", 0)])
def test_live_clip_rehearsal_keeps_synthetic_evidence_separate(setup, scenario, decision, count):
    loop, store, calls = setup
    quote = "The point is simple, you cannot reverse engineer a chip from wafers"
    clip = store.get("clips", "c0")
    store.patch("clips", "c0", hook=quote, edit_plan={**clip["edit_plan"], "hook": quote})
    store.patch("videos", "video", transcript={"segments": [{"start": 0, "end": 30, "text": quote}]})
    checksum = store.get("clips", "c0")["sha256"]
    receipt = loop.rehearse("p", request_id="rehearse", clip_id="c0", expected_strategy_version_id="v1",
                            expected_sha256=checksum, scenario=scenario)
    assert receipt["comparison"]["decision"] == decision
    assert receipt["simulated"] is False and receipt["simulated_evidence"] is True
    assert all(s["simulated"] for s in receipt["synthetic_observations"])
    assert len(calls) == count
    assert receipt["status"] == ("running" if count else "no_draft")
    assert not store.all("learning_publications") and not store.all("learning_snapshots")
    assert store.get("profiles", "p")["active_strategy_id"] == "v1"
    if count:
        assert calls[0][3]["simulated_evidence"] is True
        assert calls[0][3]["evidence_kind"] == "simulated_observation_rehearsal"
        assert calls[0][1].changed_variable == "hooks"
        assert len(calls[0][1].hook.split()) <= 8 and "cannot" in calls[0][1].hook
        assert receipt["proposal"]["weak_dimension"] == "hook"
    store.patch("profiles", "p", active_strategy_id="changed")
    retry = loop.rehearse("p", request_id="rehearse", clip_id="c0", expected_strategy_version_id="v1",
                          expected_sha256=checksum, scenario=scenario)
    assert retry["id"] == receipt["id"] and len(calls) == count


def test_rehearsal_abstains_when_rubric_has_no_supported_repair(setup):
    loop, store, calls = setup
    receipt = loop.rehearse("p", request_id="nothing-to-repair", clip_id="c0", expected_strategy_version_id="v1",
        expected_sha256=store.get("clips", "c0")["sha256"])
    assert receipt["status"] == "no_draft" and not calls
    assert receipt["draft_decision"] == "no_supported_rubric_edit"
    assert receipt["comparison"]["decision"] == "test"
    assert receipt["proposal"]["after"] is None


def test_rehearsal_preview_is_read_only_and_does_not_reserve_request_id(setup):
    loop, store, calls = setup
    quote = "The point is simple, you cannot reverse engineer a chip from wafers"
    clip = store.get("clips", "c0")
    store.patch("clips", "c0", hook=quote, edit_plan={**clip["edit_plan"], "hook": quote})
    store.patch("videos", "video", transcript={"segments": [{"start": 0, "end": 30, "text": quote}]})
    with store.connect() as db:
        before = db.execute("SELECT kind,id,data FROM records ORDER BY kind,id").fetchall()
    preview = loop.rehearsal_preview("p", request_id="preview-not-reserved", clip_id="c0",
        expected_strategy_version_id="v1", expected_sha256=clip["sha256"])
    with store.connect() as db:
        after = db.execute("SELECT kind,id,data FROM records ORDER BY kind,id").fetchall()
    assert before == after and not calls
    assert preview["can_render"] is True and preview["persisted"] is False
    assert preview["proposal"]["weak_dimension"] == "hook"
    assert preview["actual_render"] is False and preview["publication_permission"] is False
    assert not store.all("growth_loops")
    actual = loop.rehearse("p", request_id="preview-not-reserved", clip_id="c0",
        expected_strategy_version_id="v1", expected_sha256=clip["sha256"])
    assert actual["proposal"] == preview["proposal"] and len(calls) == 1


def test_current_ai_faithfulness_hold_repairs_from_verified_negative_payoff(setup):
    loop, store, calls = setup
    quote = "You cannot reverse engineer a chip from wafers"
    clip = store.get("clips", "c0")
    store.patch("clips", "c0", hook="Reverse engineer a chip from wafers", edit_plan={
        **clip["edit_plan"], "hook": "Reverse engineer a chip from wafers"},
        swarm={"payoff_quote": quote, "payoff_verified": True})
    store.patch("videos", "video", transcript={"segments": [{"start": 0, "end": 30, "text": quote}]})
    loop.scorecard = lambda _: {"ranking": {"rubric_version": "ranking@2"}, "integrity": {"status": "verified"},
        "assessments": [{"id": "exact-ai-assessment", "sha256": clip["sha256"], "status": "assessed",
                         "current": True, "assessment": {"source_faithfulness": {"score": 1}, "editorial_hold": True}}]}
    receipt = loop.rehearse("p", request_id="repair", clip_id="c0", expected_strategy_version_id="v1",
        expected_sha256=clip["sha256"])
    assert len(calls) == 1 and calls[0][1].hook == quote
    assert receipt["proposal"]["weak_dimension"] == "source_faithfulness"
    assert receipt["proposal"]["assessment_id"] == "exact-ai-assessment"
    assert receipt["rubric_before"]["assessment"]["id"] == "exact-ai-assessment"
    assert calls[0][3]["rubric_proposal"]["after"] == quote


def test_stale_ai_hold_or_unverified_payoff_cannot_drive_repair(setup):
    loop, store, calls = setup
    clip = store.get("clips", "c0")
    loop.scorecard = lambda _: {"ranking": {}, "integrity": {"status": "verified"}, "assessments": [{
        "id": "stale", "sha256": clip["sha256"], "status": "assessed", "current": False,
        "assessment": {"source_faithfulness": {"score": 1}, "editorial_hold": True}}]}
    receipt = loop.rehearse("p", request_id="stale", clip_id="c0", expected_strategy_version_id="v1",
        expected_sha256=clip["sha256"])
    assert receipt["status"] == "no_draft" and not calls


def test_stale_rule_holds_prepared_work_and_isolation(setup):
    loop, store, calls = setup
    receipt = loop.start_ab("p", request_id="ab", clip_ids=["c0", "c1"], expected_strategy_version_id="v1")
    store.patch("profiles", "p", active_strategy_id="changed")
    complete(store, calls, 0)
    loop.tick()
    assert len(calls) == 1
    assert loop.reconcile(receipt["id"])["slots"][1]["status"] == "held"
    with pytest.raises(HTTPException) as error:
        loop.record_review("other", "c0", "approve", request_id="foreign")
    assert error.value.status_code == 422


def test_recut_requires_actual_single_approved_rule_and_duplicate_key(setup):
    loop, store, calls = setup
    with pytest.raises(HTTPException):
        loop.recut("p", request_id="nothing", clip_ids=["c0"], expected_strategy_version_id="v1")
    direction = deepcopy(store.get("strategy_versions", "v1")["directions"]["p"])
    direction["hooks"] = ["A new supported hook"]
    store.put("strategy_versions", {"id": "v2", "version": 2, "status": "approved", "scope": "workspace",
                                     "profile_id": "p", "directions": {"p": direction}})
    store.patch("profiles", "p", active_strategy_id="v2")
    receipt = loop.recut("p", request_id="recut", clip_ids=["c0"], expected_strategy_version_id="v2")
    assert calls[0][1].hook == "A new supported hook"
    assert calls[0][1].parent_clip_id == "c0"
    assert receipt["rule_id"] == "v2" and not store.get("clips", "c0")["approved"]
    with pytest.raises(HTTPException) as error:
        loop.recut("p", request_id="recut", clip_ids=["c1"], expected_strategy_version_id="v2")
    assert error.value.status_code == 409


def test_preferences_have_sample_size_dedupe_and_bounded_reordering(setup):
    loop, store, _ = setup
    for index in range(4):
        decision = "approve" if index < 2 else "reject"
        loop.record_review("p", f"c{index}", decision, request_id=f"review{index}")
        loop.record_review("p", f"c{index}", decision, request_id=f"review{index}")
    model = preference_model(store, "p")
    assert model["sample_size"] == 4 and model["status"] == "ready"
    assert preference_model(store, "other")["sample_size"] == 0
    clips = [store.get("clips", f"c{i}") for i in range(4)]
    original = {c["id"]: c["rank"] for c in clips}
    records = personalize_rankings(store, clips, original, "p")
    assert all(r["score"] == 75 for r in records.values())
    assert all(abs(r["taste"]["adjustment"]) <= 5 for r in records.values())
    assert records["c0"]["review_priority"] > records["c3"]["review_priority"]
    assert all(not c["approved"] for c in clips)


def test_tampered_file_rejects_preference_and_render(setup):
    loop, store, _ = setup
    clip = store.get("clips", "c0")
    (loop.root / clip["path"]).write_bytes(b"changed")
    with pytest.raises(HTTPException) as error:
        loop.record_review("p", "c0", "approve", request_id="changed")
    assert error.value.status_code == 409
    with pytest.raises(HTTPException):
        loop.start_ab("p", request_id="changed", clip_ids=["c0"], expected_strategy_version_id="v1")


def test_real_jobs_worker_dispatches_all_three_without_source_busy_collision(setup):
    loop, store, _ = setup
    jobs = Jobs(store)
    submitted = []

    def render(campaign_id, body, *, experiment_id, provenance):
        assert not jobs.busy("video_id", body.video_id)

        def work(job_id):
            store.put("clips", {"id": f"actual-{experiment_id}", "approved": False,
                "profile_id": body.profile_id,
                "edit_plan": body.model_dump(), "parent_clip_id": body.parent_clip_id,
                "sha256": "e" * 64, **provenance})
            return {"clip_id": f"actual-{experiment_id}"}

        job = jobs.submit("render", work, video_id=body.video_id, experiment_id=experiment_id)
        submitted.append(job["id"])
        return job

    loop.render = render
    try:
        receipt = loop.start_ab("p", request_id="real-queue", clip_ids=["c0", "c1", "c2"],
                                expected_strategy_version_id="v1")
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            loop.tick()
            receipt = loop.reconcile(receipt["id"])
            if receipt["status"] == "completed":
                break
            time.sleep(0.01)
        assert receipt["status"] == "completed"
        assert len(submitted) == 3 and len(set(submitted)) == 3
        loop.tick()
        assert len(submitted) == 3
    finally:
        jobs.close()


def test_comparison_requires_denominators_window_and_matching_account():
    first = {"profile_id": "p", "account_id": "a", "window_days": 3,
             "metrics": {"views": 100, "likes": 10, "comments": 2, "shares": 1, "saves": 1}}
    second = {**deepcopy(first), "metrics": {"views": 100, "likes": 8, "comments": 1, "shares": 0, "saves": 0}}
    assert compare_observations(first, second, metric="engagement_rate")["status"] == "insufficient_evidence"
    result = compare_observations(first, second, metric="engagement_rate", window_complete=True)
    assert result["status"] == "favors_parent" and result["difference"] < 0
    assert compare_observations(first, {**second, "account_id": "b"}, window_complete=True)["status"] == "insufficient_evidence"
    second["metrics"]["likes"] = None
    assert compare_observations(first, second, metric="engagement_rate", window_complete=True)["after_value"] is None
    assert compare_observations(first, {**second, "simulated": True}, window_complete=True)["status"] == "insufficient_evidence"


@pytest.mark.parametrize("value", [True, float("nan"), float("inf"), -1, 100.5])
def test_invalid_view_values_do_not_create_winner(value):
    first = {"simulated": True, "metrics": {"views": value}}
    second = {"simulated": True, "metrics": {"views": 500}}
    assert compare_observations(first, second, window_complete=True)["status"] == "insufficient_evidence"
