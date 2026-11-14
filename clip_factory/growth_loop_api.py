"""Local authenticated growth-loop controls; every rendered output starts unapproved."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .growth_loop import GrowthLoop


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class ReviewBody(Body):
    clip_id: str = Field(min_length=1, max_length=200)
    decision: Literal["approve", "reject", "request_change"]
    request_id: str = Field(min_length=1, max_length=128)
    reason: str = Field(default="", max_length=2000)
    expected_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class DraftBody(Body):
    request_id: str = Field(min_length=1, max_length=128)
    clip_ids: list[str] = Field(min_length=1, max_length=3)
    expected_strategy_version_id: str = Field(min_length=1, max_length=200)


class PolicyBody(Body):
    auto_ab: bool = Field(strict=True)


class RehearseBody(Body):
    request_id: str = Field(min_length=1, max_length=128)
    clip_id: str = Field(min_length=1, max_length=200)
    expected_strategy_version_id: str = Field(min_length=1, max_length=200)
    expected_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    scenario: Literal["mixed", "decline", "sparse"] = "mixed"


def install(app, campaigns, *, render):
    scores = getattr(app.state, "creative_scores", None)
    service = GrowthLoop(app.state.store, campaigns, render, root=app.state.root,
                         scorecard=(lambda identifier: scores.view(identifier, reconcile=False)) if scores else None)
    app.state.growth_loop = service

    @app.get("/api/growth/profiles/{profile_id}")
    def view(profile_id: str):
        return service.view(profile_id)

    @app.put("/api/growth/profiles/{profile_id}/policy")
    def policy(profile_id: str, body: PolicyBody):
        return service.policy(profile_id, auto_ab=body.auto_ab)

    @app.post("/api/growth/profiles/{profile_id}/reviews", status_code=201)
    def review(profile_id: str, body: ReviewBody):
        return service.record_review(profile_id, **body.model_dump())

    @app.post("/api/growth/profiles/{profile_id}/ab", status_code=202)
    def ab(profile_id: str, body: DraftBody):
        return service.start_ab(profile_id, **body.model_dump())

    @app.post("/api/growth/profiles/{profile_id}/recut", status_code=202)
    def recut(profile_id: str, body: DraftBody):
        return service.recut(profile_id, **body.model_dump())

    @app.post("/api/growth/profiles/{profile_id}/rehearse", status_code=202)
    def rehearse(profile_id: str, body: RehearseBody):
        return service.rehearse(profile_id, **body.model_dump())

    @app.post("/api/growth/profiles/{profile_id}/rehearse-preview")
    def rehearse_preview(profile_id: str, body: RehearseBody):
        return service.rehearsal_preview(profile_id, **body.model_dump())

    return service
