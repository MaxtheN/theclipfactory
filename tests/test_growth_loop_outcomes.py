# ruff: noqa: F811
from copy import deepcopy
from datetime import UTC, datetime, timedelta

import pytest
from test_growth_loop import complete, setup  # noqa: F401


@pytest.fixture
def measured(setup):
    loop, store, calls = setup
    receipt = loop.start_ab("p", request_id="observed", clip_ids=["c0"], expected_strategy_version_id="v1")
    complete(store, calls, 0)
    receipt = loop.reconcile(receipt["id"])
    origin = datetime.now(UTC) - timedelta(days=12)
    store.put("learning_policies", {"id": "policy", "profile_id": "p", "campaign_id": "camp",
                                   "account_id": "account", "cadence_days": 3})
    for side, clip_id, checksum, views in (("parent", "c0", store.get("clips", "c0")["sha256"], 200),
                                          ("variant", "out0", "d" * 64, 300)):
        publication_time = origin if side == "parent" else origin + timedelta(days=5)
        end = publication_time + timedelta(days=3)
        store.put("learning_publications", {"id": side, "clip_id": clip_id, "sha256": checksum,
            "policy_id": "policy", "account_id": "account", "media_id": "media-" + side,
            "published_at": publication_time.isoformat()})
        store.put("learning_snapshots", {"id": "snapshot-" + side, "publication_id": side,
            "clip_id": clip_id, "profile_id": "p", "campaign_id": "camp", "policy_id": "policy",
            "account_id": "account", "media_id": "media-" + side, "cumulative": True,
            "window_start": publication_time.isoformat(), "window_end": end.isoformat(),
            "collected_at": (end + timedelta(hours=2)).isoformat(), "source": "instagram_media_insights",
            "metrics": {"views": views, "likes": None}, "units": {"views": "count"}})
    return loop, store, receipt


def outcome(measured):
    loop, _, receipt = measured
    return loop.reconcile(receipt["id"])["slots"][0]["outcomes"]


def test_real_equal_age_observations_are_joined_and_evaluated(measured):
    result = outcome(measured)
    assert result["status"] == "compared"
    assert result["label"] == "real_observations"
    assert result["comparison"]["status"] == "favors_variant"
    assert result["comparison"]["difference"] == 100
    assert result["evidence_ids"] == ["snapshot-parent", "snapshot-variant"]
    assert result["parent"]["selected"]["actual_elapsed_hours"] == 72
    assert result["parent"]["selected"]["metrics"]["likes"] is None


def test_missing_publication_does_not_infer_account_or_measurement(measured):
    _, store, _ = measured
    store.delete("learning_publications", "variant")
    result = outcome(measured)
    assert result["status"] == "awaiting_publication"
    assert result["comparison"]["status"] == "insufficient_evidence"


def test_mixed_account_mappings_abstain(measured):
    _, store, _ = measured
    store.put("learning_policies", {"id": "different", "profile_id": "p", "campaign_id": "camp",
                                   "account_id": "second-account", "cadence_days": 3})
    store.patch("learning_publications", "variant", policy_id="different", account_id="second-account")
    result = outcome(measured)
    assert result["status"] == "incomparable"
    assert "same explicit Instagram account" in result["comparison"]["reasons"][0]


def test_incomplete_window_uses_actual_window_end_not_later_collection(measured):
    _, store, _ = measured
    snapshot = store.get("learning_snapshots", "snapshot-variant")
    start = datetime.fromisoformat(snapshot["window_start"])
    store.patch("learning_snapshots", snapshot["id"], window_end=(start + timedelta(hours=2)).isoformat())
    result = outcome(measured)
    assert result["status"] == "pending_window"
    assert result["variant"]["publications"][0]["snapshots"][0]["actual_elapsed_hours"] == 2


def test_later_cumulative_window_cannot_be_relabelled_as_declared_window(measured):
    _, store, _ = measured
    snapshot = store.get("learning_snapshots", "snapshot-variant")
    start = datetime.fromisoformat(snapshot["window_start"])
    end = start + timedelta(days=4)
    store.patch("learning_snapshots", snapshot["id"], window_end=end.isoformat(), collected_at=end.isoformat())
    result = outcome(measured)
    assert result["status"] == "incomparable"
    assert result["comparison"]["before_value"] is None


@pytest.mark.parametrize("changes", [{"simulated": True}, {"trigger": "demo_override", "real_elapsed_hours": 72}])
def test_demo_or_simulated_snapshots_do_not_contaminate_real_outcome(measured, changes):
    _, store, _ = measured
    store.patch("learning_snapshots", "snapshot-variant", **changes)
    result = outcome(measured)
    assert result["status"] == "awaiting_measurement"
    row = result["variant"]["publications"][0]["snapshots"][0]
    assert row["label"] in {"synthetic", "demo_override"}
    assert result["comparison"]["status"] == "insufficient_evidence"


def test_exact_revision_hash_and_profile_required(measured):
    _, store, _ = measured
    store.patch("learning_publications", "variant", sha256="f" * 64)
    assert outcome(measured)["status"] == "awaiting_publication"
    store.patch("learning_publications", "variant", sha256="d" * 64)
    store.patch("learning_snapshots", "snapshot-variant", profile_id="other")
    assert outcome(measured)["status"] == "awaiting_measurement"


def test_unsupported_or_missing_goal_does_not_pick_overall_winner(measured):
    loop, store, receipt = measured
    row = deepcopy(store.get("growth_loops", receipt["id"]))
    row["slots"][0]["measurement"]["metric"] = None
    store.put("growth_loops", row)
    assert outcome(measured)["status"] == "incomparable"
    assert loop.view("p")["loops"][0]["slots"][0]["outcomes"]["comparison"]["decision"] == "wait"
