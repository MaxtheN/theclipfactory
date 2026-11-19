"""Read-only, authenticated rehearsal endpoint; no simulation rows enter the real store."""

from pathlib import Path
from typing import Literal

from fastapi import HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, ConfigDict, Field

from .demo_loop import rubric, simulate_loop
from .learning_demo import build as build_learning_demo


class DemoLoopBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    seed: int = Field(default=7, ge=0, le=1_000_000)
    rounds: int = Field(default=3, ge=1, le=6)
    scenario: Literal["mixed", "decline", "sparse", "no_signal"] = "mixed"
    metric: Literal["views", "engagement_rate", "completion_rate", "click_rate"] = "completion_rate"


class LearningRecutBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(min_length=1, max_length=128)
    clip_id: str = Field(min_length=1, max_length=200)
    hook: str = Field(min_length=3, max_length=80)
    payoff_start: float = Field(ge=0)
    payoff_end: float = Field(gt=0)
    rule: str = Field(default="Question hooks hold viewers", max_length=120)


def install(app):
    viewer = Path(__file__).parent / "demo_ui"

    @app.get("/api/demo-loop/viewer", response_class=HTMLResponse)
    def show_viewer():
        html = (viewer / "index.html").read_text(encoding="utf-8")
        html = html.replace('href="/styles.css"', 'href="/api/demo-loop/assets/styles.css"')
        html = html.replace('src="/app.js"', 'src="/api/demo-loop/assets/app.js"')
        return HTMLResponse(html, headers={"Cache-Control": "no-store"})

    @app.get("/api/demo-loop/assets/{filename}")
    def viewer_asset(filename: str):
        types = {"app.js": "text/javascript", "styles.css": "text/css"}
        if filename not in types:
            raise HTTPException(404, "Unknown rehearsal asset")
        return FileResponse(viewer / filename, media_type=types[filename], headers={"Cache-Control": "no-store"})

    @app.get("/api/demo-loop/rubric")
    def show_rubric():
        return rubric()

    @app.post("/api/demo-loop/{profile_id}/simulate")
    def rehearsal(profile_id: str, body: DemoLoopBody | None = None):
        profile = app.state.strategist.require_profile(profile_id)
        body = body or DemoLoopBody()
        return simulate_loop(profile, **body.model_dump())

    @app.post("/api/demo-loop/{profile_id}/learning-loop")
    def learning_loop(profile_id: str):
        """Real clips + SIMULATED results + real belief math. Read-only: nothing is stored."""
        return build_learning_demo(app.state.store, profile_id, Path(app.state.root))

    @app.post("/api/demo-loop/{profile_id}/learning-loop/recut", status_code=202)
    def learning_recut(profile_id: str, body: LearningRecutBody):
        return app.state.growth_loop.demo_recut(profile_id, **body.model_dump())

    @app.get("/api/demo-loop/loops/{loop_id}")
    def learning_loop_status(loop_id: str):
        receipt = app.state.growth_loop.reconcile(loop_id)
        slot = (receipt.get("slots") or [{}])[0]
        clip = app.state.store.get("clips", slot["clip_id"]) if slot.get("clip_id") else None
        job = app.state.store.get("jobs", slot["job_id"]) if slot.get("job_id") else None
        return {"id": receipt["id"], "number": receipt.get("number"), "status": receipt["status"],
                "slot_status": slot.get("status"), "error": slot.get("error"),
                "progress": (job or {}).get("progress"), "message": (job or {}).get("message"),
                "output": None if not clip else {
                    "clip_id": clip["id"], "seconds": clip.get("duration"), "approved": bool(clip.get("approved")),
                    "hook": (clip.get("edit_plan") or {}).get("hook"), "parent_clip_id": clip.get("parent_clip_id"),
                    "media_url": f"/api/clips/{clip['id']}/media"}}
