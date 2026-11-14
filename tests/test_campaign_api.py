# ruff: noqa: F811
"""Authenticated integration and real cross-source campaign rendering proof."""

import hashlib
import shutil
import subprocess
import threading
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from test_app import SESSION, client, upload_mock, wait_job  # noqa: F401

from clip_factory.app import create_app
from clip_factory.campaigns import Direction
from clip_factory.store import Store


def setup_campaign(client, videos, *, duration=1):
    profiles = []
    for name in ("Creators", "Educators"):
        response = client.post("/api/profiles", json={"name": name, "audience": name})
        assert response.status_code == 201, response.text
        profiles.append(response.json())
    response = client.post(
        "/api/campaigns",
        json={
            "name": "Two-source experiment",
            "profile_ids": [p["id"] for p in profiles],
            "video_ids": [v["id"] for v in videos],
            "brief": {
                "audience": "Creators",
                "constraints": ["Preserve context"],
                "requested_outputs": ["Vertical clips"],
                "measurement_intent": "Inspect retention",
            },
        },
    )
    assert response.status_code == 201, response.text
    campaign = response.json()
    path = f"/api/campaigns/{campaign['id']}"
    versions = [
        approve_rules(client, p["id"], Direction(hooks=["Original hook"], duration_seconds=duration))
        for p in profiles
    ]
    return profiles, campaign, versions[0], path


def rules_path(profile_id):
    return f"/api/profiles/{profile_id}/strategies"


def propose_rules(client, profile_id, direction, base=None, reason="Initial testable direction"):
    return client.post(
        rules_path(profile_id),
        json={"reason": reason, "base_version_id": base, "direction": direction.model_dump()},
    )


def approve_rules(client, profile_id, direction, base=None):
    proposal = propose_rules(client, profile_id, direction, base)
    assert proposal.status_code == 201, proposal.text
    version = proposal.json()
    response = client.post(rules_path(profile_id) + f"/{version['id']}/approve")
    assert response.status_code == 200, response.text
    return response.json()


def observation(clip_id, value=40):
    now = datetime.now(UTC) - timedelta(days=1)
    return {
        "clip_id": clip_id,
        "metric": "retention",
        "value": value,
        "unit": "percent",
        "publication_reference": "Creator's measured publication 1",
        "window_start": (now - timedelta(days=2)).isoformat(),
        "window_end": (now - timedelta(days=1)).isoformat(),
        "collected_at": now.isoformat(),
        "notes": "Imported source data, observational comparison only",
    }


def test_campaign_api_requires_auth_and_valid_membership(client, monkeypatch):
    video = upload_mock(client, monkeypatch)
    profiles, _, _, path = setup_campaign(client, [video])
    assert (
        client.post(path + "/render", json={"video_id": video["id"], "profile_id": "other"}).status_code
        == 422
    )
    for route in ("/api/profiles", "/api/campaigns", path + "/strategies", path + "/observations",
                  rules_path(profiles[0]["id"])):
        assert client.get(route, headers={"X-Clip-Token": "wrong"}).status_code == 401
    assert client.post("/api/profiles", json={"name": "Sales", "objective": "sales"}).status_code == 422
    body = {"name": "Goal", "profile_ids": [profiles[0]["id"]], "objective": "sales"}
    assert client.post("/api/campaigns", json=body).status_code == 422
    goal = client.post("/api/campaigns", json={**body, "primary_metric": "orders", "notes": "Holiday angle"})
    assert goal.status_code == 201, goal.text
    assert {k: goal.json()[k] for k in ("objective", "primary_metric", "notes")} == {
        "objective": "sales", "primary_metric": "orders", "notes": "Holiday angle"}
    # Rules are no longer saved or approved on a campaign.
    for route in (path + "/strategies", path + "/strategies/any/approve", path + "/strategies/any/restore"):
        assert client.post(route, json={}).status_code == 410
    assert client.get(path + "/strategies").json() == []
    assert (
        client.post(
            "/api/profiles", json={"name": "Hidden permission", "publishing_enabled": True}
        ).status_code
        == 422
    )
    assert client.get(f"/api/profiles/{profiles[0]['id']}").json()["production_history"] == []


def test_pending_strategy_blocks_production_and_cross_campaign_versions(client, monkeypatch):
    video = upload_mock(client, monkeypatch)
    profile = client.post("/api/profiles", json={"name": "Offline"}).json()
    campaign = client.post(
        "/api/campaigns",
        json={"name": "Unapproved", "profile_ids": [profile["id"]], "video_ids": [video["id"]]},
    ).json()
    path = f"/api/campaigns/{campaign['id']}"
    response = client.post(path + "/render", json={"video_id": video["id"], "profile_id": profile["id"]})
    assert response.status_code == 409
    _, _, version, _ = setup_campaign(client, [video])
    # Another workspace's version cannot be decided or used as a base here.
    assert client.post(rules_path(profile["id"]) + f"/{version['id']}/approve").status_code == 404
    assert propose_rules(client, profile["id"], Direction(), base=version["id"], reason="Forged").status_code == 409
    pending = propose_rules(client, profile["id"], Direction()).json()
    assert client.post(path + "/render", json={"video_id": video["id"], "profile_id": profile["id"]}).status_code == 409
    approved = client.post(rules_path(profile["id"]) + f"/{pending['id']}/approve").json()
    assert client.get(f"/api/profiles/{profile['id']}").json()["active_strategy_id"] == approved["id"]
    assert [v["id"] for v in client.get(rules_path(profile["id"])).json()] == [approved["id"]]


def test_queue_freezes_strategy_and_direct_selection_is_explicit(client, monkeypatch):
    video = upload_mock(client, monkeypatch)
    profiles, _, version, path = setup_campaign(client, [video])
    entered, release = threading.Event(), threading.Event()
    blocker = client.app.state.jobs.submit("block", lambda _: (entered.set(), release.wait(10)))
    assert entered.wait(2)
    captured = []

    def render(jobs, job, source, output, **kwargs):
        captured.append(kwargs)
        output.write_bytes(b"rendered")
        return {"subtitles_burned": False}

    monkeypatch.setattr("clip_factory.media.render", render)
    # Cover extraction is mocked too; this concurrency test must not require host FFmpeg.
    monkeypatch.setattr("clip_factory.media.ffmpeg", lambda: "mock-ffmpeg")
    monkeypatch.setattr(client.app.state.jobs, "process", lambda *a, **k: b"")
    try:
        job = client.post(
            path + "/render",
            json={
                "video_id": video["id"],
                "profile_id": profiles[0]["id"],
                "start": 1,
                "end": 3,
                "instructions": "Exact range, keep my wording",
            },
        ).json()
        approve_rules(
            client,
            profiles[0]["id"],
            Direction(duration_seconds=2, hooks=["New hook"], framing="fill"),
            base=version["id"],
        )
    finally:
        release.set()
    wait_job(client, blocker["id"])
    completed = wait_job(client, job["id"])
    assert completed["status"] == "completed", completed
    clip = client.app.state.store.get("clips", completed["result"]["clip_id"])
    assert clip["strategy_version_id"] == version["id"]
    assert clip["start"] == 1 and clip["end"] == 3
    assert clip["provenance_mode"] == "direct" and clip["strategy_departures"]
    assert captured[0]["hook"] == "Original hook" and captured[0]["framing"] == "fit"
    assert clip["creator_instructions"] == "Exact range, keep my wording"


def test_agent_context_uses_only_its_profile_and_campaign(client, monkeypatch):
    video = upload_mock(client, monkeypatch)
    profiles, campaign, version, path = setup_campaign(client, [video], duration=5)
    store = client.app.state.store
    for i, profile in enumerate(profiles):
        store.put(
            "clips",
            {
                "id": f"clip{i}",
                "campaign_id": campaign["id"],
                "profile_id": profile["id"],
                "video_id": video["id"],
                "hook": "history",
                "objective": "discovery",
            },
        )
        store.put(
            "feedback", {"id": f"feedback{i}", "clip_id": f"clip{i}", "rating": 5, "notes": "Preference"}
        )
    monkeypatch.setattr(client.app.state.models, "require", lambda *a: None)
    seen = []

    def execute(run_id, job_id):
        seen.append(client.app.state.team.get(run_id))
        return {}

    monkeypatch.setattr(client.app.state.team, "execute", execute)
    update = {k: campaign[k] for k in ("name", "brief", "profile_ids", "video_ids")}
    saved = client.put(path, json={**update, "objective": "traffic", "primary_metric": "episode_visits",
                                   "notes": "Favour the guest's founding story."})
    assert saved.status_code == 200, saved.text
    response = client.post(path + "/produce", json={"video_id": video["id"], "profile_id": profiles[0]["id"]})
    assert response.status_code == 202, response.text
    wait_job(client, response.json()["job"]["id"])
    context = seen[0]["context"]
    assert context["campaign_snapshot"]["strategy_version_id"] == version["id"]
    assert context["campaign_snapshot"]["strategy_scope"] == "workspace"
    assert context["campaign_snapshot"]["goal"] == {"objective": "traffic", "primary_metric": "episode_visits"}
    assert context["campaign_snapshot"]["campaign_notes"] == "Favour the guest's founding story."
    assert seen[0]["objective"] == "traffic"
    assert [p["clip_id"] for p in context["previous_observations"]] == ["clip0"]
    legacy = client.app.state.team.create(
        video, {"brand": "", "language": "en", "objective": "discovery"}, "qwen-small"
    )
    assert legacy["context"]["previous_observations"] == []


def test_optional_run_direction_reaches_the_team_run_and_is_bounded(client, monkeypatch):
    video = upload_mock(client, monkeypatch)
    profiles, _campaign, _version, path = setup_campaign(client, [video], duration=5)
    monkeypatch.setattr(client.app.state.models, "require", lambda *a: None)
    seen = []

    def execute(run_id, job_id):
        seen.append(client.app.state.team.get(run_id))
        return {}

    monkeypatch.setattr(client.app.state.team, "execute", execute)
    body = {"video_id": video["id"], "profile_id": profiles[0]["id"]}
    too_long = client.post(path + "/produce", json={**body, "direction": "x" * 501})
    assert too_long.status_code == 422
    response = client.post(path + "/produce", json={**body, "direction": "  the spiciest takes on AI policy, under 40s "})
    assert response.status_code == 202, response.text
    wait_job(client, response.json()["job"]["id"])
    assert seen[0]["context"]["creator_direction"] == "the spiciest takes on AI policy, under 40s"
    response = client.post(path + "/produce", json=body)
    assert response.status_code == 202, response.text
    wait_job(client, response.json()["job"]["id"])
    assert "creator_direction" not in seen[1]["context"]


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="FFmpeg required")
def test_real_cross_source_learning_loop_and_restart(client, tmp_path):
    filters = subprocess.run(
        ["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True, check=True
    )
    if " subtitles " not in filters.stdout:
        pytest.skip("libass required")
    videos = []
    for i, color in enumerate(("blue", "red")):
        file = tmp_path / f"real{i}.mp4"
        subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"color=c={color}:s=160x90:r=30:d=1.2",
                "-c:v",
                "libx264",
                str(file),
            ],
            check=True,
        )
        with file.open("rb") as source:
            response = client.post("/api/videos", files={"file": (file.name, source, "video/mp4")})
        assert response.status_code == 201, response.text
        videos.append(response.json())
    profiles, _campaign, initial, path = setup_campaign(client, videos)
    clips = []

    def render(source, *, hook=None, end=None):
        response = client.post(
            path + "/render",
            json={
                "video_id": source["id"],
                "profile_id": profiles[0]["id"],
                "mode": "strategy",
                "hook": hook,
                "end": end,
            },
        )
        assert response.status_code == 202, response.text
        job = wait_job(client, response.json()["id"])
        assert job["status"] == "completed", job
        clip = next(c for c in client.get("/api/clips").json() if c["id"] == job["result"]["clip_id"])
        clips.append(clip)
        assert clip["hook_rendered"] and clip["edit_plan"]["hook_overlay"]
        assert client.get(f"/api/clips/{clip['id']}/download").status_code == 200
        return clip

    first = render(videos[0], hook="Variant A")
    second = render(videos[0], hook="Variant B")

    # Actual rendered visual differences, not just edited metadata.
    def frame_hash(clip):
        record = client.app.state.store.get("clips", clip["id"])
        raw = subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-i",
                str(client.app.state.root / record["path"]),
                "-frames:v",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "pipe:1",
            ],
            capture_output=True,
            check=True,
        ).stdout
        return hashlib.sha256(raw).hexdigest()

    assert frame_hash(first) != frame_hash(second)
    revision = render(videos[0], hook="Creator requested revision", end=0.8)
    assert client.put(f"/api/clips/{first['id']}", json={"approved": True}).status_code == 200
    known = client.post(path + "/observations", json=observation(first["id"]))
    unknown = client.post(path + "/observations", json=observation(first["id"], None))
    assert known.status_code == unknown.status_code == 201
    assert unknown.json()["value"] is None
    proposal_body = {
        "profile_id": profiles[0]["id"],
        "base_version_id": initial["id"],
        "hypothesis": "Test a more direct opening; one observation is not a controlled experiment",
        "reason": "Creator interprets imported retention as reason to test a shorter opening",
        "observation_ids": [known.json()["id"]],
        "proposed_direction": Direction(
            duration_seconds=1,
            hooks=["Evidence informed next hook"],
            framing="fill",
            caption_style="high_contrast",
        ).model_dump(),
    }
    proposal = client.post(path + "/learning", json=proposal_body)
    assert proposal.status_code == 201, proposal.text
    learned = proposal.json()
    assert learned["status"] == "proposed"
    workspace = f"/api/profiles/{profiles[0]['id']}"
    assert client.get(workspace).json()["active_strategy_id"] == initial["id"]
    assert client.post(rules_path(profiles[0]["id"]) + f"/{learned['id']}/approve").status_code == 200
    fourth = render(videos[1])
    assert fourth["strategy_version_id"] == learned["id"]
    assert fourth["hook"] == "Evidence informed next hook" and fourth["framing"] == "fill"
    assert fourth["strategy_snapshot"]["evidence_refs"] == [known.json()["id"]]
    assert set(learned["directions"]) == {profiles[0]["id"]}
    assert first["strategy_version_id"] == revision["strategy_version_id"] == initial["id"]
    for clip in (second, revision, fourth):
        assert client.put(f"/api/clips/{clip['id']}", json={"approved": True}).status_code == 200
    # Restart the actual application with the same SQLite data; no data recreation or model calls.
    root = client.app.state.root
    with TestClient(
        create_app(root, token=SESSION), base_url="http://127.0.0.1", headers={"X-Clip-Token": SESSION}
    ) as reopened:
        assert reopened.get(workspace).json()["active_strategy_id"] == learned["id"]
        assert len(reopened.get(path + "/observations").json()) == 2
        assert len(reopened.get("/api/clips").json()) == 4
        assert len(reopened.get(f"/api/profiles/{profiles[0]['id']}").json()["production_history"]) == 4
    assert Store(root).get("strategy_versions", initial["id"])["directions"] == initial["directions"]


def test_displayed_strategy_mismatch_requires_reload(client, monkeypatch):
    video = upload_mock(client, monkeypatch)
    profiles, _, initial, path = setup_campaign(client, [video])
    approve_rules(client, profiles[0]["id"], Direction(hooks=["Changed"]), base=initial["id"])
    for action in ("render", "produce"):
        response = client.post(
            path + "/" + action,
            json={
                "video_id": video["id"],
                "profile_id": profiles[0]["id"],
                "expected_strategy_version_id": initial["id"],
            },
        )
        assert response.status_code == 409 and "displayed" in response.json()["detail"]
    assert client.app.state.store.all("jobs") == []


def test_burned_hook_cannot_be_relabelled_or_approved_as_new_text(client):
    store = client.app.state.store
    store.put(
        "clips",
        {
            "id": "burned",
            "video_id": "source",
            "hook": "Rendered A",
            "caption": "Post copy",
            "hook_rendered": True,
            "approved": False,
            "edit_plan": {"hook": "Rendered A"},
        },
    )
    response = client.put("/api/clips/burned", json={"hook": "Unrendered B", "approved": True})
    assert response.status_code == 409
    assert store.get("clips", "burned")["hook"] == "Rendered A"
    assert not store.get("clips", "burned")["approved"]
    assert client.put("/api/clips/burned", json={"approved": True}).status_code == 200


def test_unassigned_analysis_does_not_borrow_profiles_or_foreign_insights(client, monkeypatch, watched):
    video = upload_mock(client, monkeypatch)
    store = client.app.state.store
    store.put(
        "clips",
        {"id": "private", "hook": "PRIVATE PROFILE DIRECTION", "objective": "sales", "profile_id": "p"},
    )
    store.put(
        "clips",
        {
            "id": "legacy",
            "hook": "Legacy",
            "objective": "discovery",
            "instagram_account_id": "own",
            "instagram_media_id": "m",
        },
    )
    store.put("insights", {"id": "m", "account_id": "foreign", "metrics": {"views": 987654}})
    watched(client)
    monkeypatch.setattr(client.app.state.models, "require", lambda *a: None)
    prompts = []

    def run(*args, **kwargs):
        prompts.append(kwargs["prompt"])
        return {"output": '{"candidates":[{"scene":"scene:0","start":0,"end":1,"hook":"Source-backed"}]}'}

    monkeypatch.setattr(client.app.state.models, "run", run)
    response = client.post(f"/api/videos/{video['id']}/analyze", json={})
    assert response.status_code == 202
    assert wait_job(client, response.json()["id"])["status"] == "completed"
    assert "PRIVATE PROFILE DIRECTION" not in prompts[0] and "987654" not in prompts[0]
    assert "Legacy" in prompts[0]


def test_campaign_comparison_fingerprint_includes_profile_and_direction(client, monkeypatch):
    video = upload_mock(client, monkeypatch)
    profiles, campaign, _, _ = setup_campaign(client, [video])
    team, service = client.app.state.team, client.app.state.campaigns

    def run(profile):
        snapshot = service.snapshot(campaign["id"], profile["id"], video["id"])
        return team.create(
            video,
            {"brand": "same", "objective": "discovery", "language": "en", "_campaign_snapshot": snapshot},
            "qwen-small",
        )

    a, b, repeated = run(profiles[0]), run(profiles[1]), run(profiles[0])
    assert a["comparison_fingerprint"] != b["comparison_fingerprint"]
    assert a["comparison_fingerprint"] == repeated["comparison_fingerprint"]


def test_archived_campaign_clip_cannot_publish_schedule_or_recheck(client):
    store = client.app.state.store
    store.put("campaigns", {"id": "old", "profile_ids": [], "video_ids": [], "archived_at": "2026-01-01T00:00:00+00:00"})
    store.put("clips", {"id": "old-clip", "campaign_id": "old", "video_id": "v", "approved": True})
    future = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    url = "https://cdn.creator.com/actual.mp4"
    for path, body in (
        ("/api/clips/old-clip/publish", {"public_video_url": url}),
        ("/api/clips/old-clip/schedule", {"public_video_url": url, "publish_at": future}),
        ("/api/clips/old-clip/team-review", None),
    ):
        response = client.post(path, json=body) if body else client.post(path)
        assert response.status_code == 409 and "archived" in response.json()["detail"], response.text
    assert store.all("schedules") == [] and store.all("jobs") == []
