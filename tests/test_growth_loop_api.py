from fastapi import FastAPI
from fastapi.testclient import TestClient

from clip_factory.growth_loop_api import install


def test_new_routes_validate_scope_and_do_not_publish(tmp_path):
    from clip_factory.campaigns import Campaigns
    from clip_factory.store import Store

    store = Store(tmp_path)
    store.put("profiles", {"id": "p", "active_strategy_id": None})
    app = FastAPI()
    app.state.store, app.state.root = store, tmp_path
    calls = []
    install(app, Campaigns(store), render=lambda *args, **kwargs: calls.append((args, kwargs)))
    with TestClient(app) as client:
        assert client.get("/api/growth/profiles/p").json()["policy"]["auto_ab"] is False
        assert client.get("/api/growth/profiles/missing").status_code == 404
        assert client.put("/api/growth/profiles/p/policy", json={"auto_ab": True}).json()["auto_ab"] is True
        assert client.put("/api/growth/profiles/p/policy", json={"auto_ab": "true"}).status_code == 422
        assert client.post("/api/growth/profiles/p/ab", json={"request_id": "x", "clip_ids": [],
                            "expected_strategy_version_id": "v"}).status_code == 422
        assert client.post("/api/growth/profiles/p/reviews", json={"clip_id": "c", "decision": "approve",
                            "request_id": "x", "expected_sha256": "not-a-hash"}).status_code == 422
        assert client.post("/api/growth/profiles/p/publish").status_code == 404
    assert not calls and not store.all("learning_publications")
