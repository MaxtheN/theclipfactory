"""Workspaces, campaigns, immutable approved Style-rules revisions, and scoped evidence.

A workspace is a backend ``profile`` (one person, channel or brand). It owns ONE versioned
Style-rules set (propose -> explicit approve), inherited by every campaign in it. A campaign
is a goal-scoped push inside a workspace: it owns its objective/primary metric and optional
free-text notes appended to production prompts. It never has its own approval chain.

Records saved before this model (rules on campaigns, goal on the profile) are adopted on
read, idempotently, without rewriting any version or production snapshot.

No social connection, model call, publication or spending permission is granted here.
Legacy clips stay unassigned. Every new campaign production captures its context.
"""

from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .craft import BrandKit, CraftOptions
from .ollama import LlmId
from .store import Store, new_id, now
from .team import Objective

Text = Annotated[str, Field(max_length=1200)]
# Who created a proposed strategy revision. Proposals never approve themselves.
StrategySource = Literal["manual", "learning_experiment", "strategist"]
LEARNING_CAVEAT = (
    "Proposed from one learning experiment on observational post metrics. It is a hypothesis to test, "
    "not proof of causal lift or a winner."
)
STRATEGIST_CAVEAT = (
    "Proposed by the strategist from beliefs scored on this account's own measured posts. Observational: a "
    "pattern to keep testing, not proof of causal lift or a winner."
)
Identifier = Annotated[str, Field(min_length=1, max_length=128)]


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Profile(Body):
    """A workspace: who it speaks to, its voice and boundaries. Goals live on campaigns."""

    name: str = Field(min_length=1, max_length=200)
    audience: str = Field(default="", max_length=3000)
    brand_context: str = Field(default="", max_length=4000)
    # Legacy workspace-wide goal. Only backfills campaigns saved before campaigns had goals;
    # an update that omits these keeps the stored values.
    objective: Objective = "discovery"
    primary_metric: str | None = Field(default=None, max_length=200)
    creative_preferences: str = Field(default="", max_length=4000)
    # Fonts, colours and logo for title cards, captions and the CTA end card (craft.BrandKit).
    brand_kit: BrandKit | None = None

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
    # Call to action for the closing card of every render in this campaign (empty: no end card).
    cta: str = Field(default="", max_length=80)


class Campaign(Body):
    name: str = Field(min_length=1, max_length=200)
    brief: Brief = Field(default_factory=Brief)
    profile_ids: list[Identifier] = Field(min_length=1, max_length=30)
    video_ids: list[Identifier] = Field(default_factory=list, max_length=100)
    # The campaign's own goal. Discovery (no metric) stays valid. An update that omits
    # these keeps the stored goal.
    objective: Objective = "discovery"
    primary_metric: str | None = Field(default=None, max_length=200)
    # Campaign-specific note appended to production prompts. Not a rule set: it is never
    # approved separately and cannot replace the workspace's approved Style rules.
    notes: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def unique_members(self):
        if not self.name.strip():
            raise ValueError("Campaign name must not be blank.")
        if self.objective != "discovery" and not (self.primary_metric or "").strip():
            raise ValueError("Select a primary metric for goal-directed work.")
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
    """A complete proposed workspace Style-rules set, built on the active approved version."""

    direction: Direction
    reason: str = Field(min_length=1, max_length=4000)
    base_version_id: Identifier | None = None


class Decision(Body):
    reason: str = Field(default="", max_length=4000)


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


class Production(CraftOptions, Body):
    # Editing-craft options (craft.CraftOptions) are accepted here too, including A/B variants.
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
    # team: a few clips with planning, self-check and revisions. swarm: many clips, one hypothesis
    # each, under the same approved direction.
    strategy: Literal["team", "swarm"] = "team"
    # Optional creator note for this run only ("what to look for"). Passed to the planner and scouts
    # as delimited guidance inside the approved Style rules; never a rule change or an instruction.
    direction: str = Field(default="", max_length=500)


LEGACY_GOAL_KEYS = ("objective", "primary_metric")
MIGRATED_FROM_CAMPAIGN = "migrated_from_campaign"
INHERITED_FROM_WORKSPACE = "inherited_from_workspace"
RULES_MOVED = (
    "Style rules belong to the workspace now. Use /api/profiles/{profile_id}/strategies; "
    "campaign goals and notes are saved on the campaign."
)


def is_workspace_version(version: dict | None, profile_id: str | None = None) -> bool:
    return (
        isinstance(version, dict)
        and version.get("scope") == "workspace"
        and (profile_id is None or version.get("profile_id") == profile_id)
    )


def migrate_workspace(store: Store, profile_id: str) -> dict | None:
    """Adopt a pre-workspace campaign rule version as this workspace's active one. Idempotent.

    Runs only when the workspace has no active rules and no workspace versions yet. It
    points the workspace at the most recently approved campaign version that carries this
    profile's direction (unarchived campaigns first) and records the provenance. No version,
    campaign pointer, clip or production snapshot is changed, so earlier productions keep
    citing the exact version they used and that version stays the current approved base.
    """
    with store.lock:
        profile = store.get("profiles", profile_id)
        if not isinstance(profile, dict) or profile.get("active_strategy_id"):
            return profile
        versions = store.all("strategy_versions")
        if any(is_workspace_version(v, profile_id) for v in versions):
            return profile
        campaigns = {
            c["id"]: c
            for c in store.all("campaigns")
            if isinstance(c, dict) and profile_id in (c.get("profile_ids") or [])
        }
        candidates = [
            v
            for v in versions
            if isinstance(v, dict)
            and v.get("campaign_id") in campaigns
            and v.get("status") == "approved"
            and isinstance(v.get("directions"), dict)
            and profile_id in v["directions"]
        ]
        if not candidates:
            return profile
        actives = {c.get("active_strategy_id") for c in campaigns.values()}

        def rank(version):
            campaign = campaigns[version["campaign_id"]]
            return (
                not campaign.get("archived_at"),
                str(version.get("approved_at") or ""),
                version["id"] in actives,
                version.get("version") or 0,
                str(version.get("created_at") or ""),
                version["id"],
            )

        chosen = max(candidates, key=rank)
        profile = {
            **profile,
            "active_strategy_id": chosen["id"],
            "strategy_migration": {
                "provenance": MIGRATED_FROM_CAMPAIGN,
                "version_id": chosen["id"],
                "version": chosen.get("version"),
                "campaign_id": chosen["campaign_id"],
                "approved_at": chosen.get("approved_at"),
                "candidate_version_ids": sorted(v["id"] for v in candidates),
                "migrated_at": now(),
            },
        }
        store.put("profiles", profile)
        return profile


def migrate_campaign(store: Store, campaign: dict) -> dict:
    """Give a pre-goal campaign its workspace's legacy goal once. Idempotent."""
    if not isinstance(campaign, dict) or "objective" in campaign:
        return campaign
    with store.lock:
        current = store.get("campaigns", campaign.get("id") or "")
        if not isinstance(current, dict) or "objective" in current:
            return current or campaign
        source = None
        for profile_id in current.get("profile_ids") or []:
            profile = store.get("profiles", profile_id)
            if isinstance(profile, dict) and profile.get("objective"):
                source = profile
                break
        objective = (source or {}).get("objective") or "discovery"
        metric = (source or {}).get("primary_metric") if objective != "discovery" else None
        if objective != "discovery" and not (metric or "").strip():
            objective, metric = "discovery", None
        current = {
            **current,
            "objective": objective,
            "primary_metric": metric,
            "goal_provenance": {
                "source": INHERITED_FROM_WORKSPACE,
                "profile_id": (source or {}).get("id"),
                "at": now(),
            },
        }
        return store.put("campaigns", current)


def snapshot_goal(snapshot: dict) -> dict:
    """The campaign goal captured in a production snapshot; old snapshots carried it on the profile."""
    goal = snapshot.get("goal") if isinstance(snapshot.get("goal"), dict) else None
    if goal is None:
        profile = snapshot.get("profile_snapshot") or {}
        goal = {"objective": profile.get("objective"), "primary_metric": profile.get("primary_metric")}
    return {"objective": goal.get("objective") or "discovery", "primary_metric": goal.get("primary_metric")}


class Campaigns:
    def __init__(self, store: Store):
        self.store = store

    def require(self, kind, identifier):
        value = self.store.get(kind, identifier)
        if not value:
            raise HTTPException(404, f"{kind.replace('_', ' ').capitalize()} record not found.")
        if kind == "profiles":
            value = migrate_workspace(self.store, identifier) or value
        elif kind == "campaigns":
            value = migrate_campaign(self.store, value)
        return value

    def active_workspace(self, identifier):
        profile = self.require("profiles", identifier)
        if profile.get("archived_at"):
            raise HTTPException(409, "This workspace is archived. Restore it before changing its style rules.")
        return profile

    def active_campaign(self, identifier):
        campaign = self.require("campaigns", identifier)
        if campaign.get("archived_at"):
            raise HTTPException(
                409, "This campaign is archived. Restore it before making changes or producing clips."
            )
        return campaign

    def list_campaigns(self, include_archived=False):
        if type(include_archived) is not bool:
            raise HTTPException(422, "include_archived must be a boolean.")
        return [
            migrate_campaign(self.store, c)
            for c in self.store.all("campaigns")
            if include_archived or not c.get("archived_at")
        ]

    @staticmethod
    def _campaign_scopes(record):
        if not isinstance(record, dict):
            return set()
        context = record.get("context")
        context = context if isinstance(context, dict) else {}
        settings = context.get("settings")
        settings = settings if isinstance(settings, dict) else {}
        candidates = [record, context, context.get("campaign_snapshot"), settings.get("_campaign_snapshot")]
        return {
            item["campaign_id"]
            for item in candidates
            if isinstance(item, dict)
            and isinstance(item.get("campaign_id"), str)
            and item["campaign_id"].strip()
        }

    def _has_active_work(self, campaign):
        """Inspect current and legacy context shapes without attributing foreign shared-source work."""
        kinds = ("clips", "team_runs", "learning_experiments", "learning_policies")
        maps = {
            kind: {
                row["id"]: row
                for row in self.store.all(kind)
                if isinstance(row, dict) and isinstance(row.get("id"), str)
            }
            for kind in kinds
        }
        videos = campaign.get("video_ids")
        video_ids = (
            {value for value in videos if isinstance(value, str)} if isinstance(videos, list) else set()
        )

        def related(record, *, job=False):
            context = record.get("context")
            context = context if isinstance(context, dict) else {}
            scopes = self._campaign_scopes(record)
            links = []
            for key, kind in (
                ("clip_id", "clips"),
                ("team_run_id", "team_runs"),
                ("experiment_id", "learning_experiments"),
                ("policy_id", "learning_policies"),
            ):
                for container in (record, context):
                    identifier = container.get(key)
                    if isinstance(identifier, str) and identifier in maps[kind]:
                        links.append(maps[kind][identifier])
            if job:
                links.extend(
                    run for run in maps["team_runs"].values() if run.get("job_id") == record.get("id")
                )
            clip_ids = record.get("clip_ids")
            if isinstance(clip_ids, list):
                links.extend(maps["clips"][i] for i in clip_ids if isinstance(i, str) and i in maps["clips"])
            for linked in links:
                scopes.update(self._campaign_scopes(linked))
            if campaign["id"] in scopes:
                return True
            if scopes:
                return False
            return any(
                isinstance(container.get("video_id"), str) and container["video_id"] in video_ids
                for container in (record, context)
            )

        # Pending publish schedules are timed external effects (scheduler submits a publish job later).
        active = {"queued", "running"}
        for kind, statuses in (
            ("jobs", active),
            ("team_runs", active),
            ("learning_work", active),
            ("schedules", {"scheduled"}),
        ):
            for row in self.store.all(kind):
                if (
                    isinstance(row, dict)
                    and isinstance(row.get("status"), str)
                    and row["status"] in statuses
                    and related(row, job=kind == "jobs")
                ):
                    return True
        return False

    def ensure_clip_campaign_active(self, clip):
        """Block new clip-level effects (publish, schedule, re-review) for an archived campaign's clips."""
        identifier = clip.get("campaign_id") if isinstance(clip, dict) else None
        campaign = self.store.get("campaigns", identifier) if isinstance(identifier, str) else None
        if campaign and campaign.get("archived_at"):
            raise HTTPException(
                409, "This clip belongs to an archived campaign. Restore the campaign before new work."
            )

    def archive(self, identifier):
        with self.store.lock:
            campaign = self.require("campaigns", identifier)
            # Already archived: return the stable record (re-pausing any policy) without re-checking work.
            if not campaign.get("archived_at") and self._has_active_work(campaign):
                raise HTTPException(409, "Finish or cancel this campaign's active work before archiving it.")
            changes = []
            timestamp = campaign.get("archived_at") or now()
            if not campaign.get("archived_at"):
                campaign = {**campaign, "archived_at": timestamp, "updated_at": timestamp}
                changes.append(("campaigns", campaign))
            for policy in self.store.all("learning_policies"):
                if (
                    isinstance(policy, dict)
                    and policy.get("campaign_id") == identifier
                    and policy.get("enabled") is True
                ):
                    changes.append(
                        ("learning_policies", {**policy, "enabled": False, "updated_at": timestamp})
                    )
            if changes:
                self.store.put_many(changes)
            return campaign

    def restore_campaign(self, identifier):
        with self.store.lock:
            campaign = self.require("campaigns", identifier)
            if not campaign.get("archived_at"):
                return campaign
            timestamp = now()
            return self.store.put(
                "campaigns",
                {**campaign, "archived_at": None, "restored_at": timestamp, "updated_at": timestamp},
            )

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

    @staticmethod
    def _merge(existing, body, keep):
        """Strict body over the saved record; omitted ``keep`` fields retain their saved values."""
        data = body.model_dump()
        for key in keep:
            if key not in body.model_fields_set and key in existing:
                data[key] = existing[key]
        return {**existing, **data}

    def save_profile(self, body, identifier=None):
        with self.store.lock:
            existing = self.require("profiles", identifier) if identifier else {}
            return self.store.put(
                "profiles",
                {
                    **self._merge(existing, body, LEGACY_GOAL_KEYS),
                    "id": identifier or new_id(),
                    "created_at": existing.get("created_at", now()),
                    "updated_at": now(),
                },
            )

    def save_campaign(self, body, identifier=None):
        with self.store.lock:
            existing = self.active_campaign(identifier) if identifier else {}
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
            record = self._merge(existing, body, (*LEGACY_GOAL_KEYS, "notes"))
            if record.get("objective") != "discovery" and not (record.get("primary_metric") or "").strip():
                raise HTTPException(422, "Select a primary metric for goal-directed work.")
            if record.get("objective") == "discovery":
                record["primary_metric"] = None
            return self.store.put(
                "campaigns",
                {
                    **record,
                    "id": identifier or new_id(),
                    "created_at": existing.get("created_at", now()),
                    "updated_at": now(),
                },
            )

    def versions(self, profile_id):
        """Workspace Style-rules history, newest first.

        Pre-workspace campaign versions that carry this workspace's direction are listed
        read-only (``scope: "campaign"``) so their history and provenance stay visible.
        """
        self.require("profiles", profile_id)
        campaigns = {
            c["id"] for c in self.store.all("campaigns") if profile_id in (c.get("profile_ids") or [])
        }
        rows = []
        for version in self.store.all("strategy_versions"):
            if is_workspace_version(version, profile_id):
                rows.append(version)
            elif (
                not is_workspace_version(version)
                and version.get("campaign_id") in campaigns
                and profile_id in (version.get("directions") or {})
            ):
                rows.append({**version, "scope": "campaign"})
        return sorted(
            rows,
            key=lambda v: (v.get("scope") == "workspace", v.get("version") or 0, str(v.get("created_at") or "")),
            reverse=True,
        )

    def campaign_versions(self, campaign_id):
        """Read-only legacy history of rules saved on this campaign before workspace rules."""
        self.require("campaigns", campaign_id)
        return sorted(
            (
                {**v, "scope": "campaign"}
                for v in self.store.all("strategy_versions")
                if v.get("campaign_id") == campaign_id and not is_workspace_version(v)
            ),
            key=lambda v: v.get("version") or 0,
            reverse=True,
        )

    def _workspace_version(self, profile_id, version_id):
        version = self.require("strategy_versions", version_id)
        if is_workspace_version(version, profile_id):
            return version
        if any(v["id"] == version_id for v in self.versions(profile_id)):
            return {**version, "scope": "campaign"}
        raise HTTPException(404, "Style-rules version not found in this workspace.")

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

    def _workspace_evidence(self, profile_id, refs):
        for identifier in refs:
            observation = self.require("campaign_observations", identifier)
            if observation.get("profile_id") != profile_id:
                raise HTTPException(
                    422,
                    "Evidence must belong to this workspace; transfers require a separate explicit experiment.",
                )

    def propose(self, profile_id, body: Proposal, *, hypothesis="", restored_from=None,
                source: StrategySource = "manual", learning: dict | None = None):
        """Save a PROPOSED workspace Style-rules version. Never approves it."""
        if source not in ("manual", "learning_experiment", "strategist") or (source != "manual") != (learning is not None):
            raise HTTPException(422, "Unsupported strategy proposal source.")
        with self.store.lock:
            profile = self.active_workspace(profile_id)
            if body.base_version_id != profile.get("active_strategy_id"):
                raise HTTPException(409, "Style rules changed. Reload and explicitly rebase the proposal.")
            if body.base_version_id:
                base = self.require("strategy_versions", body.base_version_id)
                if profile_id not in (base.get("directions") or {}):
                    raise HTTPException(409, "The approved base has no direction for this workspace.")
            if not body.reason.strip():
                raise HTTPException(422, "Explain the proposed strategy change.")
            self._workspace_evidence(profile_id, body.direction.evidence_refs)
            existing = self.versions(profile_id)
            return self.store.put(
                "strategy_versions",
                {
                    "id": new_id(),
                    "scope": "workspace",
                    "profile_id": profile_id,
                    "campaign_id": None,
                    "version": max((v.get("version") or 0 for v in existing), default=0) + 1,
                    "status": "proposed",
                    "base_version_id": body.base_version_id,
                    "directions": {profile_id: body.direction.model_dump()},
                    "changed_profile_ids": [profile_id],
                    "reason": body.reason,
                    "hypothesis": hypothesis,
                    "restored_from": restored_from,
                    "source": source,
                    **({"learning": deepcopy(learning)} if learning is not None else {}),
                    "created_at": now(),
                    "approved_at": None,
                    "limitations": STRATEGIST_CAVEAT if source == "strategist" else LEARNING_CAVEAT if learning is not None
                    else "Observational evidence informs a hypothesis, not proof of causal lift.",
                },
            )

    def propose_from_experiment(self, experiment: dict):
        """Turn one produced learning experiment into a PROPOSED workspace Style-rules revision.

        It rebases on the experiment's own approved base, so the stale-parent guard applies
        both here and again at approval. The campaign must still be active. Idempotent per
        experiment. Nothing is approved and no evidence is invented.
        """
        with self.store.lock:
            for version in self.store.all("strategy_versions"):
                if (version.get("learning") or {}).get("experiment_id") == experiment["id"]:
                    return version
            campaign = self.active_campaign(experiment["campaign_id"])
            base = self.require("strategy_versions", experiment["base_strategy_version_id"])
            profile_id = experiment["profile_id"]
            in_scope = (
                is_workspace_version(base, profile_id)
                if base.get("scope") == "workspace"
                else base.get("campaign_id") == campaign["id"]
            )
            if profile_id not in campaign["profile_ids"] or not in_scope or profile_id not in base.get("directions", {}):
                raise HTTPException(422, "Experiment base is outside this workspace's saved direction.")
            direction = deepcopy(base["directions"][profile_id])
            variable, before, after = experiment["variable"], experiment["before"], experiment["after"]
            if variable == "hook":
                hooks = [after] + [h for h in direction.get("hooks", []) if h != after]
                direction["hooks"] = hooks[:20]
            elif variable == "duration":
                direction["duration_seconds"] = float(after)
            else:
                raise HTTPException(422, "Only hook or duration experiments can propose an editing rule.")
            direction["limitations"] = LEARNING_CAVEAT
            direction["confidence"] = "low"
            evidence = list(dict.fromkeys([experiment["snapshot_id"], *experiment.get("evidence_ids", [])]))[:20]
            learning = {
                "experiment_id": experiment["id"], "profile_id": profile_id, "campaign_id": campaign["id"],
                "account_id": experiment.get("account_id"), "publication_id": experiment.get("publication_id"),
                "variable": variable, "before": before, "after": after,
                "snapshot_ids": evidence, "parent_clip_id": experiment.get("parent_clip_id"),
                "draft_clip_id": experiment.get("clip_id"), "trigger": experiment.get("trigger", "schedule"),
                "real_elapsed_hours": experiment.get("real_elapsed_hours"), "caveat": LEARNING_CAVEAT,
            }
            shown = (lambda v: f"{v:g}s" if isinstance(v, (int, float)) else repr(str(v)[:120]))
            reason = (
                f"Learning experiment {experiment['id']} changed the {variable} from {shown(before)} to "
                f"{shown(after)}; cited snapshot {experiment['snapshot_id']}. Observational, not causal."
            )[:4000]
            return self.propose(
                profile_id,
                Proposal(direction=Direction.model_validate(direction), reason=reason, base_version_id=base["id"]),
                hypothesis=f"Changing the {variable} may improve the profile's measured outcome."[:4000],
                source="learning_experiment",
                learning=learning,
            )

    def propose_from_beliefs(self, profile_id: str, layer: str, changes: dict, beliefs: list[dict]):
        """Turn supported strategist beliefs into a PROPOSED workspace Style-rules revision.

        Same propose() path as learning experiments: the stale-base guard applies here and
        again at approval. Only existing Direction fields change; text guidance is a bounded,
        replaceable block. Nothing is approved and the evidence IDs are the beliefs' own.
        """
        from .strategist import merge_guidance

        with self.store.lock:
            profile = self.active_workspace(profile_id)
            if not profile.get("active_strategy_id"):
                raise HTTPException(409, "Approve this workspace's Style rules before strategist proposals.")
            base = self.require("strategy_versions", profile["active_strategy_id"])
            if profile_id not in base.get("directions", {}):
                raise HTTPException(409, "Approve this workspace's Style rules before strategist proposals.")
            direction = deepcopy(base["directions"][profile_id])
            direction.update(changes.get("structured") or {})
            field = changes["guidance_field"]
            if field not in ("moment_selection", "editing_preferences"):
                raise HTTPException(422, "Unsupported strategist guidance field.")
            direction[field] = merge_guidance(direction.get(field, ""), changes["guidance"])
            direction["limitations"] = STRATEGIST_CAVEAT
            direction["confidence"] = "low"
            evidence = sorted({e["snapshot_id"] for b in beliefs for e in b.get("evidence", [])})[:40]
            learning = {"layer": layer, "profile_id": profile_id, "belief_ids": [b["id"] for b in beliefs],
                        "snapshot_ids": evidence, "caveat": STRATEGIST_CAVEAT,
                        "beliefs": [{k: b.get(k) for k in ("id", "statement", "variable", "value", "direction",
                                     "confidence", "status")} for b in beliefs][:10]}
            statements = " ".join(b["statement"] for b in beliefs)
            return self.propose(
                profile_id,
                Proposal(direction=Direction.model_validate(direction),
                         reason=f"Strategist ({layer}) proposal: {statements} Observational, not causal."[:4000],
                         base_version_id=base["id"]),
                hypothesis=statements[:4000], source="strategist", learning=learning,
            )

    def decision(self, profile_id, version_id, *, approve, reason=""):
        with self.store.lock:
            profile = self.active_workspace(profile_id)
            version = self._workspace_version(profile_id, version_id)
            if version.get("scope") != "workspace":
                raise HTTPException(
                    409,
                    "This version was saved on one campaign before Style rules moved to the workspace. "
                    "Restore it to propose it for the workspace.",
                )
            if version["status"] != "proposed":
                raise HTTPException(409, "Only a proposed strategy can be approved or rejected.")
            if approve:
                if version["base_version_id"] != profile.get("active_strategy_id"):
                    raise HTTPException(
                        409, "Style rules changed; stale proposals cannot replace current direction."
                    )
                if set(version["directions"]) != {profile_id}:
                    raise HTTPException(409, "Propose a complete rule set for this workspace first.")
                stamp = now()
                version.update(status="approved", approved_at=stamp)
                profile.update(active_strategy_id=version_id, updated_at=stamp)
                self.store.put_many([("strategy_versions", version), ("profiles", profile)])
            else:
                version.update(status="rejected", rejection_reason=reason, rejected_at=now())
                self.store.put("strategy_versions", version)
            return version

    def restore(self, profile_id, version_id, body: Decision):
        with self.store.lock:
            profile = self.active_workspace(profile_id)
            version = self._workspace_version(profile_id, version_id)
            legacy_draft = version.get("scope") == "campaign" and version["status"] == "proposed"
            if version["status"] != "approved" and not legacy_draft:
                raise HTTPException(422, "Restore only an approved decision from this workspace.")
            if profile_id not in version["directions"]:
                raise HTTPException(422, "Earlier strategy has no direction for this workspace.")
            return self.propose(
                profile_id,
                Proposal(
                    base_version_id=profile.get("active_strategy_id"),
                    direction=version["directions"][profile_id],
                    reason=body.reason or "Restore earlier workspace direction.",
                ),
                restored_from=version_id,
            )

    def observe(self, campaign_id, body):
        with self.store.lock:
            self.active_campaign(campaign_id)
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
            self.active_campaign(campaign_id)
            self._evidence(campaign_id, body.profile_id, body.observation_ids, known=True)
            refs = list(dict.fromkeys(body.proposed_direction.evidence_refs + body.observation_ids))
            self._evidence(campaign_id, body.profile_id, refs)
            direction = body.proposed_direction.model_copy(update={"evidence_refs": refs})
            return self.propose(
                body.profile_id,
                Proposal(direction=direction, reason=body.reason, base_version_id=body.base_version_id),
                hypothesis=body.hypothesis,
            )

    def snapshot(self, campaign_id, profile_id, video_id, expected_strategy_version_id=None):
        """Immutable production context: the workspace's exact approved rule version + campaign goal."""
        with self.store.lock:
            campaign = self.active_campaign(campaign_id)
            if profile_id not in campaign["profile_ids"] or video_id not in campaign["video_ids"]:
                raise HTTPException(422, "Select a source and profile belonging to this campaign.")
            profile = self.require("profiles", profile_id)
            active = profile.get("active_strategy_id")
            if expected_strategy_version_id and expected_strategy_version_id != active:
                raise HTTPException(
                    409, "Active strategy changed since it was displayed. Reload before production."
                )
            if not active:
                raise HTTPException(409, "Approve this workspace's Style rules before starting production.")
            strategy = self.require("strategy_versions", active)
            if strategy.get("status") != "approved" or profile_id not in strategy["directions"]:
                raise HTTPException(409, "Approve direction for this workspace before production.")
            return {
                "campaign_id": campaign_id,
                "profile_id": profile_id,
                "video_id": video_id,
                "strategy_version_id": strategy["id"],
                "strategy_version": strategy["version"],
                "strategy_scope": "workspace",
                "strategy_snapshot": deepcopy(strategy["directions"][profile_id]),
                "profile_snapshot": {k: deepcopy(v) for k, v in profile.items() if k not in LEGACY_GOAL_KEYS},
                "goal": {"objective": campaign["objective"], "primary_metric": campaign.get("primary_metric")},
                "campaign_notes": campaign.get("notes") or "",
                "brief_snapshot": deepcopy(campaign["brief"]),
                "captured_at": now(),
            }
