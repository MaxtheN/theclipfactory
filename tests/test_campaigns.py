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
    Decision,
    Direction,
    Learning,
    Observation,
    Profile,
    Proposal,
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


def propose_initial(domain, profile=None):
    profile = profile or domain.a["id"]
    return domain.service.propose(
        profile, Proposal(direction=domain.directions[profile], reason="Initial workspace rules")
    )


def approve_initial(domain):
    """Approve workspace A's and workspace B's own rule sets; return A's."""
    approved = {}
    for profile in (domain.b["id"], domain.a["id"]):
        proposed = propose_initial(domain, profile)
        approved[profile] = domain.service.decision(profile, proposed["id"], approve=True)
    return approved[domain.a["id"]]


def active_id(domain, profile=None):
    return domain.store.get("profiles", profile or domain.a["id"]).get("active_strategy_id")


def revise(domain, base, profile=None, **direction):
    return domain.service.propose(
        profile or domain.a["id"],
        Proposal(
            base_version_id=base["id"] if base else None,
            direction=Direction(**direction),
            reason="Explicit workspace revision",
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


def test_initial_workspace_rules_require_explicit_approval_per_workspace(domain):
    d = domain
    assert "active_strategy_id" not in d.a
    assert_http(409, d.service.snapshot, d.campaign["id"], d.a["id"], d.videos[0]["id"])
    assert d.service.versions(d.a["id"]) == []
    proposed = propose_initial(d)
    assert proposed["status"] == "proposed"
    assert proposed["scope"] == "workspace"
    assert proposed["profile_id"] == d.a["id"]
    assert proposed["campaign_id"] is None
    assert proposed["version"] == 1
    assert proposed["base_version_id"] is None
    assert proposed["approved_at"] is None
    assert proposed["directions"] == {d.a["id"]: d.directions[d.a["id"]].model_dump()}
    assert active_id(d) is None
    assert_http(409, d.service.snapshot, d.campaign["id"], d.a["id"], d.videos[0]["id"])
    approved = d.service.decision(d.a["id"], proposed["id"], approve=True)
    assert approved["status"] == "approved"
    assert datetime.fromisoformat(approved["approved_at"]).utcoffset() == timedelta(0)
    assert active_id(d) == approved["id"]
    assert d.service.versions(d.a["id"]) == [approved]
    # Workspace B has its own (still missing) rule set: A's approval never covers it.
    assert active_id(d, d.b["id"]) is None
    assert_http(409, d.service.snapshot, d.campaign["id"], d.b["id"], d.videos[0]["id"])
    assert d.service.snapshot(d.campaign["id"], d.a["id"], d.videos[0]["id"])["strategy_version_id"] == approved["id"]
    # Campaign records never gain a rule pointer or an approval chain of their own.
    assert "active_strategy_id" not in d.store.get("campaigns", d.campaign["id"])
    for approve in (True, False):
        assert_http(409, d.service.decision, d.a["id"], approved["id"], approve=approve)
    assert_http(404, d.service.decision, d.b["id"], approved["id"], approve=True)


def test_every_campaign_in_a_workspace_inherits_its_rules_and_new_campaigns_need_no_approval(domain):
    d = domain
    initial = approve_initial(d)
    launch = d.service.save_campaign(
        Campaign(name="Episode launch", profile_ids=[d.a["id"]], video_ids=[d.videos[1]["id"]],
                 objective="traffic", primary_metric="full_episode_visits", notes="Lead with the guest's claim.")
    )
    snapshot = d.service.snapshot(launch["id"], d.a["id"], d.videos[1]["id"])
    assert snapshot["strategy_version_id"] == initial["id"]
    assert snapshot["strategy_scope"] == "workspace"
    assert snapshot["goal"] == {"objective": "traffic", "primary_metric": "full_episode_visits"}
    assert snapshot["campaign_notes"] == "Lead with the guest's claim."
    first = d.service.snapshot(d.campaign["id"], d.a["id"], d.videos[0]["id"])
    assert first["goal"] == {"objective": "discovery", "primary_metric": None}
    assert first["campaign_notes"] == ""
    revised = d.service.decision(d.a["id"], revise(d, initial, hooks=["Shared"])["id"], approve=True)
    for campaign, video in ((launch, d.videos[1]), (d.campaign, d.videos[0])):
        assert d.service.snapshot(campaign["id"], d.a["id"], video["id"])["strategy_version_id"] == revised["id"]


def test_campaign_goal_and_notes_are_campaign_scoped_and_kept_when_omitted(domain):
    d = domain
    with pytest.raises(ValidationError):
        Campaign(name="Goal", profile_ids=[d.a["id"]], objective="leads")
    assert Campaign(name="Explore", profile_ids=[d.a["id"]]).objective == "discovery"
    goal = d.service.save_campaign(
        Campaign(name="Leads", profile_ids=[d.a["id"]], objective="leads", primary_metric="signups", notes="Short")
    )
    other = d.service.save_campaign(Campaign(name="Explore", profile_ids=[d.a["id"]]))
    assert (goal["objective"], goal["primary_metric"]) == ("leads", "signups")
    assert (other["objective"], other["primary_metric"]) == ("discovery", None)
    # An update that omits the goal keeps it (older clients send only name/brief/membership).
    renamed = d.service.save_campaign(Campaign(name="Leads 2", profile_ids=[d.a["id"]]), goal["id"])
    assert (renamed["objective"], renamed["primary_metric"], renamed["notes"]) == ("leads", "signups", "Short")
    explored = d.service.save_campaign(
        Campaign(name="Leads 2", profile_ids=[d.a["id"]], objective="discovery", primary_metric="ignored"), goal["id"]
    )
    assert (explored["objective"], explored["primary_metric"]) == ("discovery", None)
    # Workspace edits never change a campaign goal; the legacy profile goal is kept when omitted.
    d.service.save_profile(Profile(name="Profile A"), d.a["id"])
    assert d.store.get("profiles", d.a["id"])["objective"] == "sales"
    assert d.store.get("campaigns", other["id"])["objective"] == "discovery"


def test_profile_saves_that_omit_the_brand_kit_keep_the_saved_one(domain):
    d = domain
    kit = {"font_family": "Inter", "primary_color": "#123456", "accent_color": "#ABCDEF"}
    d.service.save_profile(Profile(name="Profile A", brand_kit=kit), d.a["id"])
    # The Brand profile screen saves name, audience and voice without the kit: it is kept.
    d.service.save_profile(Profile(name="Renamed brand", audience="Founders"), d.a["id"])
    saved = d.store.get("profiles", d.a["id"])
    assert saved["name"] == "Renamed brand" and saved["brand_kit"]["primary_color"] == "#123456"
    # An explicit kit replaces it; an explicit null clears it.
    d.service.save_profile(Profile(name="Renamed brand", brand_kit={**kit, "accent_color": "#000000"}), d.a["id"])
    assert d.store.get("profiles", d.a["id"])["brand_kit"]["accent_color"] == "#000000"
    d.service.save_profile(Profile(name="Renamed brand", brand_kit=None), d.a["id"])
    assert d.store.get("profiles", d.a["id"])["brand_kit"] is None


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
        if key != "updated_at":
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
    assert updated["active_strategy_id"] == before["active_strategy_id"]
    assert d.service.profile(d.a["id"])["production_history"] == before["production_history"]
    reopened = Campaigns(Store(d.store.path.parent))
    assert reopened.profile(d.a["id"])["creative_preferences"] == "New preferences"
    assert reopened.profile(d.a["id"])["production_history"] == before["production_history"]


def test_exact_snapshots_are_deep_copies_and_edits_never_rewrite_prior_context(domain):
    d = domain
    initial = approve_initial(d)
    profile = d.store.get("profiles", d.a["id"])
    campaign = d.store.get("campaigns", d.campaign["id"])
    snapshot = d.service.snapshot(d.campaign["id"], d.a["id"], d.videos[0]["id"])
    assert snapshot == {
        "campaign_id": d.campaign["id"],
        "profile_id": d.a["id"],
        "video_id": d.videos[0]["id"],
        "strategy_version_id": initial["id"],
        "strategy_version": 1,
        "strategy_scope": "workspace",
        "strategy_snapshot": initial["directions"][d.a["id"]],
        "profile_snapshot": {k: v for k, v in profile.items() if k not in ("objective", "primary_metric")},
        "goal": {"objective": "discovery", "primary_metric": None},
        "campaign_notes": "",
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
    assert d.store.get("profiles", d.a["id"]) == profile
    assert d.store.get("campaigns", d.campaign["id"]) == campaign
    d.service.save_profile(Profile(name="Rebranded", creative_preferences="Different style"), d.a["id"])
    d.service.save_campaign(
        Campaign(
            name="Edited",
            brief=Brief(constraints=["New constraint"]),
            profile_ids=d.campaign["profile_ids"],
            video_ids=d.campaign["video_ids"],
            notes="Campaign-only note",
        ),
        d.campaign["id"],
    )
    proposed = revise(d, initial, angles=["New angle"])
    d.service.decision(d.a["id"], proposed["id"], approve=True)
    assert d.store.get("clips", "captured") == {"id": "captured", **original}
    assert d.store.get("strategy_versions", initial["id"]) == initial
    fresh = d.service.snapshot(d.campaign["id"], d.a["id"], d.videos[0]["id"])
    assert fresh["profile_snapshot"]["name"] == "Rebranded"
    assert fresh["brief_snapshot"]["constraints"] == ["New constraint"]
    assert fresh["campaign_notes"] == "Campaign-only note"
    assert fresh["strategy_version_id"] == proposed["id"]


def test_workspaces_keep_independent_rule_sets_and_history(domain):
    d = domain
    initial = approve_initial(d)
    b_initial = d.store.get("strategy_versions", active_id(d, d.b["id"]))
    revised = revise(d, initial, angles=["A only"], hooks=["A new hook"])
    assert revised["changed_profile_ids"] == [d.a["id"]]
    assert set(revised["directions"]) == {d.a["id"]}
    assert revised["version"] == 2
    assert (
        d.service.snapshot(d.campaign["id"], d.a["id"], d.videos[0]["id"])["strategy_version_id"]
        == initial["id"]
    )
    approved = d.service.decision(d.a["id"], revised["id"], approve=True)
    snap_a = d.service.snapshot(d.campaign["id"], d.a["id"], d.videos[1]["id"])
    snap_b = d.service.snapshot(d.campaign["id"], d.b["id"], d.videos[1]["id"])
    assert snap_a["strategy_snapshot"] == approved["directions"][d.a["id"]]
    assert snap_b["strategy_version_id"] == b_initial["id"]
    assert snap_b["strategy_snapshot"] == b_initial["directions"][d.b["id"]]
    assert d.service.versions(d.a["id"]) == [approved, initial]
    assert d.service.versions(d.b["id"]) == [b_initial]
    assert d.store.get("strategy_versions", initial["id"]) == initial


def test_stale_creation_and_approval_cannot_replace_active_strategy(domain):
    d = domain
    initial = approve_initial(d)
    first = revise(d, initial, hooks=["First"])
    stale = revise(d, initial, hooks=["Stale"])
    current = d.service.decision(d.a["id"], first["id"], approve=True)
    versions = d.service.versions(d.a["id"])
    assert_http(409, revise, d, initial, hooks=["Late proposal"])
    assert_http(409, revise, d, None, hooks=["Unbased proposal"])
    assert_http(409, d.service.decision, d.a["id"], stale["id"], approve=True)
    assert d.service.versions(d.a["id"]) == versions
    assert d.store.get("strategy_versions", stale["id"]) == stale
    assert active_id(d) == current["id"]


def test_rejection_retains_reason_and_leaves_active_direction_unchanged(domain):
    d = domain
    initial = approve_initial(d)
    proposed = revise(d, initial, hooks=["Rejected hook"])
    rejected = d.service.decision(d.a["id"], proposed["id"], approve=False, reason="Unsupported claim")
    assert rejected["status"] == "rejected"
    assert rejected["rejection_reason"] == "Unsupported claim"
    assert rejected["rejected_at"]
    assert rejected["approved_at"] is None
    assert active_id(d) == initial["id"]
    assert_http(409, d.service.decision, d.a["id"], proposed["id"], approve=True)
    assert_http(422, d.service.restore, d.a["id"], proposed["id"], Decision())


def test_restore_is_a_new_workspace_proposal_not_a_history_rewrite(domain):
    d = domain
    initial = approve_initial(d)
    a_change = revise(d, initial, hooks=["A changed"])
    a_current = d.service.decision(d.a["id"], a_change["id"], approve=True)
    b_before = d.store.get("strategy_versions", active_id(d, d.b["id"]))
    restored = d.service.restore(d.a["id"], initial["id"], Decision(reason="Return A to the original direction"))
    assert restored["status"] == "proposed"
    assert restored["base_version_id"] == a_current["id"]
    assert restored["restored_from"] == initial["id"]
    assert restored["version"] == 3
    assert restored["changed_profile_ids"] == [d.a["id"]]
    assert restored["directions"] == {d.a["id"]: initial["directions"][d.a["id"]]}
    assert active_id(d) == a_current["id"]
    d.service.decision(d.a["id"], restored["id"], approve=True)
    for version in (initial, a_current, b_before):
        assert d.store.get("strategy_versions", version["id"]) == version
    assert active_id(d, d.b["id"]) == b_before["id"]
    assert_http(404, d.service.restore, d.b["id"], initial["id"], Decision())


def test_archived_workspace_blocks_rule_changes_without_implicit_approval(domain):
    d = domain
    initial = approve_initial(d)
    pending = revise(d, initial, hooks=["Pending"])
    d.store.put("profiles", {**d.store.get("profiles", d.a["id"]), "archived_at": "2026-01-01T00:00:00+00:00"})
    assert_http(409, revise, d, initial, hooks=["Blocked"])
    assert_http(409, d.service.decision, d.a["id"], pending["id"], approve=True)
    assert_http(409, d.service.restore, d.a["id"], initial["id"], Decision())
    assert d.store.get("strategy_versions", pending["id"]) == pending
    assert active_id(d) == initial["id"]


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


def test_snapshot_rejects_nonmembers_and_a_new_member_workspace_needs_its_own_rules(domain):
    d = domain
    initial = approve_initial(d)
    outsider = d.service.save_profile(Profile(name="Outsider"))
    d.store.put("videos", {"id": "outside-source"})
    assert_http(422, d.service.snapshot, d.campaign["id"], outsider["id"], d.videos[0]["id"])
    assert_http(422, d.service.snapshot, d.campaign["id"], d.a["id"], "outside-source")
    assert_http(404, d.service.propose, "missing-workspace", Proposal(direction=Direction(), reason="No workspace"))
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
    # Campaign membership never changes a workspace's rule chain; the new member has none yet.
    assert_http(409, d.service.snapshot, d.campaign["id"], outsider["id"], d.videos[0]["id"])
    approved = d.service.decision(d.a["id"], proposal["id"], approve=True)
    assert active_id(d) == approved["id"]


@pytest.mark.parametrize("invalid", [object(), float("nan"), float("inf"), float("-inf")])
def test_store_put_many_serialization_failure_rolls_back_every_record(domain, invalid):
    d = domain
    initial = approve_initial(d)
    before = d.store.get("profiles", d.a["id"])
    with pytest.raises((TypeError, ValueError)):
        d.store.put_many(
            [
                ("profiles", {**before, "name": "Must not persist"}),
                ("strategy_versions", {**initial, "status": "Must not persist"}),
                ("campaign_observations", {"id": "bad", "value": invalid}),
            ]
        )
    assert d.store.get("profiles", d.a["id"]) == before
    assert d.store.get("strategy_versions", initial["id"]) == initial
    assert d.store.get("campaign_observations", "bad") is None
    reopened = Store(d.store.path.parent)
    assert reopened.get("profiles", d.a["id"]) == before
    assert reopened.get("strategy_versions", initial["id"]) == initial


@pytest.mark.parametrize("invalid", [object(), float("nan")])
def test_approval_serialization_failure_leaves_proposal_and_active_pointer_unchanged(
    domain, monkeypatch, invalid
):
    d = domain
    initial = approve_initial(d)
    proposed = revise(d, initial, hooks=["Must not become active"])
    before = d.store.get("profiles", d.a["id"])
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
        d.service.decision(d.a["id"], proposed["id"], approve=True)
    assert len(calls) == 1
    assert [kind for kind, _ in calls[0]] == ["strategy_versions", "profiles"]
    assert calls[0][0][1]["status"] == "approved"
    assert calls[0][1][1]["active_strategy_id"] == proposed["id"]
    assert d.store.get("strategy_versions", proposed["id"]) == proposed
    assert d.store.get("profiles", d.a["id"]) == before
    reopened = Store(d.store.path.parent)
    assert reopened.get("strategy_versions", proposed["id"]) == proposed
    assert reopened.get("profiles", d.a["id"]) == before
    monkeypatch.setattr(d.store, "put_many", actual_put_many)
    assert d.service.decision(d.a["id"], proposed["id"], approve=True)["status"] == "approved"


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
    d.service.decision(d.a["id"], proposed["id"], approve=True)
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


def test_cross_workspace_and_cross_campaign_evidence_and_strategy_refs_are_rejected(domain):
    d = domain
    initial = approve_initial(d)
    clip_b = seed_clip(d, profile=d.b["id"], identifier="b-evidence")
    b_evidence = d.service.observe(d.campaign["id"], observation_body(clip_b["id"]))
    other = d.service.save_campaign(
        Campaign(name="Other campaign", profile_ids=[d.a["id"]], video_ids=[d.videos[0]["id"]])
    )
    other_clip = d.store.put("clips", {**seed_clip(d, identifier="other-evidence"), "campaign_id": other["id"]})
    other_evidence = d.service.observe(other["id"], observation_body(other_clip["id"]))
    b_version = d.store.get("strategy_versions", active_id(d, d.b["id"]))
    before = d.service.versions(d.a["id"])
    # Another workspace's evidence never informs this workspace's rules.
    assert_http(422, revise, d, initial, evidence_refs=[b_evidence["id"]])
    # Campaign-scoped learning only cites that campaign's evidence.
    for evidence in (b_evidence, other_evidence):
        assert_http(422, d.service.learn, d.campaign["id"], learning_body(d, initial, [evidence["id"]]))
    assert_http(404, revise, d, initial, evidence_refs=["missing-observation"])
    assert_http(404, d.service.decision, d.a["id"], b_version["id"], approve=True)
    assert_http(404, d.service.restore, d.a["id"], b_version["id"], Decision())
    assert_http(
        409,
        d.service.propose,
        d.a["id"],
        Proposal(base_version_id=b_version["id"], direction=Direction(), reason="Foreign base"),
    )
    assert d.service.versions(d.a["id"]) == before
    # Evidence from another campaign in the SAME workspace can inform the shared workspace rules.
    cited = revise(d, initial, evidence_refs=[other_evidence["id"]])
    assert cited["directions"][d.a["id"]]["evidence_refs"] == [other_evidence["id"]]
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
    assert d.service.versions(d.a["id"]) == [initial]
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
    assert set(proposed["directions"]) == {d.a["id"]}
    assert body.proposed_direction.evidence_refs == []
    assert active_id(d) == initial["id"]
    approved = d.service.decision(d.a["id"], proposed["id"], approve=True)
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
    assert reopened.versions(d.a["id"]) == [approved, initial]
    assert reopened.observations(d.campaign["id"]) == [observation]
    assert reopened.store.get("clips", new_clip["id"]) == new_clip
    b_rules = reopened.store.get("strategy_versions", active_id(d, d.b["id"]))
    assert (
        reopened.snapshot(d.campaign["id"], d.b["id"], d.videos[1]["id"])["strategy_snapshot"]
        == b_rules["directions"][d.b["id"]]
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
    # The legacy brief shape stays valid; newer fields default.
    assert Brief(constraints=["No invented claims"], requested_outputs=["Vertical clip"]).model_dump() == {
        "audience": "",
        "key_messages": [],
        "cta": "",
        "cta_link": None,
        "must_include": [],
        "must_avoid": [],
        "tone": "",
        "references": [],
        "deliverables": {"clip_count": None, "max_duration_seconds": None, "platforms": ["instagram_reels"]},
        "context": "",
        "measurement_intent": "",
        "constraints": ["No invented claims"],
        "requested_outputs": ["Vertical clip"],
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
            return ("approved", service.decision(d.a["id"], proposal["id"], approve=True))
        except HTTPException as error:
            return ("conflict", error.status_code)

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(approve, proposals))
    assert sorted(result[0] for result in outcomes) == ["approved", "conflict"]
    assert next(result[1] for result in outcomes if result[0] == "conflict") == 409
    winner = next(result[1] for result in outcomes if result[0] == "approved")
    loser = next(proposal for proposal in proposals if proposal["id"] != winner["id"])
    assert active_id(d) == winner["id"]
    assert d.store.get("strategy_versions", loser["id"]) == loser
    assert d.store.get("strategy_versions", initial["id"]) == initial
    reopened = Campaigns(Store(d.store.path.parent))
    assert reopened.store.get("profiles", d.a["id"])["active_strategy_id"] == winner["id"]
    assert reopened.store.get("strategy_versions", winner["id"]) == winner
    assert reopened.store.get("strategy_versions", loser["id"]) == loser
    assert (
        reopened.snapshot(d.campaign["id"], d.a["id"], d.videos[0]["id"])["strategy_snapshot"]
        == winner["directions"][d.a["id"]]
    )
    assert_http(409, reopened.decision, d.a["id"], loser["id"], approve=True)


LIVE_PROFILE = "7e548b8d1f49455381ace8ee1944560c"
LIVE_CAMPAIGN = "8a58392142c44e1d8a9e5dc57d251bc7"
LIVE_ACTIVE = "1bba56db2a564ede8dfbff60384eb493"


def legacy_store(tmp_path):
    """Records shaped like data saved before workspace rules: rules on campaigns, goal on the profile."""
    store = Store(tmp_path / "legacy")
    direction = Direction(hooks=["Claim first"], editing_preferences="Readable captions.").model_dump()
    store.put("videos", {"id": "episode", "name": "Episode", "duration": 600})
    store.put("profiles", {"id": LIVE_PROFILE, "name": "All-In", "audience": "Founders", "brand_context": "Direct",
                           "objective": "traffic", "primary_metric": "full_episode_visits",
                           "creative_preferences": "", "created_at": "2026-10-01T00:00:00+00:00",
                           "updated_at": "2026-10-01T00:00:00+00:00"})
    campaigns = [
        {"id": LIVE_CAMPAIGN, "name": "Episode launch", "active_strategy_id": LIVE_ACTIVE},
        {"id": "campaign-two", "name": "Founder stories", "active_strategy_id": None},
        {"id": "campaign-three", "name": "Old test", "active_strategy_id": None},
        {"id": "campaign-four", "name": "Archived push", "active_strategy_id": None,
         "archived_at": "2026-10-20T00:00:00+00:00"},
    ]
    for campaign in campaigns:
        store.put("campaigns", {"brief": Brief().model_dump(), "profile_ids": [LIVE_PROFILE], "video_ids": ["episode"],
                                "created_at": "2026-10-02T00:00:00+00:00", "updated_at": "2026-10-02T00:00:00+00:00",
                                **campaign})

    def version(identifier, campaign, number, status, approved_at=None, base=None):
        return store.put("strategy_versions", {
            "id": identifier, "campaign_id": campaign, "version": number, "status": status, "base_version_id": base,
            "directions": {LIVE_PROFILE: {**direction, "hooks": [f"Hook v{number}"]}},
            "changed_profile_ids": [LIVE_PROFILE], "reason": f"v{number}", "hypothesis": "", "restored_from": None,
            "source": "manual", "created_at": f"2026-10-0{number + 2}T00:00:00+00:00", "approved_at": approved_at,
            "limitations": "Observational."})

    versions = [
        version("older-approved", LIVE_CAMPAIGN, 1, "approved", "2026-10-03T00:00:00+00:00"),
        version("rejected", LIVE_CAMPAIGN, 2, "rejected", base="older-approved"),
        version(LIVE_ACTIVE, LIVE_CAMPAIGN, 3, "approved", "2026-10-05T00:00:00+00:00", base="older-approved"),
        version("pending-other", "campaign-two", 1, "proposed"),
    ]
    clip = store.put("clips", {
        "id": "produced", "campaign_id": LIVE_CAMPAIGN, "profile_id": LIVE_PROFILE, "video_id": "episode",
        "strategy_version_id": LIVE_ACTIVE, "strategy_version": 3,
        "strategy_snapshot": versions[2]["directions"][LIVE_PROFILE],
        "profile_snapshot": store.get("profiles", LIVE_PROFILE), "brief_snapshot": Brief().model_dump(),
        "captured_at": "2026-10-06T00:00:00+00:00", "approved": True})
    return store, versions, clip


def test_legacy_live_shaped_data_adopts_campaign_rules_and_goals_idempotently(tmp_path):
    from clip_factory.campaigns import snapshot_goal

    store, versions, clip = legacy_store(tmp_path)
    before = {kind: {r["id"]: deepcopy(r) for r in store.all(kind)} for kind in ("campaigns", "strategy_versions")}
    service = Campaigns(store)
    profile = service.profile(LIVE_PROFILE)
    assert profile["active_strategy_id"] == LIVE_ACTIVE
    migration = profile["strategy_migration"]
    assert migration["provenance"] == "migrated_from_campaign"
    assert (migration["version_id"], migration["campaign_id"], migration["version"]) == (LIVE_ACTIVE, LIVE_CAMPAIGN, 3)
    assert migration["candidate_version_ids"] == sorted(["older-approved", LIVE_ACTIVE])
    # No version is rewritten; the production snapshot still names the exact version it used.
    assert {r["id"]: r for r in store.all("strategy_versions")} == before["strategy_versions"]
    assert store.get("clips", "produced") == clip
    assert snapshot_goal(clip) == {"objective": "traffic", "primary_metric": "full_episode_visits"}
    # Each campaign inherits the profile's goal once; nothing else about it changes.
    for row in service.list_campaigns(include_archived=True):
        old = before["campaigns"][row["id"]]
        assert (row["objective"], row["primary_metric"]) == ("traffic", "full_episode_visits")
        assert row["goal_provenance"]["source"] == "inherited_from_workspace"
        assert {k: v for k, v in row.items() if k not in ("objective", "primary_metric", "goal_provenance")} == old
    # Idempotent across reads and restarts.
    saved = {kind: {r["id"]: r for r in store.all(kind)} for kind in ("profiles", "campaigns")}
    reopened = Campaigns(Store(store.path.parent))
    reopened.profile(LIVE_PROFILE)
    reopened.list_campaigns(include_archived=True)
    assert {kind: {r["id"]: r for r in reopened.store.all(kind)} for kind in ("profiles", "campaigns")} == saved
    # History keeps every legacy version, read-only and marked by scope.
    history = reopened.versions(LIVE_PROFILE)
    assert {v["id"] for v in history} == {v["id"] for v in versions}
    assert {v["scope"] for v in history} == {"campaign"}
    # Every campaign in the workspace now inherits the adopted rules, including ones that had none.
    for campaign in (LIVE_CAMPAIGN, "campaign-two", "campaign-three"):
        snap = reopened.snapshot(campaign, LIVE_PROFILE, "episode", LIVE_ACTIVE)
        assert snap["strategy_version_id"] == LIVE_ACTIVE
        assert snap["goal"] == {"objective": "traffic", "primary_metric": "full_episode_visits"}
    assert_http(409, reopened.snapshot, "campaign-four", LIVE_PROFILE, "episode")
    # A legacy draft is never approved implicitly or through the workspace chain; it can be restored.
    assert_http(409, reopened.decision, LIVE_PROFILE, "pending-other", approve=True)
    draft = reopened.restore(LIVE_PROFILE, "pending-other", Decision(reason="Carry over"))
    assert (draft["scope"], draft["status"], draft["base_version_id"], draft["version"]) == (
        "workspace", "proposed", LIVE_ACTIVE, 4)
    assert reopened.store.get("profiles", LIVE_PROFILE)["active_strategy_id"] == LIVE_ACTIVE
    approved = reopened.decision(LIVE_PROFILE, draft["id"], approve=True)
    assert reopened.store.get("profiles", LIVE_PROFILE)["active_strategy_id"] == approved["id"]
    assert reopened.store.get("profiles", LIVE_PROFILE)["strategy_migration"] == migration
    assert {r["id"]: r for r in store.all("strategy_versions") if r["id"] != draft["id"]} == before["strategy_versions"]
    assert store.get("clips", "produced") == clip
    assert store.get("campaigns", LIVE_CAMPAIGN)["active_strategy_id"] == LIVE_ACTIVE


def test_migration_skips_profiles_with_workspace_rules_or_no_approved_campaign_rules(tmp_path):
    store, _, _ = legacy_store(tmp_path)
    for version in store.all("strategy_versions"):
        if version["status"] == "approved":
            store.put("strategy_versions", {**version, "status": "rejected"})
    service = Campaigns(store)
    assert "active_strategy_id" not in service.profile(LIVE_PROFILE)
    assert "strategy_migration" not in store.get("profiles", LIVE_PROFILE)
    store.put("campaigns", {**store.get("campaigns", "campaign-two"), "objective": "leads", "primary_metric": "signups"})
    assert service.require("campaigns", "campaign-two")["objective"] == "leads"
    assert "goal_provenance" not in store.get("campaigns", "campaign-two")


def test_old_brief_reads_complete_survives_omitted_brief_and_reaches_snapshot(domain):
    d = domain
    approve_initial(d)
    stored = d.store.get("campaigns", d.campaign["id"])
    legacy = {"audience": "Builders", "constraints": ["No guest names"], "requested_outputs": [],
              "measurement_intent": ""}
    d.store.put("campaigns", {**stored, "brief": legacy})
    read = d.service.require("campaigns", d.campaign["id"])
    assert read["brief"]["constraints"] == ["No guest names"] and read["brief"]["key_messages"] == []
    assert d.store.get("campaigns", d.campaign["id"])["brief"] == legacy  # reading does not rewrite
    # An update that omits the brief keeps it; one that sends it replaces it exactly.
    body = {k: read[k] for k in ("name", "profile_ids", "video_ids")}
    kept = d.service.save_campaign(Campaign(**body), d.campaign["id"])
    assert kept["brief"]["constraints"] == ["No guest names"] and kept["brief"]["cta"] == ""
    full = Brief(key_messages=["Agents need review"], cta="Listen to the full episode", must_avoid=["predictions"])
    saved = d.service.save_campaign(Campaign(**body, brief=full), d.campaign["id"])
    assert saved["brief"] == full.model_dump()
    snapshot = d.service.snapshot(d.campaign["id"], d.a["id"], d.videos[0]["id"])
    assert snapshot["brief_snapshot"] == full.model_dump()
