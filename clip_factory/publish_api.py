"""Local endpoints for Approve & post: quality gate, posting, batches, attempts and reconcile."""

from __future__ import annotations

from fastapi import HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from . import post_package
from .composio import ComposioPublishingClient
from .post_schedule import PostScheduler
from .publish_storage import PublishStorage
from .publisher import Publisher, PublishError

_ID = r"^[A-Za-z0-9_-]{1,200}$"


class PostRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account_id: str = Field(pattern=_ID)
    caption: str = Field(min_length=1, max_length=2200)
    sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    override_reason: str | None = Field(default=None, max_length=500)
    share_to_feed: bool = True
    cover_time_ms: int | None = Field(default=None, ge=0, le=600_000)
    collaborators: list[str] = Field(default_factory=list, max_length=3)

    def package(self) -> dict:
        return {"share_to_feed": self.share_to_feed, "cover_time_ms": self.cover_time_ms,
                "collaborators": self.collaborators}


class ScheduleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account_ids: list[str] = Field(min_length=1, max_length=3)
    # One caption per account: the shared caption, or that account's own override.
    captions: dict[str, str] = Field(min_length=1, max_length=3)
    sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    publish_at: str = Field(min_length=10, max_length=64)
    timezone: str | None = Field(default=None, max_length=64)
    override_reason: str | None = Field(default=None, max_length=500)
    share_to_feed: bool = True
    cover_time_ms: int | None = Field(default=None, ge=0, le=600_000)
    collaborators: list[str] = Field(default_factory=list, max_length=3)


class ScheduleDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: str = Field(pattern=r"^(post_now|reschedule|cancel)$")
    publish_at: str | None = Field(default=None, max_length=64)


class BatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account_ids: list[str] = Field(min_length=1, max_length=3)
    clip_ids: list[str] = Field(min_length=1, max_length=10)
    captions: dict[str, str] = Field(default_factory=dict, max_length=10)
    override_reasons: dict[str, str] = Field(default_factory=dict, max_length=10)


def _http(error: PublishError) -> HTTPException:
    # Plain-text detail for the UI; only batch validation returns its per-item problems.
    if error.code == "batch_invalid":
        return HTTPException(error.status, {"message": error.message, "code": error.code, **error.details})
    return HTTPException(error.status, error.message)


def install(app, runtime, engine, campaigns, *, publisher: Publisher | None = None,
            scheduler: PostScheduler | None = None):
    store = app.state.store

    def client_factory():
        key = runtime.secrets.get()
        if not key:
            raise PublishError(409, "Configure Composio and connect an Instagram account first.", "no_composio")
        return ComposioPublishingClient(key)

    def storage_factory():
        accessor = getattr(app.state, "cloud_account", None)
        account = accessor() if accessor else None
        return PublishStorage(account) if account is not None else None

    publisher = publisher or Publisher(store, root=app.state.root, client_factory=client_factory,
                                       storage_factory=storage_factory, learning=engine, campaigns=campaigns)
    app.state.publisher = publisher
    scheduler = scheduler or PostScheduler(store, publisher)
    app.state.post_scheduler = scheduler
    # Runs while the app is open, only when a schedule is pending (started again on each new one).
    # Items that came due while the app was closed are flagged overdue and always wait for a click.
    if publisher.start_worker and scheduler.pending():
        scheduler.start()

    def call(action):
        try:
            return action()
        except PublishError as error:
            raise _http(error) from None

    @app.get("/api/clips/{identifier}/quality")
    def clip_quality(identifier: str, refresh: bool = False):
        clip = store.get("clips", identifier)
        if not clip:
            raise HTTPException(404, "Clip not found.")
        return call(lambda: publisher.quality_report(clip, refresh=refresh))

    @app.get("/api/clips/{identifier}/post-targets")
    def post_targets(identifier: str):
        clip = store.get("clips", identifier)
        if not clip:
            raise HTTPException(404, "Clip not found.")
        accounts = [
            {"id": a["id"], "display_name": a.get("display_name"), "verified_at": a.get("verified_at")}
            for a in store.all("connected_accounts")
            if a.get("status") == "active" and a.get("provider") == "composio"
            and a.get("profile_id") and a.get("profile_id") == clip.get("profile_id")
        ]
        accessor = getattr(app.state, "cloud_account", None)
        cloud = accessor() if accessor else None
        try:
            signed_in = bool(cloud and cloud.status().get("signed_in"))
        except Exception:  # noqa: BLE001 - status is advisory; posting re-checks the session
            signed_in = False
        return {"accounts": accounts, "cloud_configured": cloud is not None, "signed_in": signed_in,
                "attempts": publisher.list(clip_id=identifier),
                "schedules": scheduler.list(clip_id=identifier),
                "default_caption": clip.get("caption") or clip.get("hook") or ""}

    @app.post("/api/clips/{identifier}/post", status_code=202)
    def post_clip(identifier: str, body: PostRequest):
        return call(lambda: publisher.request_post(identifier, body.account_id, body.caption, body.sha256,
                                                   body.override_reason, body.package()))

    def require_clip(identifier):
        clip = store.get("clips", identifier)
        if not clip:
            raise HTTPException(404, "Clip not found.")
        return clip

    @app.get("/api/clips/{identifier}/post-package")
    def post_package_view(identifier: str):
        clip = require_clip(identifier)
        auto = post_package.auto_cover(clip)
        times = post_package.candidate_times(clip)
        frame = f"/api/clips/{identifier}/cover-frames"
        return {"limits": post_package.limits(), "auto_cover": {**auto, "url": f"/api/clips/{identifier}/cover"},
                "candidates": [{"time_ms": t, "url": f"{frame}/{t}", "auto": t == auto["time_ms"]} for t in times],
                "duration": post_package.duration_of(clip),
                "collaborators_note": "The connected Instagram tool has no collaborators option; "
                                      "mention people with @ in the caption instead."}

    @app.get("/api/clips/{identifier}/cover-frames/{time_ms}")
    def cover_frame(identifier: str, time_ms: int):
        clip = require_clip(identifier)
        try:
            path = publisher.covers.frame(clip, publisher.clip_path(clip), time_ms)
        except PublishError as error:
            raise _http(error) from None
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
        return FileResponse(path, media_type="image/jpeg")

    @app.post("/api/clips/{identifier}/schedule-post", status_code=201)
    def schedule_post(identifier: str, body: ScheduleRequest):
        package = {"share_to_feed": body.share_to_feed, "cover_time_ms": body.cover_time_ms,
                   "collaborators": body.collaborators}
        row = call(lambda: scheduler.schedule(identifier, body.account_ids, body.captions, body.sha256,
                                              body.publish_at, override_reason=body.override_reason,
                                              package=package, timezone=body.timezone))
        if publisher.start_worker:
            scheduler.start()
        return row

    @app.get("/api/post-schedules")
    def list_post_schedules(clip_id: str | None = None):
        return scheduler.list(clip_id=clip_id)

    @app.post("/api/post-schedules/{identifier}/decision")
    def decide_post_schedule(identifier: str, body: ScheduleDecision):
        return call(lambda: scheduler.decide(identifier, body.action, body.publish_at))

    @app.post("/api/campaigns/{identifier}/post-batch", status_code=202)
    def post_batch(identifier: str, body: BatchRequest):
        if not store.get("campaigns", identifier):
            raise HTTPException(404, "Campaign not found.")
        return call(lambda: publisher.request_batch(identifier, body.account_ids, body.clip_ids,
                                                    body.captions, body.override_reasons))

    @app.get("/api/publish-attempts")
    def list_attempts(clip_id: str | None = None, campaign_id: str | None = None):
        return publisher.list(clip_id=clip_id, campaign_id=campaign_id)

    @app.get("/api/publish-attempts/{identifier}")
    def read_attempt(identifier: str):
        return call(lambda: publisher.get(identifier))

    @app.post("/api/publish-attempts/{identifier}/reconcile")
    def reconcile_attempt(identifier: str):
        return call(lambda: publisher.reconcile(identifier))

    @app.post("/api/publish-attempts/{identifier}/resume", status_code=202)
    def resume_attempt(identifier: str):
        return call(lambda: publisher.resume(identifier))

    @app.get("/api/publish/accounts/{identifier}/readiness")
    def readiness(identifier: str):
        return call(lambda: publisher.readiness(identifier))

    return publisher
