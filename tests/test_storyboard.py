"""Whole-source storyboard: deterministic planning and a scripted vision model, no FFmpeg or weights."""

import contextlib
import json
from itertools import pairwise
from pathlib import Path

import pytest
from conftest import board
from test_app import client as authenticated_client_fixture
from test_app import upload_mock

from clip_factory import media, storyboard
from clip_factory.jobs import JobCancelled, WorkError
from clip_factory.store import Store
from clip_factory.storyboard import Storyboards

client = authenticated_client_fixture


def test_scenes_cover_the_whole_source_at_a_sensible_grain():
    for duration, expected in [(5, 1), (60, 8), (600, 48), (1260, 48), (5094, 57), (3 * 3600, 96)]:
        scenes = storyboard.plan_scenes(duration, [])
        assert len(scenes) == expected
        assert scenes[0][0] == 0 and scenes[-1][1] == duration
        assert all(a[1] == b[0] for a, b in pairwise(scenes))  # no gaps, no overlaps
    assert storyboard.plan_scenes(0, []) == []


def test_scene_boundaries_move_onto_nearby_hard_cuts_only():
    scenes = storyboard.plan_scenes(80, [9.2, 31.0, 44.9])
    # Eight-second grid. Cuts at 9.2 and 31.0 are close to the boundaries at 8 and 32 and replace
    # them; 44.9 is too far from both 40 and 48, so those boundaries stay on the grid.
    assert scenes[0] == (0.0, 9.2) and scenes[1] == (9.2, 16.0)
    assert (24.0, 31.0) in scenes and (31.0, 40.0) in scenes and (40.0, 48.0) in scenes


@pytest.mark.parametrize("span,count", [(4, 3), (10, 4), (26, 6), (60, 8)])
def test_longer_scenes_get_more_looks(span, count):
    times = storyboard.frame_times(100, 100 + span, [], 1000)
    assert len(times) == count and times == sorted(times)
    assert all(100 <= at <= 100 + span for at in times)


def test_frames_land_just_after_a_cut_and_never_past_the_end():
    times = storyboard.frame_times(0, 24, [5.0], 24)
    assert times[1] == 5.4  # the slot containing the cut shows the new shot, not the dissolve
    assert storyboard.frame_times(20, 24, [], 24)[-1] <= 23.95


def test_ranks_are_positions_within_the_series_not_absolute_levels():
    assert storyboard.ranks([0.001, 0.002, 1.0, None]) == [0.0, 0.5, 1.0, None]
    assert storyboard.ranks([3, 3, 3]) == [0.5, 0.5, 0.5]
    assert storyboard.ranks([None, None]) == [None, None]
    assert [storyboard.level(v) for v in (None, 0.1, 0.5, 0.9)] == ["unknown", "low", "medium", "high"]
    assert storyboard.binned([(0.2, 1.0), (0.8, 3.0), (2.5, 5.0)], 3.0, 1.0) == [2.0, None, 5.0]


def test_speech_is_assigned_once_and_background_chatter_is_left_out():
    transcript = {"segments": [
        {"start": 8, "end": 12, "text": " Straddles the boundary. "},
        {"start": 12, "end": 14, "text": "Second scene."},
        {"start": 15, "end": 16, "text": "Oh my God!", "background": True},
        {"start": "bad", "end": 3, "text": "Unreadable timing"},
    ]}
    assert storyboard.speech_between(transcript, 0, 10.5) == "Straddles the boundary."
    assert storyboard.speech_between(transcript, 10.5, 20) == "Second scene."
    assert storyboard.speech_between(None, 0, 10) == ""


def test_digest_shows_roles_every_usable_scene_within_budget():
    value = board("v", 100.0, scenes=10)
    value["scenes"][3]["usable"] = False
    value["scenes"][0].update(visual="x" * 900, on_screen_text=["NATIONAL TRAINING CENTER"], said="About the rally")
    rows = storyboard.digest(value, budget=2000)
    assert [row["ref"] for row in rows] == [f"scene:{i}" for i in range(10) if i != 3]
    assert rows[0]["text_on_screen"] == ["NATIONAL TRAINING CENTER"] and rows[0]["said"] == "About the rally"
    assert len(rows[0]["seen"]) <= 80 and rows[0]["seen"].endswith("…")
    assert rows[1]["interest"] == 5 and "sound" not in rows[1]  # no audio measured


def test_loudness_reaches_the_roles_only_where_speech_matters():
    value = board("v", 20.0, scenes=2)
    for scene in value["scenes"]:
        scene["loudness"] = 0.9
    assert storyboard.digest(value)[0]["sound"] == "high"
    assert "sound" not in storyboard.digest({**value, "speech": "none"})[0]
    assert "sound" not in storyboard.digest({**value, "speech": "in places"})[0]


def test_shortlist_prefers_strong_scenes_spread_across_the_source():
    value = board("v", 60.0, scenes=6)
    for index, score in enumerate([0.9, 0.85, 0.2, 0.8, 0.1, 0.0]):
        value["scenes"][index]["score"] = score
    value["scenes"][3]["usable"] = False
    assert [s["index"] for s in storyboard.shortlist(value, 2)] == [0, 2]  # scene 1 neighbours scene 0
    assert [s["index"] for s in storyboard.shortlist(value, 4)] == [0, 1, 2, 4]  # then neighbours fill in
    assert storyboard.shortlist({"scenes": []}, 3) == []


def test_measured_movement_leads_the_score_and_unusable_footage_scores_nothing():
    assert storyboard.score({"motion": 1.0, "loudness": 0.0, "highlight": None}) == 0.7
    assert storyboard.score({"motion": 0.5, "loudness": None, "highlight": 10}) == 0.8
    assert storyboard.score({"motion": 1.0, "loudness": 1.0, "highlight": 10, "usable": False}) == 0.0


def observation(**changes):
    return {
        "visual": "Two players rally at the near table.",
        "action": "high",
        "on_screen_text": ["USA TABLE TENNIS", "  ", 7],
        "usable": True,
        "said": "",
        "highlight": 7,
        "highlight_reason": "A long rally",
        **changes,
    }


def test_observations_are_validated_and_private_reasoning_is_dropped():
    parsed = storyboard.parse_observation("<think>secret</think>```json\n" + json.dumps(observation()) + "\n```")
    assert parsed["on_screen_text"] == ["USA TABLE TENNIS"] and parsed["highlight"] == 7
    for bad in [None, "", "{", json.dumps(observation(highlight=11)), json.dumps(observation(extra=1)), "[]"]:
        assert storyboard.parse_observation(bad) is None


class FakeJobs:
    def __init__(self):
        self.updates = []
        self.cancelled = False

    def check(self, _):
        if self.cancelled:
            raise JobCancelled()

    def update(self, _, **changes):
        self.updates.append(changes)


class FakeModels:
    def __init__(self, sees=True, outputs=None):
        self.sees = sees
        self.batches = []
        self.outputs = outputs

    def vision(self, _):
        return self.sees

    def run_batch(self, job, model, requests):
        self.batches.append(requests)
        if self.outputs is not None:
            return self.outputs.pop(0)
        return [{"output": json.dumps(observation(visual=f"Scene with {len(r.get('images', []))} frames"))} for r in requests]


@pytest.fixture
def studio(tmp_path, monkeypatch):
    """A Storyboards service over fake signals and stills; the vision model is scripted."""
    store, jobs = Store(tmp_path), FakeJobs()
    video = store.put("videos", {
        "id": "v1", "name": "Rally", "duration": 120.0, "width": 1920, "height": 1080, "has_audio": True,
        "hdr": True, "path": "videos/v1.mov", "transcript_updated_at": "t1",
        "transcript": {"speech": "in places", "segments": [
            {"start": 100, "end": 104, "text": "Can I challenge this table?"},
            {"start": 20, "end": 21, "text": "Oh wow.", "background": True},
        ]},
    })
    seen = {"signals": [], "stills": []}

    def signals(jobs_, job, source, work, *, duration, has_audio):
        seen["signals"].append((source, duration, has_audio))
        motion = [(float(t), 0.9 if t == 62 else 0.01 + (t % 7) / 1000) for t in range(120)]
        loudness = [(t / 2, -40.0 + (20 if 28 <= t / 2 < 32 else 0)) for t in range(240)]
        return {"motion": motion, "loudness": loudness, "method": "keyframes"}

    def extract_frames(jobs_, job, source, targets, *, hdr=False, size=768):
        seen["stills"].append((len(targets), hdr))
        for _, target in targets:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"\xff\xd8still")
        return [{"time": round(at, 2), "path": str(target)} for at, target in targets]

    monkeypatch.setattr(media, "signals", signals)
    monkeypatch.setattr(media, "extract_frames", extract_frames)
    models = FakeModels()
    service = Storyboards(tmp_path, store, jobs, models, lambda v: tmp_path / v["path"])
    return service, store, jobs, models, video, seen


def test_build_watches_every_scene_and_records_what_was_measured_and_seen(studio):
    service, store, jobs, models, video, seen = studio
    result = service.build("job", video, "qwen-small")
    assert seen["signals"] == [(service.source_path(video), 120.0, True)]
    scenes = result["scenes"]
    assert len(scenes) == 15 and scenes[0]["start"] == 0 and scenes[-1]["end"] == 120
    # The hard cut at 62s became a scene boundary, and frames were tone-mapped for the HDR source.
    assert any(scene["start"] == 62.0 for scene in scenes) and all(hdr for _, hdr in seen["stills"])
    # One model load serves a batch of scenes; every request carries timestamped frames and a schema.
    assert [len(batch) for batch in models.batches] == [8, 7]
    request = models.batches[0][0]
    assert request["image_labels"][0].startswith("Frame at ") and len(request["images"]) == 4
    assert request["schema"]["properties"]["action"]["enum"] == ["none", "low", "medium", "high"]
    assert all(scene["visual"] == "Scene with 4 frames" and scene["highlight"] == 7 for scene in scenes)
    # Foreground speech is attached to its scene; background chatter is not shown to the model.
    spoken = next(scene for scene in scenes if scene["start"] <= 102 < scene["end"])
    assert spoken["speech"] == "Can I challenge this table?"
    assert "Can I challenge this table?" in models.batches[1][-3]["prompt"]
    assert not any("Oh wow" in r["prompt"] for batch in models.batches for r in batch)
    # Measured levels are relative to this source; the loudest instant marks its scene's peak.
    loud = next(scene for scene in scenes if scene["start"] <= 30 < scene["end"])
    assert loud["loudness"] == 1.0 and loud["peak_time"] == 28.0
    assert all(0 <= scene["motion"] <= 1 and 0 <= scene["score"] <= 1 for scene in scenes)
    assert result["vision"] is True and result["model_id"] == "qwen-small" and result["speech"] == "in places"
    assert len(result["signals"]["motion"]) == 120 and result["signals"]["interval"] == 1.0
    # Persisted: frames on disk, the storyboard record, and a small pointer on the video.
    assert service.get("v1") == result
    assert service.frame_path("v1", "s000-0.jpg").read_bytes() == b"\xff\xd8still"
    assert store.get("videos", "v1")["storyboard"] == {
        "scenes": 15, "usable_scenes": 15, "vision": True, "model_id": "qwen-small",
        "updated_at": result["created_at"], "thumbnail": "s000-0.jpg", "speech_available": True,
    }
    assert not (service.root / "v1.building").exists()
    assert jobs.updates[0]["message"].startswith("Measuring") and jobs.updates[-1]["progress"] == 95
    assert any(u.get("message") == "Watching the footage: scene 9 of 15" for u in jobs.updates)


def test_one_model_load_serves_every_batch_of_the_watch(studio):
    service, _, _, models, video, _ = studio
    events = []

    @contextlib.contextmanager
    def warm(model):
        events.append(("hold", model))
        yield
        events.append(("release", model))

    batch = models.run_batch
    models.warm = warm
    models.run_batch = lambda job, model, requests: events.append(("batch", model)) or batch(job, model, requests)
    service.build("job", video, "qwen-small")
    assert events == [("hold", "qwen-small"), ("batch", "qwen-small"), ("batch", "qwen-small"),
                      ("release", "qwen-small")]


def test_public_view_serves_frames_by_url_and_hides_internals(studio):
    service, _, _, _, video, _ = studio
    public = service.public(service.build("job", video, "qwen-small"))
    assert "id" not in public and "transcript_stamp" not in public
    frame = public["scenes"][0]["frames"][0]
    assert frame["url"].startswith("/api/videos/v1/storyboard/frames/s000-0.jpg?v=") and "file" not in frame
    for name in ["../factory.sqlite3", "s000-0.png", "s0-0.jpg", "s000-0.jpg/..", ""]:
        assert service.frame_path("v1", name) is None
    assert service.frame_path("../v1", "s000-0.jpg") is None


def test_a_storyboard_is_reused_until_the_speech_changes_or_vision_becomes_available(studio):
    service, store, _, models, video, _ = studio
    models.sees = False
    first = service.ensure("job", video, "ollama:text-only")
    # No vision: only scenes with speech are sent to the model, without images.
    assert [len(batch) for batch in models.batches] == [1] and "images" not in models.batches[0][0]
    assert first["vision"] is False and "No vision model" in first["limitations"]
    assert all(scene["visual"] is None for scene in first["scenes"])
    assert all(scene["frames"] for scene in first["scenes"])  # stills are still kept for the reviewer
    assert service.ensure("job", video, "ollama:text-only") == first and len(models.batches) == 1
    models.sees = True
    upgraded = service.ensure("job", video, "qwen-small")
    assert upgraded["vision"] is True and len(models.batches) == 3
    assert service.ensure("job", video, "qwen-large") == upgraded  # another model need not watch again
    edited = store.patch("videos", "v1", transcript_updated_at="t2")
    assert service.fresh(edited) is None


def test_scenes_the_model_could_not_describe_are_kept_as_measured(studio):
    service, _, _, models, video, _ = studio
    models.outputs = [
        [{"output": json.dumps(observation())}] + [{"error": "Generation failed"}] * 6 + [{"output": "not json"}],
        [{"output": json.dumps(observation(usable=False, visual="Lens covered"))}] * 7,
    ]
    result = service.build("job", video, "qwen-small")
    described = [scene for scene in result["scenes"] if scene["visual"]]
    assert len(described) == 8 and result["scenes"][1]["visual"] is None and result["scenes"][1]["usable"] is True
    assert result["scenes"][1]["score"] > 0  # still ranked from what was measured
    assert all(scene["score"] == 0 for scene in result["scenes"][8:])  # unusable footage is never offered
    assert service.fresh(video)["scenes"][8]["usable"] is False


def test_failure_or_cancellation_leaves_the_previous_storyboard_untouched(studio):
    service, _, jobs, models, video, _ = studio
    original = service.build("job", video, "qwen-small")

    def unavailable(*_):
        raise WorkError("Local inference failed.")

    models.run_batch = unavailable
    with pytest.raises(WorkError, match="inference failed"):
        service.build("job", video, "qwen-small")
    jobs.cancelled = True
    with pytest.raises(JobCancelled):
        service.build("job", video, "qwen-small")
    assert service.get("v1") == original and service.frame_path("v1", "s000-0.jpg")
    assert not (service.root / "v1.building").exists()
    service.delete("v1")
    assert service.get("v1") is None and not (service.root / "v1").exists()


def test_signals_alone_make_a_storyboard_when_no_model_is_usable(studio):
    service, _, _, models, video, _ = studio
    result = service.build("job", video, None)
    assert not models.batches and result["model_id"] is None and result["vision"] is False
    assert all(scene["highlight"] is None and scene["frames"] for scene in result["scenes"])
    assert max(scene["score"] for scene in result["scenes"]) > 0


def test_storyboard_api_serves_only_what_was_built(client, monkeypatch, tmp_path):
    video = upload_mock(client, monkeypatch)
    listed = client.get("/api/videos").json()[0]
    assert listed["storyboard"] is None and listed["has_transcript"] is False
    assert client.get(f"/api/videos/{video['id']}/storyboard").status_code == 404
    assert client.get("/api/videos/missing/storyboard").status_code == 404
    boards = client.app.state.storyboards
    value = board(video["id"], 5.0)
    value["scenes"][0]["frames"] = [{"time": 1.0, "file": "s000-0.jpg"}]
    (boards.root / video["id"]).mkdir()
    (boards.root / video["id"] / "s000-0.jpg").write_bytes(b"\xff\xd8frame")
    client.app.state.store.put("storyboards", value)
    client.app.state.store.patch("videos", video["id"], storyboard=storyboard.summary(value))
    served = client.get(f"/api/videos/{video['id']}/storyboard").json()
    assert served["scenes"][0]["frames"][0]["url"].startswith(f"/api/videos/{video['id']}/storyboard/frames/")
    frame = client.get(served["scenes"][0]["frames"][0]["url"])
    assert frame.status_code == 200 and frame.content == b"\xff\xd8frame" and frame.headers["content-type"] == "image/jpeg"
    assert client.get(f"/api/videos/{video['id']}/storyboard/frames/s000-9.jpg").status_code == 404
    assert client.get(f"/api/videos/{video['id']}/storyboard/frames/..%2Ffactory.sqlite3").status_code == 404
    assert client.get("/api/videos").json()[0]["storyboard"]["thumbnail"] == "s000-0.jpg"
    line = client.get("/api/factory").json()["sources"][0]
    assert line["thumbnail"] == f"/api/videos/{video['id']}/storyboard/frames/s000-0.jpg"
    assert line["storyboard"]["scenes"] == 2
    # Deleting the source removes what was derived from it.
    assert client.delete(f"/api/videos/{video['id']}").status_code == 200
    assert not (boards.root / video["id"]).exists() and boards.get(video["id"]) is None


def test_watching_can_be_requested_on_its_own_and_reports_progress(client, monkeypatch):
    video = upload_mock(client, monkeypatch)
    built = []

    def build(job, source, model, progress=(5, 95)):
        built.append((source["id"], model))
        return board(source["id"], 5.0, vision=False)

    monkeypatch.setattr(client.app.state.storyboards, "build", build)
    job = client.post(f"/api/videos/{video['id']}/storyboard", json={})
    assert job.status_code == 202 and job.json()["kind"] == "storyboard"
    from test_app import wait_job

    finished = wait_job(client, job.json()["id"])
    assert finished["status"] == "completed" and finished["result"]["scenes"] == 2
    # No model is installed in this workspace: the source is still measured, just not described.
    assert built == [(video["id"], None)]
    assert Path(client.app.state.root / "storyboards").is_dir()
