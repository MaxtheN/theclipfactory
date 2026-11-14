"""Actual review API records preference without treating an undo as a rejection."""
import hashlib

from fastapi.testclient import TestClient

from clip_factory.app import create_app
from clip_factory.campaigns import Direction


def test_successful_review_captures_one_exact_revision_and_undo_is_not_rejection(tmp_path):
    app = create_app(tmp_path, token="review-test")
    store = app.state.store
    store.put("profiles", {"id": "p", "active_strategy_id": "v1"})
    store.put("campaigns", {"id": "c", "profile_ids": ["p"], "video_ids": ["v"], "brief": {}})
    store.put("strategy_versions", {"id": "v1", "version": 1, "status": "approved", "scope": "workspace",
                                    "profile_id": "p", "directions": {"p": Direction().model_dump()}})
    path = tmp_path / "clips" / "c.mp4"
    path.write_bytes(b"exact file, review fixture only")
    checksum = hashlib.sha256(path.read_bytes()).hexdigest()
    store.put("clips", {"id": "clip", "profile_id": "p", "campaign_id": "c", "video_id": "v",
                        "path": "clips/c.mp4", "sha256": checksum, "approved": False,
                        "rank": {"score": 70, "signals": {"hook": 1.0}}})
    with TestClient(app, base_url="http://127.0.0.1", headers={"X-Clip-Token": "review-test"}) as client:
        assert client.put("/api/clips/clip", json={"approved": True}).status_code == 200
        assert client.put("/api/clips/clip", json={"approved": True}).status_code == 200
        labels = store.all("taste_labels")
        assert len(labels) == 1
        assert labels[0]["decision"] == "approve" and labels[0]["sha256"] == checksum
        assert client.put("/api/clips/clip", json={"approved": False}).status_code == 200
        assert len(store.all("taste_labels")) == 1
        assert client.put("/api/clips/clip", json={"caption": "Changed copy", "approved": True}).status_code == 200
        assert not store.get("clips", "clip")["approved"]
        assert len(store.all("taste_labels")) == 1
        assert not store.all("learning_publications")
        assert client.get("/api/demo-loop/rubric", headers={"X-Clip-Token": "wrong"}).status_code == 401


def test_legacy_unscoped_approval_does_not_invent_brand_preferences(tmp_path):
    app = create_app(tmp_path, token="review-test")
    app.state.store.put("clips", {"id": "legacy", "approved": False})
    with TestClient(app, base_url="http://127.0.0.1", headers={"X-Clip-Token": "review-test"}) as client:
        assert client.put("/api/clips/legacy", json={"approved": True}).status_code == 200
    assert not app.state.store.all("taste_labels")
