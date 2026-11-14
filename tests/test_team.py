"""Bounded team orchestration with scripted JSON, never weights or remote APIs."""

import copy
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

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
)


def plan():
    return {
        "summary": "Make a source-backed draft",
        "tasks": [
            {"role": role, "instruction": f"Complete {role} using supplied evidence"} for role in ROLES[1:]
        ],
    }


def footage(ref="frame:0"):
    return {
        "moments": [{"start": 0, "end": 2, "summary": "Visible source", "evidence_refs": [ref]}],
        "limitations": "Silent sampled frames do not establish speech",
    }


def strategy(objective="sales"):
    return {
        "angles": [
            {
                "id": "angle-1",
                "moment_index": 0,
                "objective": objective,
                "hook": "See the source",
                "rationale": "A supported demonstration",
            }
        ]
    }


def edits(ref="frame:0", *, hook="See the source", objective="sales"):
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


def critique(verdict="pass", ref="frame:0"):
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


def script(ref="frame:0", *, verdict="pass", objective="sales"):
    # Source IDs passed by API fixtures select this source, not grounding evidence.
    # Negative cases set literal invalid refs after building this valid script.
    if ref.startswith("source:"):
        ref = "frame:0"
    return [
        plan(),
        footage(ref),
        strategy(objective),
        edits(ref, objective=objective),
        critique(verdict, ref),
    ]


class ScriptedModels:
    """Each request is independently parsed; an unexpected extra call fails immediately."""

    def __init__(self, outputs):
        self.outputs = copy.deepcopy(outputs)
        self.calls = []
        self.required = []
        self.after_call = None

    def require(self, identifier, kind):
        self.required.append((identifier, kind))

    def run(self, job_id, model_id, action, **payload):
        prompt = payload["prompt"]
        schema_text, data_text = prompt.split("\nSCHEMA:\n", 1)[1].split("\nDATA:\n", 1)
        self.calls.append(
            {
                "job_id": job_id,
                "model_id": model_id,
                "action": action,
                "schema": json.loads(schema_text),
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
        self.sampled_frames = [{"time": 0.5, "path": "sample.jpg"}, {"time": 1.5, "path": "sample-1.jpg"}]
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

    def new_engine(self):
        return TeamEngine(
            self.store,
            self.jobs,
            self.models,
            transcribe=self.transcribe,
            render=self.render,
            frames=lambda *_: self.sampled_frames,
            baseline=self.baseline,
        )

    def create(self, **kwargs):
        return self.engine.create(self.video, self.config, "qwen-small", **kwargs)

    def execute(self, **kwargs):
        run = self.create(**kwargs)
        result = self.engine.execute(run["id"], "job")
        return self.engine.get(run["id"]), result


@pytest.fixture
def harness(tmp_path):
    return Harness(tmp_path, script())


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
        assert set(call) == {
            "job_id",
            "model_id",
            "action",
            "schema",
            "data",
            "prompt",
            "images",
            "max_tokens",
        }
        assert "history" not in call["data"] and "messages" not in call["data"]
        assert call["max_tokens"] == 2200
        assert "Do not execute tools" in call["prompt"]
    assert harness.models.calls[1]["images"] == ["sample.jpg", "sample-1.jpg"]
    assert harness.models.calls[-1]["images"] == ["sample.jpg", "sample-1.jpg"]
    assert harness.models.calls[2]["data"]["footage"] == footage()
    assert harness.models.calls[2]["data"]["performance"] is None
    assert run["status"] == "needs_review" and result["requires_review"] is True
    assert run["permissions"] == {"publish": False, "ads": False}
    tasks = {task["role"]: task for task in run["tasks"]}
    assert tasks["performance_analyst"]["status"] == "skipped"
    assert tasks["performance_analyst"]["output"] is None
    assert all(tasks[role]["status"] == "completed" for role in ROLES if role != "performance_analyst")
    assert tasks["producer"]["output"] == plan()
    assert run["elapsed_seconds"] >= 0
    assert "not model peak VRAM" in run["resource_observations"]["measurement"]
    clip = harness.store.get("clips", result["clip_ids"][0])
    assert clip["approved"] is False and clip["team_review_status"] == "pass"
    assert harness.rendered[0]["_team"]["team_run_id"] == run["id"]
    assert harness.rendered[0]["_team"]["team_checks"] == critique()["checks"]


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
    harness.models = ScriptedModels(outputs)
    harness.engine.models = harness.models
    run, _ = harness.execute()
    assert titles(harness.models) == ["Plan", "Footage", "Performance", "Strategy", "Edits", "Critique"]
    observations = harness.models.calls[2]["data"]["observations"]
    assert observations["event:manual"]["source"] == "manual"
    assert observations["event:manual"]["revenue"] is None
    assert observations["observation:media"]["account_id"] == "account"
    assert observations["observation:media"]["metrics"] == {"views": 0, "saved": None}
    assert harness.models.calls[3]["data"]["performance"] == performance
    assert all(task["status"] == "completed" for task in run["tasks"])


def test_schema_correction_repairs_excess_evidence_refs_before_dependent_calls(harness):
    outputs = script()
    oversized = copy.deepcopy(outputs[1])
    oversized["moments"][0]["evidence_refs"] = ["frame:0"] * 17
    outputs.insert(1, oversized)
    harness.models = ScriptedModels(outputs)
    harness.engine.models = harness.models
    run, _ = harness.execute()
    assert titles(harness.models) == ["Plan", "Footage", "Footage", "Strategy", "Edits", "Critique"]
    correction = harness.models.calls[2]["data"]["format_correction"]
    assert correction[0]["field"] == "moments.0.evidence_refs"
    assert "at most 16" in correction[0]["problem"]
    assert run["status"] == "needs_review"
    assert len(harness.rendered) == 1
    assert next(task for task in run["tasks"] if task["role"] == "footage_analyst")["output"] == footage()


def test_schema_correction_stops_after_one_failed_retry(harness):
    oversized = footage()
    oversized["moments"][0]["evidence_refs"] = ["frame:0"] * 17
    harness.models = ScriptedModels([plan(), oversized, oversized])
    harness.engine.models = harness.models
    run = harness.create()
    with pytest.raises(WorkError, match="invalid structured handoff"):
        harness.engine.execute(run["id"], "job")
    assert titles(harness.models) == ["Plan", "Footage", "Footage"]
    assert not harness.rendered
    assert harness.engine.get(run["id"])["status"] == "failed"


def test_footage_keeps_grounded_moments_when_other_citations_are_outside_the_range(harness):
    outputs = script()
    outputs[1]["moments"].append({
        "start": 0, "end": 0.25, "summary": "Unsupported frame timing", "evidence_refs": ["frame:1"]
    })
    harness.models = ScriptedModels(outputs)
    harness.engine.models = harness.models
    run, _ = harness.execute()
    accepted = next(task for task in run["tasks"] if task["role"] == "footage_analyst")["output"]
    assert accepted["moments"] == footage()["moments"]
    assert "omitted" in accepted["limitations"]
    assert harness.models.calls[2]["data"]["footage"] == accepted
    assert run["status"] == "needs_review"
    assert len(harness.rendered) == 1


def test_footage_keeps_valid_moments_when_another_row_violates_the_schema(harness):
    outputs = script()
    rejected = copy.deepcopy(outputs[1]["moments"][0])
    rejected["evidence_refs"] = ["frame:0"] * 17
    outputs[1]["moments"].append(rejected)
    harness.models = ScriptedModels(outputs)
    harness.engine.models = harness.models
    run, _ = harness.execute()
    accepted = next(t for t in run["tasks"] if t["role"] == "footage_analyst")["output"]
    assert accepted["moments"] == footage()["moments"]
    assert "structured fields were invalid" in accepted["limitations"]
    assert titles(harness.models) == ["Plan", "Footage", "Strategy", "Edits", "Critique"]
    assert len(harness.rendered) == 1


@pytest.mark.parametrize("case", ["valid", "wrong_source", "out_of_bounds", "no_evidence"])
def test_rejected_footage_can_only_reuse_same_source_time_grounded_analysis(harness, case):
    analysis = {"video_id": "source", "candidates": [{
        "start": 0, "end": 2,
        "reason": "Previously analyzed source window"
    }]}
    if case == "wrong_source":
        analysis["video_id"] = "another-source"
    elif case == "out_of_bounds":
        analysis["candidates"][0]["end"] = 3
    elif case == "no_evidence":
        analysis["candidates"][0]["end"] = 0.25
    harness.store.patch("videos", "source", analysis=analysis)
    rejected = footage("source:invented")
    harness.models = ScriptedModels([plan(), rejected, rejected] + script()[2:])
    harness.engine.models = harness.models
    if case != "valid":
        run = harness.create()
        with pytest.raises(WorkError):
            harness.engine.execute(run["id"], "job")
        assert not harness.rendered
        return
    run, _ = harness.execute()
    assert run["status"] == "needs_review"
    assert "Reused revalidated saved source analysis" in run["stop_reason"]
    assert next(t for t in run["tasks"] if t["role"] == "footage_analyst")["status"] == "failed"
    reused = next(t for t in run["tasks"] if t["role"] == "reuse_footage")
    assert reused["kind"] == "tool" and reused["status"] == "completed"
    assert reused["output"]["moments"][0]["evidence_refs"] == ["frame:0", "frame:1"]
    assert len(harness.rendered) == 1
    assert not harness.store.all("clips")[0]["approved"]


def test_schema_correction_honors_cancellation_before_retry(harness):
    oversized = footage()
    oversized["moments"][0]["evidence_refs"] = ["frame:0"] * 17
    harness.models = ScriptedModels([plan(), oversized])
    harness.engine.models = harness.models
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
    rows = rejected["moments" if role_index == 1 else "candidates"]
    rows[0]["end"] = 3
    outputs.insert(role_index, rejected)
    harness.models = ScriptedModels(outputs)
    harness.engine.models = harness.models
    run, _ = harness.execute()
    correction = harness.models.calls[role_index + 1]["data"]
    assert correction["previous_handoff"] == rejected
    assert correction["format_correction"][0]["field"] == "source_grounding"
    assert run["status"] == "needs_review"
    assert len(harness.rendered) == 1
    assert harness.rendered[0]["end"] == 1


def test_grounding_correction_honors_cancellation(harness):
    rejected = footage()
    rejected["moments"][0]["end"] = 3
    harness.models = ScriptedModels([plan(), rejected])
    harness.engine.models = harness.models
    harness.models.after_call = lambda calls: setattr(harness.jobs, "cancelled", calls == 2)
    run = harness.create()
    with pytest.raises(JobCancelled):
        harness.engine.execute(run["id"], "job")
    assert titles(harness.models) == ["Plan", "Footage"]
    assert not harness.rendered


@pytest.mark.parametrize("invalid_angle", [
    {"id": "angle-2", "moment_index": 1},
    {"id": "angle-1"},
    {"id": "angle-2", "objective": "traffic"},
])
def test_strategy_keeps_valid_angles_when_another_cannot_be_used(harness, invalid_angle):
    outputs = script()
    rejected = {**outputs[2]["angles"][0], **invalid_angle}
    outputs[2]["angles"].append(rejected)
    harness.models = ScriptedModels(outputs)
    harness.engine.models = harness.models
    run, _ = harness.execute()
    assert harness.models.calls[3]["data"]["strategy"] == strategy()
    assert run["status"] == "needs_review"
    assert "Omitted 1 invalid creative angles" in run["stop_reason"]
    assert len(harness.rendered) == 1


def test_editor_receives_only_accepted_moment_evidence_and_explicit_angle_ranges(harness):
    harness.store.patch("videos", "source", transcript={"segments": [
        {"start": 0, "end": 1, "text": "Unselected speech"}
    ]})
    run, _ = harness.execute()
    editor = harness.models.calls[3]["data"]
    assert set(run["context"]["evidence"]) >= {"frame:0", "frame:1", "transcript:0", "source:source"}
    assert editor["evidence"] == {"frame:0": {"time": 0.5, "type": "sampled_frame"}}
    assert editor["allowed_source_ranges"] == {
        "angle-1": {"start": 0, "end": 2, "objective": "sales", "evidence_refs": ["frame:0"]}
    }


@pytest.mark.parametrize("role_index", [1, 3])
def test_grounding_correction_stops_after_one_rejected_retry(harness, role_index):
    outputs = script()[:role_index + 1]
    rejected = outputs[role_index]
    rejected["moments" if role_index == 1 else "candidates"][0]["end"] = 3
    outputs.append(copy.deepcopy(rejected))
    harness.models = ScriptedModels(outputs)
    harness.engine.models = harness.models
    run = harness.create()
    with pytest.raises(WorkError):
        harness.engine.execute(run["id"], "job")
    assert len(harness.models.calls) == role_index + 2
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


@pytest.mark.parametrize(
    "bad",
    [
        "bad_evidence",
        "out_of_bounds",
        "changed_objective",
        "editor_range",
        "editor_objective",
        "editor_angle",
        "editor_refs",
        "permissions",
        "tools",
        "truncated",
        "duplicate_roles",
        "critic_ref",
        "critic_index",
    ],
)
def test_invalid_handoff_fails_before_any_render(harness, bad):
    outputs = script()
    if bad == "bad_evidence":
        outputs[1]["moments"][0]["evidence_refs"] = ["source:invented"]
    elif bad == "out_of_bounds":
        outputs[1]["moments"][0]["end"] = 3
    elif bad == "changed_objective":
        outputs[2]["angles"][0]["objective"] = "traffic"
    elif bad == "editor_range":
        outputs[3]["candidates"][0]["end"] = 3
    elif bad == "editor_objective":
        outputs[3]["candidates"][0]["objective"] = "traffic"
    elif bad == "editor_angle":
        outputs[3]["candidates"][0]["angle_id"] = "angle-2"
    elif bad == "editor_refs":
        outputs[3]["candidates"][0]["evidence_refs"] = ["frame:1"]  # Exists, but not in assigned moment.
    elif bad in {"permissions", "tools"}:
        outputs[0][bad] = {"publish": True}
    elif bad == "truncated":
        outputs[0] = '{"summary":"incomplete", "tasks":['
    elif bad == "duplicate_roles":
        outputs[0]["tasks"][0]["role"] = "editor"
    else:
        outputs[4] = critique("revise")
        outputs[4]["findings"][0]["evidence_refs"] = ["fake"] if bad == "critic_ref" else ["source:source"]
        if bad == "critic_index":
            outputs[4]["findings"][0]["candidate_index"] = 1
    harness.models = ScriptedModels(outputs)
    harness.engine.models = harness.models
    run = harness.create()
    with pytest.raises(WorkError):
        harness.engine.execute(run["id"], "job")
    persisted = harness.engine.get(run["id"])
    assert persisted["status"] == "failed"
    assert any(task["status"] == "failed" for task in persisted["tasks"])
    assert not any(task["status"] in {"queued", "running"} for task in persisted["tasks"])
    assert not harness.rendered and not harness.store.all("clips")
    assert persisted["permissions"] == {"publish": False, "ads": False}


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


@pytest.mark.parametrize("check", ["fail", "unknown"])
def test_pass_cannot_override_unresolved_checks(check):
    value = critique()
    value["checks"]["claims"] = check
    with pytest.raises(WorkError):
        decode_output(json.dumps(value), Critique)


def test_default_two_revisions_exhaust_budget_without_approval(harness):
    outputs = script(verdict="revise") + [
        revision("First correction"),
        edits(hook="Second edit"),
        critique("revise"),
        revision("Second correction"),
        edits(hook="Third edit"),
        critique("revise"),
    ]
    harness.models = ScriptedModels(outputs)
    harness.engine.models = harness.models
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
    invalid["candidates"][0]["evidence_refs"] = ["source:invented"]
    harness.models = ScriptedModels(script(verdict="revise") + [revision(), invalid, invalid])
    harness.engine.models = harness.models
    run, result = harness.execute()
    assert run["status"] == "needs_review"
    assert "Revision rejected" in run["stop_reason"]
    assert result["review_status"] == "fail"
    assert len(harness.rendered) == 1
    assert harness.rendered[0]["hook"] == "See the source"
    clip = harness.store.get("clips", result["clip_ids"][0])
    assert clip["approved"] is False
    assert clip["team_review_status"] == "fail"
    assert any(t["role"] == "editor" and t["iteration"] == 1 and t["status"] == "failed" for t in run["tasks"])


def test_rejected_critic_recheck_retains_prior_edit_with_its_original_review(harness):
    rejected = critique("revise", "source:invented")
    harness.models = ScriptedModels(script(verdict="revise") + [
        revision(), edits(hook="Unreviewed replacement"), rejected
    ])
    harness.engine.models = harness.models
    run, result = harness.execute()
    assert run["status"] == "needs_review"
    assert "Critic recheck rejected" in run["stop_reason"]
    assert result["review_status"] == "fail"
    assert len(harness.rendered) == 1
    assert harness.rendered[0]["hook"] == "See the source"
    assert harness.rendered[0]["_team"]["team_findings"] == critique("revise")["findings"]
    assert not harness.store.all("clips")[0]["approved"]
    assert next(t for t in run["tasks"] if t["role"] == "critic" and t["iteration"] == 1)["status"] == "failed"
    assert titles(harness.models).count("Critique") == 2


def test_cancellation_during_critic_recheck_does_not_render_retained_drafts(harness):
    harness.models = ScriptedModels(script(verdict="revise") + [
        revision(), edits(hook="Replacement"), critique("pass")
    ])
    harness.engine.models = harness.models
    harness.models.after_call = lambda calls: setattr(harness.jobs, "cancelled", calls == 8)
    run = harness.create()
    with pytest.raises(JobCancelled):
        harness.engine.execute(run["id"], "job")
    assert not harness.rendered
    assert harness.engine.get(run["id"])["status"] == "cancelled"


def test_invalid_editor_candidate_does_not_discard_other_validated_drafts(harness):
    outputs = script()
    invalid = copy.deepcopy(outputs[3]["candidates"][0])
    invalid.update(end=3, hook="Rejected out-of-range candidate")
    outputs[3]["candidates"].insert(0, invalid)
    harness.models = ScriptedModels(outputs)
    harness.engine.models = harness.models
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
    harness.models = ScriptedModels(outputs)
    harness.engine.models = harness.models
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
    assert next(t for t in saved["tasks"] if t["role"] == "critic")["output"] == critique()
    assert not harness.rendered
    assert all(t["status"] not in {"queued", "running"} for t in saved["tasks"])


def test_cancellation_before_second_render_retains_first_local_output(harness):
    outputs = script()
    outputs[3]["candidates"].append({**outputs[3]["candidates"][0], "hook": "Second variant"})
    harness.models = ScriptedModels(outputs)
    harness.engine.models = harness.models
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
    assert next(t for t in saved["tasks"] if t["role"] == "render")["status"] == "completed"


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
        {**original, "_previous_observations": [], "_team_run_id": run["id"]},
    )
    assert harness.engine.get(run["id"])["context"]["settings"] == original
    assert not harness.models.calls


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
    assert not harness.rendered


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
    harness.models = ScriptedModels(outputs)
    harness.engine.models = harness.models
    run = harness.create()
    with pytest.raises(WorkError, match="unknown evidence"):
        harness.engine.execute(run["id"], "job")
    assert titles(harness.models) == ["Plan", "Footage", "Performance"]
    assert not harness.rendered
    assert harness.engine.get(run["id"])["status"] == "failed"


def test_audio_transcription_completes_before_footage_and_uses_snapshot_language(harness):
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
    harness.models = ScriptedModels(script("transcript:0"))
    harness.engine.models = harness.models
    run = harness.create()
    harness.config["language"] = "fr"
    harness.engine.execute(run["id"], "job")
    saved = harness.engine.get(run["id"])
    assert calls == [("job", "source", "en")]
    assert saved["context"]["evidence"]["transcript:0"] == {
        "start": 0,
        "end": 1,
        "text": "Actual spoken words",
    }
    assert next(task for task in saved["tasks"] if task["role"] == "transcribe")["status"] == "completed"
    assert (
        harness.models.calls[1]["data"]["context"]["evidence"]["transcript:0"]["text"]
        == "Actual spoken words"
    )


def test_passing_revision_preserves_initial_critic_findings_in_ledger(harness):
    outputs = script(verdict="revise") + [revision(), edits(hook="Corrected draft"), critique()]
    harness.models = ScriptedModels(outputs)
    harness.engine.models = harness.models
    run, result = harness.execute()
    critics = [task for task in run["tasks"] if task["role"] == "critic"]
    assert [task["output"]["verdict"] for task in critics] == ["revise", "pass"]
    assert critics[0]["output"]["findings"][0]["message"] == "Claim needs source support"
    assert run["revision_count"] == 1
    assert result["review_status"] == "pass"
    assert harness.rendered[0]["hook"] == "Corrected draft"
    assert harness.store.get("clips", result["clip_ids"][0])["approved"] is False


@pytest.mark.parametrize(
    "case",
    [
        "source_only",
        "feedback_only",
        "metrics_only",
        "manual_only",
        "transcript_out_of_time",
        "transcript_touching_boundary",
        "frame_out_of_time",
        "frame_and_feedback",
    ],
)
def test_footage_requires_time_associated_source_evidence_before_dependents(harness, case):
    seed_observations(harness.store)
    harness.store.patch(
        "videos",
        "source",
        transcript={"segments": [{"start": 1, "end": 2, "text": "Speech outside the proposed moment"}]},
    )
    outputs = script()
    moment = outputs[1]["moments"][0]
    refs = {
        "source_only": ["source:source"],
        "feedback_only": ["feedback:feedback"],
        "metrics_only": ["observation:media"],
        "manual_only": ["event:manual"],
        "transcript_out_of_time": ["transcript:0"],
        "transcript_touching_boundary": ["transcript:0"],
        "frame_out_of_time": ["frame:1"],
        "frame_and_feedback": ["frame:0", "feedback:feedback"],
    }
    moment["evidence_refs"] = refs[case]
    if case == "transcript_out_of_time":
        moment["end"] = 0.5
    elif case in {"transcript_touching_boundary", "frame_out_of_time"}:
        moment["end"] = 1
    outputs.insert(1, copy.deepcopy(outputs[1]))
    harness.models = ScriptedModels(outputs)
    harness.engine.models = harness.models
    run = harness.create()
    with pytest.raises(WorkError):
        harness.engine.execute(run["id"], "job")
    saved = harness.engine.get(run["id"])
    assert saved["status"] == "failed"
    assert titles(harness.models) == ["Plan", "Footage", "Footage"]
    assert next(t for t in saved["tasks"] if t["role"] == "footage_analyst")["status"] == "failed"
    assert not harness.rendered
    assert [clip["id"] for clip in harness.store.all("clips")] == ["previous"]


@pytest.mark.parametrize("ref", ["frame:0", "frame:1", "transcript:0"])
def test_valid_timestamped_frame_or_overlapping_transcript_grounds_footage(harness, ref):
    harness.store.patch(
        "videos",
        "source",
        transcript={"segments": [{"start": 0.25, "end": 0.75, "text": "Actual overlapping speech"}]},
    )
    outputs = script(ref)
    if ref == "frame:1":
        outputs[3]["candidates"][0].update(start=1, end=2)
    harness.models = ScriptedModels(outputs)
    harness.engine.models = harness.models
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
    role = "render" if mode == "team" else "baseline"
    task = next(t for t in saved["tasks"] if t["role"] == role)
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
    render = next(t for t in recovered["tasks"] if t["role"] == "render")
    assert render["status"] == "completed" and render["output"]["clip_id"] == "persisted"
    assert render["output"]["recovered_from_persisted_output"] is True
    assert not harness.models.calls
