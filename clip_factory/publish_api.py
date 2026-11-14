"""Local endpoints for Approve & post: quality gate, posting, batches, attempts and reconcile."""

from __future__ import annotations

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .composio import ComposioPublishingClient
from .publish_storage import PublishStorage
from .publisher import Publisher, PublishError

_ID = r"^[A-Za-z0-9_-]{1,200}$"


class PostRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account_id: str = Field(pattern=_ID)
    caption: str = Field(min_length=1, max_length=2200)
    sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    override_reason: str | None = Field(default=None, max_length=500)


class BatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account_ids: list[str] = Field(min_length=1, max_length=3)
    clip_ids: list[str] = Field(min_length=1, max_length=10)
    captions: dict[str, str] = Field(default_factory=dict, max_length=10)
    override_reasons: dict[str, str] = Field(default_factory=dict, max_length=10)


def _http(error: PublishError) -> HTTPException:
    detail = error.message if not error.details else {"message": error.message, "code": error.code,
                                                      **error.details}
    return HTTPException(error.status, detail)


def install(app, runtime, engine, campaigns, *, publisher: Publisher | None = None):
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
                "default_caption": clip.get("caption") or clip.get("hook") or ""}

    @app.post("/api/clips/{identifier}/post", status_code=202)
    def post_clip(identifier: str, body: PostRequest):
        return call(lambda: publisher.request_post(identifier, body.account_id, body.caption, body.sha256,
                                                   body.override_reason))

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
