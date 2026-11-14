"""Bounded team orchestration with scripted JSON, never weights or remote APIs.

Roles select storyboard scenes by ID; source ranges are derived and repaired in code.
"""

import copy
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from conftest import board

from clip_factory.jobs import JobCancelled, WorkError
from clip_factory.models import Models
from clip_factory.store import Store
from clip_factory.team import (
    ROLES,
    Critique,
    Edits,
    Footage,
    Performance,
    Plan,
    Revision,
    Strategy,
    TeamEngine,
    decode_output,
    fit_range,
    snap_to_speech,
)


def plan():
    return {
        "summary": "Make a source-backed draft",
        "tasks": [
            {"role": role, "instruction": f"Complete {role} using supplied evidence"} for role in ROLES[1:]
        ],
    }


def footage(*refs):
    return {
        "moments": [{"scenes": list(refs or ["scene:0"]), "summary": "Visible source"}],
        "limitations": "A few frames per scene do not show everything",
    }


def moment(start=0.0, end=1.0, refs=("scene:0",), peak=0.5):
    """What the engine derives from a cited scene: measured range, never model-supplied."""
    return {
        "start": start,
        "end": end,
        "summary": "Visible source",
        "scenes": list(refs),
        "evidence_refs": list(refs),
        "peak_time": peak,
        "id": "moment-1",
    }


def strategy(objective="sales"):
    return {
        "angles": [
            {
                "id": "angle-1",
                "moment": "moment-1",
                "objective": objective,
                "hook": "See the source",
                "rationale": "A supported demonstration",
            }
        ]
    }


def edits(ref="scene:0", *, hook="See the source", objective="sales"):
    return {
        "candidates": [
            {
                "start": 0,
                "end": 1,
                "hook": hook,
                "caption": "A silent demonstration",
                "reason": "Supported source range",
                "objective": objective,
                "angle_id": "angle-1",
                "evidence_refs": [ref],
            }
        ]
    }


def critique(verdict="pass", ref="scene:0"):
    check = {"pass": "pass", "revise": "fail", "unknown": "unknown"}[verdict]
    return {
        "verdict": verdict,
        "checks": {key: check for key in ("context", "claims", "captions", "duplicates")},
        "findings": []
        if verdict == "pass"
        else [
            {
                "candidate_index": 0,
                "category": "claims",
                "severity": "error" if check == "fail" else "warning",
                "evidence_refs": [ref],
                "message": "Claim needs source support",
            }
        ],
    }


def revision(instruction="Remove unsupported claim", decision="revise"):
    return {"decision": decision, "instruction": instruction}


def script(ref="scene:0", *, verdict="pass", objective="sales"):
    # Source IDs passed by API fixtures select this source, not grounding evidence.
    # Negative cases set literal invalid refs after building this valid script.
    if ref.startswith("source:"):
        ref = "scene:0"
    return [
        plan(),
        footage(),
        strategy(objective),
        edits(ref, objective=objective),
        critique(verdict, ref if ref.startswith("scene:") else "scene:0"),
    ]


class ScriptedModels:
    """Each request is independently parsed; an unexpected extra call fails immediately."""

    def __init__(self, outputs):
        self.outputs = copy.deepcopy(outputs)
        self.calls = []
        self.required = []
        self.after_call = None
        self.sees = True
        self.batches = []
        self.closeups = []

    def require(self, identifier, kind):
        self.required.append((identifier, kind))

    def vision(self, identifier):
        return self.sees

    def run_batch(self, job_id, model_id, requests):
        """Close looks. Unscripted, they are unavailable and production carries on without them."""
        self.batches.append(copy.deepcopy(requests))
        scripted = self.closeups[: len(requests)]
        return [
            {"output": json.dumps(scripted[index])} if index < len(scripted) else {"error": "unscripted"}
            for index in range(len(requests))
        ]

    def run(self, job_id, model_id, action, **payload):
        prompt = payload["prompt"]
        schema_text, data_text = prompt.split("\nSCHEMA:\n", 1)[1].split("\nDATA:\n", 1)
        # The grammar the model is held to is exactly the schema it is shown.
        assert payload["schema"] == json.loads(schema_text)
        self.calls.append(
            {
                "job_id": job_id,
                "model_id": model_id,
                "action": action,
                "data": json.loads(data_text),
                **payload,
            }
        )
        assert self.outputs, "Unexpected dependent model call"
        output = self.outputs.pop(0)
        if self.after_call:
            self.after_call(len(self.calls))
        return {"output": output if isinstance(output, str) else json.dumps(output)}


class DirectJobs:
    def __init__(self):
        self.cancelled = False
        self.messages = []

    def check(self, _):
        if self.cancelled:
            raise JobCancelled()

    def update(self, _, **changes):
        self.messages.append(changes)


class Harness:
    def __init__(self, root, outputs):
        self.store = Store(root)
        self.jobs = DirectJobs()
        self.models = ScriptedModels(outputs)
        self.video = self.store.put(
            "videos",
            {
                "id": "source",
                "name": "Silent source",
                "duration": 2,
                "width": 320,
                "height": 180,
                "size": 100,
                "has_audio": False,
            },
        )
        self.config = {"brand": "Original brand", "objective": "sales", "language": "en", "custom_event": ""}
        self.rendered = []
        # Two one-second scenes: scene:0 covers 0-1s, scene:1 covers 1-2s.
        self.board = board("source", 2.0, scenes=2)
        self.watched = []
        self.still_requests = []
        self.transcribe = Mock(side_effect=AssertionError("Silent source must not be transcribed"))
        self.baseline = Mock(side_effect=AssertionError("Team must not invoke baseline"))
        self.engine = self.new_engine()

    def render(self, job_id, video, candidate):
        self.rendered.append(copy.deepcopy(candidate))
        identifier = f"clip-{len(self.rendered)}"
        self.store.put(
            "clips",
            {
                "id": identifier,
                "video_id": video["id"],
                "approved": False,
                **{k: v for k, v in candidate.items() if k != "_team"},
                **candidate["_team"],
            },
        )
        return {"clip_id": identifier}

    def storyboard(self, job_id, video, model_id, progress=None):
        self.watched.append((job_id, video["id"], model_id))
        return self.board

    def stills(self, job_id, video, ranges, per_range):
        self.still_requests.append((list(ranges), per_range))
        return [
            {"time": round((start + end) / 2, 2), "path": f"still-{index}.jpg", "range": index}
            for index, (start, end) in enumerate(ranges)
        ]

    def dense_stills(self, job_id, video, ranges, per_range):
        """Several frames per range, as the real extractor returns."""
        self.still_requests.append((list(ranges), per_range))
        return [
            {
                "time": round(start + (n + 0.5) * (end - start) / per_range, 3),
                "path": f"still-{index}-{n}.jpg",
                "range": index,
            }
            for index, (start, end) in enumerate(ranges)
            for n in range(per_range)
        ]

    def new_engine(self):
        return TeamEngine(
            self.store,
            self.jobs,
            self.models,
            transcribe=self.transcribe,
            render=self.render,
            storyboard=self.storyboard,
            frames=self.stills,
            baseline=self.baseline,
        )

    def use(self, outputs):
        self.models = ScriptedModels(outputs)
        self.engine.models = self.models
        return self.models

    def create(self, **kwargs):
        return self.engine.create(self.video, self.config, "qwen-small", **kwargs)

    def execute(self, **kwargs):
        run = self.create(**kwargs)
        result = self.engine.execute(run["id"], "job")
        return self.engine.get(run["id"]), result


@pytest.fixture
def harness(tmp_path):
    return Harness(tmp_path, script())


def role(run, name, iteration=0):
    return next(t for t in run["tasks"] if t["role"] == name and t["iteration"] == iteration)


def titles(models):
    return [call["schema"]["title"] for call in models.calls]


def seed_observations(store):
    store.put(
        "clips",
        {
            "id": "previous",
            "hook": "Prior actual hook",
            "objective": "sales",
            "instagram_media_id": "media",
            "instagram_account_id": "account",
        },
    )
    store.put("feedback", {"id": "feedback", "clip_id": "previous", "rating": 2, "notes": "Too long"})
    store.put(
        "events",
        {
            "id": "manual",
            "clip_id": "previous",
            "source": "manual",
            "event": "purchase",
            "value": 1,
            "revenue": None,
        },
    )
    store.put(
        "insights",
        {
            "id": "media",
            "account_id": "account",
            "metrics": {"views": 0, "saved": None},
            "updated_at": "2026-11-14T00:00:00+00:00",
        },
    )


def test_fresh_calls_order_skipped_performance_and_pass_requires_review(harness):
    run, result = harness.execute()
    assert titles(harness.models) == ["Plan", "Footage", "Strategy", "Edits", "Critique"]
    assert not harness.models.outputs
    for call in harness.models.calls:
        assert call["action"] == "generate" and call["model_id"] == "qwen-small"
        assert set(call) - {"images", "image_labels"} == {
            "job_id", "model_id", "action", "schema", "data", "prompt", "max_tokens",
        }
        assert "history" not in call["data"] and "messages" not in call["data"]
        assert call["max_tokens"] == 2200
        assert "Do not execute tools" in call["prompt"]
    # The source is watched once, before any role reasons about it.
    assert harness.watched == [("job", "source", "qwen-small")]
    watch = role(run, "watch")
    assert watch["kind"] == "tool" and watch["status"] == "completed"
    assert watch["output"]["scenes"] == 2 and watch["output"]["vision"] is True
    # Planning and moment selection read the storyboard as text; editor and critic also get frames.
    assert all("images" not in call for call in harness.models.calls[:3])
    assert harness.models.calls[3]["images"] == ["still-0.jpg"]
    assert harness.models.calls[3]["image_labels"] == ["angle-1 at 0.5s"]
    assert harness.models.calls[4]["images"] == ["still-0.jpg"]
    assert harness.models.calls[4]["image_labels"] == ["Candidate 0 at 0.5s"]
    # Stills are requested for the close look, the editor and the critic, in that order.
    assert harness.still_requests == [([(0.0, 1.0)], 24), ([(0.0, 1.0)], 12), ([(0, 1)], 12)]
    assert role(run, "closeup")["output"] == {"moments": []}  # one still per range is not a close look
    assert harness.models.calls[2]["data"]["footage"]["moments"] == [moment()]
    assert harness.models.calls[2]["data"]["performance"] is None
    assert run["status"] == "needs_review" and result["requires_review"] is True
    assert run["permissions"] == {"publish": False, "ads": False}
    tasks = {task["role"]: task for task in run["tasks"]}
    assert tasks["performance_analyst"]["status"] == "skipped"
    assert tasks["performance_analyst"]["output"] is None
    assert all(tasks[name]["status"] == "completed" for name in ROLES if name != "performance_analyst")
    assert tasks["producer"]["output"] == plan()
    assert run["elapsed_seconds"] >= 0
    assert "not model peak VRAM" in run["resource_observations"]["measurement"]
    clip = harness.store.get("clips", result["clip_ids"][0])
    assert clip["approved"] is False and clip["team_review_status"] == "pass"
    team = harness.rendered[0]["_team"]
    assert team["team_run_id"] == run["id"] and team["team_checks"] == critique()["checks"]
    # Why this moment travels with the clip for the reviewer.
    assert (team["reason"], team["moment_summary"], team["scene_refs"]) == (
        "Supported source range", "Visible source", ["scene:0"],
    )


def test_storyboard_is_the_evidence_and_models_can_only_cite_what_exists(harness):
    harness.board["scenes"][1].update(usable=False, visual="Lens covered")
    run, _ = harness.execute()
    evidence = run["context"]["evidence"]
    # Unusable footage is not offered to any role.
    assert set(evidence) == {"source:source", "scene:0"}
    assert evidence["scene:0"]["seen"] == "Visible source scene 0"
    assert (evidence["scene:0"]["start"], evidence["scene:0"]["end"]) == (0.0, 1.0)
    analyst = harness.models.calls[1]
    assert [row["ref"] for row in analyst["data"]["storyboard"]] == ["scene:0"]
    assert analyst["schema"]["$defs"]["Moment"]["properties"]["scenes"]["items"] == {
        "type": "string", "enum": ["scene:0"],
    }
    assert analyst["schema"]["properties"]["moments"]["maxItems"] == 3
    editor = harness.models.calls[3]["schema"]["$defs"]["Candidate"]["properties"]
    assert editor["angle_id"]["enum"] == ["angle-1"]
    assert editor["evidence_refs"]["items"]["enum"] == ["scene:0"]
    critic = harness.models.calls[4]["schema"]["$defs"]["Finding"]["properties"]
    assert critic["candidate_index"]["maximum"] == 0
    assert critic["evidence_refs"]["items"]["enum"] == ["source:source", "scene:0"]
    # The producer plans from a brief, not from the whole evidence set.
    assert "evidence" not in harness.models.calls[0]["data"]["context"]
    assert harness.models.calls[0]["data"]["context"]["storyboard"]["scenes"] == 1


def test_no_usable_footage_stops_before_any_model_call(harness):
    for scene in harness.board["scenes"]:
        scene["usable"] = False
    run = harness.create()
    with pytest.raises(WorkError, match="No usable footage"):
        harness.engine.execute(run["id"], "job")
    assert not harness.models.calls and not harness.rendered
    assert harness.engine.get(run["id"])["status"] == "failed"


def test_all_six_roles_observed_performance_keeps_actual_provenance(harness):
    seed_observations(harness.store)
    performance = {
        "recommendations": [
            {
                "recommendation": "Shorten the draft",
                "evidence_refs": ["feedback:feedback", "event:manual", "observation:media"],
                "limitation": "Manual events and platform counts do not establish causal lift",
            }
        ]
    }
    outputs = script()
    outputs.insert(2, performance)
    harness.use(outputs)
    run, _ = harness.execute()
    assert titles(harness.models) == ["Plan", "Footage", "Performance", "Strategy", "Edits", "Critique"]
    observations = harness.models.calls[2]["data"]["observations"]
    assert observations["event:manual"]["source"] == "manual"
    assert observations["event:manual"]["revenue"] is None
    assert observations["observation:media"]["account_id"] == "account"
    assert observations["observation:media"]["metrics"] == {"views": 0, "saved": None}
    assert harness.models.calls[3]["data"]["performance"] == performance
    assert all(task["status"] == "completed" for task in run["tasks"])


@pytest.mark.parametrize(
    "cited,expected",
    [
        (["scene:1"], (1.0, 2.0, ["scene:1"])),
        (["scene:0", "scene:1"], (0.0, 2.0, ["scene:0", "scene:1"])),
        (["scene:1", "scene:0"], (0.0, 2.0, ["scene:0", "scene:1"])),
        # Scenes that are not adjacent to the first-cited one are not stitched into its range.
        (["scene:0", "scene:3"], (0.0, 1.0, ["scene:0"])),
        (["scene:9", "scene:2"], (2.0, 3.0, ["scene:2"])),
    ],
)
def test_moment_ranges_are_measured_from_cited_scenes(harness, cited, expected):
    harness.video["duration"] = 4
    harness.store.put("videos", harness.video)
    harness.board = board("source", 4.0, scenes=4)
    outputs = script()
    outputs[1] = footage(*cited)
    start, end, refs = expected
    outputs[3]["candidates"][0].update(start=start, end=end, evidence_refs=[refs[0]])
    outputs[4] = critique("pass")
    harness.use(outputs)
    run, _ = harness.execute()
    accepted = role(run, "footage_analyst")["output"]["moments"][0]
    assert (accepted["start"], accepted["end"], accepted["scenes"]) == (start, end, refs)
    assert accepted["evidence_refs"] == refs
    assert (harness.rendered[0]["start"], harness.rendered[0]["end"]) == (start, end)


def test_long_moments_are_capped_around_the_first_cited_scene(harness):
    harness.video["duration"] = 360
    harness.store.put("videos", harness.video)
    harness.board = board("source", 360.0, scenes=4)  # 90-second scenes
    outputs = script()
    outputs[1] = footage("scene:1", "scene:0", "scene:2")
    outputs[3]["candidates"][0].update(start=95, end=140, evidence_refs=["scene:1"])
    harness.use(outputs)
    run, _ = harness.execute()
    accepted = role(run, "footage_analyst")["output"]["moments"][0]
    # Three 90s scenes would be 270s; the scene farthest from the first cited one is dropped.
    assert accepted["end"] - accepted["start"] == 180 and "scene:1" in accepted["scenes"]
    assert len(accepted["scenes"]) == 2


def test_duplicate_or_ungrounded_moments_are_omitted_and_noted(harness):
    outputs = script()
    outputs[1]["moments"] += [
        {"scenes": ["scene:0"], "summary": "Same range again"},
        {"scenes": ["source:source"], "summary": "Metadata is not footage"},
    ]
    harness.use(outputs)
    run, _ = harness.execute()
    accepted = role(run, "footage_analyst")["output"]
    assert accepted["moments"] == [moment()]
    assert "omitted" in accepted["limitations"]
    assert run["status"] == "needs_review" and len(harness.rendered) == 1


def test_requested_clip_count_bounds_moments_angles_and_candidates(harness):
    harness.video["duration"] = 6
    harness.store.put("videos", harness.video)
    harness.board = board("source", 6.0, scenes=6)
    harness.config["clip_count"] = 2
    outputs = script()
    outputs[1]["moments"] = [{"scenes": [f"scene:{i}"], "summary": f"Moment {i}"} for i in range(4)]
    outputs[2]["angles"] = [
        {**strategy()["angles"][0], "id": f"angle-{i + 1}", "moment": f"moment-{i + 1}"} for i in range(2)
    ]
    outputs[3]["candidates"] = [
        {**edits()["candidates"][0], "angle_id": f"angle-{i + 1}", "start": i, "end": i + 1,
         "evidence_refs": [f"scene:{i}"], "hook": f"Clip {i}"}
        for i in range(2)
    ]
    harness.use(outputs)
    run, result = harness.execute()
    assert run["clip_count"] == 2
    assert len(role(run, "footage_analyst")["output"]["moments"]) == 2
    assert harness.models.calls[1]["schema"]["properties"]["moments"]["maxItems"] == 2
    assert harness.models.calls[2]["schema"]["properties"]["angles"]["maxItems"] == 2
    assert harness.models.calls[2]["schema"]["$defs"]["Angle"]["properties"]["moment"]["enum"] == [
        "moment-1", "moment-2",
    ]
    assert [clip["hook"] for clip in harness.rendered] == ["Clip 0", "Clip 1"]
    assert len(result["clip_ids"]) == 2


def test_schema_correction_repairs_a_malformed_handoff_before_dependent_calls(harness):
    outputs = script()
    oversized = copy.deepcopy(outputs[1])
    oversized["moments"][0]["scenes"] = ["scene:0"] * 5
    outputs.insert(1, oversized)
    harness.use(outputs)
    run, _ = harness.execute()
    assert titles(harness.models) == ["Plan", "Footage", "Footage", "Strategy", "Edits", "Critique"]
    correction = harness.models.calls[2]["data"]["format_correction"]
    assert correction[0]["field"] == "moments.0.scenes"
    assert "at most 4" in correction[0]["problem"]
    assert run["status"] == "needs_review"
    assert len(harness.rendered) == 1
    assert role(run, "footage_analyst")["output"]["moments"] == [moment()]


@pytest.mark.parametrize("problem", ["malformed", "ungrounded"])
def test_unusable_moment_selection_falls_back_to_the_measured_shortlist(harness, problem):
    harness.board["scenes"][1].update(score=0.9, visual="A decisive rally")
    rejected = footage("source:invented")
    if problem == "malformed":
        rejected["moments"][0]["scenes"] = ["scene:0"] * 5
    outputs = script()
    outputs[1:2] = [rejected, rejected]
    outputs[3]["angles"][0]["moment"] = "moment-2"
    outputs[4]["candidates"][0].update(start=1, end=2, evidence_refs=["scene:1"])
    outputs[5] = critique("pass", "scene:1")
    harness.use(outputs)
    run, result = harness.execute()
    assert titles(harness.models) == ["Plan", "Footage", "Footage", "Strategy", "Edits", "Critique"]
    assert role(run, "footage_analyst")["status"] == "failed"
    shortlist = role(run, "shortlist")
    assert shortlist["kind"] == "tool" and shortlist["status"] == "completed"
    # Highest measured and observed interest first; described by what the watcher saw.
    assert [m["scenes"] for m in shortlist["output"]["moments"]] == [["scene:0"], ["scene:1"]]
    assert shortlist["output"]["moments"][1]["summary"] == "A decisive rally"
    assert run["status"] == "needs_review" and "shortlisted from measured signals" in run["stop_reason"]
    assert len(harness.rendered) == 1 and result["requires_review"] is True
    assert not harness.store.all("clips")[0]["approved"]


def test_footage_keeps_valid_moments_when_another_row_violates_the_schema(harness):
    outputs = script()
    rejected = copy.deepcopy(outputs[1]["moments"][0])
    rejected["scenes"] = ["scene:0"] * 5
    outputs[1]["moments"].append(rejected)
    harness.use(outputs)
    run, _ = harness.execute()
    accepted = role(run, "footage_analyst")["output"]
    assert accepted["moments"] == [moment()]
    assert "structured fields were invalid" in accepted["limitations"]
    assert titles(harness.models) == ["Plan", "Footage", "Strategy", "Edits", "Critique"]
    assert len(harness.rendered) == 1


def test_schema_correction_honors_cancellation_before_retry(harness):
    oversized = footage()
    oversized["moments"][0]["scenes"] = ["scene:0"] * 5
    harness.use([plan(), oversized])
    harness.models.after_call = lambda calls: setattr(harness.jobs, "cancelled", calls == 2)
    run = harness.create()
    with pytest.raises(JobCancelled):
        harness.engine.execute(run["id"], "job")
    assert titles(harness.models) == ["Plan", "Footage"]
    assert not harness.rendered
    assert harness.engine.get(run["id"])["status"] == "cancelled"


@pytest.mark.parametrize("role_index", [1, 3])
def test_grounding_correction_revalidates_footage_and_editor_before_dependents(harness, role_index):
    outputs = script()
    rejected = copy.deepcopy(outputs[role_index])
    if role_index == 1:
        rejected["moments"][0]["scenes"] = ["scene:9"]
    else:
        rejected["candidates"][0]["angle_id"] = "angle-2"
    outputs.insert(role_index, rejected)
    harness.use(outputs)
    run, _ = harness.execute()
    correction = harness.models.calls[role_index + 1]["data"]
    assert correction["previous_handoff"] == rejected
    assert correction["format_correction"][0]["field"] == "source_grounding"
    assert run["status"] == "needs_review"
    assert len(harness.rendered) == 1
    assert harness.rendered[0]["end"] == 1


def test_grounding_correction_honors_cancellation(harness):
    harness.use([plan(), footage("scene:9")])
    harness.models.after_call = lambda calls: setattr(harness.jobs, "cancelled", calls == 2)
    run = harness.create()
    with pytest.raises(JobCancelled):
        harness.engine.execute(run["id"], "job")
    assert titles(harness.models) == ["Plan", "Footage"]
    assert not harness.rendered


def test_strategy_repairs_labels_and_objective_and_keeps_one_angle_per_moment(harness):
    harness.video["duration"] = 4
    harness.store.put("videos", harness.video)
    harness.board = board("source", 4.0, scenes=4)
    outputs = script()
    outputs[1]["moments"].append({"scenes": ["scene:2"], "summary": "Second moment"})
    first = outputs[2]["angles"][0]
    outputs[2]["angles"] = [
        {**first, "id": "angle-3", "moment": "moment-2", "objective": "traffic"},  # label and objective are set, not judged
        {**first, "hook": "Same footage again"},
        {**first, "id": "angle-1", "moment": "moment-2"},  # a second angle on one moment is the same clip
        {**first, "moment": "moment-5"},  # there is no such moment
    ]
    outputs[3]["candidates"][0].update(start=2, end=3, evidence_refs=["scene:2"])
    harness.use(outputs)
    run, _ = harness.execute()
    accepted = role(run, "creative_strategist")["output"]["angles"]
    assert [(a["id"], a["objective"], a["moment"], a["moment_index"]) for a in accepted] == [
        ("angle-1", "sales", "moment-2", 1), ("angle-2", "sales", "moment-1", 0),
    ]
    assert harness.models.calls[3]["schema"]["$defs"]["Candidate"]["properties"]["angle_id"]["enum"] == [
        "angle-1", "angle-2",
    ]
    assert "Omitted 2 invalid creative angles" in run["stop_reason"]
    assert run["status"] == "needs_review" and len(harness.rendered) == 1


def test_discovery_keeps_the_strategists_intended_outcomes(harness):
    harness.config["objective"] = "discovery"
    harness.use(script(objective="traffic"))
    run, _ = harness.execute()
    assert role(run, "creative_strategist")["output"]["angles"][0]["objective"] == "traffic"
    assert harness.rendered[0]["objective"] == "traffic"


def test_editor_zooms_into_selected_moments_with_their_speech(harness):
    harness.store.patch("videos", "source", transcript={"segments": [
        {"start": 0.2, "end": 0.9, "text": "Speech inside the moment"},
        {"start": 1.2, "end": 1.9, "text": "Speech in an unselected scene"},
    ]})
    run, _ = harness.execute()
    editor = harness.models.calls[3]["data"]
    # Speech joins the evidence only for the moments that were selected.
    assert set(run["context"]["evidence"]) == {"source:source", "scene:0", "scene:1", "transcript:0"}
    assert set(editor["evidence"]) == {"scene:0", "transcript:0"}
    assert editor["evidence"]["transcript:0"] == {"start": 0.2, "end": 0.9, "text": "Speech inside the moment"}
    assert editor["allowed_source_ranges"] == {
        "angle-1": {
            "start": 0.0, "end": 1.0, "objective": "sales",
            "evidence_refs": ["scene:0", "transcript:0"], "peak_time": 0.5,
            "suggested_range": {"start": 0.0, "end": 1.0},
        }
    }
    critic = harness.models.calls[4]["data"]
    assert set(critic["evidence"]) == {"source:source", "scene:0", "transcript:0"}
    assert critic["clip_speech"] == ["Speech inside the moment"]


@pytest.mark.parametrize(
    "proposed,rendered,adjusted",
    [
        ((0, 1), (0, 1), False),
        ((0.2, 0.8), (0.0, 1.0), False),  # under a second is not a clip: widened to the moment
        ((0, 3), (0.0, 1.0), True),  # runs past its moment: trimmed to it
        ((1.4, 1.9), (0.0, 1.0), True),  # misses its moment: centred on the measured peak
    ],
)
def test_editor_ranges_are_fitted_inside_their_moment_instead_of_rejected(harness, proposed, rendered, adjusted):
    outputs = script()
    outputs[3]["candidates"][0].update(start=proposed[0], end=proposed[1])
    harness.use(outputs)
    harness.execute()
    assert titles(harness.models) == ["Plan", "Footage", "Strategy", "Edits", "Critique"]
    assert (harness.rendered[0]["start"], harness.rendered[0]["end"]) == rendered
    assert ("adjusted" in harness.rendered[0]) is adjusted
    # The critic reviews the range that will actually be rendered.
    reviewed = harness.models.calls[4]["data"]["candidates"][0]
    assert (reviewed["start"], reviewed["end"]) == rendered


def test_editor_objective_and_references_are_repaired_to_the_assigned_angle(harness):
    outputs = script()
    outputs[3]["candidates"][0].update(objective="traffic", evidence_refs=["scene:1", "source:invented"])
    harness.use(outputs)
    run, _ = harness.execute()
    assert harness.rendered[0]["objective"] == "sales"
    assert harness.rendered[0]["evidence_refs"] == ["scene:0"]
    assert run["status"] == "needs_review"


@pytest.mark.parametrize("role_index", [2, 3])
def test_unusable_strategy_or_edit_stops_before_any_render(harness, role_index):
    outputs = script()[: role_index + 1]
    if role_index == 2:
        outputs[2]["angles"][0]["moment"] = "moment-5"
    else:
        outputs[3]["candidates"][0]["angle_id"] = "angle-2"
        outputs.append(copy.deepcopy(outputs[3]))
    harness.use(outputs)
    run = harness.create()
    with pytest.raises(WorkError):
        harness.engine.execute(run["id"], "job")
    assert not harness.models.outputs
    assert not harness.rendered
    assert harness.engine.get(run["id"])["status"] == "failed"


@pytest.mark.parametrize("metrics,account", [({"views": None}, "account"), ({"views": 10}, "other-account")])
def test_unknown_or_wrong_account_metrics_do_not_invent_performance(harness, metrics, account):
    seed_observations(harness.store)
    harness.store.delete("events", "manual")
    harness.store.delete("feedback", "feedback")
    harness.store.patch("insights", "media", metrics=metrics, account_id=account)
    run, _ = harness.execute()
    assert "Performance" not in titles(harness.models)
    assert not any(ref.startswith("observation:") for ref in run["context"]["evidence"])


@pytest.mark.parametrize("bad", ["permissions", "tools", "truncated"])
def test_invalid_plan_fails_before_any_render(harness, bad):
    outputs = script()
    if bad in {"permissions", "tools"}:
        outputs[0][bad] = {"publish": True}
    else:
        outputs[0] = '{"summary":"incomplete", "tasks":['
    harness.use(outputs)
    run = harness.create()
    with pytest.raises(WorkError):
        harness.engine.execute(run["id"], "job")
    persisted = harness.engine.get(run["id"])
    assert persisted["status"] == "failed"
    assert any(task["status"] == "failed" for task in persisted["tasks"])
    assert not any(task["status"] in {"queued", "running"} for task in persisted["tasks"])
    assert not harness.rendered and not harness.store.all("clips")
    assert persisted["permissions"] == {"publish": False, "ads": False}


def test_plan_with_a_duplicated_role_gets_the_standard_assignment(harness):
    outputs = script()
    outputs[0]["tasks"][0]["role"] = "editor"  # footage_analyst is now missing, editor appears twice
    harness.use(outputs)
    run, _ = harness.execute()
    tasks = {t["role"]: t["instruction"] for t in run["plan"]["tasks"]}
    assert set(tasks) == set(ROLES[1:])
    assert tasks["footage_analyst"].startswith("Find the strongest")
    assert tasks["editor"] == "Complete footage_analyst using supplied evidence"
    assert run["status"] == "needs_review"


@pytest.mark.parametrize(
    "schema,value",
    [
        (Plan, plan()),
        (Footage, footage()),
        (Strategy, strategy()),
        (Edits, edits()),
        (
            Performance,
            {
                "recommendations": [
                    {
                        "recommendation": "Shorten",
                        "evidence_refs": ["event:manual"],
                        "limitation": "Not causal",
                    }
                ]
            },
        ),
        (Critique, critique()),
        (Revision, revision()),
    ],
)
def test_every_handoff_rejects_extra_fields(schema, value):
    value["shell"] = "publish and spend"
    with pytest.raises(WorkError, match="invalid structured handoff"):
        decode_output(json.dumps(value), schema)


@pytest.mark.parametrize("value", [None, "x" * 65537, '{"candidates":', "[]", '{"candidates":NaN}'])
def test_invalid_or_oversized_json_is_rejected(value):
    with pytest.raises(WorkError):
        decode_output(value, Edits)


def test_thinking_is_not_saved_as_ledger_output():
    assert (
        decode_output("<think>private reasoning</think>\n```json\n" + json.dumps(plan()) + "\n```", Plan)
        == plan()
    )


@pytest.mark.parametrize("check,verdict", [("fail", "revise"), ("unknown", "unknown")])
def test_pass_with_unresolved_checks_is_read_as_the_stricter_verdict(check, verdict):
    value = critique()
    value["checks"]["claims"] = check
    assert decode_output(json.dumps(value), Critique)["verdict"] == verdict
    blocking = critique()
    blocking["findings"] = critique("revise")["findings"]
    assert decode_output(json.dumps(blocking), Critique)["verdict"] == "revise"
    assert decode_output(json.dumps(critique()), Critique)["verdict"] == "pass"


def test_default_two_revisions_exhaust_budget_without_approval(harness):
    outputs = script(verdict="revise") + [
        revision("First correction"),
        edits(hook="Second edit"),
        critique("revise"),
        revision("Second correction"),
        edits(hook="Third edit"),
        critique("revise"),
    ]
    harness.use(outputs)
    run, result = harness.execute()
    assert run["revision_budget"] == 2 and run["revision_count"] == 2
    assert titles(harness.models).count("Critique") == 3
    assert titles(harness.models).count("Revision") == 2
    assert not harness.models.outputs
    assert "budget exhausted" in run["stop_reason"]
    assert result["review_status"] == "fail"
    assert harness.store.get("clips", result["clip_ids"][0])["approved"] is False
    assert harness.rendered[0]["hook"] == "Third edit"


def test_invalid_revision_retains_validated_draft_with_unresolved_review(harness):
    invalid = edits(hook="Rejected revision")
    invalid["candidates"][0]["angle_id"] = "angle-2"
    harness.use(script(verdict="revise") + [revision(), invalid, invalid])
    run, result = harness.execute()
    assert run["status"] == "needs_review"
    assert "Revision rejected" in run["stop_reason"]
    assert result["review_status"] == "fail"
    assert len(harness.rendered) == 1
    assert harness.rendered[0]["hook"] == "See the source"
    clip = harness.store.get("clips", result["clip_ids"][0])
    assert clip["approved"] is False
    assert clip["team_review_status"] == "fail"
    assert role(run, "editor", 1)["status"] == "failed"


@pytest.mark.parametrize("case", ["reference", "index", "schema"])
def test_rejected_first_critic_allows_only_validated_unapproved_previews(harness, case):
    outputs = script(verdict="revise")
    if case == "reference":
        outputs[-1]["findings"][0]["evidence_refs"] = ["source:invented"]
    elif case == "index":
        outputs[-1]["findings"][0]["candidate_index"] = 1
    else:
        outputs[-1]["findings"][0]["evidence_refs"] *= 17
    harness.use(outputs)
    run, result = harness.execute()
    assert run["status"] == "needs_review"
    assert "Critic review unavailable" in run["stop_reason"]
    assert result["review_status"] == "unknown"
    assert len(harness.rendered) == 1
    clip = harness.store.all("clips")[0]
    assert not clip["approved"] and clip["team_review_status"] == "unknown"
    assert set(clip["team_checks"].values()) == {"unknown"}
    assert role(run, "critic")["status"] == "failed"
    assert titles(harness.models).count("Critique") == 1
    assert run["permissions"] == {"publish": False, "ads": False}


def test_rejected_critic_recheck_retains_prior_edit_with_its_original_review(harness):
    rejected = critique("revise", "source:invented")
    harness.use(script(verdict="revise") + [revision(), edits(hook="Unreviewed replacement"), rejected])
    run, result = harness.execute()
    assert run["status"] == "needs_review"
    assert "Critic recheck rejected" in run["stop_reason"]
    assert result["review_status"] == "fail"
    assert len(harness.rendered) == 1
    assert harness.rendered[0]["hook"] == "See the source"
    assert harness.rendered[0]["_team"]["team_findings"] == critique("revise")["findings"]
    assert not harness.store.all("clips")[0]["approved"]
    assert role(run, "critic", 1)["status"] == "failed"
    assert titles(harness.models).count("Critique") == 2


def test_cancellation_during_critic_recheck_does_not_render_retained_drafts(harness):
    harness.use(script(verdict="revise") + [revision(), edits(hook="Replacement"), critique("pass")])
    harness.models.after_call = lambda calls: setattr(harness.jobs, "cancelled", calls == 8)
    run = harness.create()
    with pytest.raises(JobCancelled):
        harness.engine.execute(run["id"], "job")
    assert not harness.rendered
    assert harness.engine.get(run["id"])["status"] == "cancelled"


def test_unusable_editor_candidate_does_not_discard_other_validated_drafts(harness):
    outputs = script()
    invalid = copy.deepcopy(outputs[3]["candidates"][0])
    invalid.update(angle_id="angle-2", hook="Candidate for an angle that was never proposed")
    outputs[3]["candidates"].insert(0, invalid)
    harness.use(outputs)
    run, result = harness.execute()
    assert run["status"] == "needs_review"
    assert "Omitted 1 invalid editor candidates" in run["stop_reason"]
    assert result["review_status"] == "pass"
    assert len(harness.rendered) == 1
    assert harness.rendered[0]["hook"] == "See the source"
    assert harness.store.get("clips", result["clip_ids"][0])["approved"] is False


@pytest.mark.parametrize("stop", ["repeated_edit", "repeated_instruction", "producer_stop"])
def test_non_progress_stops_dependent_calls(harness, stop):
    outputs = script(verdict="revise")
    if stop == "producer_stop":
        outputs += [revision(decision="stop")]
    elif stop == "repeated_edit":
        outputs += [revision(), edits()]
    else:
        outputs += [revision(), edits(hook="Different edit"), critique("revise"), revision()]
    harness.use(outputs)
    run, result = harness.execute()
    assert not harness.models.outputs
    assert titles(harness.models).count("Edits") == (1 if stop == "producer_stop" else 2)
    assert titles(harness.models).count("Critique") == (2 if stop == "repeated_instruction" else 1)
    assert "progress" in run["stop_reason"]
    assert result["review_status"] == "fail"


def test_cancellation_before_render_retains_completed_handoffs(harness):
    run = harness.create()
    original_check = harness.jobs.check

    def check(job):
        # Cancel between completed critique and the first dependent render operation.
        if any(
            t["role"] == "critic" and t["status"] == "completed"
            for t in harness.store.get("team_runs", run["id"])["tasks"]
        ):
            harness.jobs.cancelled = True
        original_check(job)

    harness.jobs.check = check
    with pytest.raises(JobCancelled):
        harness.engine.execute(run["id"], "job")
    saved = harness.engine.get(run["id"])
    assert saved["status"] == "cancelled"
    assert role(saved, "critic")["output"] == critique()
    assert not harness.rendered
    assert all(t["status"] not in {"queued", "running"} for t in saved["tasks"])


def test_cancellation_before_second_render_retains_first_local_output(harness):
    outputs = script()
    outputs[3]["candidates"].append(
        {**outputs[3]["candidates"][0], "start": 0.2, "end": 0.9, "hook": "Second variant"}
    )
    harness.use(outputs)
    original_check = harness.jobs.check

    def check(job):
        if harness.store.all("clips"):
            # The post-render check runs too; allow it once so the first task is completed.
            saved = harness.store.all("team_runs")[0]
            if any(t["role"] == "render" and t["status"] == "completed" for t in saved["tasks"]):
                harness.jobs.cancelled = True
        original_check(job)

    harness.jobs.check = check
    run = harness.create()
    with pytest.raises(JobCancelled):
        harness.engine.execute(run["id"], "job")
    saved = harness.engine.get(run["id"])
    assert saved["status"] == "cancelled" and saved["clip_ids"] == ["clip-1"]
    assert len(harness.store.all("clips")) == 1
    assert harness.store.get("clips", "clip-1")["team_run_id"] == run["id"]
    assert role(saved, "render")["status"] == "completed"


@pytest.mark.parametrize("status", ["queued", "running"])
def test_restart_terminalizes_tasks_without_auto_resuming(harness, status):
    run = harness.create()
    tasks = run["tasks"]
    tasks[0].update(status="completed", output=plan())
    tasks[1].update(status=status)
    harness.store.patch("team_runs", run["id"], status=status, tasks=tasks)
    recovered = harness.new_engine().get(run["id"])
    assert recovered["status"] == "interrupted"
    assert recovered["tasks"][0]["output"] == plan()
    assert all(task["status"] not in {"queued", "running"} for task in recovered["tasks"])
    assert not harness.models.calls and not harness.rendered
    assert "restarted" in recovered["stop_reason"]


def test_settings_snapshot_and_baseline_receive_original_intent(harness):
    original = copy.deepcopy(harness.config)
    run = harness.create(mode="baseline")
    harness.config.update(brand="Changed", objective="traffic", language="fr")
    harness.baseline.side_effect = None
    harness.baseline.return_value = {"clips": []}
    harness.engine.execute(run["id"], "job")
    assert harness.baseline.call_args.args == (
        "job",
        harness.video,
        "qwen-small",
        {**original, "clip_count": 3, "_previous_observations": [], "_team_run_id": run["id"]},
    )
    assert harness.engine.get(run["id"])["context"]["settings"] == original
    assert not harness.models.calls and not harness.watched


def test_baseline_comparisons_match_source_intent_and_preserve_unknown_metrics(harness):
    seed_observations(harness.store)
    baseline = harness.create(mode="baseline")
    harness.store.patch("team_runs", baseline["id"], clip_ids=["previous"], status="needs_review")
    team = harness.create()
    rows = harness.engine.comparisons("source")["runs"]
    assert {row["id"] for row in rows} == {baseline["id"], team["id"]}
    assert all(row["comparable"] for row in rows)
    observed = next(row for row in rows if row["id"] == baseline["id"])
    assert observed["outcomes"]["platform_observations"][0]["metrics"] == {"views": 0, "saved": None}
    assert observed["outcomes"]["manual_observations"][0]["source"] == "manual"
    assert observed["feedback"][0]["rating"] == 2
    empty = next(row for row in rows if row["id"] == team["id"])
    assert empty["outcomes"] == {"platform_observations": [], "manual_observations": []}
    harness.config["brand"] = "Another brand"
    changed = harness.create()
    rows = harness.engine.comparisons("source")["runs"]
    assert next(row for row in rows if row["id"] == changed["id"])["comparable"] is True
    assert all(not row["comparable"] for row in rows if row["id"] != changed["id"])
    harness.video["size"] = 999
    changed_source = harness.create()
    rows = harness.engine.comparisons("source")["runs"]
    assert all(row["comparable"] == (row["id"] == changed_source["id"]) for row in rows)
    for row in rows:
        assert not {"roi", "lift", "winner", "success_rate"} & row.keys()
    assert any("No marketing-lift" in note for note in harness.engine.comparisons("source")["notes"])


def test_team_inherits_actual_models_memory_guard_before_any_inference(harness, monkeypatch, tmp_path):
    models = Models(tmp_path, Mock())
    monkeypatch.setattr(models, "item", lambda _: {"kind": "llm", "installed": True, "estimated_gb": 4})
    monkeypatch.setattr(models, "ready", lambda: True)
    monkeypatch.setattr("clip_factory.models.apple_silicon", lambda: True)
    monkeypatch.setattr("clip_factory.models.psutil.virtual_memory", lambda: SimpleNamespace(available=1e9))
    harness.engine.models = models
    run = harness.create()
    with pytest.raises(WorkError, match="available memory"):
        harness.engine.execute(run["id"], "job")
    assert harness.engine.get(run["id"])["status"] == "failed"
    models.jobs.process.assert_not_called()
    assert not harness.rendered and not harness.watched


def test_performance_cannot_cite_source_as_an_actual_outcome(harness):
    seed_observations(harness.store)
    outputs = script()
    outputs.insert(
        2,
        {
            "recommendations": [
                {
                    "recommendation": "Claim a sales lift",
                    "evidence_refs": ["source:source"],
                    "limitation": "A source is not a platform outcome",
                }
            ]
        },
    )
    harness.use(outputs)
    run = harness.create()
    with pytest.raises(WorkError, match="unknown evidence"):
        harness.engine.execute(run["id"], "job")
    assert titles(harness.models) == ["Plan", "Footage", "Performance"]
    assert harness.models.calls[2]["schema"]["$defs"]["Recommendation"]["properties"]["evidence_refs"][
        "items"
    ]["enum"] == ["feedback:feedback", "observation:media", "event:manual"]
    assert not harness.rendered
    assert harness.engine.get(run["id"])["status"] == "failed"


def test_audio_is_transcribed_before_watching_and_uses_snapshot_language(harness):
    harness.video["has_audio"] = True
    harness.store.put("videos", harness.video)
    calls = []

    def transcribe(job, video, language):
        calls.append((job, video["id"], language))
        harness.store.patch(
            "videos",
            video["id"],
            transcript={"segments": [{"start": 0, "end": 1, "text": "Actual spoken words"}]},
        )
        return {"video_id": video["id"], "language": language}

    harness.engine.transcribe = transcribe
    harness.use(script("transcript:0"))
    run = harness.create()
    harness.config["language"] = "fr"
    harness.engine.execute(run["id"], "job")
    saved = harness.engine.get(run["id"])
    assert calls == [("job", "source", "en")]
    order = [t["role"] for t in sorted(saved["tasks"], key=lambda t: t["started_at"] or "") if t["started_at"]]
    assert order.index("transcribe") < order.index("watch") < order.index("footage_analyst")
    assert saved["context"]["evidence"]["transcript:0"] == {
        "start": 0,
        "end": 1,
        "text": "Actual spoken words",
    }
    assert role(saved, "transcribe")["status"] == "completed"
    assert harness.models.calls[3]["data"]["evidence"]["transcript:0"]["text"] == "Actual spoken words"
    assert harness.rendered[0]["evidence_refs"] == ["transcript:0"]


def test_missing_speech_model_still_produces_clips_from_pictures(harness):
    harness.video["has_audio"] = True
    harness.store.put("videos", harness.video)
    harness.engine.can_transcribe = lambda: False
    run, result = harness.execute()
    harness.transcribe.assert_not_called()
    listen = role(run, "transcribe")
    assert listen["status"] == "skipped" and "speech model is not installed" in listen["error"]
    assert run["status"] == "needs_review" and len(result["clip_ids"]) == 1
    assert "no captions" in run["stop_reason"]


def test_text_only_model_gets_no_frames(harness):
    harness.models.sees = False
    run, _ = harness.execute()
    assert all("images" not in call for call in harness.models.calls)
    assert not harness.still_requests
    assert run["status"] == "needs_review"


def test_unavailable_stills_do_not_stop_production(harness):
    def broken(*_):
        raise WorkError("Frame sampling failed.")

    harness.engine.frames = broken
    run, _ = harness.execute()
    assert all("images" not in call for call in harness.models.calls)
    assert run["status"] == "needs_review" and len(harness.rendered) == 1


def test_passing_revision_preserves_initial_critic_findings_in_ledger(harness):
    outputs = script(verdict="revise") + [revision(), edits(hook="Corrected draft"), critique()]
    harness.use(outputs)
    run, result = harness.execute()
    critics = [task for task in run["tasks"] if task["role"] == "critic"]
    assert [task["output"]["verdict"] for task in critics] == ["revise", "pass"]
    assert critics[0]["output"]["findings"][0]["message"] == "Claim needs source support"
    assert run["revision_count"] == 1
    assert result["review_status"] == "pass"
    assert harness.rendered[0]["hook"] == "Corrected draft"
    assert harness.store.get("clips", result["clip_ids"][0])["approved"] is False


@pytest.mark.parametrize("ref", ["scene:0", "transcript:0"])
def test_editor_may_cite_its_scene_or_the_speech_inside_it(harness, ref):
    harness.store.patch(
        "videos",
        "source",
        transcript={"segments": [{"start": 0.25, "end": 0.75, "text": "Actual overlapping speech"}]},
    )
    harness.use(script(ref))
    run, result = harness.execute()
    assert run["status"] == "needs_review" and result["review_status"] == "pass"
    assert harness.rendered[0]["evidence_refs"] == [ref]
    assert not harness.models.outputs


@pytest.mark.parametrize("mode", ["team", "baseline"])
def test_cancel_immediately_after_persist_retains_completed_operation_and_lineage(harness, mode):
    run = harness.create(mode=mode)
    if mode == "team":
        original_render = harness.engine.render

        def render(job, video, candidate):
            result = original_render(job, video, candidate)
            harness.jobs.cancelled = True
            return result

        harness.engine.render = render
    else:

        def baseline(job, video, model, config):
            harness.store.put("clips", {"id": "clip-1", "video_id": video["id"], "approved": False})
            harness.jobs.cancelled = True
            return {"clips": [{"clip_id": "clip-1"}], "requires_review": True}

        harness.engine.baseline = baseline
    with pytest.raises(JobCancelled):
        harness.engine.execute(run["id"], "job")
    saved = harness.engine.get(run["id"])
    assert saved["status"] == "cancelled" and saved["clip_ids"] == ["clip-1"]
    task = role(saved, "render" if mode == "team" else "baseline")
    assert task["status"] == "completed" and task["output"] is not None
    clip = harness.store.get("clips", "clip-1")
    assert clip["team_run_id"] == run["id"] and clip["approved"] is False
    if mode == "baseline":
        assert clip["team_review_status"] == "not_applicable"


def test_restart_recovers_persisted_team_render_before_callback_return(harness):
    run = harness.create()
    task = harness.engine._task(run["id"], "render")
    harness.engine._update_task(run["id"], task["id"], status="running")
    harness.store.patch("team_runs", run["id"], status="running")
    harness.store.put(
        "clips",
        {
            "id": "persisted",
            "video_id": "source",
            "approved": False,
            "team_run_id": run["id"],
            "team_task_id": task["id"],
        },
    )
    recovered = harness.new_engine().get(run["id"])
    assert recovered["status"] == "interrupted" and recovered["clip_ids"] == ["persisted"]
    render = role(recovered, "render")
    assert render["status"] == "completed" and render["output"]["clip_id"] == "persisted"
    assert render["output"]["recovered_from_persisted_output"] is True
    assert not harness.models.calls


def test_progress_moves_forward_through_the_stages(harness):
    harness.execute()
    steps = [m["progress"] for m in harness.jobs.messages if "progress" in m]
    assert steps == sorted(steps) and steps[0] <= 10 and steps[-1] >= 86
    assert any(m.get("message") == "Rendering clip 1" for m in harness.jobs.messages)


@pytest.mark.parametrize(
    "proposed,expected",
    [
        ((10, 40), (10, 40)),
        ((0, 40), (5, 40)),  # starts before its moment
        ((10, 90), (10, 65)),  # ends after it
        ((70, 80), (20, 50)),  # entirely outside: centred on the peak, default 30s
        ((40, 10), (20, 50)),  # reversed
    ],
)
def test_fit_range_keeps_the_proposal_where_it_can(proposed, expected):
    assert fit_range(*proposed, 5, 65, 180, peak=35) == expected


def test_fit_range_respects_the_duration_limit_and_short_moments():
    assert fit_range(10, 60, 5, 65, 20) == (10, 30)
    assert fit_range(0, 9, 0, 2, 180) == (0, 2)
    assert fit_range(5, 6, 0, 2, 180, peak=1.5) == (0, 2)


def test_cuts_snap_to_nearby_speech_boundaries_never_outside_the_moment():
    transcript = {"segments": [
        {"start": 10.0, "end": 14.0, "text": "First sentence.", "words": [
            {"word": "First", "start": 10.0, "end": 10.6}, {"word": "sentence.", "start": 10.7, "end": 14.0},
        ]},
        {"start": 14.5, "end": 19.0, "text": "Second sentence."},
        {"start": 30.0, "end": 40.0, "text": "Far away."},
    ]}
    # Start lands mid-sentence near its beginning; end lands just before a sentence finishes.
    assert snap_to_speech(10.8, 18.2, transcript, 5, 60, 180) == (9.88, 19.2)
    # No boundary within reach: the proposal stands.
    assert snap_to_speech(22.0, 27.0, transcript, 5, 60, 180) == (22.0, 27.0)
    # Sentence boundaries outside the moment are never used; a cut inside a word still moves to its start.
    assert snap_to_speech(10.8, 18.2, transcript, 10.5, 18.5, 180) == (10.58, 18.2)
    assert snap_to_speech(12.0, 18.2, transcript, 11.0, 18.5, 180) == (12.0, 18.2)
    # Snapping never breaks the duration limit.
    assert snap_to_speech(10.8, 18.2, transcript, 5, 60, 8.0) == (10.8, 18.2)
    assert snap_to_speech(1.0, 2.0, None, 0, 5, 180) == (1.0, 2.0)
    # A cut three seconds into or before the end of a sentence moves out to the sentence's edge.
    assert snap_to_speech(17.0, 33.0, transcript, 5, 60, 180) == (14.38, 33.0)
    assert snap_to_speech(22.0, 36.5, transcript, 5, 60, 180) == (22.0, 40.2)


def test_close_look_follows_the_action_and_moves_the_clip_to_its_peak(harness):
    harness.video["duration"] = 120
    harness.store.put("videos", harness.video)
    harness.board = board("source", 120.0, scenes=2)  # 60-second scenes
    harness.engine.frames = harness.dense_stills
    harness.models.closeups = [
        {"happens": "A long rally ends with a smash; the winner raises his arm.", "peak_frame": 20, "strength": 8}
    ]
    outputs = script()
    outputs[3]["candidates"][0].update(start=30, end=50)
    harness.models.outputs = copy.deepcopy(outputs)
    run, _ = harness.execute()
    # Dense frames around the measured peak (30s): 25-37s, far tighter than the storyboard's stills.
    request = harness.models.batches[0][0]
    assert harness.still_requests[0] == ([(25.0, 37.0)], 24)
    assert len(request["images"]) == 24 and request["image_labels"][0] == "Frame 1 at 25.2s"
    assert request["schema"]["properties"]["peak_frame"]["maximum"] == 24
    looked = role(run, "closeup")
    assert looked["kind"] == "tool" and looked["status"] == "completed"
    assert looked["output"]["moments"][0]["peak_time"] == 34.75  # frame 20 of 24
    strategist, editor = harness.models.calls[2]["data"], harness.models.calls[3]["data"]
    assert strategist["footage"]["moments"][0]["seen_up_close"].startswith("A long rally")
    allowed = editor["allowed_source_ranges"]["angle-1"]
    assert allowed["peak_time"] == 34.75 and allowed["seen_up_close"].startswith("A long rally")
    # The suggested cut is half a minute placed around that instant, lead-in first.
    assert allowed["suggested_range"] == {"start": 22.8, "end": 52.8}
    assert harness.rendered[0]["start"] == 30 and harness.rendered[0]["end"] == 50


@pytest.mark.parametrize("problem", ["malformed", "unavailable", "frames"])
def test_production_continues_without_a_close_look(harness, problem):
    harness.engine.frames = harness.dense_stills
    if problem == "malformed":
        harness.models.closeups = [{"happens": "", "peak_frame": 99, "strength": 50}]
    elif problem == "unavailable":

        def unavailable(*_):
            raise WorkError("Local inference failed.")

        harness.models.run_batch = unavailable
    else:
        calls = []

        def first_fails(job, video, ranges, per_range):
            calls.append(ranges)
            if len(calls) == 1:
                raise WorkError("Frame sampling failed.")
            return harness.dense_stills(job, video, ranges, per_range)

        harness.engine.frames = first_fails
    run, _ = harness.execute()
    assert run["status"] == "needs_review" and len(harness.rendered) == 1
    assert "seen_up_close" not in harness.models.calls[3]["data"]["allowed_source_ranges"]["angle-1"]
    assert role(run, "closeup")["status"] == ("completed" if problem == "malformed" else "failed")


def test_background_chatter_is_not_evidence_and_does_not_move_cuts(harness):
    harness.store.patch("videos", "source", transcript={"speech": "none", "segments": [
        {"start": 0.3, "end": 0.6, "text": "Oh my God!", "background": True},
    ]})
    run, _ = harness.execute()
    assert not any(ref.startswith("transcript:") for ref in run["context"]["evidence"])
    assert harness.models.calls[4]["data"]["clip_speech"] == [""]
    assert (harness.rendered[0]["start"], harness.rendered[0]["end"]) == (0, 1)


def test_too_long_proposals_keep_the_stretch_around_the_peak():
    # A 100-second proposal with a 60-second ceiling: lead-in before the peak, then the tail.
    assert fit_range(0, 100, 0, 100, 60, peak=70) == (40, 100)
    assert fit_range(0, 100, 0, 100, 60, peak=10) == (0, 60)
    assert fit_range(0, 100, 0, 100, 60) == (0, 60)


class ScoutingModels(ScriptedModels):
    """Answers scout and selector prompts itself; team roles go to the scripted outputs."""

    def __init__(self, outputs, scout_answer):
        super().__init__(outputs)
        self.scout_answer, self.scout_calls = scout_answer, []

    def run(self, job_id, model_id, action, keep_warm=False, **payload):
        if payload["prompt"].startswith(("You are one scout", "Scouts reviewed")):
            self.scout_calls.append(keep_warm)
            lo = payload["prompt"].split("You only see seconds ", 1)[-1].split("-", 1)[0]
            return {"output": json.dumps(self.scout_answer.get(lo, []))}
        return super().run(job_id, model_id, action, **payload)


def long_talk(harness, text="speech {}"):
    segments = [{"start": s, "end": s + 4, "text": text.format(s)} for s in range(0, 1800, 5)]
    harness.video = harness.store.put(
        "videos", {**harness.video, "duration": 1800, "has_audio": True, "transcript": {"segments": segments}}
    )
    harness.board = board("source", 1800.0, scenes=36)  # 50-second scenes


def test_long_talk_footage_comes_from_scouts_and_is_tied_to_storyboard_scenes(harness):
    long_talk(harness)
    outputs = script()
    del outputs[1]  # no footage-analyst prompt: scouts replace it
    harness.models = ScoutingModels(
        outputs, {"0": [{"start": 0, "end": 30, "hook": "Opening bit", "score": 7, "why": "clear payoff"}]}
    )
    harness.engine.models = harness.models
    run, result = harness.execute()
    assert run["status"] == "needs_review" and result["review_status"] == "pass"
    assert harness.models.scout_calls and all(harness.models.scout_calls)  # every scout call kept warm
    assert run["scouting"]["chunks"] == 3 and run["scouting"]["candidates_found"] == 1
    moment = role(run, "footage_analyst")["output"]["moments"][0]
    assert (moment["start"], moment["end"], moment["scenes"], moment["id"]) == (0, 30, ["scene:0"], "moment-1")
    assert "Opening bit" in moment["summary"]
    # The words spoken inside the scout's range join the evidence for the editor and critic.
    assert "transcript:0" in harness.models.calls[2]["data"]["evidence"]
    assert harness.rendered[0]["start"] == 0


def test_long_talk_with_no_scout_moments_falls_back_to_the_measured_shortlist(harness):
    long_talk(harness, text="um")
    outputs = script()
    del outputs[1]
    harness.models = ScoutingModels(outputs, {})
    harness.engine.models = harness.models
    run, _ = harness.execute()
    assert role(run, "footage_analyst")["status"] == "failed"
    assert "no speech-backed moments" in role(run, "footage_analyst")["error"]
    assert role(run, "shortlist")["status"] == "completed" and len(harness.rendered) == 1
    assert "shortlisted from measured signals" in run["stop_reason"]


def test_footage_with_only_background_chatter_is_never_sent_to_scouts(harness):
    long_talk(harness)
    transcript = harness.video["transcript"]
    for segment in transcript["segments"]:
        segment["background"] = True
    harness.store.patch("videos", "source", transcript={**transcript, "speech": "none"})
    harness.models = ScoutingModels(script(), {})
    harness.engine.models = harness.models
    run, _ = harness.execute()
    assert not harness.models.scout_calls and "scouting" not in run
    assert titles(harness.models) == ["Plan", "Footage", "Strategy", "Edits", "Critique"]


def test_a_prompt_over_the_local_limit_is_refused_with_what_to_shorten(harness):
    harness.config["brand"] = "x" * 100_000
    run = harness.create()
    with pytest.raises(WorkError, match="over the 96,000 local limit"):
        harness.engine.execute(run["id"], "job")
    assert not harness.models.calls and not harness.rendered


class SwarmModels(ScriptedModels):
    """One idea per requested slot, placed inside the stretch named in the prompt."""

    def __init__(self, empty=()):
        super().__init__([])
        self.empty = set(empty)

    def run_batch(self, job_id, model_id, requests):
        self.batches.append(copy.deepcopy(requests))
        replies = []
        for request in requests:
            start = float(request["prompt"].split("Your stretch is ", 1)[1].split("s", 1)[0])
            wanted = request["schema"]["properties"]["ideas"]["maxItems"]
            kinds = request["schema"]["$defs"]["Idea"]["properties"]["hypothesis"]["enum"]
            ideas = [
                {"hypothesis": kinds[n], "start": start + 20 * n, "end": start + 20 * n + 15,
                 "hook": f"{kinds[n]} at {start:.0f}", "caption": "Caption. #tag"}
                for n in range(wanted)
            ]
            replies.append({"output": json.dumps({"ideas": [] if start in self.empty else ideas})})
        return replies


def swarm_source(harness, minutes=6, scenes=6, **transcript):
    harness.video = harness.store.put("videos", {**harness.video, "duration": minutes * 60, **transcript})
    harness.board = board("source", minutes * 60.0, scenes=scenes)


def test_swarm_quotas_cover_every_scene_before_any_gets_a_second_idea():
    value = board("v", 600.0, scenes=5)
    for index, score in enumerate([0.2, 0.9, 0.5, 0.0, 0.7]):
        value["scenes"][index]["score"] = score
    value["scenes"][3]["usable"] = False
    assert TeamEngine.swarm_quotas(value, 3) == {1: 1, 4: 1, 2: 1}  # fewer clips than scenes: the strongest
    assert TeamEngine.swarm_quotas(value, 6) == {0: 1, 1: 2, 2: 1, 4: 2}
    assert TeamEngine.swarm_quotas(value, 100) == {0: 3, 1: 3, 2: 3, 4: 3}  # never more than three a scene


def test_swarm_makes_about_a_clip_a_minute_each_on_its_own_hypothesis(harness):
    swarm_source(harness)
    harness.use([])
    harness.models = harness.engine.models = SwarmModels()
    run, result = harness.execute(mode="swarm")
    assert run["status"] == "needs_review" and run["mode"] == "swarm"
    # Six minutes of footage: seven clips wanted, nine ideas asked (a little spare), nine delivered.
    assert (result["target"], result["ideas"], result["clips"], result["stretches"]) == (7, 9, 9, 6)
    assert [r["schema"]["properties"]["ideas"]["maxItems"] for r in harness.models.batches[0]] == [2, 2, 2, 1, 1, 1]
    assert len(harness.rendered) == 9 and len(run["clip_ids"]) == 9
    # Each stretch is offered a different slice of the hypotheses, so the set stays varied.
    offered = [r["schema"]["$defs"]["Idea"]["properties"]["hypothesis"]["enum"] for r in harness.models.batches[0]]
    assert offered[0] == ["spectacle", "emotion", "contrast", "humor"] and offered[1][0] == "humor"
    assert result["hypotheses"] == ["contrast", "emotion", "humor", "spectacle"]
    first = harness.rendered[0]
    assert (first["start"], first["end"], first["hook"]) == (0.0, 15.0, "spectacle at 0")
    assert first["_team"]["hypothesis"] == "spectacle" and first["_team"]["team_review_status"] == "not_applicable"
    assert first["_team"]["scene_refs"] == ["scene:0"] and first["_team"]["team_run_id"] == run["id"]
    # No committee: the only model work is one short prompt per stretch.
    assert not harness.models.calls and len(harness.models.batches) == 1
    assert {t["role"]: t["status"] for t in run["tasks"]} == {"swarm": "completed", "watch": "completed"}
    assert "9 clips from 6 stretches" in run["stop_reason"]
    assert harness.watched == [("job", "source", "qwen-small")]  # footage without a transcript is watched


def test_swarm_cuts_a_talk_from_its_words_without_first_watching_every_scene(harness):
    lines = [{"start": 10.0 * i, "end": 10.0 * i + 8, "text": "Six words are spoken right here."} for i in range(36)]
    swarm_source(harness, has_audio=True, transcript={"speech": "throughout", "segments": lines})
    harness.models = harness.engine.models = SwarmModels()
    run, _ = harness.execute(mode="swarm")
    assert harness.watched == [("job", "source", None)]  # measured signals only: clips start sooner
    prompt = harness.models.batches[0][0]["prompt"]
    assert "[0.0-8.0] Six words are spoken right here." in prompt and "[60.0-" not in prompt
    # A talk is offered spoken hypotheses; "spectacle" is for footage you look at.
    spoken = harness.models.batches[0][0]["schema"]["$defs"]["Idea"]["properties"]["hypothesis"]["enum"]
    assert spoken == ["bold_claim", "question", "story", "lesson"]
    # Cuts land on sentence boundaries: 0-15s becomes 0-18.2s (the sentence ending at 18s, plus air).
    assert (harness.rendered[0]["start"], harness.rendered[0]["end"]) == (0.0, 18.2)
    assert run["status"] == "needs_review"


def test_swarm_skips_empty_stretches_and_survives_failed_renders(harness):
    swarm_source(harness)
    harness.models = harness.engine.models = SwarmModels(empty={0.0, 60.0})
    original = harness.engine.render
    calls = []

    def render(job, video, candidate):
        calls.append(candidate["hook"])
        if len(calls) == 2:
            raise WorkError("FFmpeg render failed.")
        return original(job, video, candidate)

    harness.engine.render = render
    run, result = harness.execute(mode="swarm")
    assert (result["ideas"], result["clips"], result["failed_renders"]) == (5, 4, 1)
    assert "1 renders failed" in run["stop_reason"] and run["status"] == "needs_review"


def test_swarm_with_nothing_to_cut_fails_plainly_and_cancellation_keeps_finished_clips(harness):
    swarm_source(harness)
    harness.models = harness.engine.models = SwarmModels(empty={60.0 * i for i in range(6)})
    run = harness.create(mode="swarm")
    with pytest.raises(WorkError, match="no clip ideas"):
        harness.engine.execute(run["id"], "job")
    assert harness.engine.get(run["id"])["status"] == "failed" and not harness.rendered
    harness.models = harness.engine.models = SwarmModels()
    original = harness.engine.render

    def render(job, video, candidate):
        result = original(job, video, candidate)
        harness.jobs.cancelled = True
        return result

    harness.engine.render = render
    run = harness.create(mode="swarm")
    with pytest.raises(JobCancelled):
        harness.engine.execute(run["id"], "job")
    saved = harness.engine.get(run["id"])
    assert saved["status"] == "cancelled" and len(saved["clip_ids"]) >= 1
    assert len(harness.store.all("clips")) == len(saved["clip_ids"])
