"""Authenticated local endpoints for the Factory builder ("the factory that improves itself").

Every side effect is behind an explicit POST from a button: writing a work order, filing an issue
(``confirm: true``), building (``confirm: true``), pushing + opening a draft PR (``confirm: true``)
and discarding. Nothing runs on a schedule; a scan only reads saved records.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel, ConfigDict, Field

from . import factory_builder as fb
from .capabilities import model_classifier
from .extensions import registry
from .jobs import WorkError

SCAN_INTERVAL = 30.0
Identifier = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Confirm(Body):
    confirm: bool = False


class Scan(Body):
    use_model: bool = False


class Text(Body):
    source: str = Field(default="change_request", pattern=r"^(change_request|feedback|critic_finding)$")
    id: str = Identifier
    text: str = Field(min_length=1, max_length=2000)


def builder_model(app, job_id: str | None):
    """OpenRouter (Sonnet-class, the creator's key) when a key is saved; else the local model."""
    gateway = getattr(app.state, "llm", None)
    if gateway is not None:
        try:
            present = gateway.key_status().get("present")
        except Exception:  # noqa: BLE001 - an unreadable keychain means "no key"
            present = False
        if present:
            from . import llm_provider

            slug = fb.discover_sonnet()
            if slug not in llm_provider.MODELS:  # the gateway prices and routes only known slugs
                slug = llm_provider.SONNET
            return fb.GatewayBuilderModel(gateway, slug, job_id)
    models = getattr(app.state, "models", None)
    if models is None:
        return None
    from .ollama import is_ollama

    installed = [m["id"] for m in models.catalog() if m["kind"] == "llm" and m["installed"] and is_ollama(m["id"])]
    if not installed:
        return None
    identifier = installed[0]
    runtime = getattr(app.state, "autonomy_runtime", None)

    def admit() -> list[str]:
        check = getattr(runtime, "resource_check", None)
        if check is None:
            return []
        try:
            check(identifier, 16384)
        except WorkError as exc:
            return [str(exc)[:300]]
        return []

    def run(prompt: str) -> str:
        output = models.run(job_id, identifier, "generate", prompt=prompt, max_tokens=6000, context_tokens=16384)
        return output.get("output") if isinstance(output, dict) else ""

    return fb.LocalBuilderModel(run, identifier, admit)


def install(app: FastAPI, builder: fb.FactoryBuilder):
    def guard(call):
        try:
            return call()
        except KeyError:
            raise HTTPException(404, "Not found.") from None
        except fb.BuilderError as exc:
            raise HTTPException(409, str(exc)) from None
        except ValueError as exc:
            raise HTTPException(422, str(exc)[:400]) from None

    last_scan = [0.0]

    @app.get("/api/factory-builder")
    def view():
        # Detection is automatic but cheap: a deterministic keyword scan of saved records, at most every 30 s.
        if time.monotonic() - last_scan[0] > SCAN_INTERVAL:
            last_scan[0] = time.monotonic()
            builder.requests.scan()
        return builder.view()

    @app.get("/api/extensions")
    def extensions():
        return registry().public()

    @app.post("/api/factory-builder/scan")
    def scan(body: Scan):
        classify = None
        if body.use_model:
            gateway = getattr(app.state, "llm", None)
            if gateway is None or not gateway.key_status().get("present"):
                raise HTTPException(409, "Model classification needs an OpenRouter key; keyword detection still ran.")
            from . import llm_provider

            def complete(system, user, schema):
                result = gateway._cloud(fb.ROLE, llm_provider.HAIKU, system, user, schema, images=None,
                                        image_labels=None, max_tokens=400, timeout=60, temperature=0.0, job_id=None)
                try:
                    return json.loads(result.text)
                except ValueError:
                    return {}

            classify = model_classifier(complete)
        result = builder.requests.scan(classify=classify)
        return {**result, **builder.view()}

    @app.post("/api/factory-builder/demo", status_code=201)
    def demo():
        guard(builder.requests.demo)
        return builder.view()

    @app.post("/api/factory-builder/text")
    def text(body: Text):
        found = builder.requests.record_text(body.source, body.id, body.text)
        return {"requests": [r["id"] for r in found]}

    @app.post("/api/factory-builder/requests/{identifier}/work-order")
    def write_order(identifier: str):
        return guard(lambda: builder.write_work_order(identifier))

    @app.get("/api/factory-builder/requests/{identifier}/work-order.md")
    def order_markdown(identifier: str):
        request = builder.requests.get(identifier)
        if not request or not request.get("work_order"):
            raise HTTPException(404, "Write the work order first.")
        return PlainTextResponse(request["work_order"]["markdown"], media_type="text/markdown")

    @app.post("/api/factory-builder/requests/{identifier}/issue")
    def issue(identifier: str, body: Confirm):
        return guard(lambda: builder.file_issue(identifier, confirm=body.confirm))

    @app.post("/api/factory-builder/requests/{identifier}/build", status_code=202)
    def build(identifier: str, body: Confirm):
        if body.confirm is not True:
            raise HTTPException(409, "Building needs an explicit click (confirm: true).")

        def submit(work):
            return app.state.jobs.submit("factory_build", work, capability_request_id=identifier)

        return guard(lambda: builder.start(identifier, submit))

    @app.post("/api/factory-builder/requests/{identifier}/reject")
    def reject(identifier: str):
        return guard(lambda: builder.reject(identifier))

    @app.post("/api/factory-builder/requests/{identifier}/reopen")
    def reopen(identifier: str):
        return guard(lambda: builder.requests.transition(identifier, "detected"))

    @app.get("/api/factory-builder/builds/{identifier}")
    def build_detail(identifier: str):
        return guard(lambda: builder.build(identifier))

    @app.get("/api/factory-builder/builds/{identifier}/sample")
    def sample(identifier: str):
        record = guard(lambda: builder.build(identifier))
        path = Path(record.get("sample_path") or "")
        root = (builder.data_dir / "work" / "factory" / "samples").resolve()
        if not record.get("sample_path") or not path.is_file() or not path.resolve().is_relative_to(root):
            raise HTTPException(404, "No sample render for this build.")
        return FileResponse(path, media_type="video/mp4")

    @app.get("/api/factory-builder/builds/{identifier}/pr-plan")
    def pr_plan(identifier: str):
        return guard(lambda: builder.pr_plan(identifier))

    @app.post("/api/factory-builder/builds/{identifier}/push")
    def push(identifier: str, body: Confirm):
        return guard(lambda: builder.push_and_open_pr(identifier, confirm=body.confirm))

    @app.post("/api/factory-builder/builds/{identifier}/discard")
    def discard(identifier: str):
        return guard(lambda: builder.discard(identifier))


def create(app: FastAPI, store, root: Path) -> fb.FactoryBuilder:
    from .media import find_tool

    builder = fb.FactoryBuilder(store, root, model_factory=lambda job_id: builder_model(app, job_id),
                                ffmpeg=lambda: find_tool("ffmpeg"))
    app.state.factory_builder = builder
    install(app, builder)
    return builder
