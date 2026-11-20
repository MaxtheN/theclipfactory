"""Local endpoints for Approve & post: quality gate, posting, batches, attempts, reconcile and accounts.

Posting goes through the Growth Factory posting server (Zernio); see clip_factory/posting_server.py.
"""

from __future__ import annotations

from typing import Literal

from fastapi import HTTPException, Path, Request
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, ConfigDict, Field

from . import post_package
from .post_schedule import PostScheduler
from .posting_accounts import PostingAccounts
from .posting_server import PLATFORMS, PostingServerClient, PostingServerError
from .publisher import Publisher, PublishError, _from_server

_ID = r"^[A-Za-z0-9_-]{1,200}$"
_ZERNIO = r"^[0-9a-f]{24}$"
CONNECTED_PATH = "/api/posting/connected/"


class TikTokSettings(BaseModel):
    """What the creator chose in the TikTok posting form; consent fields must be explicitly true."""
    model_config = ConfigDict(extra="forbid")
    privacy_level: str = Field(min_length=1, max_length=64)
    allow_comment: bool
    allow_duet: bool
    allow_stitch: bool
    content_preview_confirmed: bool
    express_consent_given: bool


class PackageFields(BaseModel):
    model_config = ConfigDict(extra="forbid")
    share_to_feed: bool = True
    cover_time_ms: int | None = Field(default=None, ge=0, le=600_000)
    collaborators: list[str] = Field(default_factory=list, max_length=3)
    youtube_title: str | None = Field(default=None, max_length=100)
    youtube_visibility: Literal["public", "unlisted", "private"] = "public"
    tiktok: TikTokSettings | None = None

    def package(self) -> dict:
        return {"share_to_feed": self.share_to_feed, "cover_time_ms": self.cover_time_ms,
                "collaborators": self.collaborators, "youtube_title": self.youtube_title,
                "youtube_visibility": self.youtube_visibility,
                "tiktok": self.tiktok.model_dump() if self.tiktok else None}


class PostRequest(PackageFields):
    account_id: str = Field(pattern=_ID)
    caption: str = Field(min_length=1, max_length=63206)
    sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    override_reason: str | None = Field(default=None, max_length=500)


class ScheduleRequest(PackageFields):
    account_ids: list[str] = Field(min_length=1, max_length=3)
    # One caption per account: the shared caption, or that account's own override.
    captions: dict[str, str] = Field(min_length=1, max_length=3)
    sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    publish_at: str = Field(min_length=10, max_length=64)
    timezone: str | None = Field(default=None, max_length=64)
    override_reason: str | None = Field(default=None, max_length=500)


class ConnectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    platform: Literal[PLATFORMS]  # type: ignore[valid-type]
    profile_id: str = Field(pattern=_ID)


class BindRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    profile_id: str = Field(pattern=_ID)


class PermissionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    publishing_permitted: bool


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
            scheduler: PostScheduler | None = None, accounts: PostingAccounts | None = None,
            server_factory=None, enabled=None):
    store = app.state.store

    def default_server():
        accessor = getattr(app.state, "cloud_account", None)
        account = accessor() if accessor else None
        return PostingServerClient(account) if account is not None else None

    server_factory = server_factory or default_server
    enabled = enabled or (lambda: True)
    publisher = publisher or Publisher(store, root=app.state.root, server_factory=server_factory,
                                       learning=engine, campaigns=campaigns, enabled=enabled)
    app.state.publisher = publisher
    scheduler = scheduler or PostScheduler(store, publisher)
    app.state.post_scheduler = scheduler
    accounts = accounts or PostingAccounts(store, server_factory=server_factory, engine=engine,
                                           open_url=lambda url: runtime.open_url(url))
    app.state.posting_accounts = accounts
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
        targets = [
            {"id": a["id"], "display_name": a.get("display_name"), "verified_at": a.get("verified_at"),
             "platform": a.get("platform"), "platform_label": a.get("platform_label"),
             "publishing_permitted": a.get("publishing_permitted") is True}
            for a in accounts.list()
            if a.get("status") == "active" and a.get("profile_id") and a.get("profile_id") == clip.get("profile_id")
        ]
        accessor = getattr(app.state, "cloud_account", None)
        cloud = accessor() if accessor else None
        try:
            signed_in = bool(cloud and cloud.status().get("signed_in"))
        except Exception:  # noqa: BLE001 - status is advisory; posting re-checks the session
            signed_in = False
        return {"accounts": targets, "cloud_configured": cloud is not None, "signed_in": signed_in,
                "publishing_enabled": bool(enabled()),
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
                "collaborators_note": "Instagram only: up to 3 public Business or Creator usernames. "
                                      "A rejected invite does not stop the post."}

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
        package = body.package()
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

    # ------------------------------------------------------------------ connected posting accounts
    @app.get("/api/posting/accounts")
    def posting_accounts(profile_id: str | None = None, refresh: bool = False):
        if refresh:
            call(accounts.sync)
        return accounts.list(profile_id)

    @app.post("/api/posting/accounts/sync")
    def sync_posting_accounts():
        return call(accounts.sync)

    @app.post("/api/posting/connect", status_code=201)
    def connect_account(body: ConnectRequest, request: Request):
        base = str(request.base_url).rstrip("/")
        return call(lambda: accounts.connect(body.platform, body.profile_id,
                                             lambda identifier: f"{base}{CONNECTED_PATH}{identifier}"))

    @app.get("/api/posting/connect/{request_id}")
    def connect_progress(request_id: str = Path(pattern=_ID)):
        return call(lambda: accounts.connect_status(request_id))

    @app.get(CONNECTED_PATH + "{request_id}", response_class=HTMLResponse)
    def connected(request_id: str = Path(pattern=_ID)):
        # Reached from the system browser without the local session (see app.local_session): it only
        # re-reads accounts for a pending request this app started, and returns static text.
        if not accounts.is_pending(request_id):
            return HTMLResponse(_page("This connection link has expired.", "Start again from Growth Factory."),
                                status_code=404)
        try:
            result = accounts.connect_status(request_id)
        except PublishError:
            result = {"status": "pending"}
        if result["status"] == "connected":
            return HTMLResponse(_page("Account connected.", "You can close this tab and return to Growth Factory."))
        return HTMLResponse(_page("Almost done.", "Return to Growth Factory to finish connecting the account."))

    @app.put("/api/posting/accounts/{identifier}/binding")
    def bind_account(body: BindRequest, identifier: str = Path(pattern=_ZERNIO)):
        return call(lambda: accounts.bind(identifier, body.profile_id))

    @app.put("/api/posting/accounts/{identifier}/permission")
    def account_permission(body: PermissionRequest, identifier: str = Path(pattern=_ZERNIO)):
        return call(lambda: accounts.set_permission(identifier, body.publishing_permitted))

    @app.delete("/api/posting/accounts/{identifier}")
    def disconnect_account(identifier: str = Path(pattern=_ZERNIO)):
        return call(lambda: accounts.disconnect(identifier))

    @app.get("/api/posting/accounts/{identifier}/tiktok-creator-info")
    def tiktok_creator_info(identifier: str = Path(pattern=_ZERNIO)):
        account = call(lambda: accounts.get(identifier))
        if account.get("platform") != "tiktok":
            raise HTTPException(400, "Creator info is only available for TikTok accounts.")
        server = accounts.server_factory()
        if server is None:
            raise HTTPException(409, "Growth Factory cloud is not configured.")
        try:
            return server.creator_info(account["zernio_account_id"])
        except PostingServerError as error:
            raise _http(_from_server(error)) from None

    return publisher


def _page(title: str, text: str) -> str:
    return ("<!doctype html><meta charset=utf-8><title>Growth Factory</title>"
            "<body style=\"font-family:system-ui;max-width:32rem;margin:15vh auto;text-align:center\">"
            f"<h1>{title}</h1><p>{text}</p></body>")
