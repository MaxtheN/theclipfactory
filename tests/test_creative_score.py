"""Real file binding, bounded fake models, and honest rubric provenance. No network."""
import hashlib
import json

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from clip_factory import creative_score as cs
from clip_factory import ranking
from clip_factory.app import create_app
from clip_factory.creative_score_api import install
from clip_factory.jobs import WorkError
from clip_factory.llm_provider import HAIKU, Completion
from clip_factory.store import Store


class Jobs:
    def __init__(self):
        self.pending = []

    def submit(self, kind, operation, **context):
        self.pending.append(operation)
        return {"id": "job"}

    def check(self, job_id):
        assert job_id == "job"


class Gateway:
    def __init__(self, replies=None, enabled=True):
        self.replies = list(replies or [])
        self.enabled = enabled
        self.calls = []
        self.on_call = None

    def uses_cloud(self, role):
        assert role == "agents"
        return self.enabled

    def route(self, role):
        assert role == "agents"
        return {"provider": "openrouter", "model": HAIKU} if self.enabled else {"provider": "local", "model": None}

    def complete_json(self, role, system, user, schema, **options):
        self.calls.append((role, system, user, schema, options))
        if self.on_call:
            self.on_call()
        return Completion(text=self.replies.pop(0), provider="openrouter", model=HAIKU,
                          prompt_tokens=500, completion_tokens=200, cost_usd=0.0002, cost_basis="provider")


def payload():
    def d(quote, source):
        return {"score": 4, "reason": "Specific and supported by the supplied source.",
                "evidence": [{"source": source, "quote": quote}]}
    return {
        "hook_clarity": d("Why teams need focus", "clip_hook"),
        "source_faithfulness": {"score": 4, "reason": "The hook preserves the source meaning.", "evidence": [
            {"source": "clip_hook", "quote": "Why teams need focus"},
            {"source": "source_speech", "quote": "Teams need focus to finish meaningful work."}]},
        "standalone_context": d("Teams need focus to finish meaningful work.", "source_speech"),
        "payoff": d("Focus gives you time to do one thing well.", "source_speech"),
        "brand_fit": d("Useful advice", "brand_brief"),
        "suggested_change": "Test a shorter opening while preserving the source meaning.",
    }


@pytest.fixture
def setup(tmp_path):
    store, jobs, gateway = Store(tmp_path), Jobs(), Gateway()
    path = tmp_path / "clips" / "c.mp4"
    path.parent.mkdir()
    path.write_bytes(b"a real test file, not a claim of playable media")
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    clip = {"id": "c", "video_id": "v", "profile_id": "p", "campaign_id": "camp", "strategy_version_id": "s1",
            "path": "clips/c.mp4", "sha256": sha, "start": 0, "end": 30,
            "hook": "Why teams need focus", "caption": "Finish meaningful work with focus.", "duration": 30,
            "approved": False, "profile_snapshot": {"name": "P", "voice": "Useful advice"},
            "brief_snapshot": {"key_messages": ["Useful advice"], "must_include": []},
            "subtitles_burned": True, "technical_checks": {"playback_format_passed": True},
            "swarm": {"strength": 7, "payoff_verified": True, "spoken": True,
                      "duration": {"ends_on_sentence": True, "band": [24, 36]}}}
    store.put("clips", clip)
    store.put("profiles", {"id": "p", "name": "P"})
    store.put("campaigns", {"id": "camp", "profile_ids": ["p"]})
    store.put("videos", {"id": "v", "transcript": {"segments": [
        {"start": 0, "end": 15, "text": "Teams need focus to finish meaningful work."},
        {"start": 15, "end": 30, "text": "Focus gives you time to do one thing well."},
        {"start": 31, "end": 40, "text": "This must never be sent because it is outside the clip."}]}})
    return cs.CreativeScores(store, tmp_path, gateway, lambda: jobs), store, jobs, gateway, clip, path


def test_scorecard_reuses_actual_production_weights_and_preserves_unknowns(setup):
    service, store, _, _, clip, _ = setup
    view = service.view("c")
    card = view["ranking"]
    expected, _ = ranking.score(clip, None, clip["brief_snapshot"], speech_source=True)
    assert card["score"] == expected and card["rubric_version"] == f"ranking@{ranking.RANK_VERSION}"
    assert {d["id"]: d["weight"] for d in card["dimensions"]} == ranking.WEIGHTS
    unknown = next(d for d in card["dimensions"] if d["id"] == "moment")
    assert unknown["value"] is None and unknown["ranking_value"] == 0.5
    assert card["publication_permission"] is False and store.all(cs.ASSESSMENTS) == []


def test_speechless_and_missing_captions_remain_held(setup):
    _, _, _, _, clip, _ = setup
    silent = {**clip, "swarm": {"spoken": False}, "subtitles_burned": False}
    card = cs.scorecard(silent, speech_source=True)
    assert card["speechless_multiplier"] == ranking.NO_SPEECH_FACTOR
    assert card["hold_reason"] == ranking.NO_SPEECH_REASON


def test_assessment_is_bound_cached_and_never_approves_or_publishes(setup):
    service, store, jobs, gateway, clip, _ = setup
    gateway.replies = [json.dumps(payload())]
    receipt = service.request("c", clip["sha256"])
    assert receipt["status"] == "queued" and len(jobs.pending) == 1
    result = jobs.pending[0]("job")
    assert result["status"] == "assessed" and result["assessment"]["score"] == 80
    assert result["assessment"]["coverage"] == 1 and not result["assessment"]["editorial_hold"]
    assert result["usage"]["calls"] == 1 and result["usage"]["cost_usd"] == 0.0002
    assert service.request("c", clip["sha256"])["cached"] and len(jobs.pending) == 1
    assert not store.get("clips", "c")["approved"]
    assert not store.all("learning_publications") and not store.all("strategy_versions")
    assert "outside the clip" not in gateway.calls[0][2]
    assert "negation" in gateway.calls[0][1]


def test_unverified_quote_gets_one_repair_then_abstains(setup):
    service, _, jobs, gateway, clip, _ = setup
    invalid = payload()
    invalid["hook_clarity"]["evidence"][0]["quote"] = "invented evidence"
    gateway.replies = [json.dumps(invalid), json.dumps(invalid)]
    service.request("c", clip["sha256"])
    result = jobs.pending[0]("job")
    assert result["status"] == "abstained" and result["assessment"] is None
    assert result["usage"]["calls"] == 2 and len(gateway.calls) == 2


def test_repair_can_succeed_and_unknown_is_not_zero(setup):
    service, _, jobs, gateway, clip, _ = setup
    result = payload()
    result["brand_fit"] = {"score": None, "reason": "Brand evidence is insufficient.", "evidence": []}
    gateway.replies = ["not JSON", json.dumps(result)]
    service.request("c", clip["sha256"])
    assessed = jobs.pending[0]("job")["assessment"]
    assert assessed["brand_fit"]["score"] is None and assessed["score"] is None
    assert assessed["coverage"] == 0.85


@pytest.mark.parametrize("bad", [True, 6, -1, 2.5])
def test_scores_refuse_booleans_and_out_of_scale_values(bad):
    result = payload()
    result["hook_clarity"]["score"] = bad
    evidence = {"clip_hook": "Why teams need focus", "source_speech": "Teams need focus to finish meaningful work. Focus gives you time to do one thing well.", "brand_brief": "Useful advice", "clip_caption": ""}
    with pytest.raises(ValueError):
        cs.validate_assessment(json.dumps(result), evidence)


def test_meaning_reversal_can_hold_and_requires_source_and_hook_quotes():
    result = payload()
    result["source_faithfulness"]["score"] = 1
    evidence = {"clip_hook": "Why teams need focus", "source_speech": "Teams need focus to finish meaningful work. Focus gives you time to do one thing well.", "brand_brief": "Useful advice", "clip_caption": ""}
    assert cs.validate_assessment(json.dumps(result), evidence)["editorial_hold"] is True
    result["source_faithfulness"]["evidence"] = [{"source": "clip_hook", "quote": "Why teams need focus"}]
    with pytest.raises(ValueError):
        cs.validate_assessment(json.dumps(result), evidence)


def test_bytes_context_or_model_changes_cannot_reuse_an_assessment(setup):
    service, store, jobs, gateway, clip, path = setup
    gateway.replies = [json.dumps(payload())]
    first = service.request("c", clip["sha256"])
    store.patch("clips", "c", caption="A new caption changes the assessment context.")
    assert not service.view("c")["assessments"][0]["current"]
    with pytest.raises(WorkError):
        jobs.pending[0]("job")
    assert gateway.calls == [] and store.get(cs.ASSESSMENTS, first["id"])["status"] == "failed"
    path.write_bytes(b"changed")
    with pytest.raises(HTTPException) as error:
        service.request("c", clip["sha256"])
    assert error.value.status_code == 409


def test_cloud_opt_in_and_workspace_scope_are_enforced(setup):
    service, store, jobs, gateway, clip, _ = setup
    gateway.enabled = False
    with pytest.raises(HTTPException):
        service.request("c", clip["sha256"])
    assert jobs.pending == [] and gateway.calls == []
    gateway.enabled = True
    store.patch("campaigns", "camp", profile_ids=["someone-else"])
    with pytest.raises(HTTPException):
        service.view("c")
    store.patch("campaigns", "camp", profile_ids=["p"])
    store.patch("profiles", "p", archived_at="2026-11-14")
    with pytest.raises(HTTPException):
        service.request("c", clip["sha256"])


def test_changed_model_or_bytes_during_call_discards_result(setup):
    service, store, jobs, gateway, clip, path = setup
    gateway.replies = [json.dumps(payload())]
    gateway.on_call = lambda: path.write_bytes(b"different bytes")
    receipt = service.request("c", clip["sha256"])
    with pytest.raises(WorkError):
        jobs.pending[0]("job")
    result = store.get(cs.ASSESSMENTS, receipt["id"])
    assert result["status"] == "failed" and result["assessment"] is None
    assert result["usage"]["calls"] == 1


def test_file_path_cannot_escape_library(setup):
    service, store, _, _, clip, _path = setup
    store.patch("clips", "c", path="../outside.mp4")
    with pytest.raises(HTTPException):
        service.request("c", clip["sha256"])


def test_api_inherits_auth_and_rejects_bad_request_without_a_model_call(tmp_path):
    app = create_app(tmp_path, token="token")
    app.state.llm = Gateway()
    install(app)
    with TestClient(app, base_url="http://127.0.0.1", headers={"X-Clip-Token": "token"}) as client:
        assert client.get("/api/clips/missing/scorecard").status_code == 404
        assert client.get("/api/clips/missing/scorecard", headers={"X-Clip-Token": "wrong"}).status_code == 401
        assert client.post("/api/clips/missing/assess", json={"expected_sha256": "x"}).status_code == 422
        assert client.post("/api/clips/missing/assess", json={"expected_sha256": "a" * 64, "approve": True}).status_code == 422


def test_after_ranking_queues_every_exact_clip_once_and_retains_generation_state(setup):
    service, store, jobs, gateway, _clip, _ = setup
    store.patch("clips", "c", team_run_id="run")
    store.put("team_runs", {"id": "run", "clip_ids": ["c", "c"], "status": "completed"})
    summary = service.after_ranking("run")
    assert len(summary["requested"]) == 1 and len(jobs.pending) == 1
    assert "separate usage" in summary["policy"]["cost_basis"]
    assert len(service.after_ranking("run")["cached"]) == 1 and len(jobs.pending) == 1
    assert store.get("team_runs", "run")["status"] == "completed"
    gateway.enabled = False
    held = service.after_ranking("run")
    assert held["held"] == ["c"] and held["policy"]["status"] == "held"
    assert service.view("c")["judge_policy"]["automatic_after_production"] is False


def test_after_ranking_never_scores_a_foreign_clip_or_fails_production(setup):
    service, store, _, _, _, path = setup
    store.put("team_runs", {"id": "other", "clip_ids": ["c"], "status": "completed"})
    summary = service.after_ranking("other")
    assert len(summary["errors"]) == 1 and summary["requested"] == []
    store.patch("clips", "c", team_run_id="other")
    path.unlink()
    summary = service.after_ranking("other")
    assert len(summary["errors"]) == 1 and store.get("team_runs", "other")["status"] == "completed"


def test_failed_assessment_requires_explicit_retry_and_retains_failure_receipt(setup):
    service, _store, jobs, gateway, clip, _path = setup
    first = service.request("c", clip["sha256"])
    gateway.on_call = lambda: (_ for _ in ()).throw(WorkError("Temporary provider failure"))
    with pytest.raises(WorkError):
        jobs.pending[0]("job")
    assert service.request("c", clip["sha256"])["cached"]
    assert len(jobs.pending) == 1
    retried = service.request("c", clip["sha256"], retry_failed=True)
    assert retried["id"] == first["id"] and retried["status"] == "queued"
    assert retried["previous_attempts"][0]["status"] == "failed" and len(jobs.pending) == 2


def test_current_assessment_requires_exact_bytes_on_view_and_missing_file_is_unknown(setup):
    service, _, jobs, gateway, clip, path = setup
    gateway.replies = [json.dumps(payload())]
    service.request("c", clip["sha256"])
    jobs.pending[0]("job")
    assert service.view("c")["assessments"][0]["current"]
    path.write_bytes(b"changed after assessment")
    view = service.view("c")
    assert view["integrity"]["status"] == "hold"
    assert not view["assessments"][0]["current"]
    path.unlink()
    view = service.view("c")
    assert view["integrity"]["status"] == "unknown"
    assert not view["assessments"][0]["current"]


def test_read_only_scorecard_does_not_reconcile_interrupted_assessment(setup):
    service, store, _, _, clip, _ = setup
    receipt = service.request("c", clip["sha256"])
    store.put("jobs", {"id": receipt["job_id"], "status": "failed"})
    before = store.all(cs.ASSESSMENTS)
    view = service.view("c", reconcile=False)
    assert view["assessments"][0]["status"] == "queued"
    assert store.all(cs.ASSESSMENTS) == before
    assert service.view("c")["assessments"][0]["status"] == "failed"


def test_actual_ana_caption_gets_independent_hold_without_rewriting_ai_score(setup):
    service, store, jobs, gateway, clip, _ = setup
    caption = "Ana points out how vague anonymous sourcing like 'people briefed on the matter' really is."
    store.patch("clips", "c", caption=caption)
    gateway.replies = [json.dumps(payload())]
    service.request("c", clip["sha256"])
    receipt = jobs.pending[0]("job")
    assert receipt["assessment"]["source_faithfulness"]["score"] == 4
    view = service.view("c", reconcile=False)
    assert view["editorial_hold"] is True
    guard = view["source_attribution"]
    assert guard["status"] == "hold" and guard["speaker_context"] == "unknown"
    [finding] = guard["findings"]
    assert finding["name"] == "Ana" and finding["quote"] == "Ana points out"
    assert finding["source"] == "clip_caption" and finding["source_name_mentioned"] is False
    assert caption[finding["start"]:finding["end"]] == finding["quote"]
    assert view["assessments"][0]["assessment"]["source_faithfulness"]["score"] == 4
    assert store.get("clips", "c")["caption"] == caption
    assert "named speaker attribution" in gateway.calls[0][1]


@pytest.mark.parametrize("caption", [
    "The speaker discusses Eric Swalwell and a defensive briefing.",
    "Four questions nobody is answering",
    "Research suggests a useful starting point.",
    "Eric Swalwell was a congressman. The speaker asks why no briefing was given.",
    "Friends unpack the questions. The speaker says more context is needed.",
])
def test_people_discussed_and_generic_speaker_are_not_unsupported_named_speakers(caption):
    result = cs.source_attribution_guard({"caption": caption}, {})
    assert not result["editorial_hold"] and result["findings"] == []


def test_name_mention_does_not_establish_speaker_but_explicit_reported_attribution_can():
    clip = {"start": 0, "end": 10, "caption": "Eric Swalwell said he cut off the relationship."}
    video = {"transcript": {"segments": [{"start": 0, "end": 10, "text": "Eric Swalwell was a congressman."}]}}
    held = cs.source_attribution_guard(clip, video)
    assert held["editorial_hold"] and held["findings"][0]["source_name_mentioned"] is True
    video["transcript"]["segments"][0]["text"] = "Eric Swalwell said he cut off the relationship."
    assert not cs.source_attribution_guard(clip, video)["editorial_hold"]
    # User/independent verification can support identity; raw metadata never does.
    video = {"verified_speakers": ["Ana"]}
    assert cs.source_attribution_guard({"caption": "Ana argues that this needs context."}, video)["editorial_hold"]
    assert not cs.source_attribution_guard({"caption": "Ana argues that this needs context."}, video,
                                           verified_speaker_names=["Ana"])["editorial_hold"]
