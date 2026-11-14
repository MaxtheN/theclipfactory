"""Local campaign context, immutable approved strategy revisions, and scoped evidence.

No social connection, model call, publication or spending permission is granted here.
Legacy clips stay unassigned. Every new campaign production captures its context.
"""

from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .ollama import LlmId
from .store import Store, new_id, now
from .team import Objective

Text = Annotated[str, Field(max_length=1200)]
Identifier = Annotated[str, Field(min_length=1, max_length=128)]


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Profile(Body):
    name: str = Field(min_length=1, max_length=200)
    audience: str = Field(default="", max_length=3000)
    brand_context: str = Field(default="", max_length=4000)
    objective: Objective = "discovery"
    primary_metric: str | None = Field(default=None, max_length=200)
    creative_preferences: str = Field(default="", max_length=4000)

    @model_validator(mode="after")
    def objective_metric(self):
        if not self.name.strip():
            raise ValueError("Profile name must not be blank.")
        if self.objective != "discovery" and not (self.primary_metric or "").strip():
            raise ValueError("Select a primary metric for goal-directed work.")
        return self


class Brief(Body):
    audience: str = Field(default="", max_length=4000)
    constraints: list[Text] = Field(default_factory=list, max_length=30)
    requested_outputs: list[Text] = Field(default_factory=list, max_length=30)
    measurement_intent: str = Field(default="", max_length=4000)


class Campaign(Body):
    name: str = Field(min_length=1, max_length=200)
    brief: Brief = Field(default_factory=Brief)
    profile_ids: list[Identifier] = Field(min_length=1, max_length=30)
    video_ids: list[Identifier] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def unique_members(self):
        if not self.name.strip():
            raise ValueError("Campaign name must not be blank.")
        for members in (self.profile_ids, self.video_ids):
            if len(set(members)) != len(members):
                raise ValueError("Campaign membership must not contain duplicates.")
        return self


class Direction(Body):
    angles: list[Text] = Field(default_factory=list, max_length=20)
    moment_selection: str = Field(default="Preserve the speaker's context.", min_length=1, max_length=4000)
    hooks: list[Annotated[str, Field(min_length=1, max_length=250)]] = Field(
        default_factory=list, max_length=20
    )
    pacing: str = Field(default="Preserve source pacing.", max_length=1200)
    duration_seconds: float = Field(default=30, ge=1, le=180)
    framing: Literal["fit", "fill"] = "fit"
    caption_style: Literal["standard", "high_contrast"] = "standard"
    editing_preferences: str = Field(default="", max_length=4000)
    measurement_questions: list[Text] = Field(default_factory=list, max_length=20)
    next_experiments: list[Text] = Field(default_factory=list, max_length=20)
    evidence_refs: list[Identifier] = Field(default_factory=list, max_length=50)
    limitations: str = Field(
        default="Untested creative direction; no audience lift established.", max_length=4000
    )
    confidence: Literal["low", "medium", "high"] = "low"


class Proposal(Body):
    directions: dict[Identifier, Direction] = Field(min_length=1, max_length=30)
    reason: str = Field(min_length=1, max_length=4000)
    base_version_id: Identifier | None = None


class Decision(Body):
    reason: str = Field(default="", max_length=4000)


class Restore(Decision):
    profile_id: Identifier


class Observation(Body):
    clip_id: Identifier
    metric: str = Field(min_length=1, max_length=200)
    value: float | None = Field(default=None, ge=0)
    unit: str = Field(min_length=1, max_length=100)
    source: Literal["manual_import"] = "manual_import"
    publication_reference: str = Field(min_length=1, max_length=2000)
    window_start: datetime
    window_end: datetime
    collected_at: datetime
    notes: str = Field(default="", max_length=4000)

    @model_validator(mode="after")
    def valid_window(self):
        timestamps = (self.window_start, self.window_end, self.collected_at)
        if any(t.tzinfo is None or t.utcoffset() is None for t in timestamps):
            raise ValueError("Observation timestamps need explicit timezones.")
        if self.window_end <= self.window_start or self.collected_at < self.window_end:
            raise ValueError("Collection must follow a positive observation window.")
        if self.collected_at > datetime.now(UTC):
            raise ValueError("Collection time must not be in the future.")
        if not all(s.strip() for s in (self.metric, self.unit, self.publication_reference)):
            raise ValueError("Metric, unit and publication reference must not be blank.")
        if self.value is not None:
            if self.unit == "percent" and self.value > 100:
                raise ValueError("Percent must be between zero and 100.")
            if self.unit == "count" and not self.value.is_integer():
                raise ValueError("Count metrics must be whole numbers.")
        return self


class Learning(Body):
    profile_id: Identifier
    observation_ids: list[Identifier] = Field(min_length=1, max_length=50)
    hypothesis: str = Field(min_length=1, max_length=4000)
    reason: str = Field(min_length=1, max_length=4000)
    base_version_id: Identifier
    proposed_direction: Direction


class Production(Body):
    expected_strategy_version_id: Identifier | None = None
    video_id: Identifier
    profile_id: Identifier
    start: float = Field(default=0, ge=0)
    end: float | None = Field(default=None, gt=0)
    hook: str | None = Field(default=None, max_length=250)
    caption: str = Field(default="", max_length=2200)
    subtitles: bool = True
    mode: Literal["direct", "strategy"] = "direct"
    instructions: str = Field(default="", max_length=4000)
    # Opening variants: omitted keeps the strategy hook as a text overlay (when one exists).
    opening_treatment: Literal["text_overlay", "cold_open"] | None = None
    cold_open_start: float | None = Field(default=None, ge=0)
    cold_open_end: float | None = Field(default=None, gt=0)
    focus_x: float = Field(default=0.5, ge=0, le=1)
    changed_variable: str = Field(default="", max_length=120)
    # Revision of an earlier campaign clip, and explicit retry of a failed render.
    parent_clip_id: Identifier | None = None
    change_reason: str = Field(default="", max_length=2000)
    retry_of_job_id: Identifier | None = None


class AgentProduction(Body):
    expected_strategy_version_id: Identifier | None = None
    video_id: Identifier
    profile_id: Identifier
    model_id: LlmId = "qwen-small"
    revision_budget: int = Field(default=2, ge=0, le=2, strict=True)


class Campaigns:
    def __init__(self, store: Store):
        self.store = store

    def require(self, kind, identifier):
        value = self.store.get(kind, identifier)
        if not value:
            raise HTTPException(404, f"{kind.replace('_', ' ').capitalize()} record not found.")
        return value

    def profile(self, identifier):
        profile = self.require("profiles", identifier)
        keys = ("id", "video_id", "campaign_id", "strategy_version_id", "created_at", "approved", "status")
        return {
            **profile,
            "production_history": [
                {k: clip.get(k) for k in keys}
                for clip in self.store.all("clips")
                if clip.get("profile_id") == identifier
            ],
        }

    def save_profile(self, body, identifier=None):
        with self.store.lock:
            existing = self.require("profiles", identifier) if identifier else {}
            return self.store.put(
                "profiles",
                {
                    **existing,
                    **body.model_dump(),
                    "id": identifier or new_id(),
                    "created_at": existing.get("created_at", now()),
                    "updated_at": now(),
                },
            )

    def save_campaign(self, body, identifier=None):
        with self.store.lock:
            existing = self.require("campaigns", identifier) if identifier else {}
            for profile in body.profile_ids:
                self.require("profiles", profile)
            for video in body.video_ids:
                self.require("videos", video)
            if existing and (
                set(existing["profile_ids"]) - set(body.profile_ids)
                or set(existing["video_ids"]) - set(body.video_ids)
            ):
                raise HTTPException(
                    409,
                    "Existing campaign membership is retained for provenance; create a new campaign to narrow scope.",
                )
            return self.store.put(
                "campaigns",
                {
                    **existing,
                    **body.model_dump(),
                    "id": identifier or new_id(),
                    "created_at": existing.get("created_at", now()),
                    "updated_at": now(),
                    "active_strategy_id": existing.get("active_strategy_id"),
                },
            )

    def versions(self, campaign_id):
        self.require("campaigns", campaign_id)
        return sorted(
            (v for v in self.store.all("strategy_versions") if v["campaign_id"] == campaign_id),
            key=lambda v: v["version"],
            reverse=True,
        )

    def observations(self, campaign_id):
        self.require("campaigns", campaign_id)
        return [o for o in self.store.all("campaign_observations") if o["campaign_id"] == campaign_id]

    def _evidence(self, campaign_id, profile_id, refs, *, known=False):
        for identifier in refs:
            observation = self.require("campaign_observations", identifier)
            if observation["campaign_id"] != campaign_id or observation["profile_id"] != profile_id:
                raise HTTPException(
                    422,
                    "Evidence must belong to this campaign and profile; transfers require a separate explicit experiment.",
                )
            if known and observation["value"] is None:
                raise HTTPException(422, "Unavailable metrics cannot establish a measured learning change.")

    def propose(self, campaign_id, body: Proposal, *, hypothesis="", restored_from=None):
        with self.store.lock:
            campaign = self.require("campaigns", campaign_id)
            if body.base_version_id != campaign["active_strategy_id"]:
                raise HTTPException(409, "Strategy changed. Reload and explicitly rebase the proposal.")
            active = self.require("strategy_versions", body.base_version_id) if body.base_version_id else None
            directions = deepcopy(active["directions"]) if active else {}
            for profile_id, direction in body.directions.items():
                if profile_id not in campaign["profile_ids"]:
                    raise HTTPException(422, "Strategy direction must belong to a campaign profile.")
                self._evidence(campaign_id, profile_id, direction.evidence_refs)
                directions[profile_id] = direction.model_dump()
            if set(directions) != set(campaign["profile_ids"]):
                raise HTTPException(422, "Save initial direction for every campaign profile.")
            if not body.reason.strip():
                raise HTTPException(422, "Explain the proposed strategy change.")
            existing = self.versions(campaign_id)
            return self.store.put(
                "strategy_versions",
                {
                    "id": new_id(),
                    "campaign_id": campaign_id,
                    "version": (existing[0]["version"] + 1) if existing else 1,
                    "status": "proposed",
                    "base_version_id": body.base_version_id,
                    "directions": directions,
                    "changed_profile_ids": list(body.directions),
                    "reason": body.reason,
                    "hypothesis": hypothesis,
                    "restored_from": restored_from,
                    "created_at": now(),
                    "approved_at": None,
                    "limitations": "Observational evidence informs a hypothesis, not proof of causal lift.",
                },
            )

    def decision(self, campaign_id, version_id, *, approve, reason=""):
        with self.store.lock:
            campaign = self.require("campaigns", campaign_id)
            version = self.require("strategy_versions", version_id)
            if version["campaign_id"] != campaign_id:
                raise HTTPException(404, "Strategy version not found in campaign.")
            if version["status"] != "proposed":
                raise HTTPException(409, "Only a proposed strategy can be approved or rejected.")
            if approve:
                if version["base_version_id"] != campaign["active_strategy_id"]:
                    raise HTTPException(
                        409, "Strategy changed; stale proposals cannot replace current direction."
                    )
                if set(version["directions"]) != set(campaign["profile_ids"]):
                    raise HTTPException(
                        409, "Campaign membership changed; propose direction for every profile first."
                    )
                version.update(status="approved", approved_at=now())
                campaign.update(active_strategy_id=version_id, updated_at=now())
                self.store.put_many([("strategy_versions", version), ("campaigns", campaign)])
            else:
                version.update(status="rejected", rejection_reason=reason, rejected_at=now())
                self.store.put("strategy_versions", version)
            return version

    def restore(self, campaign_id, version_id, body):
        with self.store.lock:
            campaign = self.require("campaigns", campaign_id)
            version = self.require("strategy_versions", version_id)
            if version["campaign_id"] != campaign_id or version["status"] != "approved":
                raise HTTPException(422, "Restore only an approved decision from this campaign.")
            if body.profile_id not in version["directions"]:
                raise HTTPException(422, "Earlier strategy has no direction for this profile.")
            return self.propose(
                campaign_id,
                Proposal(
                    base_version_id=campaign["active_strategy_id"],
                    directions={body.profile_id: version["directions"][body.profile_id]},
                    reason=body.reason or "Restore earlier account-specific direction.",
                ),
                restored_from=version_id,
            )

    def observe(self, campaign_id, body):
        with self.store.lock:
            self.require("campaigns", campaign_id)
            clip = self.require("clips", body.clip_id)
            if clip.get("campaign_id") != campaign_id or not clip.get("profile_id"):
                raise HTTPException(422, "Observation requires a campaign-associated clip and profile.")
            if not clip.get("approved"):
                raise HTTPException(
                    409, "Review and approve this output before associating performance evidence."
                )
            return self.store.put(
                "campaign_observations",
                {
                    **body.model_dump(mode="json"),
                    "id": new_id(),
                    "campaign_id": campaign_id,
                    "profile_id": clip["profile_id"],
                    "strategy_version_id": clip["strategy_version_id"],
                    "clip_snapshot": {
                        k: deepcopy(clip.get(k))
                        for k in (
                            "id",
                            "video_id",
                            "start",
                            "end",
                            "hook",
                            "caption",
                            "edit_plan",
                            "approved",
                            "created_at",
                        )
                    },
                    "created_at": now(),
                    "kind": "performance",
                },
            )

    def learn(self, campaign_id, body):
        with self.store.lock:
            self._evidence(campaign_id, body.profile_id, body.observation_ids, known=True)
            refs = list(dict.fromkeys(body.proposed_direction.evidence_refs + body.observation_ids))
            self._evidence(campaign_id, body.profile_id, refs)
            direction = body.proposed_direction.model_copy(update={"evidence_refs": refs})
            return self.propose(
                campaign_id,
                Proposal(
                    directions={body.profile_id: direction},
                    reason=body.reason,
                    base_version_id=body.base_version_id,
                ),
                hypothesis=body.hypothesis,
            )

    def snapshot(self, campaign_id, profile_id, video_id, expected_strategy_version_id=None):
        with self.store.lock:
            campaign = self.require("campaigns", campaign_id)
            if profile_id not in campaign["profile_ids"] or video_id not in campaign["video_ids"]:
                raise HTTPException(422, "Select a source and profile belonging to this campaign.")
            if (
                expected_strategy_version_id
                and expected_strategy_version_id != campaign["active_strategy_id"]
            ):
                raise HTTPException(
                    409, "Active strategy changed since it was displayed. Reload before production."
                )
            if not campaign["active_strategy_id"]:
                raise HTTPException(409, "Approve a campaign strategy before starting production.")
            strategy = self.require("strategy_versions", campaign["active_strategy_id"])
            if profile_id not in strategy["directions"]:
                raise HTTPException(409, "Approve direction for this profile before production.")
            profile = self.require("profiles", profile_id)
            return {
                "campaign_id": campaign_id,
                "profile_id": profile_id,
                "video_id": video_id,
                "strategy_version_id": strategy["id"],
                "strategy_version": strategy["version"],
                "strategy_snapshot": deepcopy(strategy["directions"][profile_id]),
                "profile_snapshot": deepcopy(profile),
                "brief_snapshot": deepcopy(campaign["brief"]),
                "captured_at": now(),
            }
