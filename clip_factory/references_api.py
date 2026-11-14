"""Authenticated local endpoints for reference research ("Research what works").

Reference files live under ``<data>/references/<research id>/`` and are records of kind
``reference_research``: they are never production sources (never in ``videos``), never rendered,
never posted. Analysis is one queued job on the serial heavy worker. "Use this direction" queues an
A/B render through the campaign render path and saves a PROPOSED Style-rules version; nothing here
approves rules or publishes.
"""

from __future__ import annotations

import shutil
import threading
import time
from copy import deepcopy
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from . import brief as briefs
from . import media
from . import references as refs
from .campaigns import Campaigns, Direction, Production, Proposal
from .jobs import WorkError
from .store import new_id, now

Identifier = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Start(Body):
    profile_id: str = Identifier


class LinkBody(Body):
    url: str = Field(min_length=1, max_length=500)
    note: str = Field(default="", max_length=300)

    @field_validator("url")
    @classmethod
    def safe(cls, value: str) -> str:
        return briefs._safe_url(value.strip())


class NoteBody(Body):
    note: str = Field(default="", max_length=300)


class AnalyzeBody(Body):
    target_clip_id: str | None = Field(default=None, min_length=1, max_length=128)


class UseBody(Body):
    clip_id: str | None = Field(default=None, min_length=1, max_length=128)


def install(app: FastAPI, campaigns: Campaigns, *, render):
    store = campaigns.store
    lock = threading.RLock()

    def root() -> Path:
        folder = Path(app.state.root) / "references"
        folder.mkdir(exist_ok=True)
        return folder

    def folder_of(research: dict) -> Path:
        folder = root() / research["id"]
        folder.mkdir(exist_ok=True)
        return folder

    def require(identifier: str) -> dict:
        item = store.get(refs.STORE, identifier)
        if not item:
            raise HTTPException(404, "Reference research not found.")
        return item

    def editable(research: dict) -> dict:
        if research["status"] in {"queued", "analyzing"}:
            raise HTTPException(409, "Analysis is running. Wait for it to finish before changing references.")
        return research

    def save(research: dict) -> dict:
        research["updated_at"] = now()
        return store.put(refs.STORE, research)

    def campaign_clips(campaign_id: str) -> list[dict]:
        rows = [c for c in store.all("clips") if c.get("campaign_id") == campaign_id and c.get("video_id")]
        rows.sort(key=lambda c: ((c.get("rank") or {}).get("position") or 999, c.get("created_at") or ""))
        return [{"id": c["id"], "hook": c.get("hook") or "", "start": c.get("start"), "end": c.get("end"),
                 "video_id": c["video_id"], "name": c.get("name") or "", "approved": bool(c.get("approved")),
                 "reference_research_id": c.get("reference_research_id")} for c in rows[:60]]

    def view(research: dict) -> dict:
        out = refs.public(research)
        out["candidate_clips"] = campaign_clips(research["campaign_id"])
        job = store.get("jobs", research["job_id"]) if research.get("job_id") else None
        out["job"] = job and {k: job.get(k) for k in ("id", "status", "progress", "message", "error")}
        if research["status"] in {"queued", "analyzing"} and job and job["status"] in {"failed", "cancelled"}:
            research = {**research, "status": "failed",
                        "error": job.get("error") or "Analysis stopped before finishing."}
            save(research)
            out.update(status="failed", error=research["error"])
        return out

    def ref_of(research: dict, ref_id: str) -> dict:
        found = next((r for r in research["references"] if r["id"] == ref_id), None)
        if not found:
            raise HTTPException(404, "Reference not found.")
        return found

    def room(research: dict):
        if len(research["references"]) >= refs.MAX_REFERENCES:
            raise HTTPException(422, "Use at most 3 references. Remove one first.")

    def reset_results(research: dict):
        research.update(status="draft", observations=[], pattern=None, plans=[], limits=[], abstained=None,
                        holds=[], direction=None)

    # ------------------------------------------------------------------ records

    @app.get("/api/campaigns/{identifier}/reference-research")
    def research_for(identifier: str):
        campaigns.require("campaigns", identifier)
        rows = [r for r in store.all(refs.STORE) if r["campaign_id"] == identifier]
        rows.sort(key=lambda r: r["created_at"], reverse=True)
        return [view(r) for r in rows[:10]]

    @app.post("/api/campaigns/{identifier}/reference-research", status_code=201)
    def start(identifier: str, body: Start):
        campaign = campaigns.active_campaign(identifier)
        if body.profile_id not in campaign["profile_ids"]:
            raise HTTPException(422, "Choose a brand that belongs to this campaign.")
        return view(save(refs.new_research(identifier, body.profile_id)))

    @app.get("/api/reference-research/{identifier}")
    def research(identifier: str):
        return view(require(identifier))

    # ------------------------------------------------------------------ references

    @app.post("/api/reference-research/{identifier}/references", status_code=201)
    def upload(identifier: str, file: UploadFile, note: Annotated[str, Form()] = ""):
        if len(note) > 300:
            raise HTTPException(422, "Keep the note under 300 characters.")
        with lock:
            item = editable(require(identifier))
            room(item)
        name = Path(file.filename or "reference.mp4").name
        suffix = Path(name).suffix.lower()
        if suffix not in refs.VIDEO_SUFFIXES:
            raise HTTPException(422, "Upload a reel or short as MP4, MOV, M4V or WebM.")
        ref_id = "ref_" + new_id()[:12]
        target = folder_of(item) / f"{ref_id}{suffix}"
        try:
            size = 0
            with target.open("wb") as output:
                while chunk := file.file.read(1024 * 1024):
                    size += len(chunk)
                    if size > refs.MAX_REFERENCE_BYTES:
                        raise HTTPException(413, "References are limited to 200 MB.")
                    output.write(chunk)
            try:
                info = media.probe(target)
                refs.check_video(info)
            except WorkError as exc:
                raise HTTPException(422, str(exc)) from None
            with lock:
                item = editable(require(identifier))
                room(item)
                item["references"].append({
                    "id": ref_id, "kind": "upload", "media_kind": "reference", "name": name[:200],
                    "note": note.strip(), "url": None, "file": target.name, "bytes": size,
                    "duration": info["duration"], "width": info["width"], "height": info["height"],
                    "has_audio": info["has_audio"], "status": "stored",
                    "status_reason": "Uploaded; analyzed when you run the analysis.", "added_at": now(),
                })
                reset_results(item)
                return view(save(item))
        except Exception:
            target.unlink(missing_ok=True)
            raise
        finally:
            file.file.close()

    @app.post("/api/reference-research/{identifier}/links", status_code=201)
    def link(identifier: str, body: LinkBody):
        with lock:
            item = editable(require(identifier))
            room(item)
            status = refs.url_status(body.url)
            item["references"].append({
                "id": "ref_" + new_id()[:12], "kind": "url", "media_kind": "reference", "name": body.url[:200],
                "note": body.note.strip(), "url": body.url, "file": None,
                "status": "linked" if status["fetchable"] else "not_inspected",
                "status_reason": status["reason"], "added_at": now(),
            })
            reset_results(item)
            return view(save(item))

    @app.patch("/api/reference-research/{identifier}/references/{ref_id}")
    def annotate(identifier: str, ref_id: str, body: NoteBody):
        with lock:
            item = editable(require(identifier))
            ref_of(item, ref_id)["note"] = body.note.strip()
            return view(save(item))

    @app.delete("/api/reference-research/{identifier}/references/{ref_id}")
    def remove(identifier: str, ref_id: str):
        with lock:
            item = editable(require(identifier))
            ref = ref_of(item, ref_id)
            refs.remove_files(folder_of(item), ref)
            item["references"] = [r for r in item["references"] if r["id"] != ref_id]
            reset_results(item)
            return view(save(item))

    @app.get("/api/reference-research/{identifier}/references/{ref_id}/media")
    def reference_media(identifier: str, ref_id: str):
        item = require(identifier)
        ref = ref_of(item, ref_id)
        path = refs.safe_child(folder_of(item), ref.get("file") or "")
        if not path:
            raise HTTPException(404, "This reference has no inspected video.")
        return FileResponse(path)

    @app.get("/api/reference-research/{identifier}/frames/{name}")
    def reference_frame(identifier: str, name: str):
        item = require(identifier)
        if not name.endswith(".jpg"):
            raise HTTPException(404, "Frame not found.")
        path = refs.safe_child(folder_of(item), name)
        if not path:
            raise HTTPException(404, "Frame not found.")
        return FileResponse(path, media_type="image/jpeg")

    # ------------------------------------------------------------------ analysis job

    def vision_model() -> str | None:
        config = store.get("automation_settings", "local") or {}
        model = config.get("model_id", "ollama:qwen3-vl:4b-instruct")
        from .ollama import is_ollama, model_name

        if not is_ollama(model) or not model_name(model).startswith(refs.QUALIFIED):
            return None
        try:
            app.state.models.require(model, "llm")
        except WorkError:
            return None
        return model if app.state.models.vision(model) else None

    def whisper_ready() -> bool:
        try:
            app.state.models.require("whisper-turbo", "asr")
            return True
        except WorkError:
            return False

    def context(item: dict) -> tuple[dict, dict, dict | None, dict | None, dict | None]:
        campaign = store.get("campaigns", item["campaign_id"]) or {}
        profile = store.get("profiles", item["profile_id"]) or {}
        active = store.get("strategy_versions", profile.get("active_strategy_id") or "") or {}
        direction = (active.get("directions") or {}).get(item["profile_id"]) if active.get("status") == "approved" else None
        clip = store.get("clips", item["target_clip_id"]) if item.get("target_clip_id") else None
        video = store.get("videos", clip["video_id"]) if clip else None
        return campaign, profile, direction, clip, video

    def analyze(job_id: str, research_id: str) -> dict:
        from .strategist_api import LocalModel

        item = require(research_id)
        item.update(status="analyzing", job_id=job_id, started_at=now())
        save(item)
        clock = time.monotonic()
        jobs = app.state.jobs
        guard = LocalModel(app, app.state.autonomy_runtime, job_id)
        # Frame descriptions always run locally behind the admission guard; only the text-only pattern
        # step may use the creator's cloud model.
        writer = LocalModel(app, app.state.autonomy_runtime, job_id, role="reference_pattern")
        model = vision_model()
        settings = store.get("config", "settings") or {}
        analyzer = refs.Analyzer(
            jobs=jobs, models=app.state.models, admit=guard.admit_local, vision_model=model,
            whisper_ready=whisper_ready, language=(settings.get("value") or {}).get("language") or None,
        )
        folder, work = folder_of(item), Path(app.state.root) / "work" / job_id / "references"
        work.mkdir(parents=True, exist_ok=True)
        try:
            total = len(item["references"])
            for index, ref in enumerate(item["references"]):
                jobs.check(job_id)
                jobs.update(job_id, progress=5 + 70 * index // max(1, total),
                            message=f"Studying reference {index + 1} of {total}")
                for key in ("measurements", "frames", "observations", "captions", "words", "transcript_text"):
                    ref.pop(key, None)
                if ref["kind"] == "url" and ref["status"] == "not_inspected":
                    continue
                try:
                    analyzer.reference(job_id, ref, folder, work)
                except WorkError as exc:
                    ref.update(status="failed", status_reason=f"Could not analyze: {str(exc)[:200]}")
                save(item)
            observations = refs.number_observations(item["references"])
            campaign, profile, direction, clip, video = context(item)
            own = refs.own_span(clip, video)
            control = refs.control_values(direction, clip)
            brief = briefs.normalize_brief(campaign.get("brief"))
            snapshot = {"profile_snapshot": profile, "strategy_snapshot": direction or {},
                        "goal": {"objective": campaign.get("objective"), "primary_metric": campaign.get("primary_metric")},
                        "brief_snapshot": brief, "campaign_notes": campaign.get("notes") or ""}
            jobs.update(job_id, progress=80, message="Naming one pattern from the observations")

            def local_generate(prompt: str):
                return app.state.models.run(
                    job_id, model, "generate", prompt=prompt, max_tokens=refs.PATTERN_TOKENS,
                    context_tokens=refs.CONTEXT_TOKENS, schema=refs.PatternDraft.model_json_schema(), temperature=0.2)

            def generate(prompt: str) -> str | None:
                if writer.cloud:
                    return writer.complete(prompt, refs.PatternDraft.model_json_schema(), refs.PATTERN_TOKENS, 0.2,
                                           (lambda: local_generate(prompt)) if model else None)
                output = local_generate(prompt)
                return output.get("output") if isinstance(output, dict) else None

            if model or writer.cloud:
                outcome = analyzer.pattern(
                    job_id, item["references"], observations,
                    brief_text=briefs.brief_block(snapshot, role="creative_strategist", compact=True),
                    brief=brief, own=own, control=control, generate=generate, admitted=writer.cloud)
            else:
                outcome = {"status": "abstained",
                           "reason": "No qualified local model (qwen3-vl:4b via Ollama) is installed; facts only."}
            pattern = outcome.get("pattern")
            item.update(
                observations=observations, pattern=pattern, own_span=own,
                plans=refs.build_plans(pattern, own, clip) if pattern else [],
                limits=refs.limits_for(item["references"], pattern),
                abstained=None if pattern else {"status": outcome["status"], "reason": outcome["reason"]},
                status="ready" if pattern else "abstained", model_id=writer.model_id if writer.cloud else model,
                llm=writer.usage, holds=analyzer.holds,
                timings={**analyzer.timings, "total": round(time.monotonic() - clock, 2)},
                finished_at=now(), analysis_version=refs.VERSION,
            )
            save(item)
            jobs.update(job_id, progress=100, message="Pattern ready" if pattern else "Observations ready; no pattern")
            return {"reference_research_id": research_id, "status": item["status"]}
        except Exception as exc:
            item.update(status="failed", error=str(exc)[:300] or "Analysis stopped.", finished_at=now(),
                        holds=analyzer.holds)
            save(item)
            raise
        finally:
            shutil.rmtree(work, ignore_errors=True)

    @app.post("/api/reference-research/{identifier}/analyze", status_code=202)
    def run_analysis(identifier: str, body: AnalyzeBody | None = None):
        with lock:
            item = editable(require(identifier))
            if not item["references"]:
                raise HTTPException(422, "Add 1–3 references first.")
            target = body.target_clip_id if body else None
            if target:
                clip = store.get("clips", target)
                if not clip or clip.get("campaign_id") != item["campaign_id"]:
                    raise HTTPException(422, "Choose one of this campaign's clips to test the pattern on.")
            reset_results(item)
            item.update(status="queued", target_clip_id=target, error=None)
            try:
                job = app.state.jobs.submit("reference_research", lambda job_id: analyze(job_id, identifier),
                                            reference_research_id=identifier, campaign_id=item["campaign_id"])
            except WorkError as exc:
                raise HTTPException(503, str(exc)) from None
            item["job_id"] = job["id"]
            save(item)
            return view(item)

    # ------------------------------------------------------------------ use this direction

    @app.post("/api/reference-research/{identifier}/use", status_code=202)
    def use(identifier: str, body: UseBody | None = None):
        with lock:
            item = require(identifier)
            if item["status"] != "ready" or not item.get("pattern"):
                raise HTTPException(409, "There is no validated pattern to use yet.")
            if item.get("direction"):
                raise HTTPException(409, "This direction is already in use; see the queued versions.")
            clip_id = (body.clip_id if body else None) or item.get("target_clip_id")
            if not clip_id:
                raise HTTPException(422, "Choose the clip to test the pattern on.")
            if item["pattern"]["variable"] == "hook" and clip_id != item.get("target_clip_id"):
                raise HTTPException(422, "This hook was grounded in another clip's words. Re-run on this clip.")
            clip = store.get("clips", clip_id)
            if not clip or clip.get("campaign_id") != item["campaign_id"]:
                raise HTTPException(422, "Choose one of this campaign's clips.")
            try:
                request = refs.variant_request(item, clip)
                production = Production.model_validate(request)
            except (WorkError, ValidationError) as exc:
                raise HTTPException(422, f"These two versions cannot be rendered: {str(exc)[:300]}") from None
            job = render(item["campaign_id"], production,
                         provenance={"reference_research_id": identifier,
                                     "reference_pattern": {k: item["pattern"][k] for k in
                                                           ("pattern", "variable", "value_a", "value_b", "supported_by")}})
            proposal, problem = None, None
            try:
                proposal = propose(item)
            except HTTPException as exc:
                problem = str(exc.detail)[:300]
            item["direction"] = {
                "applied_at": now(), "clip_id": clip_id, "job_id": job["id"],
                "variant_request": {k: v for k, v in request.items() if k != "caption"},
                "proposal_id": proposal and proposal["id"], "proposal_status": proposal and proposal["status"],
                "proposal_error": problem,
            }
            save(item)
            return view(item)

    def propose(item: dict) -> dict:
        profile = campaigns.active_workspace(item["profile_id"])
        base_id = profile.get("active_strategy_id")
        base = store.get("strategy_versions", base_id) if base_id else None
        direction = deepcopy(((base or {}).get("directions") or {}).get(item["profile_id"]) or {})
        note = refs.proposal_note(item)
        direction["next_experiments"] = [note["next_experiment"],
                                         *[e for e in direction.get("next_experiments", []) if e != note["next_experiment"]]][:20]
        direction["limitations"] = note["limitations"]
        direction["confidence"] = "low"
        version = campaigns.propose(
            item["profile_id"],
            Proposal(direction=Direction.model_validate(direction), reason=note["reason"], base_version_id=base_id),
            hypothesis=note["hypothesis"], source="manual",
        )
        # Link the proposal back to its research (evidence lives on the research record).
        return store.patch("strategy_versions", version["id"], reference_research_id=item["id"],
                           reference_research={"pattern": item["pattern"]["pattern"],
                                               "variable": item["pattern"]["variable"],
                                               "supported_by": item["pattern"]["supported_by"],
                                               "inference": True})
