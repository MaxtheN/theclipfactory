"""Local authenticated controls for explicit account bindings and durable learning."""

from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .autonomy_runtime import ConnectionSettings
from .learning import Policy, Publication, memory_digest


class ConnectProfile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    profile_id: str = Field(min_length=1, max_length=128)


class TrackPublication(BaseModel):
    model_config = ConfigDict(extra="forbid")
    policy_id: str = Field(min_length=1, max_length=128)
    clip_id: str = Field(min_length=1, max_length=128)
    account_id: str = Field(min_length=1, max_length=128)
    media_id: str = Field(pattern=r"^\d{1,100}$")
    sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    confirmed_clip_mapping: Literal[True]


class ImportAccount(ConnectProfile):
    connected_account_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,200}$")
    user_id: str | None = Field(default=None, min_length=1, max_length=200)


def install(app, runtime, engine):
    @app.get("/api/automation/settings")
    def settings():
        return runtime.settings()

    @app.put("/api/automation/settings")
    def configure(body: ConnectionSettings):
        return runtime.configure(body)

    @app.get("/api/automation/accounts")
    def accounts():
        return runtime.store.all("connected_accounts")

    @app.get("/api/automation/accounts/{identifier}/posts")
    def recent_posts(identifier: str, profile_id: str):
        account = runtime.store.get("connected_accounts", identifier)
        if not account:
            raise HTTPException(404, "Connected account not found.")
        if (account.get("profile_id") != profile_id or account.get("status") != "active"
            or account.get("provider") != "composio" or account.get("toolkit") != "instagram"
            or not isinstance(account.get("user_id"), str) or not account["user_id"].strip()
            or not isinstance(account.get("instagram_user_id"), str) or not account["instagram_user_id"].isdigit()):
            raise HTTPException(422, "Choose the active account verified for this workspace.")
        return runtime.client().list_media(account["id"], account["user_id"],
            instagram_user_id=account["instagram_user_id"], limit=6)

    @app.post("/api/automation/connections", status_code=201)
    def begin_connection(body: ConnectProfile):
        return runtime.connection_start(body.profile_id)

    @app.post("/api/automation/connections/{identifier}/verify")
    def finish_connection(identifier: str):
        return runtime.connection_finish(identifier)

    @app.post("/api/automation/accounts/import", status_code=201)
    def import_account(body: ImportAccount):
        return runtime.bind_account(body.connected_account_id, body.user_id, body.profile_id)

    @app.delete("/api/automation/accounts/{identifier}")
    def disconnect(identifier: str):
        record = runtime.store.get("connected_accounts", identifier)
        if not record:
            raise HTTPException(404, "Connected account not found.")
        # Retain evidence/history while immediately stopping this local binding's work.
        updates = [("connected_accounts", {**record, "status": "disconnected"})]
        for policy in engine.list_policies():
            if policy["account_id"] == identifier:
                updates.append(("learning_policies", {**policy, "enabled": False}))
        runtime.store.put_many(updates)
        return {"id": identifier, "status": "disconnected", "provider_access_revoked": False}

    @app.get("/api/automation/policies")
    def policies():
        return engine.list_policies()

    @app.post("/api/automation/policies", status_code=201)
    def configure_policy(body: Policy):
        return engine.configure_policy(body)

    @app.put("/api/automation/policies/{identifier}")
    def update_policy(identifier: str, body: Policy):
        return engine.configure_policy(body, identifier)

    @app.post("/api/automation/publications", status_code=201)
    def register_publication(body: TrackPublication):
        policy = engine.read_policy(body.policy_id)
        account = runtime.store.get("connected_accounts", body.account_id)
        if (not account or account.get("status") != "active" or not account.get("instagram_user_id")
            or policy["account_id"] != body.account_id or policy["profile_id"] != account.get("profile_id")):
            raise HTTPException(422, "Select the exact verified account bound to this policy.")
        identity = runtime.client().media_identity(account["id"], account["user_id"], body.media_id,
            instagram_user_id=account["instagram_user_id"])
        row = engine.register_publication(Publication(**body.model_dump(exclude={"confirmed_clip_mapping"}),
            published_at=identity["published_at"]))
        runtime.store.patch("learning_publications", row["id"],
            mapping_source="User confirms exact clip; provider verifies account, media identity and timestamp.")
        return runtime.store.get("learning_publications", row["id"])

    @app.get("/api/automation/state")
    def state():
        return {"policies": engine.list_policies(), "publications": engine.list_publications(),
            "snapshots": engine.list_snapshots(), "work": engine.list_work(),
            "experiments": engine.list_experiments(),
            "health": runtime.store.get("automation_health", "local"),
            "publishing_policy": "human_approval", "paid_spending_enabled": False}

    @app.post("/api/automation/publications/{identifier}/measure-now", status_code=202)
    def measure_now(identifier: str):
        # Demo control: only an explicit creator request moves ONE post's due time.
        # Provider metrics stay real; the receipt records the override and real age.
        publication = runtime.store.get("learning_publications", identifier)
        if not publication or not publication.get("mapping_source"):
            raise HTTPException(404, "Track this post with a confirmed clip mapping before measuring it.")
        result = engine.measure_now(identifier)
        worker = getattr(runtime, "thread", None)
        if worker and worker.is_alive():
            runtime.wake.set()
        return result

    @app.get("/api/automation/memory")
    def memory(profile_id: str, account_id: str | None = None, campaign_id: str | None = None):
        if not runtime.store.get("profiles", profile_id):
            raise HTTPException(404, "Profile not found.")
        return memory_digest(runtime.store, profile_id, account_id, campaign_id=campaign_id, limit=6, max_chars=6000)

    @app.post("/api/automation/check", status_code=202)
    def check_due():
        # Queue onto a separate coordinator: analysis itself uses the shared heavy worker.
        # Returning immediately keeps long local inference out of the HTTP request.
        worker = getattr(runtime, "thread", None)
        if not worker or not worker.is_alive():
            raise HTTPException(503, "Learning worker is not running. Reopen the app.")
        runtime.wake.set()
        return {"status": "requested", "message": "Checking due work; no future window is advanced."}
