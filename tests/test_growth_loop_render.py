# ruff: noqa: F811
"""Actual local FFmpeg A/B and approved-rule recut proof, using labelled synthetic footage."""
import hashlib
import shutil
import subprocess
import time

import pytest
from test_app import client, wait_job  # noqa: F401
from test_campaign_api import approve_rules, setup_campaign

from clip_factory import ranking
from clip_factory.campaigns import Direction, Production


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="FFmpeg required")
def test_treated_parent_ab_and_reserved_technical_repair(client, tmp_path):
    client.put("/api/settings", json={"autonomy": "manual"})
    source_path = tmp_path / "treated-blue-fixture.mp4"
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
                    "color=c=blue:s=160x90:r=30:d=3", "-c:v", "libx264", str(source_path)], check=True)
    with source_path.open("rb") as stream:
        video = client.post("/api/videos", files={"file": (source_path.name, stream, "video/mp4")}).json()
    profiles, _, rule, campaign_path = setup_campaign(client, [video], duration=2)
    profile = profiles[0]["id"]
    response = client.post(f"/api/videos/{video['id']}/render", json={"start": 0, "end": 2,
        "hook": "An actual source-backed hook", "subtitles": False, "motion": "push_in", "caption_style": "pop"})
    assert response.status_code == 202, response.text
    original_job = wait_job(client, response.json()["id"])
    assert original_job["status"] == "completed"
    store = client.app.state.store
    parent = store.get("clips", original_job["result"]["clip_id"])
    snapshot = client.app.state.campaigns.snapshot(campaign_path.rsplit("/", 1)[-1], profile, video["id"], rule["id"])
    parent = store.patch("clips", parent["id"], **snapshot)
    prefix = f"/api/growth/profiles/{profile}"
    started = client.post(prefix + "/ab", json={"request_id": "treated-parent", "clip_ids": [parent["id"]],
        "expected_strategy_version_id": rule["id"]})
    assert started.status_code == 202, started.text
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        client.app.state.growth_loop.tick()
        loop = client.app.state.growth_loop.reconcile(started.json()["id"])
        if loop["status"] in {"completed", "held"}:
            break
        time.sleep(.03)
    assert loop["status"] == "completed", loop
    variant = store.get("clips", loop["slots"][0]["clip_id"])
    assert variant["edit_plan"]["motion"] == "push_in" and variant["edit_plan"]["caption_style"] == "pop"
    assert [c["field"] for c in variant["plan_changes"]] == ["hook_format"]
    assert not variant["approved"]

    # A controlled legacy failed-render record exercises reprocessing admission;
    # actual caption normalization is covered separately with captured speech.
    store.patch("clips", parent["id"], caption_timeline_version=0,
                technical_checks={"captions": [{"id": "timing", "status": "fail"}]})
    body = {k: v for k, v in parent["edit_plan"].items() if k in Production.model_fields}
    body.update(video_id=video["id"], profile_id=profile, expected_strategy_version_id=rule["id"],
                parent_clip_id=parent["id"], changed_variable="caption_timing", change_reason="Repair captured timeline defects")
    mixed = client.post(campaign_path + "/render", json={**body, "hook": "A different creative decision"})
    assert mixed.status_code == 422
    repair = client.post(campaign_path + "/render", json=body)
    assert repair.status_code == 202, repair.text
    done = wait_job(client, repair.json()["id"])
    assert done["status"] == "completed", done
    repaired = store.get("clips", done["result"]["clip_id"])
    assert repaired["plan_changes"][0]["kind"] == "technical_repair"
    assert repaired["plan_changes"][0]["audience_evidence"] is False
    assert repaired["caption_timeline_version"] == 2 and not repaired["approved"]
    assert store.get("clips", parent["id"])["sha256"] == parent["sha256"]
    assert not store.all("learning_publications")


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="FFmpeg required")
def test_real_rendered_ab_recut_and_approval_boundary(client, tmp_path, monkeypatch):
    judged = []
    monkeypatch.setattr(client.app.state.creative_scores, "judge_policy", lambda: {"automatic_after_production": True})
    monkeypatch.setattr(client.app.state.creative_scores, "request", lambda identifier, checksum: judged.append((identifier, checksum)))
    assert client.put("/api/settings", json={"autonomy": "manual"}).status_code == 200
    file = tmp_path / "synthetic-blue-source.mp4"
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
                    "color=c=blue:s=160x90:r=30:d=3", "-c:v", "libx264", str(file)], check=True)
    with file.open("rb") as stream:
        source = client.post("/api/videos", files={"file": (file.name, stream, "video/mp4")})
    assert source.status_code == 201, source.text
    video = source.json()
    profiles, _, rule, campaign_path = setup_campaign(client, [video], duration=2)
    profile = profiles[0]["id"]
    long_hook = "The point is simple, you cannot reverse engineer a chip from wafers"
    # Explicit imported test transcript for the labelled synthetic source; no ASR/model claim.
    client.app.state.store.patch("videos", video["id"], transcript_origin="imported_fixture",
        transcript={"segments": [{"start": 0, "end": 2, "text": long_hook}]})
    response = client.post(campaign_path + "/render", json={"profile_id": profile, "video_id": video["id"],
        "expected_strategy_version_id": rule["id"], "subtitles": False, "hook_format": "title_card",
        "cover": "first_frame", "jump_cuts": "off", "loudness": "off", "structure": "linear", "hook": long_hook})
    assert response.status_code == 202, response.text
    job = wait_job(client, response.json()["id"], timeout=60)
    assert job["status"] == "completed", job
    store, root = client.app.state.store, client.app.state.root
    parent = store.get("clips", job["result"]["clip_id"])
    prefix = f"/api/growth/profiles/{profile}"
    assert client.get(prefix, headers={"X-Clip-Token": "wrong"}).status_code == 401
    response = client.post(prefix + "/ab", json={"request_id": "real-ab", "clip_ids": [parent["id"]],
                                                 "expected_strategy_version_id": rule["id"]})
    assert response.status_code == 202, response.text

    def completed_loop(loop_id):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            client.app.state.growth_loop.tick()
            result = client.app.state.growth_loop.reconcile(loop_id)
            if result["status"] in {"completed", "held"}:
                return result
            time.sleep(0.02)
        pytest.fail("The actual loop render did not finish")

    loop = completed_loop(response.json()["id"])
    assert loop["status"] == "completed", loop
    variant = store.get("clips", loop["slots"][0]["clip_id"])
    assert variant["sha256"] != parent["sha256"]
    assert not variant["approved"] and not parent["approved"]
    assert variant["parent_clip_id"] == parent["id"]
    assert [change["field"] for change in variant["plan_changes"]] == ["hook_format"]
    assert hashlib.sha256((root / parent["path"]).read_bytes()).hexdigest() == parent["sha256"]

    direction = Direction.model_validate(rule["directions"][profile])
    direction.hooks = ["A genuinely changed hook"]
    approved = approve_rules(client, profile, direction, base=rule["id"])
    response = client.post(prefix + "/recut", json={"request_id": "real-recut", "clip_ids": [parent["id"]],
                                                   "expected_strategy_version_id": approved["id"]})
    assert response.status_code == 202, response.text
    recut_loop = completed_loop(response.json()["id"])
    assert recut_loop["status"] == "completed", recut_loop
    recut = store.get("clips", recut_loop["slots"][0]["clip_id"])
    assert recut["hook"] == "A genuinely changed hook" and not recut["approved"]
    assert recut["strategy_version_id"] == approved["id"]
    assert recut["sha256"] != parent["sha256"]
    assert [change["field"] for change in recut["plan_changes"]] == ["hook"]
    assert not store.all("learning_publications")
    assert [item[0] for item in judged] == [parent["id"], variant["id"], recut["id"]]

    request = {"request_id": "real-rehearsal", "clip_id": parent["id"],
        "expected_strategy_version_id": approved["id"], "expected_sha256": parent["sha256"], "scenario": "mixed"}
    store.put("jobs", {"id": "interrupted-judge", "status": "failed", "kind": "creative_assessment"})
    store.put("creative_assessments", {"id": "interrupted-fixture", "clip_id": parent["id"],
        "sha256": parent["sha256"], "model": "fixture-only", "status": "queued", "job_id": "interrupted-judge"})
    with store.connect() as db:
        before = db.execute("SELECT kind,id,data FROM records ORDER BY kind,id").fetchall()
    preview = client.post(prefix + "/rehearse-preview", json=request)
    assert preview.status_code == 200, preview.text
    with store.connect() as db:
        after = db.execute("SELECT kind,id,data FROM records ORDER BY kind,id").fetchall()
    assert before == after and preview.json()["can_render"] is True
    assert store.get("creative_assessments", "interrupted-fixture")["status"] == "queued"
    response = client.post(prefix + "/rehearse", json=request)
    assert response.status_code == 202, response.text
    rehearsal = completed_loop(response.json()["id"])
    assert rehearsal["status"] == "completed", rehearsal
    output = store.get("clips", rehearsal["slots"][0]["clip_id"])
    assert output["simulated_evidence"] is True
    assert output["evidence_kind"] == "simulated_observation_rehearsal"
    assert output["parent_clip_id"] == parent["id"] and not output["approved"]
    assert output["sha256"] != parent["sha256"]
    assert [change["field"] for change in output["plan_changes"]] == ["hook"]
    assert len(output["hook"].split()) <= 8 and "cannot" in output["hook"]
    assert rehearsal["proposal"]["weak_dimension"] == "hook"
    assert rehearsal["rubric_before"]["ranking"]["rubric_version"] == f"ranking@{ranking.RANK_VERSION}"
    assert rehearsal["proposal"] == preview.json()["proposal"]
    assert judged[-1][0] == output["id"] and len(judged) == 4
    assert not store.all("learning_publications") and not store.all("learning_snapshots")
    assert store.get("profiles", profile)["active_strategy_id"] == approved["id"]
