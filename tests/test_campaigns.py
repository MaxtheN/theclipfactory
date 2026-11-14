"""Offline domain regression tests: local records only, no app or media workers."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import UTC, datetime, timedelta, timezone
from threading import Barrier
from types import SimpleNamespace
from typing import get_args

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from clip_factory.campaigns import (
    Brief,
    Campaign,
    Campaigns,
    Direction,
    Learning,
    Observation,
    Profile,
    Proposal,
    Restore,
)
from clip_factory.store import Store
from clip_factory.team import Objective


@pytest.fixture
def domain(tmp_path):
    store = Store(tmp_path / "campaign-domain")
    service = Campaigns(store)
    videos = [
        store.put("videos", {"id": f"source-{n}", "name": f"Mock source {n}", "duration": 120})
        for n in (1, 2)
    ]
    a = service.save_profile(
        Profile(
            name="Profile A",
            audience="New creators",
            brand_context="Practical, source-backed demonstrations",
            objective="sales",
            primary_metric="qualified leads",
            creative_preferences="Keep the speaker's context; use clear captions.",
        )
    )
    b = service.save_profile(
        Profile(
            name="Profile B",
            audience="Experienced editors",
            brand_context="Technical education",
            creative_preferences="Slow pacing; no promotional hooks.",
        )
    )
    brief = Brief(
        audience="Independent creators",
        constraints=["No invented claims", "Preserve source context"],
        requested_outputs=["One vertical clip per profile", "Caption variants"],
        measurement_intent="Import known observations; do not infer missing values.",
    )
    campaign = service.save_campaign(
        Campaign(
            name="Local campaign",
            brief=brief,
            profile_ids=[a["id"], b["id"]],
            video_ids=[v["id"] for v in videos],
        )
    )
    directions = {
        a["id"]: Direction(
            angles=["Practical example"],
            hooks=["See the example"],
            editing_preferences="Retain the explanation",
            confidence="low",
        ),
        b["id"]: Direction(angles=["Technical detail"], hooks=["How this works"], pacing="Slow"),
    }
    return SimpleNamespace(
        store=store, service=service, a=a, b=b, videos=videos, campaign=campaign, directions=directions
    )


def propose_initial(domain):
    return domain.service.propose(
        domain.campaign["id"], Proposal(directions=domain.directions, reason="Initial account directions")
    )


def approve_initial(domain):
    proposed = propose_initial(domain)
    return domain.service.decision(domain.campaign["id"], proposed["id"], approve=True)


def revise(domain, base, profile=None, **direction):
    return domain.service.propose(
        domain.campaign["id"],
        Proposal(
            base_version_id=base["id"],
            directions={profile or domain.a["id"]: Direction(**direction)},
            reason="Explicit account-specific revision",
        ),
    )


def seed_clip(domain, *, profile=None, video=None, identifier="clip-a", approved=True, campaign=None):
    snapshot = domain.service.snapshot(
        domain.campaign["id"], profile or domain.a["id"], video or domain.videos[0]["id"]
    )
    return domain.store.put(
        "clips",
        {
            **snapshot,
            "id": identifier,
            "campaign_id": campaign or snapshot["campaign_id"],
            "start": 5.0,
            "end": 35.0,
            "hook": "A source-backed hook",
            "caption": "Original caption",
            "edit_plan": {"cuts": [{"start": 5.0, "end": 35.0}], "subtitles": True},
            "approved": approved,
            "status": "ready",
            "created_at": "2026-01-01T00:00:00+00:00",
        },
    )


def observation_body(clip_id, **changes):
    values = {
        "clip_id": clip_id,
        "metric": "qualified leads",
        "value": 12,
        "unit": "count",
        "publication_reference": "manual:creator-post-1",
        "window_start": datetime(2025, 1, 1, tzinfo=UTC),
        "window_end": datetime(2025, 1, 2, tzinfo=UTC),
        "collected_at": datetime(2025, 1, 3, tzinfo=UTC),
        "notes": "Imported observation; not a causal result.",
        **changes,
    }
    return Observation(**values)


def assert_http(status, operation, *args, **kwargs):
    with pytest.raises(HTTPException) as error:
        operation(*args, **kwargs)
    assert error.value.status_code == status
    return error.value


def test_initial_proposal_requires_explicit_approval_and_all_profiles(domain):
    d = domain
    assert d.campaign["active_strategy_id"] is None
    assert_http(409, d.service.snapshot, d.campaign["id"], d.a["id"], d.videos[0]["id"])
    assert_http(
        422,
        d.service.propose,
        d.campaign["id"],
        Proposal(directions={d.a["id"]: d.directions[d.a["id"]]}, reason="Incomplete"),
    )
    assert d.service.versions(d.campaign["id"]) == []
    proposed = propose_initial(d)
    assert proposed["status"] == "proposed"
    assert proposed["version"] == 1
    assert proposed["base_version_id"] is None
    assert proposed["approved_at"] is None
    assert proposed["directions"] == {key: value.model_dump() for key, value in d.directions.items()}
    assert d.store.get("campaigns", d.campaign["id"])["active_strategy_id"] is None
    assert_http(409, d.service.snapshot, d.campaign["id"], d.a["id"], d.videos[0]["id"])
    approved = d.service.decision(d.campaign["id"], proposed["id"], approve=True)
    assert approved["status"] == "approved"
    assert datetime.fromisoformat(approved["approved_at"]).utcoffset() == timedelta(0)
    assert d.store.get("campaigns", d.campaign["id"])["active_strategy_id"] == approved["id"]
    assert d.service.versions(d.campaign["id"]) == [approved]
    for approve in (True, False):
        assert_http(409, d.service.decision, d.campaign["id"], approved["id"], approve=approve)


def test_profile_context_and_profile_scoped_production_history_persist(domain):
    d = domain
    approve_initial(d)
    clip_a = seed_clip(d)
    seed_clip(d, profile=d.b["id"], identifier="clip-b")
    d.store.put("clips", {"id": "legacy", "video_id": d.videos[0]["id"]})
    before = d.service.profile(d.a["id"])
    keys = ("id", "video_id", "campaign_id", "strategy_version_id", "created_at", "approved", "status")
    assert before["production_history"] == [{key: clip_a[key] for key in keys}]
    for key, value in d.a.items():
        assert before[key] == value
    updated = d.service.save_profile(
        Profile(
            **{
                **Profile(**{k: d.a[k] for k in Profile.model_fields}).model_dump(),
                "creative_preferences": "New preferences",
            }
        ),
        d.a["id"],
    )
    assert updated["created_at"] == d.a["created_at"]
    assert d.service.profile(d.a["id"])["production_history"] == before["production_history"]
    reopened = Campaigns(Store(d.store.path.parent))
    assert reopened.profile(d.a["id"])["creative_preferences"] == "New preferences"
    assert reopened.profile(d.a["id"])["production_history"] == before["production_history"]


def test_exact_snapshots_are_deep_copies_and_edits_never_rewrite_prior_context(domain):
    d = domain
    initial = approve_initial(d)
    snapshot = d.service.snapshot(d.campaign["id"], d.a["id"], d.videos[0]["id"])
    assert snapshot == {
        "campaign_id": d.campaign["id"],
        "profile_id": d.a["id"],
        "video_id": d.videos[0]["id"],
        "strategy_version_id": initial["id"],
        "strategy_version": 1,
        "strategy_snapshot": initial["directions"][d.a["id"]],
        "profile_snapshot": d.a,
        "brief_snapshot": d.campaign["brief"],
        "captured_at": snapshot["captured_at"],
    }
    assert datetime.fromisoformat(snapshot["captured_at"]).utcoffset() == timedelta(0)
    original = deepcopy(snapshot)
    d.store.put("clips", {"id": "captured", **snapshot})
    snapshot["strategy_snapshot"]["angles"].append("Caller mutation")
    snapshot["profile_snapshot"]["name"] = "Caller mutation"
    snapshot["brief_snapshot"]["constraints"].append("Caller mutation")
    assert d.store.get("strategy_versions", initial["id"]) == initial
    assert d.store.get("profiles", d.a["id"]) == d.a
    assert d.store.get("campaigns", d.campaign["id"])["brief"] == d.campaign["brief"]
    d.service.save_profile(Profile(name="Rebranded", creative_preferences="Different style"), d.a["id"])
    d.service.save_campaign(
        Campaign(
            name="Edited",
            brief=Brief(constraints=["New constraint"]),
            profile_ids=d.campaign["profile_ids"],
            video_ids=d.campaign["video_ids"],
        ),
        d.campaign["id"],
    )
    proposed = revise(d, initial, angles=["New angle"])
    d.service.decision(d.campaign["id"], proposed["id"], approve=True)
    assert d.store.get("clips", "captured") == {"id": "captured", **original}
    assert d.store.get("strategy_versions", initial["id"]) == initial
    fresh = d.service.snapshot(d.campaign["id"], d.a["id"], d.videos[0]["id"])
    assert fresh["profile_snapshot"]["name"] == "Rebranded"
    assert fresh["brief_snapshot"]["constraints"] == ["New constraint"]
    assert fresh["strategy_version_id"] == proposed["id"]


def test_multiple_profiles_partial_revision_keeps_other_direction_and_history(domain):
    d = domain
    initial = approve_initial(d)
    revised = revise(d, initial, angles=["A only"], hooks=["A new hook"])
    assert revised["changed_profile_ids"] == [d.a["id"]]
    assert revised["directions"][d.b["id"]] == initial["directions"][d.b["id"]]
    assert (
        d.service.snapshot(d.campaign["id"], d.a["id"], d.videos[0]["id"])["strategy_version_id"]
        == initial["id"]
    )
    approved = d.service.decision(d.campaign["id"], revised["id"], approve=True)
    for profile in (d.a, d.b):
        snap = d.service.snapshot(d.campaign["id"], profile["id"], d.videos[1]["id"])
        assert snap["strategy_snapshot"] == approved["directions"][profile["id"]]
        assert snap["profile_snapshot"] == profile
    assert d.service.versions(d.campaign["id"]) == [approved, initial]
    assert d.store.get("strategy_versions", initial["id"]) == initial


def test_stale_creation_and_approval_cannot_replace_active_strategy(domain):
    d = domain
    initial = approve_initial(d)
    first = revise(d, initial, hooks=["First"])
    stale = revise(d, initial, hooks=["Stale"])
    current = d.service.decision(d.campaign["id"], first["id"], approve=True)
    versions = d.service.versions(d.campaign["id"])
    assert_http(409, revise, d, initial, hooks=["Late proposal"])
    assert_http(409, d.service.decision, d.campaign["id"], stale["id"], approve=True)
    assert d.service.versions(d.campaign["id"]) == versions
    assert d.store.get("strategy_versions", stale["id"]) == stale
    assert d.store.get("campaigns", d.campaign["id"])["active_strategy_id"] == current["id"]


def test_rejection_retains_reason_and_leaves_active_direction_unchanged(domain):
    d = domain
    initial = approve_initial(d)
    proposed = revise(d, initial, hooks=["Rejected hook"])
    rejected = d.service.decision(d.campaign["id"], proposed["id"], approve=False, reason="Unsupported claim")
    assert rejected["status"] == "rejected"
    assert rejected["rejection_reason"] == "Unsupported claim"
    assert rejected["rejected_at"]
    assert rejected["approved_at"] is None
    assert d.store.get("campaigns", d.campaign["id"])["active_strategy_id"] == initial["id"]
    assert_http(409, d.service.decision, d.campaign["id"], proposed["id"], approve=True)
    assert_http(422, d.service.restore, d.campaign["id"], proposed["id"], Restore(profile_id=d.a["id"]))


def test_restore_is_a_new_profile_specific_proposal_not_a_history_rewrite(domain):
    d = domain
    initial = approve_initial(d)
    a_change = revise(d, initial, hooks=["A changed"])
    a_current = d.service.decision(d.campaign["id"], a_change["id"], approve=True)
    b_change = revise(d, a_current, profile=d.b["id"], hooks=["B changed"])
    current = d.service.decision(d.campaign["id"], b_change["id"], approve=True)
    restored = d.service.restore(
        d.campaign["id"],
        initial["id"],
        Restore(profile_id=d.a["id"], reason="Return A to the original direction"),
    )
    assert restored["status"] == "proposed"
    assert restored["base_version_id"] == current["id"]
    assert restored["restored_from"] == initial["id"]
    assert restored["version"] == 4
    assert restored["changed_profile_ids"] == [d.a["id"]]
    assert restored["directions"][d.a["id"]] == initial["directions"][d.a["id"]]
    assert restored["directions"][d.b["id"]] == current["directions"][d.b["id"]]
    assert d.store.get("campaigns", d.campaign["id"])["active_strategy_id"] == current["id"]
    d.service.decision(d.campaign["id"], restored["id"], approve=True)
    for version in (initial, a_current, current):
        assert d.store.get("strategy_versions", version["id"]) == version
    assert_http(422, d.service.restore, d.campaign["id"], initial["id"], Restore(profile_id="outsider"))


@pytest.mark.parametrize("member", ["profile", "video"])
def test_campaign_membership_requires_existing_records_and_cannot_be_narrowed(domain, member):
    d = domain
    body = {"name": "Invalid", "profile_ids": d.campaign["profile_ids"], "video_ids": d.campaign["video_ids"]}
    body[f"{member}_ids"] = ["missing"]
    assert_http(404, d.service.save_campaign, Campaign(**body))
    body[f"{member}_ids"] = d.campaign[f"{member}_ids"][:1]
    assert_http(409, d.service.save_campaign, Campaign(**body), d.campaign["id"])
    assert d.store.get("campaigns", d.campaign["id"]) == d.campaign


@pytest.mark.parametrize("field", ["profile_ids", "video_ids"])
def test_duplicate_campaign_members_are_invalid(domain, field):
    values = {
        "name": "Duplicate",
        "profile_ids": domain.campaign["profile_ids"],
        "video_ids": domain.campaign["video_ids"],
    }
    values[field] = [values[field][0]] * 2
    with pytest.raises(ValidationError):
        Campaign(**values)


def test_snapshot_and_proposal_reject_nonmembers_and_membership_change_blocks_approval(domain):
    d = domain
    initial = approve_initial(d)
    outsider = d.service.save_profile(Profile(name="Outsider"))
    d.store.put("videos", {"id": "outside-source"})
    assert_http(422, d.service.snapshot, d.campaign["id"], outsider["id"], d.videos[0]["id"])
    assert_http(422, d.service.snapshot, d.campaign["id"], d.a["id"], "outside-source")
    assert_http(422, revise, d, initial, profile=outsider["id"])
    proposal = revise(d, initial, hooks=["Pending"])
    d.service.save_campaign(
        Campaign(
            name="Expanded",
            brief=Brief(**d.campaign["brief"]),
            profile_ids=[*d.campaign["profile_ids"], outsider["id"]],
            video_ids=d.campaign["video_ids"],
        ),
        d.campaign["id"],
    )
    assert_http(409, d.service.decision, d.campaign["id"], proposal["id"], approve=True)
    assert d.store.get("strategy_versions", proposal["id"]) == proposal
    assert d.store.get("campaigns", d.campaign["id"])["active_strategy_id"] == initial["id"]


@pytest.mark.parametrize("invalid", [object(), float("nan"), float("inf"), float("-inf")])
def test_store_put_many_serialization_failure_rolls_back_every_record(domain, invalid):
    d = domain
    initial = approve_initial(d)
    before = d.store.get("campaigns", d.campaign["id"])
    with pytest.raises((TypeError, ValueError)):
        d.store.put_many(
            [
                ("campaigns", {**before, "name": "Must not persist"}),
                ("strategy_versions", {**initial, "status": "Must not persist"}),
                ("campaign_observations", {"id": "bad", "value": invalid}),
            ]
        )
    assert d.store.get("campaigns", d.campaign["id"]) == before
    assert d.store.get("strategy_versions", initial["id"]) == initial
    assert d.store.get("campaign_observations", "bad") is None
    reopened = Store(d.store.path.parent)
    assert reopened.get("campaigns", d.campaign["id"]) == before
    assert reopened.get("strategy_versions", initial["id"]) == initial


@pytest.mark.parametrize("invalid", [object(), float("nan")])
def test_approval_serialization_failure_leaves_proposal_and_active_pointer_unchanged(
    domain, monkeypatch, invalid
):
    d = domain
    initial = approve_initial(d)
    proposed = revise(d, initial, hooks=["Must not become active"])
    before = d.store.get("campaigns", d.campaign["id"])
    actual_put_many = d.store.put_many
    calls = []

    def fail_serialization(records):
        calls.append(deepcopy(records))
        # Exercise the real serializer on the second approval record, not a stubbed exception.
        broken = deepcopy(records)
        broken[1][1]["unserializable"] = invalid
        actual_put_many(broken)

    monkeypatch.setattr(d.store, "put_many", fail_serialization)
    with pytest.raises((TypeError, ValueError)):
        d.service.decision(d.campaign["id"], proposed["id"], approve=True)
    assert len(calls) == 1
    assert [kind for kind, _ in calls[0]] == ["strategy_versions", "campaigns"]
    assert calls[0][0][1]["status"] == "approved"
    assert calls[0][1][1]["active_strategy_id"] == proposed["id"]
    assert d.store.get("strategy_versions", proposed["id"]) == proposed
    assert d.store.get("campaigns", d.campaign["id"]) == before
    reopened = Store(d.store.path.parent)
    assert reopened.get("strategy_versions", proposed["id"]) == proposed
    assert reopened.get("campaigns", d.campaign["id"]) == before
    monkeypatch.setattr(d.store, "put_many", actual_put_many)
    assert d.service.decision(d.campaign["id"], proposed["id"], approve=True)["status"] == "approved"


def test_imported_observations_preserve_null_and_exact_immutable_clip_context(domain):
    d = domain
    initial = approve_initial(d)
    clip = seed_clip(d)
    body = observation_body(clip["id"], value=None)
    observation = d.service.observe(d.campaign["id"], body)
    keys = ("id", "video_id", "start", "end", "hook", "caption", "edit_plan", "approved", "created_at")
    assert observation == {
        **body.model_dump(mode="json"),
        "id": observation["id"],
        "campaign_id": d.campaign["id"],
        "profile_id": d.a["id"],
        "strategy_version_id": initial["id"],
        "clip_snapshot": {key: clip[key] for key in keys},
        "created_at": observation["created_at"],
        "kind": "performance",
    }
    assert observation["value"] is None
    assert observation["source"] == "manual_import"
    original = deepcopy(observation)
    clip["edit_plan"]["cuts"][0]["start"] = 9
    clip["caption"] = "Changed caption"
    clip["approved"] = False
    d.store.put("clips", clip)
    observation["clip_snapshot"]["edit_plan"]["cuts"].clear()
    observation["value"] = 0
    d.service.save_profile(Profile(name="Renamed A"), d.a["id"])
    proposed = revise(d, initial, hooks=["Changed strategy"])
    d.service.decision(d.campaign["id"], proposed["id"], approve=True)
    assert d.service.observations(d.campaign["id"]) == [original]
    assert Campaigns(Store(d.store.path.parent)).observations(d.campaign["id"]) == [original]
    assert original["value"] is None


@pytest.mark.parametrize(
    "changes,status",
    [({"approved": False}, 409), ({"campaign_id": "other-campaign"}, 422), ({"profile_id": None}, 422)],
)
def test_observations_require_approved_campaign_associated_clips(domain, changes, status):
    d = domain
    approve_initial(d)
    clip = seed_clip(d)
    d.store.patch("clips", clip["id"], **changes)
    assert_http(status, d.service.observe, d.campaign["id"], observation_body(clip["id"]))
    assert d.service.observations(d.campaign["id"]) == []


def test_missing_clip_cannot_be_observed(domain):
    assert_http(404, domain.service.observe, domain.campaign["id"], observation_body("missing"))


def learning_body(domain, base, refs, profile=None):
    return Learning(
        profile_id=profile or domain.a["id"],
        observation_ids=refs,
        hypothesis="A clearer source example may improve qualified responses.",
        reason="Known imported evidence suggests a test, not proven lift.",
        base_version_id=base["id"],
        proposed_direction=Direction(hooks=["Try the concrete example"], confidence="low"),
    )


def test_cross_profile_and_cross_campaign_evidence_and_strategy_refs_are_rejected(domain):
    d = domain
    initial = approve_initial(d)
    clip_b = seed_clip(d, profile=d.b["id"], identifier="b-evidence")
    b_evidence = d.service.observe(d.campaign["id"], observation_body(clip_b["id"]))
    other = d.service.save_campaign(
        Campaign(name="Other campaign", profile_ids=[d.a["id"]], video_ids=[d.videos[0]["id"]])
    )
    other_proposal = d.service.propose(
        other["id"], Proposal(directions={d.a["id"]: Direction()}, reason="Other")
    )
    other_version = d.service.decision(other["id"], other_proposal["id"], approve=True)
    other_clip = d.store.put(
        "clips",
        {
            **seed_clip(d, identifier="other-evidence"),
            "campaign_id": other["id"],
            "strategy_version_id": other_version["id"],
        },
    )
    other_evidence = d.service.observe(other["id"], observation_body(other_clip["id"]))
    before = d.service.versions(d.campaign["id"])
    for evidence in (b_evidence, other_evidence):
        assert_http(422, revise, d, initial, evidence_refs=[evidence["id"]])
        assert_http(422, d.service.learn, d.campaign["id"], learning_body(d, initial, [evidence["id"]]))
    assert_http(404, revise, d, initial, evidence_refs=["missing-observation"])
    assert_http(404, d.service.decision, d.campaign["id"], other_version["id"], approve=True)
    assert_http(422, d.service.restore, d.campaign["id"], other_version["id"], Restore(profile_id=d.a["id"]))
    assert_http(
        409,
        d.service.propose,
        d.campaign["id"],
        Proposal(
            base_version_id=other_version["id"], directions={d.a["id"]: Direction()}, reason="Foreign base"
        ),
    )
    assert d.service.versions(d.campaign["id"]) == before
    assert d.service.observations(d.campaign["id"]) == [b_evidence]
    assert d.service.observations(other["id"]) == [other_evidence]


def test_unavailable_metric_cannot_establish_measured_learning(domain):
    d = domain
    initial = approve_initial(d)
    clip = seed_clip(d)
    unknown = d.service.observe(d.campaign["id"], observation_body(clip["id"], value=None))
    known = d.service.observe(d.campaign["id"], observation_body(clip["id"], value=0))
    assert_http(
        422, d.service.learn, d.campaign["id"], learning_body(d, initial, [known["id"], unknown["id"]])
    )
    assert d.service.versions(d.campaign["id"]) == [initial]
    assert d.store.get("campaign_observations", unknown["id"])["value"] is None


def test_known_evidence_learns_approved_a_revision_keeps_b_and_new_source_provenance(domain):
    d = domain
    initial = approve_initial(d)
    old_clip = seed_clip(d)
    observation = d.service.observe(d.campaign["id"], observation_body(old_clip["id"], value=0))
    body = learning_body(d, initial, [observation["id"], observation["id"]])
    proposed = d.service.learn(d.campaign["id"], body)
    assert proposed["status"] == "proposed"
    assert proposed["hypothesis"] == body.hypothesis
    assert proposed["reason"] == body.reason
    assert proposed["changed_profile_ids"] == [d.a["id"]]
    assert (
        proposed["directions"][d.a["id"]]
        == body.proposed_direction.model_copy(update={"evidence_refs": [observation["id"]]}).model_dump()
    )
    assert proposed["directions"][d.b["id"]] == initial["directions"][d.b["id"]]
    assert body.proposed_direction.evidence_refs == []
    assert d.store.get("campaigns", d.campaign["id"])["active_strategy_id"] == initial["id"]
    approved = d.service.decision(d.campaign["id"], proposed["id"], approve=True)
    new_clip = seed_clip(d, video=d.videos[1]["id"], identifier="new-source-clip")
    assert approved["status"] == "approved"
    assert new_clip["video_id"] != old_clip["video_id"]
    assert new_clip["strategy_version_id"] == approved["id"] != old_clip["strategy_version_id"]
    assert new_clip["strategy_version"] == 2
    assert new_clip["strategy_snapshot"]["evidence_refs"] == [observation["id"]]
    assert d.store.get("clips", old_clip["id"]) == old_clip
    assert d.store.get("campaign_observations", observation["id"]) == observation
    assert observation["strategy_version_id"] == initial["id"]
    assert observation["clip_snapshot"]["video_id"] == d.videos[0]["id"]
    assert d.store.get("strategy_versions", initial["id"]) == initial
    assert_http(409, d.service.learn, d.campaign["id"], body)
    reopened = Campaigns(Store(d.store.path.parent))
    assert reopened.versions(d.campaign["id"]) == [approved, initial]
    assert reopened.observations(d.campaign["id"]) == [observation]
    assert reopened.store.get("clips", new_clip["id"]) == new_clip
    assert (
        reopened.snapshot(d.campaign["id"], d.b["id"], d.videos[1]["id"])["strategy_snapshot"]
        == initial["directions"][d.b["id"]]
    )


@pytest.mark.parametrize(
    "changes",
    [
        {"window_start": datetime(2025, 1, 1)},
        {"window_end": datetime(2025, 1, 2)},
        {"collected_at": datetime(2025, 1, 3)},
        {"window_end": datetime(2025, 1, 1, tzinfo=UTC)},
        {"window_end": datetime(2024, 12, 31, tzinfo=UTC)},
        {"collected_at": datetime(2025, 1, 1, tzinfo=UTC)},
        {"collected_at": datetime.now(UTC) + timedelta(days=2)},
    ],
)
def test_observation_window_requires_timezones_positive_duration_and_nonfuture_collection(changes):
    with pytest.raises(ValidationError):
        observation_body("clip", **changes)


def test_observation_accepts_equivalent_timezones_and_collection_at_window_end():
    offset = timezone(timedelta(hours=5, minutes=30))
    body = observation_body(
        "clip",
        window_start=datetime(2025, 1, 1, 5, 30, tzinfo=offset),
        window_end=datetime(2025, 1, 2, tzinfo=UTC),
        collected_at=datetime(2025, 1, 2, 5, 30, tzinfo=offset),
    )
    assert body.window_start == datetime(2025, 1, 1, tzinfo=UTC)
    assert body.collected_at == body.window_end


@pytest.mark.parametrize(
    "changes",
    [
        {"value": -1},
        {"value": float("nan")},
        {"value": float("inf")},
        {"unit": "percent", "value": 101},
        {"unit": "count", "value": 1.5},
        {"metric": " "},
        {"unit": " "},
        {"publication_reference": " "},
        {"source": "inferred"},
    ],
)
def test_observation_rejects_invalid_metrics_and_non_imported_sources(changes):
    with pytest.raises(ValidationError):
        observation_body("clip", **changes)


@pytest.mark.parametrize("objective", get_args(Objective))
def test_goal_profiles_require_primary_metric_but_discovery_does_not(objective):
    if objective == "discovery":
        assert Profile(name="Exploration", objective=objective).primary_metric is None
    else:
        for metric in (None, "", "  "):
            with pytest.raises(ValidationError):
                Profile(name="Goal", objective=objective, primary_metric=metric)
    assert (
        Profile(name="Account", objective=objective, primary_metric="qualified leads").primary_metric
        == "qualified leads"
    )


def test_profile_and_brief_use_text_preferences_and_string_arrays():
    assert Profile(name="A", creative_preferences="Plain text").creative_preferences == "Plain text"
    assert Brief(constraints=["No invented claims"], requested_outputs=["Vertical clip"]).model_dump() == {
        "audience": "",
        "constraints": ["No invented claims"],
        "requested_outputs": ["Vertical clip"],
        "measurement_intent": "",
    }
    for invalid in ([], ["preference"], {"preference": "text"}):
        with pytest.raises(ValidationError):
            Profile(name="A", creative_preferences=invalid)
    for field in ("constraints", "requested_outputs"):
        for invalid in ("not an array", [1], [{"text": "not a string"}]):
            with pytest.raises(ValidationError):
                Brief(**{field: invalid})


@pytest.mark.parametrize("race", range(3))
def test_two_same_base_approvals_race_exactly_one_wins_and_restart_persists(domain, race):
    d = domain
    initial = approve_initial(d)
    proposals = [revise(d, initial, hooks=[f"Contender {race}-{n}"]) for n in range(2)]
    barrier = Barrier(2)

    def approve(proposal):
        # Two service instances share the application's Store and its transaction lock.
        service = Campaigns(d.store)
        barrier.wait(timeout=5)
        try:
            return ("approved", service.decision(d.campaign["id"], proposal["id"], approve=True))
        except HTTPException as error:
            return ("conflict", error.status_code)

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(approve, proposals))
    assert sorted(result[0] for result in outcomes) == ["approved", "conflict"]
    assert next(result[1] for result in outcomes if result[0] == "conflict") == 409
    winner = next(result[1] for result in outcomes if result[0] == "approved")
    loser = next(proposal for proposal in proposals if proposal["id"] != winner["id"])
    assert d.store.get("campaigns", d.campaign["id"])["active_strategy_id"] == winner["id"]
    assert d.store.get("strategy_versions", loser["id"]) == loser
    assert d.store.get("strategy_versions", initial["id"]) == initial
    reopened = Campaigns(Store(d.store.path.parent))
    assert reopened.store.get("campaigns", d.campaign["id"])["active_strategy_id"] == winner["id"]
    assert reopened.store.get("strategy_versions", winner["id"]) == winner
    assert reopened.store.get("strategy_versions", loser["id"]) == loser
    assert (
        reopened.snapshot(d.campaign["id"], d.a["id"], d.videos[0]["id"])["strategy_snapshot"]
        == winner["directions"][d.a["id"]]
    )
    assert_http(409, reopened.decision, d.campaign["id"], loser["id"], approve=True)
