"""Read-only, authenticated rehearsal endpoint; no simulation rows enter the real store."""

from pathlib import Path
from typing import Literal

from fastapi import HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, ConfigDict, Field

from .demo_loop import rubric, simulate_loop


class DemoLoopBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    seed: int = Field(default=7, ge=0, le=1_000_000)
    rounds: int = Field(default=3, ge=1, le=6)
    scenario: Literal["mixed", "decline", "sparse", "no_signal"] = "mixed"
    metric: Literal["views", "engagement_rate", "completion_rate", "click_rate"] = "completion_rate"


def install(app):
    viewer = Path(__file__).parent / "demo_ui"

    @app.get("/api/demo-loop/viewer", response_class=HTMLResponse)
    def show_viewer():
        html = (viewer / "index.html").read_text()
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
