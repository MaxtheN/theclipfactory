"""Local API for "Give us your website - we'll draft your brand brief".

POST /api/brand-research {url} starts a read and returns its id; GET /api/brand-research/{id} reports
real stage events; POST /api/brand-research/{id}/cancel stops it. Fetching runs on a light thread so it
never blocks renders; the model step is queued on the existing serial heavy worker (jobs.Jobs) so it
never overlaps another model or render, and it passes the memory admission guard before every call.

Drafts are kept in memory only, for a short time: nothing is saved until the creator confirms it in
onboarding, and the durable job record holds ids and status, never fetched content.
"""

from __future__ import annotations

import contextlib
import threading
import time
from collections.abc import Callable
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .brand_research import (
    CONTEXT_TOKENS,
    DRAFT_SCHEMA,
    MAX_OUTPUT_TOKENS,
    Abstain,
    FetchError,
    ModelHeld,
    SiteReader,
    draft_brief,
    normalize_url,
    read_site,
)
from .jobs import JobCancelled, WorkError
from .ollama import is_ollama, model_name
from .store import new_id, now

QUALIFIED_MODEL = "qwen3-vl:4b"
DEFAULT_MODEL = "ollama:qwen3-vl:4b-instruct"
KEEP_SECONDS = 30 * 60
MAX_SESSIONS = 10
PROGRESS = {"opening": 5, "reading": 10, "found": 20, "voice": 62, "drafting": 70, "done": 100}


class StartBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(min_length=1, max_length=2048)


class Cancelled(Exception):
    pass


class LocalBrandModel:
    """The qualified local 4B model behind the memory admission guard (same path as the Strategist)."""

    def __init__(self, app, runtime, job_id: str):
        self.app, self.runtime, self.job_id = app, runtime, job_id
        config = runtime.store.get("automation_settings", "local") or {}
        chosen = config.get("model_id") or DEFAULT_MODEL
        qualified = is_ollama(chosen) and model_name(chosen).startswith(QUALIFIED_MODEL)
        self.model = chosen if qualified else DEFAULT_MODEL

    def admit(self) -> list[str]:
        try:
            self.runtime.resource_check(self.model, CONTEXT_TOKENS)
        except WorkError as exc:
            return [str(exc)[:400] or "The local model is held: not enough free memory."]
        except Exception:  # noqa: BLE001 - unverifiable resources must hold, never infer
            return ["Available memory could not be verified, so the local model is held."]
        return []

    def generate(self, prompt: str) -> str | None:
        output = self.app.state.models.run(
            self.job_id, self.model, "generate", prompt=prompt, schema=DRAFT_SCHEMA, temperature=0.2,
            max_tokens=MAX_OUTPUT_TOKENS, context_tokens=CONTEXT_TOKENS,
        )
        return output.get("output") if isinstance(output, dict) else None


class BrandResearchService:
    def __init__(self, jobs: Callable[[], Any], model_factory: Callable[[str], Any],
                 reader_factory: Callable[[Callable[[], None]], SiteReader] | None = None):
        self.jobs = jobs
        self.model_factory = model_factory
        self.reader_factory = reader_factory or (lambda check: SiteReader(check=check))
        self.lock = threading.Lock()
        self.sessions: dict[str, dict] = {}
        self.stops: dict[str, threading.Event] = {}

    # ----------------------------------------------------------------------------- lifecycle
    def start(self, url: str) -> dict:
        try:
            normalized = normalize_url(url)
        except FetchError as exc:
            raise HTTPException(422, str(exc)) from None
        with self.lock:
            self._prune()
            if any(s["status"] == "running" for s in self.sessions.values()):
                raise HTTPException(409, "A website is already being read. Wait for it or cancel it first.")
            identifier = new_id()
            self.sessions[identifier] = {
                "id": identifier, "url": normalized, "status": "running", "stage": "opening", "progress": 0,
                "events": [], "draft": None, "error": None, "error_kind": None, "job_id": None,
                "created_at": now(), "started": time.monotonic(), "timings": {},
            }
            self.stops[identifier] = threading.Event()
        threading.Thread(target=self._read, args=(identifier,), name="brand-research-reader", daemon=True).start()
        return self.view(identifier)

    def view(self, identifier: str) -> dict:
        with self.lock:
            session = self.sessions.get(identifier)
            if not session:
                raise HTTPException(404, "This website read has expired. Start again.")
            value = {k: v for k, v in session.items() if k != "started"}
            value["events"] = [dict(e) for e in session["events"]]
        value["waiting"] = False
        if value["status"] == "running" and value["job_id"]:
            with contextlib.suppress(Exception):  # advisory only
                job = self.jobs().store.get("jobs", value["job_id"]) or {}
                value["waiting"] = job.get("status") == "queued"
        return value

    def cancel(self, identifier: str) -> dict:
        with self.lock:
            session = self.sessions.get(identifier)
            if not session:
                raise HTTPException(404, "This website read has expired. Start again.")
            if session["status"] != "running":
                return self.view_unlocked(identifier)
            self.stops[identifier].set()
            job_id = session["job_id"]
            self._finish(session, "cancelled", error="Stopped. Nothing was saved.", kind="cancelled")
        if job_id:
            with contextlib.suppress(Exception):  # the job may already be gone
                self.jobs().cancel(job_id)
        return self.view(identifier)

    def view_unlocked(self, identifier):
        session = self.sessions[identifier]
        return {**{k: v for k, v in session.items() if k != "started"}, "waiting": False}

    # ----------------------------------------------------------------------------- internals
    def _prune(self):
        cutoff = time.monotonic() - KEEP_SECONDS
        for key, session in list(self.sessions.items()):
            if session["status"] != "running" and session["started"] < cutoff:
                self.sessions.pop(key, None)
                self.stops.pop(key, None)
        finished = [k for k, s in self.sessions.items() if s["status"] != "running"]
        while len(self.sessions) > MAX_SESSIONS and finished:
            key = finished.pop(0)
            self.sessions.pop(key, None)
            self.stops.pop(key, None)

    def _emit(self, identifier: str, stage: str, label: str, **detail):
        with self.lock:
            session = self.sessions.get(identifier)
            if not session or session["status"] != "running":
                raise Cancelled()
            elapsed = round(time.monotonic() - session["started"], 2)
            event = {"stage": stage, "label": label[:160], "at": elapsed, **detail}
            session["events"].append(event)
            session["stage"] = stage
            if stage == "found":
                session["expected_pages"] = int(detail.get("count") or 1)
            if stage == "reading":
                read = sum(1 for e in session["events"] if e["stage"] == "reading")
                expected = session.get("expected_pages") or 0
                progress = 10 if not expected else 20 + int(38 * min(1.0, (read - 1) / max(1, expected - 1)))
            elif stage == "drafting" and detail.get("repair"):
                progress = 85
            else:
                progress = PROGRESS.get(stage, session["progress"])
            session["progress"] = max(session["progress"], progress)

    def _check(self, identifier: str):
        stop = self.stops.get(identifier)
        if stop is None or stop.is_set():
            raise Cancelled()

    def _finish(self, session: dict, status: str, *, error: str | None = None, kind: str | None = None,
                draft: dict | None = None):
        session["status"] = status
        session["error"], session["error_kind"] = error, kind
        session["draft"] = draft
        session["timings"]["total_seconds"] = round(time.monotonic() - session["started"], 2)
        if status == "done":
            session["stage"], session["progress"] = "done", 100
            session["events"].append({"stage": "done", "label": "Your draft is ready",
                                      "at": session["timings"]["total_seconds"]})
        elif status == "failed":
            session["events"].append({"stage": "failed", "label": error or "Failed",
                                      "at": session["timings"]["total_seconds"]})
            session["stage"] = "failed"

    def _fail(self, identifier: str, message: str, kind: str):
        with self.lock:
            session = self.sessions.get(identifier)
            if session and session["status"] == "running":
                self._finish(session, "failed", error=message, kind=kind)

    def _read(self, identifier: str):
        with self.lock:
            url = self.sessions[identifier]["url"]
        emit = lambda stage, label, **detail: self._emit(identifier, stage, label, **detail)
        try:
            site = read_site(url, self.reader_factory(lambda: self._check(identifier)), emit=emit)
        except Cancelled:
            return
        except FetchError as exc:
            return self._fail(identifier, str(exc), "fetch")
        except Exception:  # noqa: BLE001 - never leak parser/network internals
            return self._fail(identifier, "Something went wrong while reading that site. Type it instead.", "fetch")
        with self.lock:
            session = self.sessions.get(identifier)
            if not session or session["status"] != "running":
                return
            session["timings"]["fetch_seconds"] = round(time.monotonic() - session["started"], 2)
        try:
            job = self.jobs().submit("brand_research", lambda job_id: self._draft(identifier, site, job_id),
                                     research_id=identifier)
        except WorkError as exc:
            return self._fail(identifier, str(exc), "model")
        with self.lock:
            if identifier in self.sessions:
                self.sessions[identifier]["job_id"] = job["id"]

    def _draft(self, identifier: str, site, job_id: str) -> dict:
        """Runs on the heavy worker. The durable job result carries ids/status only."""
        self._check_job(identifier)
        started = time.monotonic()
        emit = lambda stage, label, **detail: self._emit(identifier, stage, label, **detail)
        try:
            model = self.model_factory(job_id)
            draft = draft_brief(site, admit=model.admit, generate=self._cancellable(identifier, model.generate),
                                emit=emit)
        except Cancelled:
            raise JobCancelled() from None
        except ModelHeld as exc:
            self._fail(identifier, f"{exc} Your website was read; try again in a moment or type it instead.", "held")
            raise WorkError("Brand research held: insufficient memory for the local model.") from None
        except Abstain as exc:
            self._fail(identifier, f"{exc} Type it instead, or try again.", "abstain")
            raise WorkError("Brand research abstained: no valid evidence-backed draft.") from None
        except JobCancelled:
            self._fail(identifier, "Stopped. Nothing was saved.", "cancelled")
            raise
        except WorkError as exc:
            self._fail(identifier, f"The local model couldn't finish: {str(exc)[:300]}", "model")
            raise
        except Exception:  # noqa: BLE001
            self._fail(identifier, "The local model couldn't finish. Type it instead.", "model")
            raise WorkError("Brand research failed in the model step.") from None
        with self.lock:
            session = self.sessions.get(identifier)
            if not session or session["status"] != "running":
                raise JobCancelled()
            session["timings"]["model_seconds"] = round(time.monotonic() - started, 2)
            self._finish(session, "done", draft=draft)
        return {"research_id": identifier, "status": "done"}

    def _check_job(self, identifier: str):
        try:
            self._check(identifier)
        except Cancelled:
            raise JobCancelled() from None

    def _cancellable(self, identifier: str, generate):
        def run(prompt):
            self._check(identifier)
            return generate(prompt)
        return run


def install(app, service: BrandResearchService):
    @app.post("/api/brand-research", status_code=202)
    def start(body: StartBody):
        return service.start(body.url)

    @app.get("/api/brand-research/{identifier}")
    def status(identifier: str):
        return service.view(identifier)

    @app.post("/api/brand-research/{identifier}/cancel")
    def cancel(identifier: str):
        return service.cancel(identifier)
