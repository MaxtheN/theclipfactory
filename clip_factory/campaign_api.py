"""Authenticated local campaign endpoints installed on the existing application."""

from fastapi import FastAPI

from .campaigns import (
    AgentProduction,
    Campaign,
    Campaigns,
    Decision,
    Learning,
    Observation,
    Production,
    Profile,
    Proposal,
    Restore,
)


def install(app: FastAPI, campaigns: Campaigns, *, render, produce):
    @app.get("/api/profiles")
    def profiles():
        return [campaigns.profile(p["id"]) for p in campaigns.store.all("profiles")]

    @app.get("/api/profiles/{identifier}")
    def profile(identifier: str):
        return campaigns.profile(identifier)

    @app.post("/api/profiles", status_code=201)
    def create_profile(body: Profile):
        return campaigns.save_profile(body)

    @app.put("/api/profiles/{identifier}")
    def update_profile(identifier: str, body: Profile):
        return campaigns.save_profile(body, identifier)

    @app.get("/api/campaigns")
    def all_campaigns():
        return campaigns.store.all("campaigns")

    @app.get("/api/campaigns/{identifier}")
    def campaign(identifier: str):
        return campaigns.require("campaigns", identifier)

    @app.post("/api/campaigns", status_code=201)
    def create_campaign(body: Campaign):
        return campaigns.save_campaign(body)

    @app.put("/api/campaigns/{identifier}")
    def update_campaign(identifier: str, body: Campaign):
        return campaigns.save_campaign(body, identifier)

    @app.get("/api/campaigns/{identifier}/strategies")
    def strategies(identifier: str):
        return campaigns.versions(identifier)

    @app.post("/api/campaigns/{identifier}/strategies", status_code=201)
    def propose(identifier: str, body: Proposal):
        return campaigns.propose(identifier, body)

    @app.post("/api/campaigns/{identifier}/strategies/{version_id}/approve")
    def approve(identifier: str, version_id: str):
        return campaigns.decision(identifier, version_id, approve=True)

    @app.post("/api/campaigns/{identifier}/strategies/{version_id}/reject")
    def reject(identifier: str, version_id: str, body: Decision):
        return campaigns.decision(identifier, version_id, approve=False, reason=body.reason)

    @app.post("/api/campaigns/{identifier}/strategies/{version_id}/restore", status_code=201)
    def restore(identifier: str, version_id: str, body: Restore):
        return campaigns.restore(identifier, version_id, body)

    @app.get("/api/campaigns/{identifier}/observations")
    def observations(identifier: str):
        return campaigns.observations(identifier)

    @app.post("/api/campaigns/{identifier}/observations", status_code=201)
    def observe(identifier: str, body: Observation):
        return campaigns.observe(identifier, body)

    @app.post("/api/campaigns/{identifier}/learning", status_code=201)
    def learn(identifier: str, body: Learning):
        return campaigns.learn(identifier, body)

    @app.post("/api/campaigns/{identifier}/render", status_code=202)
    def render_campaign(identifier: str, body: Production):
        return render(identifier, body)

    @app.post("/api/campaigns/{identifier}/produce", status_code=202)
    def produce_campaign(identifier: str, body: AgentProduction):
        return produce(identifier, body)
