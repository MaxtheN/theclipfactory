"""Authenticated local endpoints for the optional cloud account, installed on the existing app."""

from __future__ import annotations

import threading

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .cloud import CloudError

NOT_CONFIGURED = "Growth Factory cloud is not configured in this build. Continue offline."


class Credentials(BaseModel):
    # Plain strings: lengths are checked in cloud.py so validation errors never echo the password.
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    email: str = Field(repr=False)
    password: str = Field(repr=False)
    workspace_name: str | None = None


def install(app: FastAPI, account_factory):
    """account_factory() -> CloudAccount | None (None = not configured). Created once, lazily."""
    lock, cache = threading.Lock(), {}

    def account():
        with lock:
            if "account" not in cache:
                try:
                    cache["account"] = account_factory()
                except CloudError as error:
                    cache["error"] = error.message
                    cache["account"] = None
            return cache["account"]

    def require():
        current = account()
        if current is None:
            raise HTTPException(409, cache.get("error") or NOT_CONFIGURED)
        return current

    # Shared accessor so publishing hosts files with the same signed-in session (one refresh-token owner).
    app.state.cloud_account = account

    def call(action):
        try:
            return action()
        except CloudError as error:
            raise HTTPException(error.status if 400 <= error.status < 600 else 502, error.message) from None

    @app.get("/api/cloud/status")
    def cloud_status():
        current = account()
        if current is None:
            result = {"configured": False, "signed_in": False, "email": None, "workspace_id": None}
            if cache.get("error"):
                result["message"] = cache["error"]
            return result
        return call(current.status)

    @app.post("/api/cloud/sign-up")
    def cloud_sign_up(body: Credentials):
        current = require()
        return call(lambda: current.sign_up(body.email, body.password, body.workspace_name))

    @app.post("/api/cloud/sign-in")
    def cloud_sign_in(body: Credentials):
        current = require()
        return call(lambda: current.sign_in(body.email, body.password, body.workspace_name))

    @app.post("/api/cloud/sign-out")
    def cloud_sign_out():
        current = require()
        return call(current.sign_out)
