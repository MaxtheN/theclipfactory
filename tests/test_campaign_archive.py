"""Reversible campaign cleanup in isolated stores; no app/model/provider or live data."""

import copy
import sqlite3
from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from clip_factory.campaign_api import install
from clip_factory.campaigns import Campaign, Campaigns, Direction, Proposal, Restore
from clip_factory.store import Store


@pytest.fixture
def domain(tmp_path):
    store = Store(tmp_path / "archive-fixture")
    service = Campaigns(store)
    direction = Direction(hooks=["Original"], duration_seconds=30).model_dump()
    rows = [
        ("profiles", {"id": "profile", "name": "Fixture profile"}),
        (
            "connected_accounts",
            {"id": "account", "profile_id": "profile", "provider": "fixture", "status": "active"},
        ),
        ("videos", {"id": "source", "path": "source.mp4", "duration": 60}),
        (
            "clips",
            {
                "id": "clip",
                "campaign_id": "campaign",
                "profile_id": "profile",
                "video_id": "source",
                "path": "clip.mp4",
                "approved": False,
                "sha256": "a" * 64,
            },
        ),
        ("clips", {"id": "foreign-clip", "campaign_id": "foreign", "video_id": "source"}),
        (
            "campaigns",
            {
                "id": "campaign",
                "name": "Old test",
                "profile_ids": ["profile"],
                "video_ids": ["source"],
                "active_strategy_id": "strategy",
                "brief": {},
                "created_at": "old",
                "updated_at": "old",
            },
        ),
        (
            "campaigns",
            {
                "id": "foreign",
                "name": "Keep working",
                "profile_ids": ["profile"],
                "video_ids": ["source"],
                "active_strategy_id": None,
                "brief": {},
            },
        ),
        (
            "strategy_versions",
            {
                "id": "strategy",
                "campaign_id": "campaign",
                "version": 1,
                "status": "approved",
                "directions": {"profile": direction},
            },
        ),
        (
            "strategy_versions",
            {
                "id": "pending",
                "campaign_id": "campaign",
                "version": 2,
                "status": "proposed",
                "base_version_id": "strategy",
                "directions": {"profile": direction},
            },
        ),
        (
            "campaign_observations",
            {
                "id": "observation",
                "campaign_id": "campaign",
                "profile_id": "profile",
                "clip_id": "clip",
                "value": 0,
            },
        ),
        (
            "learning_policies",
            {
                "id": "policy",
                "campaign_id": "campaign",
                "profile_id": "profile",
                "enabled": True,
                "cadence_days": 3,
                "updated_at": "old",
            },
        ),
        (
            "learning_policies",
            {"id": "already-paused", "campaign_id": "campaign", "enabled": False, "updated_at": "old"},
        ),
        ("learning_policies", {"id": "foreign-policy", "campaign_id": "foreign", "enabled": True}),
        (
            "learning_experiments",
            {"id": "experiment", "campaign_id": "campaign", "status": "completed", "clip_id": "clip"},
        ),
        ("exports", {"id": "export", "clip_id": "clip", "sha256": "a" * 64}),
        (
            "team_runs",
            {
                "id": "related-run",
                "video_id": "source",
                "status": "needs_review",
                "context": {"campaign_snapshot": {"campaign_id": "campaign"}},
            },
        ),
        (
            "team_runs",
            {
                "id": "foreign-run",
                "video_id": "source",
                "status": "needs_review",
                "context": {"campaign_snapshot": {"campaign_id": "foreign"}},
            },
        ),
    ]
    for kind, row in rows:
        store.put(kind, row)
    (tmp_path / "archive-fixture/source.mp4").write_bytes(b"preserve exact source bytes")
    (tmp_path / "archive-fixture/clip.mp4").write_bytes(b"preserve exact rendered bytes")
    return SimpleNamespace(store=store, service=service, root=tmp_path / "archive-fixture")


def snapshot(store):
    with store.connect() as db:
        return {
            (kind, identifier): data
            for kind, identifier, data in db.execute("select kind,id,data from records")
        }


def test_archive_is_idempotent_and_preserves_all_evidence_and_media(domain):
    d = domain
    before = snapshot(d.store)
    first = d.service.archive("campaign")
    assert datetime.fromisoformat(first["archived_at"]).tzinfo is not None
    assert not d.store.get("learning_policies", "policy")["enabled"]
    after = snapshot(d.store)
    assert {
        key: value
        for key, value in before.items()
        if key not in {("campaigns", "campaign"), ("learning_policies", "policy")}
    } == {
        key: value
        for key, value in after.items()
        if key not in {("campaigns", "campaign"), ("learning_policies", "policy")}
    }
    assert d.store.get("learning_policies", "foreign-policy")["enabled"] is True
    assert d.store.get("learning_policies", "already-paused")["updated_at"] == "old"
    assert (d.root / "source.mp4").read_bytes() == b"preserve exact source bytes"
    assert (d.root / "clip.mp4").read_bytes() == b"preserve exact rendered bytes"
    assert d.service.archive("campaign") == first and snapshot(d.store) == after
    assert [v["id"] for v in d.service.versions("campaign")] == ["pending", "strategy"]
    assert d.service.observations("campaign")[0]["id"] == "observation"


def test_restore_is_idempotent_and_never_reactivates_learning(domain):
    d = domain
    d.service.archive("campaign")
    restored = d.service.restore_campaign("campaign")
    assert restored["archived_at"] is None and restored["restored_at"]
    assert d.service.restore_campaign("campaign") == restored
    assert d.store.get("learning_policies", "policy")["enabled"] is False
    assert d.store.get("learning_policies", "foreign-policy")["enabled"] is True
    assert {c["id"] for c in d.service.list_campaigns()} == {"campaign", "foreign"}


def test_archive_and_policy_pause_rollback_together(domain):
    d = domain
    before = snapshot(d.store)
    with d.store.connect() as db:
        db.execute(
            "CREATE TRIGGER reject_policy_update BEFORE UPDATE ON records WHEN NEW.kind='learning_policies' AND NEW.id='policy' BEGIN SELECT RAISE(ABORT,'fixture transaction failure'); END"
        )
    with pytest.raises(sqlite3.IntegrityError):
        d.service.archive("campaign")
    assert snapshot(d.store) == before
    assert d.store.get("learning_policies", "policy")["enabled"] is True
    assert not d.store.get("campaigns", "campaign").get("archived_at")


@pytest.mark.parametrize("status", ["queued", "running"])
@pytest.mark.parametrize(
    "record",
    [
        {"context": {"campaign_id": "campaign"}},
        {"campaign_id": "campaign", "context": []},
        {"context": {"campaign_snapshot": {"campaign_id": "campaign"}}},
        {"context": {"clip_id": "clip"}},
        {"context": {"team_run_id": "related-run"}},
        {"context": {"experiment_id": "experiment"}},
        {"context": {"video_id": "source"}},
        {"video_id": "source", "context": None},
    ],
)
def test_related_active_jobs_block_archive_without_partial_policy_pause(domain, status, record):
    d = domain
    d.store.put("jobs", {"id": "job", "status": status, **copy.deepcopy(record)})
    before = snapshot(d.store)
    with pytest.raises(HTTPException) as exc:
        d.service.archive("campaign")
    assert exc.value.status_code == 409 and snapshot(d.store) == before


@pytest.mark.parametrize(
    "record",
    [
        {"context": {"campaign_id": "foreign", "video_id": "source"}},
        {"context": {"team_run_id": "foreign-run", "video_id": "source"}},
        {"context": {"clip_id": "foreign-clip", "video_id": "source"}},
        {"context": None},
        {"context": []},
    ],
)
def test_foreign_shared_source_and_unrelated_malformed_context_does_not_block(domain, record):
    domain.store.put("jobs", {"id": "job", "status": "running", **record})
    assert domain.service.archive("campaign")["archived_at"]


@pytest.mark.parametrize(
    "context",
    [
        {"campaign_snapshot": {"campaign_id": "campaign"}},
        {"settings": {"_campaign_snapshot": {"campaign_id": "campaign"}}},
    ],
)
def test_active_team_run_blocks_even_without_job(domain, context):
    domain.store.put("team_runs", {"id": "new-run", "status": "running", "context": context})
    with pytest.raises(HTTPException) as exc:
        domain.service.archive("campaign")
    assert exc.value.status_code == 409


def test_run_job_link_survives_malformed_job_context(domain):
    domain.store.put(
        "team_runs",
        {
            "id": "new-run",
            "status": "needs_review",
            "job_id": "job",
            "context": {"campaign_snapshot": {"campaign_id": "campaign"}},
        },
    )
    domain.store.put("jobs", {"id": "job", "status": "queued", "context": []})
    with pytest.raises(HTTPException):
        domain.service.archive("campaign")


def test_active_learning_claim_blocks_archive_before_job_submission(domain):
    domain.store.put("learning_work", {"id": "work", "status": "running", "policy_id": "policy"})
    with pytest.raises(HTTPException):
        domain.service.archive("campaign")


def test_terminal_jobs_and_malformed_status_do_not_crash_archive(domain):
    domain.store.put("jobs", {"id": "done", "status": "completed", "context": {"campaign_id": "campaign"}})
    domain.store.put("jobs", {"id": "malformed", "status": [], "context": None})
    assert domain.service.archive("campaign")["archived_at"]


@pytest.mark.parametrize(
    "operation",
    [
        lambda d: d.service.save_campaign(
            Campaign(name="Rename", profile_ids=["profile"], video_ids=["source"]), "campaign"
        ),
        lambda d: d.service.propose(
            "campaign",
            Proposal(directions={"profile": Direction()}, reason="change", base_version_id="strategy"),
        ),
        lambda d: d.service.decision("campaign", "pending", approve=True),
        lambda d: d.service.decision("campaign", "pending", approve=False, reason="reject"),
        lambda d: d.service.restore("campaign", "strategy", Restore(profile_id="profile")),
        lambda d: d.service.observe("campaign", SimpleNamespace()),
        lambda d: d.service.learn("campaign", SimpleNamespace()),
        lambda d: d.service.snapshot("campaign", "profile", "source", "strategy"),
    ],
)
def test_archived_campaign_rejects_mutations_and_new_production_snapshot(domain, operation):
    domain.service.archive("campaign")
    before = snapshot(domain.store)
    with pytest.raises(HTTPException) as exc:
        operation(domain)
    assert exc.value.status_code == 409 and snapshot(domain.store) == before


@pytest.fixture
def api(domain):
    calls = []
    app = FastAPI()

    def render(identifier, body):
        calls.append(("render", identifier))
        return {"id": "render-fixture"}

    def produce(identifier, body):
        calls.append(("produce", identifier))
        return {"id": "produce-fixture"}

    install(app, domain.service, render=render, produce=produce)
    with TestClient(app) as client:
        yield client, calls


def test_api_default_filter_explicit_recovery_and_readable_history(domain, api):
    client, _ = api
    archived = client.post("/api/campaigns/campaign/archive")
    assert archived.status_code == 200 and archived.json()["archived_at"]
    assert [c["id"] for c in client.get("/api/campaigns").json()] == ["foreign"]
    assert {c["id"] for c in client.get("/api/campaigns?include_archived=true").json()} == {
        "campaign",
        "foreign",
    }
    assert client.get("/api/campaigns/campaign").status_code == 200
    assert len(client.get("/api/campaigns/campaign/strategies").json()) == 2
    assert len(client.get("/api/campaigns/campaign/observations").json()) == 1
    assert client.get("/api/campaigns?include_archived=unknown").status_code == 422
    assert client.post("/api/campaigns/campaign/archive").json() == archived.json()
    assert client.post("/api/campaigns/campaign/restore").json()["archived_at"] is None
    assert domain.store.get("learning_policies", "policy")["enabled"] is False


@pytest.mark.parametrize("action", ["render", "produce"])
def test_archived_production_api_never_dispatches_callback(domain, api, action):
    client, calls = api
    domain.service.archive("campaign")
    response = client.post(
        f"/api/campaigns/campaign/{action}",
        json={"video_id": "source", "profile_id": "profile", "subtitles": False}
        if action == "render"
        else {"video_id": "source", "profile_id": "profile"},
    )
    assert response.status_code == 409 and not calls
    client.post("/api/campaigns/campaign/restore")
    assert (
        client.post(
            f"/api/campaigns/campaign/{action}", json={"video_id": "source", "profile_id": "profile"}
        ).status_code
        == 202
    )
    assert len(calls) == 1


def test_missing_campaign_archive_and_restore_are_not_creations(api):
    client, _ = api
    assert client.post("/api/campaigns/missing/archive").status_code == 404
    assert client.post("/api/campaigns/missing/restore").status_code == 404


def test_pending_publish_schedule_blocks_archive_but_finished_schedule_does_not(domain):
    d = domain
    d.store.put("schedules", {"id": "schedule", "clip_id": "clip", "status": "scheduled"})
    before = snapshot(d.store)
    with pytest.raises(HTTPException) as exc:
        d.service.archive("campaign")
    assert exc.value.status_code == 409 and snapshot(d.store) == before
    d.store.put("schedules", {"id": "schedule", "clip_id": "clip", "status": "cancelled"})
    d.store.put("schedules", {"id": "foreign", "clip_id": "foreign-clip", "status": "scheduled"})
    assert d.service.archive("campaign")["archived_at"]


def test_repeat_archive_stays_idempotent_when_later_work_exists(domain):
    d = domain
    first = d.service.archive("campaign")
    # e.g. a reconcile job on an existing clip is still allowed after archival
    d.store.put("jobs", {"id": "reconcile", "status": "running", "context": {"clip_id": "clip"}})
    assert d.service.archive("campaign") == first


def test_archived_campaign_clip_rejects_new_clip_level_effects(domain):
    d = domain
    clip = d.store.get("clips", "clip")
    d.service.ensure_clip_campaign_active(clip)
    d.service.ensure_clip_campaign_active({"id": "legacy", "campaign_id": None})
    d.service.archive("campaign")
    with pytest.raises(HTTPException) as exc:
        d.service.ensure_clip_campaign_active(clip)
    assert exc.value.status_code == 409
    d.service.ensure_clip_campaign_active(d.store.get("clips", "foreign-clip"))
