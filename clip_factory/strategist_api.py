"""Local authenticated controls for the Strategist. No publishing, spending or approval of style rules here."""

from __future__ import annotations

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .jobs import WorkError
from .ollama import is_ollama, model_name
from .store import now
from .strategist import CONTEXT_TOKENS, MAX_OUTPUT_TOKENS, Layer, Strategist, simulate

QUALIFIED_ANALYST = "qwen3-vl:4b"
HELD = "model held: insufficient memory"


class RunBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    layer: Layer | None = None


class RetireBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str = Field(default="", max_length=300)


class SimulateBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    seed: int = Field(default=7, ge=0, le=1_000_000)
    steps: int = Field(default=16, ge=4, le=40)


class DecisionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    approve: bool
    reason: str = Field(default="", max_length=1000)


class LocalModel:
    """The existing local analyst path: admission guard before every call, bounded 8,192-token context."""

    def __init__(self, app, runtime, job_id: str | None):
        self.app, self.runtime, self.job_id = app, runtime, job_id
        config = runtime.store.get("automation_settings", "local") or {}
        self.model = config.get("model_id", "ollama:qwen3-vl:4b-instruct")

    def admit(self) -> list[str]:
        if not is_ollama(self.model) or not model_name(self.model).startswith(QUALIFIED_ANALYST):
            return ["Only the local qwen3-vl:4b analyst is qualified for strategist hypotheses."]
        if self.job_id is None:
            return ["The strategist model runs only inside a queued local job."]
        try:
            self.runtime.resource_check(self.model, CONTEXT_TOKENS)
        except WorkError as exc:
            return [str(exc)[:400] or HELD]
        except Exception:  # noqa: BLE001 - unverifiable resources must hold, never infer
            return ["Available memory could not be verified; the model is held."]
        return []

    def generate(self, prompt: str) -> str:
        output = self.app.state.models.run(self.job_id, self.model, "generate", prompt=prompt,
                                           max_tokens=MAX_OUTPUT_TOKENS, context_tokens=CONTEXT_TOKENS)
        return output.get("output") if isinstance(output, dict) else None


def reconcile_runs(store):
    """A receipt whose job ended without finishing it (app shutdown, cancellation) is closed as failed."""
    for receipt in store.all("strategist_runs"):
        if receipt.get("status") not in {"queued", "running"} or not receipt.get("job_id"):
            continue
        job = store.get("jobs", receipt["job_id"]) or {}
        if job.get("status") in {"failed", "cancelled", "completed"} or not job:
            store.patch("strategist_runs", receipt["id"], status="failed", finished_at=now(),
                        message="Interrupted before finishing. Run the strategist again.")


def request_run(app, strategist: Strategist, profile_id: str, *, layers=None, trigger="manual") -> dict:
    reconcile_runs(strategist.store)
    receipt = strategist.start_receipt(profile_id, layers, trigger)
    jobs = app.state.jobs

    def work(job_id):
        current = {**strategist.store.get("strategist_runs", receipt["id"]), "job_id": job_id}
        result = strategist.run(profile_id, layers=layers, trigger=trigger, receipt=current, job_id=job_id)
        return {"strategist_run_id": result["id"], "status": result["status"]}

    try:
        job = jobs.submit("strategist", work, profile_id=profile_id, strategist_run_id=receipt["id"])
    except WorkError as exc:
        strategist.store.patch("strategist_runs", receipt["id"], status="failed", message=str(exc)[:300], finished_at=now())
        raise HTTPException(503, str(exc)) from None
    return strategist.store.patch("strategist_runs", receipt["id"], job_id=job["id"])


def scheduled_tick(app, strategist: Strategist) -> dict | None:
    """After snapshot collection: queue at most one due profile per tick. Proposals only; nothing approves."""
    reconcile_runs(strategist.store)
    profiles = sorted({p.get("profile_id") for p in strategist.store.all("learning_policies") if p.get("enabled")} - {None})
    for profile_id in profiles:
        try:
            due = strategist.due_layers(profile_id)
            if due:
                return request_run(app, strategist, profile_id, layers=due, trigger="schedule")
        except HTTPException:
            continue  # archived/running/missing: skip quietly; the manual API reports the reason
    return None


def install(app, strategist: Strategist):
    @app.get("/api/strategist/{profile_id}")
    def view(profile_id: str):
        reconcile_runs(strategist.store)
        return strategist.view(profile_id)

    @app.post("/api/strategist/{profile_id}/run", status_code=202)
    def run(profile_id: str, body: RunBody | None = None):
        layer = body.layer if body else None
        return request_run(app, strategist, profile_id, layers=[layer] if layer else None, trigger="manual")

    @app.post("/api/strategist/beliefs/{belief_id}/retire")
    def retire(belief_id: str, body: RetireBody | None = None):
        return strategist.retire(belief_id, body.reason if body else "")

    @app.post("/api/strategist/campaign-proposals/{proposal_id}/decision")
    def decide(proposal_id: str, body: DecisionBody):
        return strategist.decide_campaign_proposal(proposal_id, approve=body.approve, reason=body.reason)

    @app.post("/api/strategist/{profile_id}/simulate")
    def simulation(profile_id: str, body: SimulateBody | None = None):
        body = body or SimulateBody()
        profile = strategist.require_profile(profile_id)  # read-only; the simulation never touches this store
        return simulate(profile, seed=body.seed, steps=body.steps)
