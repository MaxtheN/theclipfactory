"""Durable account-scoped observations and bounded, unapproved draft experiments.

Callbacks are injected: this module has no network, model, renderer or scheduler.
Collector/analyst reads may retry; a claimed producer effect never blindly retries.
"""
from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .store import Store, new_id

Identifier = Annotated[str, Field(min_length=1, max_length=128)]
Variable = Literal["hook", "duration"]
Metric = Annotated[float, Field(ge=0, strict=True)] | None
TERMINAL = {"completed", "insufficient_evidence", "duplicate", "proposed", "blocked", "failed"}


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


def utc(value: datetime | str) -> datetime:
    value = datetime.fromisoformat(value) if isinstance(value, str) else value
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Use a timezone-bearing UTC time.")
    return value.astimezone(UTC)


def stamp(value: datetime) -> str:
    return utc(value).isoformat()


def identity(prefix: str, value: Any) -> str:
    digest = hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    return f"{prefix}_{digest[:40]}"


class Policy(Body):
    campaign_id: Identifier
    profile_id: Identifier
    account_id: Identifier
    cadence_days: Literal[3, 6] = 3
    auto_drafts: bool = False
    allowed_changes: list[Variable] = Field(default_factory=lambda: ["hook", "duration"], min_length=1, max_length=2)
    enabled: bool = False

    @field_validator("allowed_changes")
    @classmethod
    def unique_changes(cls, value):
        if len(set(value)) != len(value):
            raise ValueError("Allowed changes must be unique.")
        return value


class Publication(Body):
    policy_id: Identifier
    clip_id: Identifier
    account_id: Identifier
    media_id: Identifier
    published_at: datetime
    sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")

    _time = field_validator("published_at")(utc)


class MetricSnapshotInput(Body):
    account_id: Identifier
    media_id: Identifier
    metrics: dict[str, Metric] = Field(min_length=1, max_length=64)
    collected_at: datetime
    window_start: datetime
    window_end: datetime
    source: str = Field(min_length=1, max_length=200)
    cumulative: Literal[True] = True
    units: dict[str, str] = Field(default_factory=dict, max_length=64)

    _times = field_validator("collected_at", "window_start", "window_end")(utc)

    @model_validator(mode="after")
    def valid_metrics(self):
        if any(not key.strip() or len(key) > 200 for key in self.metrics):
            raise ValueError("Metric names must be nonblank and at most 200 characters.")
        if set(self.units) - set(self.metrics):
            raise ValueError("Metric units must refer to supplied metrics.")
        if any(not unit.strip() or len(unit) > 100 for unit in self.units.values()):
            raise ValueError("Use short nonblank metric units.")
        if not self.window_start < self.window_end <= self.collected_at:
            raise ValueError("Observation window must end before collection.")
        return self


class AnalysisResult(Body):
    status: Literal["experiment", "insufficient_evidence"]
    variable: Variable | None = None
    proposed_hook: str | None = Field(default=None, max_length=250)
    proposed_duration_seconds: float | None = Field(default=None, ge=1, le=180)
    evidence_ids: list[Identifier] = Field(default_factory=list, max_length=20)
    rationale: str = Field(min_length=1, max_length=4000)
    limitations: str = Field(min_length=1, max_length=4000)

    @model_validator(mode="after")
    def one_variable(self):
        if self.status == "insufficient_evidence":
            if self.variable is not None or self.proposed_hook is not None or self.proposed_duration_seconds is not None:
                raise ValueError("Insufficient evidence cannot contain an executable edit.")
        elif not self.evidence_ids or (
            self.variable == "hook" and (not (self.proposed_hook or "").strip() or self.proposed_duration_seconds is not None)
            or self.variable == "duration" and (self.proposed_duration_seconds is None or self.proposed_hook is not None)
            or self.variable is None
        ):
            raise ValueError("An experiment needs citations and exactly one hook or duration change.")
        return self


class ProductionReceipt(Body):
    status: Literal["queued", "completed", "failed", "uncertain"]
    job_id: Identifier | None = None
    clip_id: Identifier | None = None
    detail: str = Field(default="", max_length=4000)


class WorkReceipt(Body):
    id: Identifier
    policy_id: Identifier
    publication_id: Identifier
    due_at: str
    status: Literal["running", "retry", "queued", "needs_reconciliation", "completed", "insufficient_evidence", "duplicate", "proposed", "blocked", "failed"]
    phase: Literal["collect", "analyze", "produce"] = "collect"
    attempts: int = 0
    claim_id: str | None = None
    lease_until: str | None = None
    retry_at: str | None = None
    snapshot_id: str | None = None
    experiment_id: str | None = None
    analysis: dict[str, Any] | None = None
    detail: str = ""
    created_at: str
    updated_at: str


class ExperimentReceipt(Body):
    id: Identifier
    work_id: Identifier
    policy_id: Identifier
    publication_id: Identifier
    campaign_id: Identifier
    profile_id: Identifier
    account_id: Identifier
    media_id: Identifier
    parent_clip_id: Identifier
    source_id: Identifier
    base_strategy_version_id: Identifier
    snapshot_id: Identifier
    variable: Variable
    before: str | float
    after: str | float
    evidence_ids: list[str]
    rationale: str
    limitations: str
    parent_edit_plan: dict[str, Any]
    raw_parent_edit_plan: dict[str, Any] = Field(default_factory=dict)
    normalization_notes: list[str] = Field(default_factory=list)
    render_request: dict[str, Any]
    status: Literal["proposed", "submitting", "queued", "needs_reconciliation", "completed", "failed"] = "proposed"
    job_id: str | None = None
    clip_id: str | None = None
    detail: str = ""
    created_at: str
    updated_at: str


class LearningEngine:
    """Public callback contract: collect(publication, policy), analyze(context), produce(experiment).

    Each argument is a detached dict. Producer receives the persisted experiment
    including its deterministic ID and full render_request. It must tag the saved
    job context with experiment_id before returning a receipt. Unknown effects
    stay held until reconcile() can verify a real job and unapproved clip.
    """
    LEASE = timedelta(minutes=10)
    MAX_ATTEMPTS = 3

    def __init__(self, store: Store, collect: Callable, analyze: Callable, produce: Callable, clock: Callable | None = None):
        self.store, self.collect, self.analyze, self.produce = store, collect, analyze, produce
        self.clock = clock or (lambda: datetime.now(UTC))

    def _now(self):
        return utc(self.clock())

    def _require(self, kind, identifier):
        item = self.store.get(kind, identifier)
        if item is None:
            raise HTTPException(404, f"{kind} record not found.")
        return item

    def _binding(self, policy):
        campaign = self._require("campaigns", policy["campaign_id"])
        profile = self._require("profiles", policy["profile_id"])
        account = self._require("connected_accounts", policy["account_id"])
        if profile["id"] not in campaign["profile_ids"] or account.get("profile_id") != profile["id"]:
            raise HTTPException(422, "Policy account, profile and campaign must have the same explicit binding.")
        if account.get("status") != "active" or account.get("provider") != "composio" or account.get("toolkit") != "instagram":
            raise HTTPException(409, "An active bound Instagram account is required.")
        return campaign, profile

    def configure_policy(self, body: Policy | dict, identifier: str | None = None) -> dict:
        data = Policy.model_validate(body).model_dump(mode="json")
        with self.store.lock:
            self._binding(data)
            key = identity("policy", [data[k] for k in ("campaign_id", "profile_id", "account_id")])
            if identifier is not None and identifier != key:
                raise HTTPException(409, "A policy cannot be rebound to another campaign, profile or account.")
            old = self.store.get("learning_policies", key)
            row = {**data, "id": key, "created_at": old["created_at"] if old else stamp(self._now()), "updated_at": stamp(self._now())}
            self.store.put("learning_policies", row)
            return deepcopy(row)

    def _context(self, publication, policy):
        campaign, profile = self._binding(policy)
        clip = self._require("clips", publication["clip_id"])
        if (clip.get("campaign_id"), clip.get("profile_id")) != (policy["campaign_id"], policy["profile_id"]):
            raise HTTPException(422, "Publication clip is outside this campaign/profile.")
        source = self._require("videos", clip["video_id"])
        strategy = self._require("strategy_versions", clip.get("strategy_version_id") or "")
        if source["id"] not in campaign["video_ids"] or strategy.get("campaign_id") != campaign["id"] or profile["id"] not in strategy.get("directions", {}):
            raise HTTPException(422, "Publication source or strategy is outside its saved scope.")
        if strategy.get("status") != "approved" or campaign.get("active_strategy_id") != strategy["id"]:
            raise HTTPException(409, "The publication's approved base is stale; review the new strategy before another experiment.")
        if clip.get("approved") is not True or clip.get("sha256", "").lower() != publication["sha256"].lower():
            raise HTTPException(409, "Register only the exact approved clip hash.")
        if publication["account_id"] != policy["account_id"]:
            raise HTTPException(422, "Publication belongs to another account.")
        if clip.get("instagram_account_id"):
            account = self._require("connected_accounts", policy["account_id"])
            # The connected-account ID is a Composio caID. Native publication
            # records instead carry Instagram's numeric user ID; never compare
            # those two namespaces or infer the binding from the current login.
            native_id = account.get("instagram_user_id")
            if native_id is None or str(clip["instagram_account_id"]) != str(native_id):
                raise HTTPException(422, "Saved native publication account does not match this bound Instagram user.")
        if clip.get("instagram_media_id") and clip["instagram_media_id"] != publication["media_id"]:
            raise HTTPException(422, "Saved publication media does not match this clip.")
        return {"policy": deepcopy(policy), "publication": deepcopy(publication), "clip": clip, "source": source, "profile": profile, "strategy": strategy}

    def register_publication(self, body: Publication | dict) -> dict:
        data = Publication.model_validate(body).model_dump(mode="json")
        data["sha256"] = data["sha256"].lower()
        with self.store.lock:
            policy = self._require("learning_policies", data["policy_id"])
            self._context(data, policy)
            if utc(data["published_at"]) > self._now():
                raise HTTPException(422, "Publication time cannot be in the future.")
            key = identity("publication", [data["account_id"], data["media_id"]])
            old = self.store.get("learning_publications", key)
            if old:
                if any(old[k] != value for k, value in data.items()):
                    raise HTTPException(409, "This account/media identity is already bound to another publication.")
                return deepcopy(old)
            row = {**data, "id": key, "created_at": stamp(self._now()), "next_due_at": stamp(utc(data["published_at"]) + timedelta(days=policy["cadence_days"]))}
            self.store.put("learning_publications", row)
            return deepcopy(row)

    def _finish(self, work, status, detail="", *, experiment=None):
        now = self._now()
        work.update(status=status, detail=detail[:4000], updated_at=stamp(now), claim_id=None, lease_until=None, retry_at=None)
        records = [("learning_work", work)]
        if experiment is not None:
            records.append(("learning_experiments", experiment))
        if status in TERMINAL:
            publication = self._require("learning_publications", work["publication_id"])
            policy = self._require("learning_policies", work["policy_id"])
            origin = utc(publication["published_at"])
            interval = timedelta(days=policy["cadence_days"])
            n = max(1, (now - origin) // interval + 1)
            publication["next_due_at"] = stamp(origin + n * interval)
            records.append(("learning_publications", publication))
        self.store.put_many(records)
        return deepcopy(work)

    def _claim(self, publication, policy):
        now = self._now()
        key = identity("work", [publication["id"], publication["next_due_at"]])
        work = self.store.get("learning_work", key)
        if work:
            if work["status"] in TERMINAL or work["status"] in {"queued", "needs_reconciliation"}:
                return None
            if work.get("lease_until") and utc(work["lease_until"]) > now:
                return None
            if work["phase"] == "produce":
                experiment = self._require("learning_experiments", work["experiment_id"])
                experiment.update(status="needs_reconciliation", detail="Producer lease expired; reconcile saved jobs before another submission.", updated_at=stamp(now))
                self._finish(work, "needs_reconciliation", experiment["detail"], experiment=experiment)
                return None
            if work.get("retry_at") and utc(work["retry_at"]) > now:
                return None
        else:
            work = WorkReceipt(id=key, policy_id=policy["id"], publication_id=publication["id"], due_at=publication["next_due_at"], status="running", created_at=stamp(now), updated_at=stamp(now)).model_dump()
        work.update(status="running", attempts=work["attempts"] + 1, claim_id=new_id(), lease_until=stamp(now + self.LEASE), retry_at=None, updated_at=stamp(now))
        self.store.put("learning_work", work)
        return work

    def _owns(self, work):
        saved = self.store.get("learning_work", work["id"])
        return saved is not None and saved.get("claim_id") == work.get("claim_id") and saved["status"] == "running"

    def _snapshot(self, raw, context):
        data = MetricSnapshotInput.model_validate(raw).model_dump(mode="json")
        publication = context["publication"]
        if data["account_id"] != publication["account_id"] or data["media_id"] != publication["media_id"]:
            raise ValueError("Collector returned another account/media identity.")
        if utc(data["collected_at"]) > self._now() or utc(data["window_start"]) != utc(publication["published_at"]):
            raise ValueError("Cumulative snapshots must begin at publication and cannot be collected in the future.")
        # Cumulative observations are immutable, never summed. Publication ID
        # fixes account/media/window-start. Values, units and provider source
        # define evidence identity; later window-end/collection times alone do
        # not create another experiment. Keep the FIRST snapshot's actual as-of
        # times (not the latest fetch time); each due-work receipt records the
        # later check without relabelling old metrics as fresh observations.
        key = identity("snapshot", [publication["id"], data["metrics"], data["units"], data["source"]])
        old = self.store.get("learning_snapshots", key)
        return old or {**data, "id": key, "policy_id": context["policy"]["id"], "publication_id": publication["id"], "clip_id": publication["clip_id"], "campaign_id": context["policy"]["campaign_id"], "profile_id": context["policy"]["profile_id"]}

    def _experiment(self, result, context, work, snapshot):
        if result.variable not in context["policy"]["allowed_changes"]:
            raise ValueError("The proposed variable is not permitted by policy.")
        if set(result.evidence_ids) != {snapshot["id"]}:
            raise ValueError("Experiment citations must identify this exact metric snapshot.")
        clip, source, strategy = context["clip"], context["source"], context["strategy"]
        raw_plan = deepcopy(clip.get("edit_plan") or {})
        plan = deepcopy(raw_plan)
        normalization_notes = []
        # Earlier renders kept a nullable requested treatment in edit_plan while
        # saving actual treatment/burned-hook facts on Clip. Missing facts,
        # contradictory flags and cold-open legacy plans must remain unknown.
        if (
            "opening_treatment" in plan and plan["opening_treatment"] is None
            and clip.get("opening_treatment") == "text_overlay"
            and clip.get("hook_rendered") is True
            and plan.get("hook_overlay") is True
            and isinstance(plan.get("hook"), str)
            and plan["hook"].strip()
            and plan.get("cold_open_start") is None
            and plan.get("cold_open_end") is None
        ):
            plan["opening_treatment"] = "text_overlay"
            normalization_notes.append(
                "Resolved nullable parent edit_plan.opening_treatment to text_overlay from saved "
                "Clip.opening_treatment=text_overlay, hook_rendered=true, edit_plan.hook_overlay=true "
                "and nonblank hook text. This records the existing physical opening; it is not a second edit. "
                "Raw parent plan is retained unchanged."
            )
        required = {"start", "end", "hook", "subtitles", "opening_treatment", "focus_x", "framing", "caption_style"}
        if not required.issubset(plan) or plan["opening_treatment"] not in {"text_overlay", "cold_open"}:
            raise ValueError("The parent has an incomplete or unsupported edit plan; do not guess legacy settings.")
        direction = strategy["directions"][context["policy"]["profile_id"]]
        if any(plan[key] != direction[key] for key in ("framing", "caption_style")):
            raise ValueError("Parent production settings differ from the approved base.")
        start, end = float(plan["start"]), float(plan["end"])
        request = {"campaign_id": context["policy"]["campaign_id"], "profile_id": context["policy"]["profile_id"], "video_id": source["id"], "expected_strategy_version_id": strategy["id"], "start": start, "end": end, "hook": plan["hook"], "caption": clip.get("caption", ""), "subtitles": plan["subtitles"], "opening_treatment": plan["opening_treatment"], "focus_x": plan["focus_x"], "parent_clip_id": clip["id"], "change_reason": result.rationale, "changed_variable": result.variable}
        if plan["opening_treatment"] == "cold_open":
            if not isinstance(plan.get("cold_open_start"), (int, float)) or not isinstance(plan.get("cold_open_end"), (int, float)):
                raise ValueError("Cold-open source boundaries are unavailable.")
            request.update(cold_open_start=plan["cold_open_start"], cold_open_end=plan["cold_open_end"])
        if result.variable == "hook":
            before, after = plan["hook"], result.proposed_hook.strip()
            if plan["opening_treatment"] != "text_overlay":
                raise ValueError("A hook experiment must alter a rendered text-overlay opening.")
            request["hook"] = after
        else:
            before, after = end - start, result.proposed_duration_seconds
            new_end = start + after
            if new_end > source["duration"]:
                raise ValueError("Proposed duration exceeds this source.")
            if source.get("has_audio"):
                transcript = source.get("transcript") or {}
                segments = transcript.get("segments", []) if isinstance(transcript, dict) else []
                if not any(isinstance(cue, dict) and isinstance(cue.get("end"), (int, float)) and abs(cue["end"] - new_end) <= 0.04 for cue in segments):
                    raise ValueError("Duration changes must end at a recorded transcript cue boundary; unsupported sentence cuts are refused.")
            cold_length = request.get("cold_open_end", 0) - request.get("cold_open_start", 0)
            if after + cold_length > 180:
                raise ValueError("Combined main and cold-open duration exceeds the render limit.")
            request["end"] = new_end
        if before == after:
            raise ValueError("The proposal changes no actual rendered variable.")
        key = identity("experiment", [context["publication"]["id"], snapshot["id"], strategy["id"]])
        return ExperimentReceipt(id=key, work_id=work["id"], policy_id=context["policy"]["id"], publication_id=context["publication"]["id"], campaign_id=context["policy"]["campaign_id"], profile_id=context["policy"]["profile_id"], account_id=context["policy"]["account_id"], media_id=context["publication"]["media_id"], parent_clip_id=clip["id"], source_id=source["id"], base_strategy_version_id=strategy["id"], snapshot_id=snapshot["id"], variable=result.variable, before=before, after=after, evidence_ids=result.evidence_ids, rationale=result.rationale, limitations=result.limitations, parent_edit_plan=plan, raw_parent_edit_plan=raw_plan, normalization_notes=normalization_notes, render_request=request, created_at=stamp(self._now()), updated_at=stamp(self._now())).model_dump()

    def _process(self, work):
        try:
            with self.store.lock:
                policy = self._require("learning_policies", work["policy_id"])
                publication = self._require("learning_publications", work["publication_id"])
                context = self._context(publication, policy)
                if not policy["enabled"]:
                    return self._finish(work, "blocked", "Learning policy was disabled.")
            if not work.get("snapshot_id"):
                raw = self.collect(deepcopy(publication), deepcopy(policy))
                with self.store.lock:
                    if not self._owns(work):
                        return self.read_work(work["id"])
                    snapshot = self._snapshot(raw, context)
                    work.update(snapshot_id=snapshot["id"], phase="analyze")
                    self.store.put_many([("learning_snapshots", snapshot), ("learning_work", work)])
            else:
                snapshot = self._require("learning_snapshots", work["snapshot_id"])
            with self.store.lock:
                if any(e["snapshot_id"] == snapshot["id"] for e in self.list_experiments(policy["id"])) or any(w["id"] != work["id"] and w.get("snapshot_id") == snapshot["id"] and w["status"] in TERMINAL for w in self.list_work(policy["id"])):
                    return self._finish(work, "duplicate", "Unchanged cumulative evidence was already evaluated; counts are not summed.")
                if all(value is None for value in snapshot["metrics"].values()):
                    return self._finish(work, "insufficient_evidence", "All measured values are unknown.")
            result = AnalysisResult.model_validate(self.analyze({**deepcopy(context), "snapshot": deepcopy(snapshot)}))
            with self.store.lock:
                if not self._owns(work):
                    return self.read_work(work["id"])
                if set(result.evidence_ids) - {snapshot["id"]}:
                    raise ValueError("Analysis cited evidence outside this exact snapshot.")
                policy = self._require("learning_policies", policy["id"])
                context = self._context(publication, policy)
                if not policy["enabled"]:
                    return self._finish(work, "blocked", "Learning policy was disabled before submission.")
                if result.status == "insufficient_evidence":
                    work["analysis"] = result.model_dump()
                    return self._finish(work, "insufficient_evidence", result.rationale)
                experiment = self._experiment(result, context, work, snapshot)
                work["experiment_id"] = experiment["id"]
                if not policy["auto_drafts"]:
                    return self._finish(work, "proposed", "Experiment saved; automatic draft rendering is disabled.", experiment=experiment)
                experiment["status"] = "submitting"
                work["phase"] = "produce"
                self.store.put_many([("learning_experiments", experiment), ("learning_work", work)])
            try:
                receipt = ProductionReceipt.model_validate(self.produce(deepcopy(experiment)))
            except Exception as exc:  # noqa: BLE001 -- producer boundary: an unknown effect must be held, never replayed.
                receipt = ProductionReceipt(status="uncertain", detail=f"Producer outcome not confirmed: {type(exc).__name__}. Reconcile saved jobs; no automatic resubmission.")
            return self.reconcile(experiment["id"], receipt)
        except HTTPException as exc:
            with self.store.lock:
                if self._owns(work):
                    if work["phase"] == "produce":
                        experiment = self._require("learning_experiments", work["experiment_id"])
                        experiment.update(status="needs_reconciliation", detail="Producer response did not verify this experiment; reconcile saved jobs before another submission.")
                        return self._finish(work, "needs_reconciliation", experiment["detail"], experiment=experiment)
                    return self._finish(work, "blocked", str(exc.detail))
            return self.read_work(work["id"])
        except Exception as exc:  # noqa: BLE001 -- injected task boundary persists failure/backoff without losing a durable claim.
            with self.store.lock:
                if not self._owns(work):
                    return self.read_work(work["id"])
                if work["phase"] == "produce":
                    experiment = self._require("learning_experiments", work["experiment_id"])
                    experiment.update(status="needs_reconciliation", detail="Unverified producer receipt; reconcile before any further submission.")
                    return self._finish(work, "needs_reconciliation", experiment["detail"], experiment=experiment)
                detail = f"{type(exc).__name__}: {str(exc)[:500]}"
                if work["attempts"] >= self.MAX_ATTEMPTS:
                    return self._finish(work, "failed", detail)
                work.update(status="retry", detail=detail, retry_at=stamp(self._now() + timedelta(minutes=5 * 2 ** (work["attempts"] - 1))), claim_id=None, lease_until=None, updated_at=stamp(self._now()))
                self.store.put("learning_work", work)
                return deepcopy(work)

    def reconcile(self, experiment_id: str, receipt: ProductionReceipt | dict) -> dict:
        receipt = ProductionReceipt.model_validate(receipt)
        with self.store.lock:
            experiment = self.read_experiment(experiment_id)
            work = self.read_work(experiment["work_id"])
            if experiment["status"] in {"completed", "failed"}:
                if receipt.job_id and experiment.get("job_id") != receipt.job_id or receipt.clip_id and experiment.get("clip_id") != receipt.clip_id:
                    raise HTTPException(409, "A terminal experiment cannot be rebound to another output.")
                return work
            if receipt.status == "uncertain":
                experiment.update(status="needs_reconciliation", detail=receipt.detail, updated_at=stamp(self._now()))
                return self._finish(work, "needs_reconciliation", receipt.detail, experiment=experiment)
            job_id = receipt.job_id or experiment.get("job_id")
            if receipt.status == "failed" and not job_id:
                experiment.update(status="failed", detail=receipt.detail or "Producer confirmed failure before submission.", updated_at=stamp(self._now()))
                return self._finish(work, "failed", experiment["detail"], experiment=experiment)
            job = self._require("jobs", job_id or "")
            if not self._job_matches(experiment, job):
                raise HTTPException(422, "Producer receipt does not identify this exact scoped experiment job.")
            if experiment.get("job_id") and experiment["job_id"] != job_id:
                raise HTTPException(409, "An experiment already has another submitted job.")
            experiment.update(job_id=job_id, detail=receipt.detail, updated_at=stamp(self._now()))
            self.store.put("learning_experiments", experiment)
            if receipt.status == "queued":
                if job["status"] in {"completed", "failed", "cancelled"}:
                    return self.reconcile(experiment_id, {"status": "completed" if job["status"] == "completed" else "failed", "job_id": job_id})
                if job["status"] not in {"queued", "running"}:
                    raise HTTPException(409, "The saved job is no longer queued/running; reconcile its terminal outcome.")
                experiment["status"] = "queued"
                return self._finish(work, "queued", receipt.detail, experiment=experiment)
            if receipt.status == "failed":
                if job["status"] not in {"failed", "cancelled"}:
                    raise HTTPException(409, "A failed receipt requires a saved failed/cancelled job.")
                experiment["status"] = "failed"
                return self._finish(work, "failed", receipt.detail or job.get("error") or "Production did not complete.", experiment=experiment)
            clip_id = receipt.clip_id or (job.get("result") or {}).get("clip_id")
            if job["status"] != "completed" or (job.get("result") or {}).get("clip_id") != clip_id:
                raise HTTPException(409, "Completed experiment requires the job's exact saved clip result.")
            clip = self._require("clips", clip_id or "")
            if any(clip.get(key) != experiment[field] for key, field in (("video_id", "source_id"), ("campaign_id", "campaign_id"), ("profile_id", "profile_id"), ("parent_clip_id", "parent_clip_id"), ("strategy_version_id", "base_strategy_version_id"))):
                raise HTTPException(422, "Only the exact new, unapproved experiment revision can complete this work.")
            render_receipt = clip.get("render_receipt") or {}
            if clip.get("approved") is not False:
                # A creator can review the draft before the next scheduler poll.
                # Accept that race only with immutable worker evidence that this
                # output was CREATED unapproved and a later human review time.
                try:
                    human_review = (
                        clip.get("approved") is True
                        and render_receipt.get("approval_state_at_creation") == "unapproved"
                        and utc(render_receipt["finished_at"]) <= utc(clip["approved_at"]) <= self._now()
                    )
                except (KeyError, TypeError, ValueError):
                    human_review = False
                if not human_review:
                    raise HTTPException(422, "An approved result needs proof it was created unapproved and human-approved after rendering.")
            if not re.fullmatch(r"[a-fA-F0-9]{64}", str(clip.get("sha256") or "")) or render_receipt.get("job_id") != job_id:
                raise HTTPException(422, "Completed experiments need the rendered checksum and this exact job receipt.")
            plan, request = clip.get("edit_plan") or {}, experiment["render_request"]
            for key in ("start", "end", "hook", "subtitles", "opening_treatment", "focus_x", "cold_open_start", "cold_open_end"):
                if key in request and plan.get(key) != request[key]:
                    raise HTTPException(422, "Rendered edit does not match the frozen experiment request.")
            if any(plan.get(key) != experiment["parent_edit_plan"].get(key) for key in ("framing", "caption_style")) or clip.get("caption", "") != request["caption"]:
                raise HTTPException(422, "The draft changed a second, unapproved experiment variable.")
            experiment.update(status="completed", clip_id=clip_id)
            return self._finish(work, "completed", receipt.detail, experiment=experiment)

    @staticmethod
    def _job_matches(experiment, job):
        context = job.get("context")
        return job.get("kind") == "render" and isinstance(context, dict) and all(
            context.get(key) == experiment[field]
            for key, field in (("experiment_id", "id"), ("video_id", "source_id"), ("campaign_id", "campaign_id"), ("profile_id", "profile_id"))
        )

    def _recover_submission(self, experiment):
        """Adopt one verified persisted effect; zero/multiple candidates stay held."""
        with self.store.lock:
            experiment = self.read_experiment(experiment["id"])
            if experiment["status"] not in {"queued", "submitting", "needs_reconciliation"}:
                return None
            work = self.read_work(experiment["work_id"])
            if experiment["status"] == "submitting" and work.get("lease_until") and utc(work["lease_until"]) > self._now():
                return None  # The original producer still owns this effect lease.
            candidates = [job for job in self.store.all("jobs") if self._job_matches(experiment, job)]
            detail = ""
            if not candidates:
                detail = "No exact tagged experiment job was found. Submission remains uncertain; do not resubmit."
            elif len(candidates) > 1:
                detail = "Multiple exact tagged experiment jobs were found. Manual reconciliation is required; do not submit another draft."
            else:
                job = candidates[0]
                status = job.get("status")
                if status in {"queued", "running", "completed", "failed", "cancelled"}:
                    if experiment["status"] == "queued" and experiment.get("job_id") == job["id"] and status in {"queued", "running"}:
                        return None
                    try:
                        return self.reconcile(experiment["id"], {"status": "queued" if status in {"queued", "running"} else "completed" if status == "completed" else "failed", "job_id": job["id"]})
                    except HTTPException:
                        detail = "The exact tagged job's receipt or output failed verification. Manual reconciliation is required; do not resubmit."
                else:
                    detail = "The exact tagged job has an unsupported state. Manual reconciliation is required; do not resubmit."
            if experiment["status"] == "needs_reconciliation" and experiment.get("detail") == detail:
                return None
            experiment.update(status="needs_reconciliation", detail=detail, updated_at=stamp(self._now()))
            return self._finish(work, "needs_reconciliation", detail, experiment=experiment)

    def tick(self, limit: int = 8) -> list[dict]:
        if not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("Tick limit must be between 1 and 100.")
        results = []
        for experiment in self.list_experiments():
            if len(results) >= limit:
                break
            recovered = self._recover_submission(experiment)
            if recovered:
                results.append(recovered)
        for publication in sorted(self.list_publications(), key=lambda p: p["next_due_at"]):
            if len(results) >= limit:
                break
            with self.store.lock:
                publication = self._require("learning_publications", publication["id"])
                policy = self._require("learning_policies", publication["policy_id"])
                if not policy["enabled"] or utc(publication["next_due_at"]) > self._now():
                    continue
                work = self._claim(publication, policy)
            if work:
                results.append(self._process(work))
        return results

    def list_policies(self, campaign_id=None, profile_id=None, account_id=None):
        return [row for row in self.store.all("learning_policies") if all(value is None or row[key] == value for key, value in (("campaign_id", campaign_id), ("profile_id", profile_id), ("account_id", account_id)))]

    def list_publications(self, policy_id=None):
        return self._list("learning_publications", policy_id)

    def list_snapshots(self, policy_id=None):
        return self._list("learning_snapshots", policy_id)

    def list_work(self, policy_id=None):
        return self._list("learning_work", policy_id)

    def list_experiments(self, policy_id=None):
        return self._list("learning_experiments", policy_id)

    def _list(self, kind, policy_id):
        return [row for row in self.store.all(kind) if policy_id is None or row["policy_id"] == policy_id]

    def read_policy(self, identifier):
        return self._require("learning_policies", identifier)

    def read_work(self, identifier):
        return self._require("learning_work", identifier)

    def read_experiment(self, identifier):
        return self._require("learning_experiments", identifier)

    def state(self, policy_id=None):
        return {"policies": [self.read_policy(policy_id)] if policy_id else self.list_policies(), "publications": self.list_publications(policy_id), "snapshots": self.list_snapshots(policy_id), "work": self.list_work(policy_id), "experiments": self.list_experiments(policy_id)}
