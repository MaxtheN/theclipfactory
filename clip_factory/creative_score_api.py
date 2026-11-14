"""Authenticated local routes; the host app supplies its existing middleware and FIFO Jobs."""
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .creative_score import CreativeScores
from .llm_provider import gateway_of


class AssessmentBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expected_sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    retry_failed: bool = False


def install(app):
    service = CreativeScores(app.state.store, app.state.root, gateway_of(app), lambda: app.state.jobs)
    app.state.creative_scores = service

    @app.get("/api/clips/{identifier}/scorecard")
    def scorecard(identifier: str):
        return service.view(identifier)

    @app.post("/api/clips/{identifier}/assess", status_code=202)
    def assess(identifier: str, body: AssessmentBody):
        try:
            return service.request(identifier, body.expected_sha256, retry_failed=body.retry_failed)
        except OSError:
            raise HTTPException(409, "The exact clip file could not be read.") from None
