"""Offline Strategist API: authenticated, proposal-only, admission-held model path, honest simulation."""
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from clip_factory.app import create_app
from clip_factory.jobs import WorkError
from clip_factory.strategist_api import LocalModel

DIRECTION = {"angles": [], "moment_selection": "Complete thoughts.", "hooks": [], "pacing": "Source pacing.",
             "duration_seconds": 30, "framing": "fit", "caption_style": "standard", "editing_preferences": "",
             "measurement_questions": [], "next_experiments": [], "evidence_refs": [], "limitations": "Untested.",
             "confidence": "low"}


class HeldModel:
    def __init__(self):
        self.prompts = []

    def admit(self):
        return ["Learning is paused: about 6.0 GiB available memory is required; 2.0 GiB is available."]

    def generate(self, prompt):
        self.prompts.append(prompt)
        raise AssertionError("A held model must never be asked to infer.")


@pytest.fixture
def client(tmp_path):
    app = create_app(tmp_path, token="local-test")
    app.state.autonomy_runtime.resource_check = lambda *_: None
    model = HeldModel()
    app.state.strategist.model_factory = lambda job_id: model
    store = app.state.store
    store.put("profiles", {"id": "p", "name": "Profile", "primary_metric": "views"})
    store.put("strategy_versions", {"id": "v1", "campaign_id": "c", "version": 1, "status": "approved",
                                    "directions": {"p": DIRECTION}, "base_version_id": None})
    store.put("campaigns", {"id": "c", "name": "C", "profile_ids": ["p"], "video_ids": [], "brief": {},
                            "active_strategy_id": "v1", "archived_at": None})
    store.put("learning_policies", {"id": "pol", "profile_id": "p", "campaign_id": "c", "account_id": "a", "enabled": False})
    for n, (hook, views) in enumerate([("Would you?", 300), ("Plain claim", 100), ("Would you?", 320), ("Plain", 90)], 1):
        store.put("clips", {"id": f"clip{n}", "hook": hook, "hypothesis": "story",
                            "edit_plan": {"start": 0, "end": 30, "hook": hook, "caption_style": "standard", "framing": "fit"}})
        store.put("learning_publications", {"id": f"pub{n}", "policy_id": "pol", "clip_id": f"clip{n}",
                                            "published_at": f"2026-11-0{n}T19:00:00+00:00"})
        store.put("learning_snapshots", {"id": f"snap{n}", "policy_id": "pol", "publication_id": f"pub{n}",
                                         "metrics": {"views": views}, "collected_at": f"2026-11-0{n + 1}T19:00:00+00:00"})
    with TestClient(app, base_url="http://127.0.0.1", headers={"X-Clip-Token": "local-test"}) as session:
        yield session, model


def wait(session, run_id):
    for _ in range(100):
        runs = session.get("/api/strategist/p").json()["runs"]
        current = next(r for r in runs if r["id"] == run_id)
        if current["status"] in {"completed", "failed"}:
            return current
        time.sleep(0.05)
    raise AssertionError("Strategist run did not finish.")


def test_endpoints_are_authenticated(client):
    session, _ = client
    bad = {"X-Clip-Token": "wrong"}
    assert session.get("/api/strategist/p", headers=bad).status_code == 401
    for path in ("/api/strategist/p/run", "/api/strategist/p/simulate", "/api/strategist/beliefs/x/retire",
                 "/api/strategist/campaign-proposals/x/decision"):
        assert session.post(path, json={}, headers=bad).status_code == 401
    assert session.post("/api/strategist/p/publish").status_code in {404, 405}


def test_manual_run_is_held_but_deterministic_layers_complete(client):
    session, model = client
    queued = session.post("/api/strategist/p/run", json={})
    assert queued.status_code == 202 and queued.json()["simulated"] is False
    done = wait(session, queued.json()["id"])
    assert done["status"] == "completed" and done["model"]["status"] == "held"
    assert done["model"]["label"] == "model held: insufficient memory" and model.prompts == []
    view = session.get("/api/strategist/p").json()
    assert view["simulated"] is False and view["baseline"]["metrics"]["views"] == 200
    assert view["beliefs"] and set(view["lanes"]) == {"craft", "selection", "campaign"}
    store = session.app.state.store
    assert store.get("campaigns", "c")["active_strategy_id"] == "v1"
    assert all(v["status"] != "approved" for v in store.all("strategy_versions") if v.get("source") == "strategist")
    belief = view["beliefs"][0]["id"]
    assert session.post(f"/api/strategist/beliefs/{belief}/retire", json={"reason": "no"}).json()["status"] == "retired"
    assert session.post("/api/strategist/beliefs/missing/retire", json={}).status_code == 404
    assert session.post("/api/strategist/p/run", json={"layer": "invented"}).status_code == 422


def test_archived_and_missing_profiles_are_rejected(client):
    session, _ = client
    store = session.app.state.store
    assert session.get("/api/strategist/missing").status_code == 404
    store.patch("campaigns", "c", archived_at="2026-11-10T00:00:00+00:00")
    assert session.post("/api/strategist/p/run", json={}).status_code == 409
    store.patch("campaigns", "c", archived_at=None)
    store.patch("profiles", "p", archived_at="2026-11-10T00:00:00+00:00")
    assert session.post("/api/strategist/p/run", json={}).status_code == 409
    assert session.post("/api/strategist/p/simulate", json={}).status_code == 409


def test_simulation_is_labelled_and_never_written(client):
    session, _ = client
    store = session.app.state.store
    before = {kind: len(store.all(kind)) for kind in ("beliefs", "strategist_runs", "strategy_versions", "clips")}
    reply = session.post("/api/strategist/p/simulate", json={"seed": 4, "steps": 10})
    assert reply.status_code == 200
    body = reply.json()
    assert body["simulated"] is True and body["banner"].startswith("Simulation") and len(body["steps"]) == 10
    assert all(step["simulated"] for step in body["steps"])
    assert {kind: len(store.all(kind)) for kind in before} == before
    assert session.post("/api/strategist/p/simulate", json={"steps": 400}).status_code == 422


def test_local_model_adapter_holds_before_inference():
    store = SimpleNamespace(get=lambda kind, key: {"model_id": "ollama:qwen3-vl:4b-instruct"})

    def refuse(*_):
        raise WorkError("Learning is paused: about 6.0 GiB available memory is required.")

    runtime = SimpleNamespace(store=store, resource_check=refuse)
    assert "6.0 GiB" in LocalModel(SimpleNamespace(), runtime, "job").admit()[0]
    assert LocalModel(SimpleNamespace(), runtime, None).admit()  # never outside a queued job
    other = SimpleNamespace(store=SimpleNamespace(get=lambda *_: {"model_id": "ollama:llama3:8b"}), resource_check=lambda *_: None)
    assert "qualified" in LocalModel(SimpleNamespace(), other, "job").admit()[0]
    ready = SimpleNamespace(store=store, resource_check=lambda *_: None)
    assert LocalModel(SimpleNamespace(), ready, "job").admit() == []
