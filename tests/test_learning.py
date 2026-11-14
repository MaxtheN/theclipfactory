"""Offline durable learning domain: injected clock, collector, analyst and producer."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from threading import Event
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from clip_factory.learning import AnalysisResult, LearningEngine, MetricSnapshotInput, Policy, Publication
from clip_factory.store import Store


class Clock:
    def __init__(self):
        self.value = datetime(2026, 1, 1, tzinfo=UTC)

    def __call__(self):
        return self.value

    def advance(self, **kwargs):
        self.value += timedelta(**kwargs)


@pytest.fixture
def domain(tmp_path):
    store, clock = Store(tmp_path / "learning"), Clock()
    store.put("profiles", {"id": "profile", "objective": "traffic", "primary_metric": "views"})
    store.put("profiles", {"id": "other-profile"})
    store.put("connected_accounts", {"id": "account", "profile_id": "profile", "provider": "composio", "toolkit": "instagram", "status": "active", "user_id": "local-user"})
    store.put("connected_accounts", {"id": "foreign-account", "profile_id": "other-profile", "provider": "composio", "toolkit": "instagram", "status": "active", "user_id": "local-user"})
    store.put("videos", {"id": "source", "duration": 120, "has_audio": True, "transcript": {"segments": [{"start": 0, "end": 20, "text": "A complete thought."}, {"start": 20, "end": 30, "text": "More context."}]}})
    store.put("campaigns", {"id": "campaign", "profile_ids": ["profile", "other-profile"], "video_ids": ["source"], "active_strategy_id": "base"})
    store.put("strategy_versions", {"id": "base", "campaign_id": "campaign", "status": "approved", "directions": {"profile": {"framing": "fit", "caption_style": "standard"}}})
    plan = {"start": 0, "end": 30, "hook": "Original", "subtitles": True, "opening_treatment": "text_overlay", "hook_overlay": True, "focus_x": .5, "framing": "fit", "caption_style": "standard"}
    store.put("clips", {"id": "parent", "campaign_id": "campaign", "profile_id": "profile", "video_id": "source", "strategy_version_id": "base", "approved": True, "sha256": "a" * 64, "caption": "Source context", "edit_plan": plan})
    calls = {"collect": 0, "analyze": 0, "produce": 0}
    metrics = {"views": 120, "likes": None}

    def collect(publication, policy):
        calls["collect"] += 1
        assert publication["account_id"] == policy["account_id"] == "account"
        return {"account_id": "account", "media_id": "post", "metrics": deepcopy(metrics), "collected_at": clock(), "window_start": publication["published_at"], "window_end": clock(), "source": "injected-fixture", "cumulative": True}

    def analyze(context):
        calls["analyze"] += 1
        return {"status": "experiment", "variable": "hook", "proposed_hook": "Try a clearer point", "evidence_ids": [context["snapshot"]["id"]], "rationale": "Test the opening against measured observations.", "limitations": "This is observational evidence, not a causal winner."}

    def produce(experiment):
        calls["produce"] += 1
        assert store.get("learning_experiments", experiment["id"])["status"] == "submitting"
        job_id = f"job-{calls['produce']}"
        store.put("jobs", {"id": job_id, "kind": "render", "status": "queued", "context": {"experiment_id": experiment["id"], "video_id": experiment["source_id"], "campaign_id": experiment["campaign_id"], "profile_id": experiment["profile_id"], "plan": deepcopy(experiment["render_request"])}, "result": None})
        return {"status": "queued", "job_id": job_id}

    def engine(**changes):
        return LearningEngine(store, changes.get("collect", collect), changes.get("analyze", analyze), changes.get("produce", produce), clock)

    service = engine()
    policy = service.configure_policy({"campaign_id": "campaign", "profile_id": "profile", "account_id": "account", "enabled": True, "auto_drafts": True})

    def publish(**changes):
        return service.register_publication({"policy_id": policy["id"], "clip_id": "parent", "account_id": "account", "media_id": "post", "published_at": clock(), "sha256": "a" * 64, **changes})

    return SimpleNamespace(store=store, clock=clock, engine=engine, service=service, policy=policy, publish=publish, calls=calls, collect=collect, analyze=analyze, produce=produce, metrics=metrics)


def complete(d, *, changes=None):
    experiment = d.service.list_experiments()[0]
    request = experiment["render_request"]
    job_id = experiment.get("job_id") or "job-1"
    clip = {"id": "draft", "campaign_id": "campaign", "profile_id": "profile", "video_id": "source", "strategy_version_id": "base", "parent_clip_id": "parent", "approved": False, "sha256": "b" * 64, "caption": request["caption"], "render_receipt": {"job_id": job_id}, "edit_plan": {**experiment["parent_edit_plan"], **deepcopy(request), **(changes or {})}}
    d.store.put("clips", clip)
    d.store.patch("jobs", job_id, status="completed", result={"clip_id": clip["id"]})
    return experiment, clip


def test_policy_requires_active_explicit_account_profile_binding(domain):
    d = domain
    for changes in [{"account_id": "foreign-account"}, {"profile_id": "missing"}]:
        with pytest.raises(HTTPException):
            d.service.configure_policy({"campaign_id": "campaign", "profile_id": "profile", "account_id": "account", **changes})
    d.store.patch("connected_accounts", "account", status="expired")
    with pytest.raises(HTTPException):
        d.service.configure_policy(Policy(campaign_id="campaign", profile_id="profile", account_id="account"))
    assert len(d.service.list_policies()) == 1


@pytest.mark.parametrize("changes", [{"cadence_days": 4}, {"allowed_changes": ["hook", "hook"]}, {"allowed_changes": ["framing"]}])
def test_policy_bounds_and_no_scope_rebinding(domain, changes):
    with pytest.raises(ValidationError):
        domain.service.configure_policy({**{k: domain.policy[k] for k in Policy.model_fields}, **changes})


def test_policy_upsert_is_idempotent_and_cannot_rebind(domain):
    d = domain
    body = {k: d.policy[k] for k in Policy.model_fields}
    assert d.service.configure_policy(body)["id"] == d.policy["id"]
    with pytest.raises(HTTPException):
        d.service.configure_policy(body, "another-policy")


@pytest.mark.parametrize("changes", [{"account_id": "foreign-account"}, {"sha256": "f" * 64}, {"published_at": "2030-01-01T00:00:00Z"}])
def test_publication_rejects_wrong_account_hash_and_future(domain, changes):
    with pytest.raises(HTTPException):
        domain.publish(**changes)
    assert domain.service.list_publications() == []


def test_publication_requires_approved_scoped_clip_and_idempotent_exact_mapping(domain):
    d = domain
    original = d.publish()
    assert d.publish() == original
    d.store.patch("clips", "parent", approved=False)
    with pytest.raises(HTTPException):
        d.publish(media_id="different")
    d.store.patch("clips", "parent", approved=True, profile_id="other-profile")
    with pytest.raises(HTTPException):
        d.publish(media_id="different")


def test_due_three_days_persists_frozen_one_field_draft_and_never_promotes_strategy(domain):
    d = domain
    d.publish()
    assert d.service.tick() == []
    d.clock.advance(days=3)
    assert d.service.tick()[0]["status"] == "queued"
    experiment = d.service.list_experiments()[0]
    assert experiment["normalization_notes"] == []
    assert experiment["raw_parent_edit_plan"] == experiment["parent_edit_plan"]
    assert experiment["render_request"] == {"campaign_id": "campaign", "profile_id": "profile", "video_id": "source", "expected_strategy_version_id": "base", "start": 0., "end": 30., "hook": "Try a clearer point", "caption": "Source context", "subtitles": True, "opening_treatment": "text_overlay", "focus_x": .5, "parent_clip_id": "parent", "change_reason": "Test the opening against measured observations.", "changed_variable": "hook"}
    assert d.store.get("campaigns", "campaign")["active_strategy_id"] == "base"
    # The workspace adopted the campaign's approved base on read; learning never promotes a version.
    assert d.store.get("profiles", "profile")["active_strategy_id"] == "base"
    assert d.store.get("clips", "parent")["approved"] is True
    assert d.calls == {"collect": 1, "analyze": 1, "produce": 1}
    assert d.engine().tick() == []
    assert d.calls["produce"] == 1


def test_six_day_policy_and_disabled_policy_do_not_collect_early(domain):
    d = domain
    d.service.configure_policy({**{k: d.policy[k] for k in Policy.model_fields}, "cadence_days": 6})
    d.publish()
    d.clock.advance(days=3)
    assert d.service.tick() == []
    d.clock.advance(days=3)
    d.service.configure_policy({**{k: d.policy[k] for k in Policy.model_fields}, "enabled": False})
    assert d.service.tick() == []
    assert d.calls["collect"] == 0
    d.service.configure_policy({**{k: d.policy[k] for k in Policy.model_fields}, "cadence_days": 6})
    assert d.service.tick()[0]["status"] == "queued"


def test_completed_draft_reconciles_after_restart_and_cumulative_counts_are_not_summed(domain):
    d = domain
    d.publish()
    d.clock.advance(days=3)
    d.service.tick()
    complete(d)
    assert d.engine().tick()[0]["status"] == "completed"
    d.clock.advance(days=3)
    assert d.engine().tick()[0]["status"] == "duplicate"
    assert d.calls == {"collect": 2, "analyze": 1, "produce": 1}
    assert len(d.service.list_snapshots()) == 1
    assert d.service.list_snapshots()[0]["metrics"] == {"views": 120., "likes": None}
    assert datetime.fromisoformat(d.service.list_snapshots()[0]["collected_at"]) == datetime(2026, 1, 4, tzinfo=UTC)
    assert datetime.fromisoformat(d.service.list_snapshots()[0]["window_end"]) == datetime(2026, 1, 4, tzinfo=UTC)
    d.metrics["views"] = 150
    d.clock.advance(days=3)
    assert d.engine().tick()[0]["status"] == "queued"
    assert d.calls["produce"] == 2
    assert len(d.service.list_snapshots()) == 2


def test_null_metrics_and_insufficient_analysis_never_make_a_draft(domain):
    d = domain
    d.metrics.update(views=None, likes=None)
    d.publish()
    d.clock.advance(days=3)
    assert d.service.tick()[0]["status"] == "insufficient_evidence"
    assert d.calls["analyze"] == d.calls["produce"] == 0
    d.metrics["views"] = 2
    d.clock.advance(days=3)
    engine = d.engine(analyze=lambda _: {"status": "insufficient_evidence", "rationale": "Only two views.", "limitations": "Too few observations."})
    assert engine.tick()[0]["status"] == "insufficient_evidence"
    assert d.calls["produce"] == 0


def test_proposal_without_auto_drafts_is_saved_not_submitted(domain):
    d = domain
    d.service.configure_policy({**{k: d.policy[k] for k in Policy.model_fields}, "auto_drafts": False})
    d.publish()
    d.clock.advance(days=3)
    assert d.service.tick()[0]["status"] == "proposed"
    assert d.service.list_experiments()[0]["status"] == "proposed"
    assert d.calls["produce"] == 0


def test_wrong_collector_account_is_not_stored_and_retries_are_bounded(domain):
    d = domain
    d.publish()
    d.clock.advance(days=3)

    def wrong(pub, policy):
        return {**d.collect(pub, policy), "account_id": "foreign-account"}

    engine = d.engine(collect=wrong)
    assert engine.tick()[0]["status"] == "retry"
    assert engine.tick() == []
    d.clock.advance(minutes=5)
    assert engine.tick()[0]["status"] == "retry"
    d.clock.advance(minutes=10)
    assert engine.tick()[0]["status"] == "failed"
    assert d.calls["collect"] == 3
    assert d.service.list_snapshots() == []
    assert d.calls["produce"] == 0


def test_stale_strategy_or_revoked_account_blocks_before_collection(domain):
    d = domain
    d.publish()
    d.clock.advance(days=3)
    d.store.patch("profiles", "profile", active_strategy_id="new-base")
    assert d.service.tick()[0]["status"] == "blocked"
    assert d.calls["collect"] == 0


def test_base_change_or_policy_disable_during_analysis_blocks_before_production(domain):
    d = domain
    d.publish()
    d.clock.advance(days=3)

    def changed(context):
        d.store.patch("profiles", "profile", active_strategy_id="another-base")
        return d.analyze(context)

    assert d.engine(analyze=changed).tick()[0]["status"] == "blocked"
    assert d.calls["produce"] == 0


@pytest.mark.parametrize("change", [{"evidence_ids": ["foreign-snapshot"]}, {"proposed_hook": "Original"}, {"variable": "duration", "proposed_hook": None, "proposed_duration_seconds": 25}, {"proposed_duration_seconds": 20}])
def test_unsupported_citations_noop_chopped_sentence_and_multiple_variables_do_not_render(domain, change):
    d = domain
    d.publish()
    d.clock.advance(days=3)
    result = d.engine(analyze=lambda c: {**d.analyze(c), **change}).tick()[0]
    assert result["status"] == "retry"
    assert d.calls["produce"] == 0


def test_duration_uses_recorded_cue_boundary_and_changes_only_the_main_end(domain):
    d = domain
    d.publish()
    d.clock.advance(days=3)
    def analyze(c):
        return {**d.analyze(c), "variable": "duration", "proposed_hook": None, "proposed_duration_seconds": 20}
    assert d.engine(analyze=analyze).tick()[0]["status"] == "queued"
    request = d.service.list_experiments()[0]["render_request"]
    assert request["end"] == 20 and request["hook"] == "Original"
    assert request["start"] == 0


def test_nullable_requested_opening_can_use_explicit_saved_physical_render_facts(domain):
    d = domain
    parent = d.store.get("clips", "parent")
    raw = {**parent["edit_plan"], "opening_treatment": None, "hook_overlay": True}
    d.store.patch("clips", "parent", edit_plan=raw, opening_treatment="text_overlay", hook_rendered=True)
    unchanged_parent = d.store.get("clips", "parent")
    d.publish()
    d.clock.advance(days=3)
    assert d.service.tick()[0]["status"] == "queued"
    experiment = d.service.list_experiments()[0]
    assert experiment["raw_parent_edit_plan"] == raw
    assert experiment["raw_parent_edit_plan"]["opening_treatment"] is None
    assert experiment["parent_edit_plan"] == {**raw, "opening_treatment": "text_overlay"}
    assert experiment["render_request"]["opening_treatment"] == "text_overlay"
    assert experiment["variable"] == "hook" and experiment["before"] == "Original"
    assert len(experiment["normalization_notes"]) == 1
    assert "existing physical opening" in experiment["normalization_notes"][0]
    assert d.store.get("clips", "parent") == unchanged_parent
    complete(d)
    assert d.engine().tick()[0]["status"] == "completed"
    assert d.store.get("clips", "draft")["approved"] is False
    assert d.store.get("clips", "parent") == unchanged_parent


@pytest.mark.parametrize("clip_changes,plan_changes,remove_key", [
    ({}, {}, None),  # No actual top-level facts.
    ({"opening_treatment": "text_overlay", "hook_rendered": False}, {}, None),
    ({"opening_treatment": "text_overlay", "hook_rendered": 1}, {}, None),
    ({"opening_treatment": "cold_open", "hook_rendered": True}, {}, None),
    ({"opening_treatment": "text_overlay", "hook_rendered": True}, {"hook_overlay": False}, None),
    ({"opening_treatment": "text_overlay", "hook_rendered": True}, {"hook": "  "}, None),
    ({"opening_treatment": "text_overlay", "hook_rendered": True}, {"cold_open_start": 0, "cold_open_end": 2}, None),
    ({"opening_treatment": "text_overlay", "hook_rendered": True}, {}, "opening_treatment"),
    ({"opening_treatment": "text_overlay", "hook_rendered": True}, {}, "hook_overlay"),
])
def test_nullable_or_missing_opening_is_not_guessed_without_consistent_saved_render_facts(domain, clip_changes, plan_changes, remove_key):
    d = domain
    parent = d.store.get("clips", "parent")
    raw = {**parent["edit_plan"], "opening_treatment": None, "hook_overlay": True, **plan_changes}
    if remove_key:
        raw.pop(remove_key)
    d.store.patch("clips", "parent", edit_plan=raw, **clip_changes)
    unchanged_parent = d.store.get("clips", "parent")
    d.publish()
    d.clock.advance(days=3)
    assert d.service.tick()[0]["status"] == "retry"
    assert d.service.list_experiments() == []
    assert d.calls["produce"] == 0
    assert d.store.get("clips", "parent") == unchanged_parent


def test_read_claims_prevent_concurrent_ticks_from_submitting_twice(domain):
    d = domain
    d.publish()
    d.clock.advance(days=3)
    started, release = Event(), Event()
    def collect(pub, policy):
        started.set()
        assert release.wait(3)
        return d.collect(pub, policy)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(d.engine(collect=collect).tick)
        assert started.wait(3)
        assert d.engine().tick() == []
        release.set()
        assert first.result()[0]["status"] == "queued"
    assert d.calls["produce"] == 1


def test_restart_after_analyzer_crash_reuses_snapshot_after_lease(domain):
    class Crash(BaseException):
        pass
    d = domain
    d.publish()
    d.clock.advance(days=3)
    def crash(_):
        raise Crash()
    with pytest.raises(Crash):
        d.engine(analyze=crash).tick()
    assert d.engine().tick() == []
    d.clock.advance(seconds=LearningEngine.LEASE.total_seconds() + 60)
    assert d.engine().tick()[0]["status"] == "queued"
    assert d.calls["collect"] == 1


def test_producer_exception_adopts_the_unique_saved_job_after_restart_without_retry(domain):
    d = domain
    d.publish()
    d.clock.advance(days=3)
    def lost(experiment):
        d.produce(experiment)
        raise RuntimeError("Response disappeared")
    assert d.engine(produce=lost).tick()[0]["status"] == "needs_reconciliation"
    d.clock.advance(days=6)
    assert d.engine().tick()[0]["status"] == "queued"
    assert d.calls["produce"] == 1
    experiment = d.service.list_experiments()[0]
    assert d.service.reconcile(experiment["id"], {"status": "queued", "job_id": "job-1"})["status"] == "queued"


def test_producer_crash_claim_recovers_the_existing_job_after_lease_without_resubmission(domain):
    class Crash(BaseException):
        pass
    d = domain
    d.publish()
    d.clock.advance(days=3)
    def crash(experiment):
        d.produce(experiment)
        raise Crash()
    with pytest.raises(Crash):
        d.engine(produce=crash).tick()
    d.clock.advance(seconds=LearningEngine.LEASE.total_seconds() + 60)
    assert d.engine().tick()[0]["status"] == "queued"
    assert d.service.list_work()[0]["status"] == "queued"
    assert d.calls["produce"] == 1


def test_known_pre_submit_failure_and_saved_failed_job_never_auto_retry_producer(domain):
    d = domain
    d.publish()
    d.clock.advance(days=3)
    result = d.engine(produce=lambda _: {"status": "failed", "detail": "No submission attempted; runtime unavailable."}).tick()[0]
    assert result["status"] == "failed"
    d.clock.advance(days=3)
    assert d.engine().tick()[0]["status"] == "duplicate"
    assert d.calls["produce"] == 0


def test_completed_receipt_requires_matching_unapproved_revision_and_actual_change(domain):
    d = domain
    d.publish()
    d.clock.advance(days=3)
    d.service.tick()
    experiment, _clip = complete(d, changes={"hook": "Original"})
    with pytest.raises(HTTPException):
        d.service.reconcile(experiment["id"], {"status": "completed", "job_id": "job-1", "clip_id": "draft"})
    d.store.patch("clips", "draft", edit_plan={**experiment["parent_edit_plan"], **experiment["render_request"]}, approved=True)
    with pytest.raises(HTTPException):
        d.service.reconcile(experiment["id"], {"status": "completed", "job_id": "job-1", "clip_id": "draft"})
    d.store.patch("clips", "draft", approved=False)
    assert d.service.reconcile(experiment["id"], {"status": "completed", "job_id": "job-1", "clip_id": "draft"})["status"] == "completed"
    assert d.service.reconcile(experiment["id"], {"status": "completed", "job_id": "job-1", "clip_id": "draft"})["status"] == "completed"


def test_foreign_producer_job_receipt_is_held_not_accepted(domain):
    d = domain
    d.publish()
    d.clock.advance(days=3)
    d.store.put("jobs", {"id": "foreign", "kind": "render", "status": "queued", "context": {"experiment_id": "elsewhere", "video_id": "source", "campaign_id": "foreign", "profile_id": "profile"}})
    assert d.engine(produce=lambda _: {"status": "queued", "job_id": "foreign"}).tick()[0]["status"] == "needs_reconciliation"
    assert d.service.list_experiments()[0]["job_id"] is None


def test_native_instagram_user_binding_is_not_the_composio_connected_account_id(domain):
    d = domain
    d.store.patch("connected_accounts", "account", instagram_user_id="178900000001")
    d.store.patch("clips", "parent", instagram_account_id="178900000001", instagram_media_id="post")
    assert d.publish()["account_id"] == "account"
    d.store.patch("clips", "parent", instagram_account_id="178900000002")
    with pytest.raises(HTTPException) as error:
        d.publish()
    assert error.value.status_code == 422


def test_missing_native_instagram_binding_cannot_be_inferred_from_composio_id(domain):
    d = domain
    d.store.patch("clips", "parent", instagram_account_id="account")
    with pytest.raises(HTTPException):
        d.publish()


def test_unknown_submit_without_any_job_stays_held_with_no_new_production(domain):
    d = domain
    d.publish()
    d.clock.advance(days=3)
    def lost(_):
        raise TimeoutError("Unknown before a receipt")
    assert d.engine(produce=lost).tick()[0]["status"] == "needs_reconciliation"
    d.clock.advance(days=6)
    assert d.engine().tick()[0]["status"] == "needs_reconciliation"
    assert "No exact tagged" in d.service.list_work()[0]["detail"]
    assert d.engine().tick() == []
    assert d.calls["produce"] == 0


def test_multiple_tagged_jobs_cannot_be_arbitrarily_adopted(domain):
    d = domain
    d.publish()
    d.clock.advance(days=3)
    def ambiguous(experiment):
        d.produce(experiment)
        d.produce(experiment)
        raise TimeoutError()
    d.engine(produce=ambiguous).tick()
    assert d.engine().tick()[0]["status"] == "needs_reconciliation"
    assert "Multiple exact tagged" in d.service.list_work()[0]["detail"]
    assert d.service.list_experiments()[0]["job_id"] is None
    assert d.engine().tick() == []
    assert d.calls["produce"] == 2


def test_unknown_effect_adopts_completed_exact_unapproved_draft_on_store_reopen(domain):
    d = domain
    d.publish()
    d.clock.advance(days=3)
    def lost(experiment):
        d.produce(experiment)
        raise TimeoutError()
    d.engine(produce=lost).tick()
    complete(d)
    reopened = LearningEngine(Store(d.store.path.parent), d.collect, d.analyze, d.produce, d.clock)
    assert reopened.tick()[0]["status"] == "completed"
    assert reopened.list_experiments()[0]["job_id"] == "job-1"
    assert reopened.list_experiments()[0]["clip_id"] == "draft"
    assert d.calls["produce"] == 1


def test_unknown_effect_adopts_failed_job_without_resubmitting(domain):
    d = domain
    d.publish()
    d.clock.advance(days=3)
    def lost(experiment):
        d.produce(experiment)
        raise TimeoutError()
    d.engine(produce=lost).tick()
    d.store.patch("jobs", "job-1", status="failed", error="Known worker failure")
    assert d.engine().tick()[0]["status"] == "failed"
    assert d.calls["produce"] == 1


def test_foreign_scoped_job_with_same_tag_does_not_resolve_unknown_submission(domain):
    d = domain
    d.publish()
    d.clock.advance(days=3)
    def lost(experiment):
        d.produce(experiment)
        d.store.patch("jobs", "job-1", context={"experiment_id": experiment["id"], "campaign_id": "foreign", "profile_id": "profile", "video_id": "source"})
        raise TimeoutError()
    d.engine(produce=lost).tick()
    assert d.engine().tick()[0]["status"] == "needs_reconciliation"
    assert "No exact tagged" in d.service.list_work()[0]["detail"]
    assert d.calls["produce"] == 1


def test_failed_render_is_recorded_after_store_reopen_without_resubmitting(domain):
    d = domain
    d.publish()
    d.clock.advance(days=3)
    d.service.tick()
    d.store.patch("jobs", "job-1", status="failed", error="Injected render failure")
    reopened = LearningEngine(Store(d.store.path.parent), d.collect, d.analyze, d.produce, d.clock)
    assert reopened.tick()[0]["status"] == "failed"
    assert reopened.list_experiments()[0]["status"] == "failed"
    assert d.calls["produce"] == 1
    assert reopened.tick() == []


def test_policy_revocation_during_analysis_stops_submission(domain):
    d = domain
    d.publish()
    d.clock.advance(days=3)
    def revoke(context):
        d.store.patch("learning_policies", d.policy["id"], enabled=False)
        return d.analyze(context)
    assert d.engine(analyze=revoke).tick()[0]["status"] == "blocked"
    assert d.calls["produce"] == 0


def test_completion_rejects_other_visual_changes_and_wrong_job_receipt(domain):
    d = domain
    d.publish()
    d.clock.advance(days=3)
    d.service.tick()
    experiment, _clip = complete(d, changes={"framing": "fill"})
    with pytest.raises(HTTPException):
        d.service.reconcile(experiment["id"], {"status": "completed", "job_id": "job-1"})
    d.store.patch("clips", "draft", edit_plan={**experiment["parent_edit_plan"], **experiment["render_request"]}, render_receipt={"job_id": "foreign"})
    with pytest.raises(HTTPException):
        d.service.reconcile(experiment["id"], {"status": "completed", "job_id": "job-1"})


def test_creator_may_accept_a_draft_before_the_next_learning_reconciliation(domain):
    d = domain
    d.publish()
    d.clock.advance(days=3)
    d.service.tick()
    experiment, _ = complete(d)
    finished = d.clock() - timedelta(seconds=1)
    d.store.patch("clips", "draft", approved=True, approved_at=d.clock().isoformat(), render_receipt={"job_id": "job-1", "finished_at": finished.isoformat(), "approval_state_at_creation": "unapproved"})
    assert d.engine().tick()[0]["status"] == "completed"
    assert d.store.get("clips", "draft")["approved"] is True
    assert d.service.read_experiment(experiment["id"])["clip_id"] == "draft"


@pytest.mark.parametrize("receipt,approved_at", [
    ({"job_id": "job-1", "finished_at": "2026-01-04T00:00:00Z"}, "2026-01-04T00:00:00Z"),
    ({"job_id": "job-1", "finished_at": "2026-01-04T00:00:00Z", "approval_state_at_creation": "unapproved"}, None),
    ({"job_id": "job-1", "finished_at": "2026-01-04T00:00:00Z", "approval_state_at_creation": "unapproved"}, "2026-01-04T00:00:00"),
    ({"job_id": "job-1", "finished_at": "2026-01-04T00:00:00Z", "approval_state_at_creation": "unapproved"}, "2026-01-03T23:59:00Z"),
    ({"job_id": "job-1", "finished_at": "2026-01-04T00:00:00Z", "approval_state_at_creation": "unapproved"}, "2026-01-05T00:00:00Z"),
])
def test_preapproved_or_unverifiable_review_results_are_not_treated_as_created_drafts(domain, receipt, approved_at):
    d = domain
    d.publish()
    d.clock.advance(days=3)
    d.service.tick()
    experiment, _ = complete(d)
    d.store.patch("clips", "draft", approved=True, approved_at=approved_at, render_receipt=receipt)
    with pytest.raises(HTTPException):
        d.service.reconcile(experiment["id"], {"status": "completed", "job_id": "job-1"})


def test_timestamps_and_metric_values_remain_strict_and_unknown_not_zero():
    with pytest.raises(ValidationError):
        Publication(policy_id="p", clip_id="c", account_id="a", media_id="m", published_at=datetime(2026, 1, 1), sha256="a"*64)
    with pytest.raises(ValidationError):
        MetricSnapshotInput(account_id="a", media_id="m", metrics={"views": float("nan")}, collected_at="2026-01-02T00:00:00Z", window_start="2026-01-01T00:00:00Z", window_end="2026-01-02T00:00:00Z", source="fixture")
    with pytest.raises(ValidationError):
        AnalysisResult(status="insufficient_evidence", variable="hook", proposed_hook="An unsupported winner", rationale="No data", limitations="Unknown")


def test_archived_campaign_rejects_policy_and_new_publication(domain):
    d = domain
    d.store.patch("campaigns", "campaign", archived_at="2026-01-01T00:00:00Z")
    with pytest.raises(HTTPException) as error:
        d.service.configure_policy({k: d.policy[k] for k in Policy.model_fields})
    assert error.value.status_code == 409
    with pytest.raises(HTTPException):
        d.publish()
    assert d.service.list_publications() == []


def test_archived_campaign_never_claims_new_due_learning_even_if_policy_left_enabled(domain):
    d = domain
    d.publish()
    d.clock.advance(days=4)
    d.store.patch("campaigns", "campaign", archived_at="2026-01-01T00:00:00Z")
    assert d.service.tick() == []
    assert d.service.list_work() == []
    assert d.service.list_snapshots() == []


def test_tick_with_missing_campaign_does_not_abort(domain):
    d = domain
    d.publish()
    d.clock.advance(days=4)
    d.store.delete("campaigns", "campaign")
    results = d.service.tick()
    assert [w["status"] for w in results] == ["blocked"]
