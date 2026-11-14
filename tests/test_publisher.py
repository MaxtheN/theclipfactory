"""Offline publisher state machine: no Composio, Supabase, Keychain or Instagram calls."""

import hashlib
import json
import threading
import time
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi import HTTPException

from clip_factory.composio import ComposioClient, ComposioError, ComposioPublishingClient
from clip_factory.publish_storage import PublishStorageError
from clip_factory.publisher import Publisher, PublishError
from clip_factory.store import Store

PUBLISH = "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH"
CREATE = "INSTAGRAM_POST_IG_USER_MEDIA"
NODES = "INSTAGRAM_GET_MULTIPLE_NODES"
QUOTA = "INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT"
MEDIA = "INSTAGRAM_GET_IG_MEDIA"
USER = "0f6c3b0e-6a5e-4a4e-9a55-2b6a7c1d9e10"


class FakeStorage:
    def __init__(self, store, *, fail=None, signed_in=True):
        self.store, self.fail, self.signed_in = store, fail, signed_in
        self.uploads, self.deleted, self.public = [], [], set()

    def user_id(self):
        if not self.signed_in:
            raise PublishStorageError("Sign in to Growth Factory cloud to post.", "sign_in_required", 409)
        return USER

    def object_path(self, user, sha):
        return f"{user}/{sha}.mp4"

    def public_url(self, name):
        return f"https://cloud.example/storage/v1/object/public/gf-publish/{name}"

    def upload(self, path, sha):
        assert any(r["sha256"] == sha and r["pending_effect"] == "upload" and r["state"] == "uploading"
                   for r in self.store.all("publish_attempts")), "durable record must precede the upload"
        if self.fail:
            raise self.fail
        self.uploads.append(sha)
        url = self.public_url(self.object_path(USER, sha))
        self.public.add(url)
        return {"url": url, "object": self.object_path(USER, sha), "bytes": path.stat().st_size, "reused": False}

    def verify_public(self, url, size):
        return url in self.public

    def delete(self, name):
        self.deleted.append(name)
        return True


class FakeClient:
    PINNED_VERSION = "20261112_00"

    def __init__(self, store, *, statuses=("IN_PROGRESS", "FINISHED"), errors=None, caption=None,
                 recent=None, quota=(0, 50)):
        self.store, self.statuses = store, list(statuses)
        self.errors = errors or {}
        self.caption, self.recent, self.quota = caption, recent or [], quota
        self.calls, self.running, self.max_running = [], 0, 0
        self.lock = threading.Lock()

    def _pending(self, effect):
        return any(r["pending_effect"] == effect for r in self.store.all("publish_attempts"))

    def account_identity(self, account_id, user_id, *, version):
        assert version == self.PINNED_VERSION
        return {"instagram_user_id": "1784"}

    def run(self, slug, arguments, *, connected_account_id, user_id):
        with self.lock:
            self.running += 1
            self.max_running = max(self.max_running, self.running)
        try:
            time.sleep(0.001)
            self.calls.append((slug, dict(arguments), connected_account_id, user_id))
            if self.errors.get(slug):
                raise self.errors[slug].pop(0)
            if slug == QUOTA:
                return {"data": [{"quota_usage": self.quota[0], "config": {"quota_total": self.quota[1]}}]}
            if slug == CREATE:
                assert self._pending("create_container"), "durable record must precede the write"
                return {"id": "900" + str(len(self.calls))}
            if slug == NODES:
                status = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
                return {arguments["object_ids"][0]: {"id": arguments["object_ids"][0], "status_code": status}}
            if slug == PUBLISH:
                assert self._pending("publish"), "durable record must precede the write"
                assert arguments["max_wait_seconds"] == 0
                return {"id": "1799" + arguments["creation_id"]}
            if slug == MEDIA:
                row = next(r for r in self.store.all("publish_attempts") if r["media_id"] == arguments["ig_media_id"])
                return {"id": arguments["ig_media_id"], "caption": self.caption or row["caption"],
                        "permalink": "https://www.instagram.com/reel/ABC123/?utm=x"}
            raise AssertionError(slug)
        finally:
            with self.lock:
                self.running -= 1

    def media_identity(self, account_id, user_id, media_id, *, version, instagram_user_id):
        self.calls.append(("media_identity", media_id, account_id, user_id))
        return {"published_at": (datetime.now(UTC) - timedelta(seconds=5)).isoformat(),
                "owner_id_namespace": "professional_user_id"}

    def list_media(self, account_id, user_id, *, instagram_user_id, limit, version):
        self.calls.append(("list_media", account_id))
        return {"items": self.recent}

    def slugs(self):
        return [c[0] for c in self.calls]


class FakeLearning:
    def __init__(self, store, policies=True):
        self.store, self.policies, self.registered = store, policies, []

    def list_policies(self, campaign_id=None, profile_id=None, account_id=None):
        if not self.policies:
            return []
        return [{"id": "policy-1", "campaign_id": campaign_id, "profile_id": profile_id,
                 "account_id": account_id, "enabled": True}]

    def register_publication(self, publication):
        data = publication.model_dump(mode="json")
        self.registered.append(data)
        row = {**data, "id": "pub-" + data["media_id"]}
        self.store.put("learning_publications", row)
        return row


class FakeCampaigns:
    def __init__(self, store):
        self.store = store

    def ensure_clip_campaign_active(self, clip):
        campaign = self.store.get("campaigns", clip.get("campaign_id") or "")
        if campaign and campaign.get("archived_at"):
            raise HTTPException(409, "This clip belongs to an archived campaign.")


def passing_gate(clip, path, expected_sha256=None):
    return {"clip_id": clip["id"], "verdict": "pass", "reasons": [], "rubric": {"technical": 5},
            "gate_version": 1, "evaluated_at": "now", "critic": {"status": clip.get("team_review_status"),
                                                                    "overridden_at_approval": False}}


def holding_gate(clip, path, expected_sha256=None):
    return {**passing_gate(clip, path), "verdict": "hold", "reasons": ["Captions burned in: none"]}


@pytest.fixture
def world(tmp_path):
    store = Store(tmp_path)
    (tmp_path / "clips").mkdir()

    def add_clip(identifier="clip-1", **extra):
        path = tmp_path / "clips" / f"{identifier}.mp4"
        path.write_bytes(b"approved bytes " + identifier.encode())
        sha = hashlib.sha256(path.read_bytes()).hexdigest()
        store.put("clips", {"id": identifier, "path": f"clips/{identifier}.mp4", "sha256": sha, "approved": True,
                            "approved_at": "2026-11-14T00:00:00+00:00", "campaign_id": "camp-1",
                            "profile_id": "prof-1", "hook": "A hook", "caption": "Watch this",
                            "revision_number": 2, **extra})
        return store.get("clips", identifier)

    def add_account(identifier="acct-1", **extra):
        store.put("connected_accounts", {"id": identifier, "profile_id": "prof-1", "user_id": "gf-user",
                                         "provider": "composio", "toolkit": "instagram", "status": "active",
                                         "instagram_user_id": "1784", "verified_at": "2026-11-14T00:00:00+00:00",
                                         "display_name": identifier, **extra})

    state = {"client": FakeClient(store), "storage": FakeStorage(store), "learning": FakeLearning(store)}

    def make(gate=passing_gate, start_worker=False, **options):
        return Publisher(store, root=tmp_path, client_factory=lambda: state["client"],
                         storage_factory=lambda: state["storage"], learning=state["learning"],
                         campaigns=FakeCampaigns(store), gate=gate, sleep=lambda _: None,
                         start_worker=start_worker, poll_interval=0, max_polls=5, item_gap=0, **options)

    return {"store": store, "add_clip": add_clip, "add_account": add_account, "make": make, "state": state}


def post(world, publisher=None, clip_id="clip-1", account="acct-1", **kw):
    publisher = publisher or world["make"]()
    clip = world["store"].get("clips", clip_id)
    attempt = publisher.request_post(clip_id, account, kw.pop("caption", "Watch this #reel"),
                                     kw.pop("sha256", clip["sha256"]), **kw)
    return publisher, attempt


def test_happy_path_writes_durable_records_before_each_effect_and_maps(world):
    clip = world["add_clip"]()
    world["add_account"]()
    publisher, attempt = post(world)
    assert attempt["state"] == "created" and attempt["active"] is True
    publisher.run(attempt["id"])
    row = publisher.get(attempt["id"])
    assert row["state"] == "mapped" and row["active"] is False and row["pending_effect"] is None
    assert row["permalink"] == "https://www.instagram.com/reel/ABC123/"
    states = [h["state"] for h in row["history"]]
    for expected in ("uploading", "uploaded", "container_created", "container_ready", "published", "mapped"):
        assert expected in states
    assert [h["pending_effect"] for h in row["history"]].count("publish") == 1
    client = world["state"]["client"]
    assert client.slugs().count(PUBLISH) == 1 and client.slugs().count(CREATE) == 1
    create = next(c for c in client.calls if c[0] == CREATE)
    assert create[1]["video_url"] == row["video_url"] and create[1]["media_type"] == "REELS"
    assert create[2:] == ("acct-1", "gf-user")  # exact connected account + user on every call
    registered = world["state"]["learning"].registered[0]
    assert registered["sha256"] == clip["sha256"] and registered["media_id"] == row["media_id"]
    publication = world["store"].get("learning_publications", "pub-" + row["media_id"])
    assert publication["mapping_source"] == "app_published"
    assert publication["publish_attempt_id"] == row["id"]
    assert world["state"]["storage"].deleted == [row["storage_object"]]


def test_crash_during_publish_is_unknown_and_never_retried_before_reconcile(world):
    world["add_clip"]()
    world["add_account"]()
    _, attempt = post(world)
    store = world["store"]
    # Simulate a process crash after the durable "publish" marker but before the response.
    store.put("publish_attempts", {**store.get("publish_attempts", attempt["id"]), "state": "container_ready",
                                   "pending_effect": "publish", "container_id": "555", "video_url": "https://x/y.mp4",
                                   "external_started_at": datetime.now(UTC).isoformat()})
    restarted = world["make"]()
    row = restarted.get(attempt["id"])
    assert row["state"] == "unknown" and row["previous_state"] == "container_ready" and not row["active"]
    with pytest.raises(PublishError) as error:
        restarted.resume(attempt["id"])
    assert error.value.code == "needs_reconcile"
    client = world["state"]["client"]
    client.statuses = ["FINISHED"]
    row = restarted.reconcile(attempt["id"])
    assert row["state"] == "container_ready" and row["pending_effect"] is None
    assert PUBLISH not in client.slugs()  # reconcile only reads
    restarted.resume(attempt["id"])
    restarted.run(attempt["id"])
    assert restarted.get(attempt["id"])["state"] == "mapped"
    assert client.slugs().count(PUBLISH) == 1


def test_reconcile_adopts_post_that_was_published_before_crash(world):
    world["add_clip"]()
    world["add_account"]()
    publisher, attempt = post(world, caption="Exact caption")
    store = world["store"]
    started = datetime.now(UTC) - timedelta(minutes=1)
    store.put("publish_attempts", {**store.get("publish_attempts", attempt["id"]), "state": "unknown",
                                   "pending_effect": "publish", "active": False, "container_id": "555",
                                   "external_started_at": started.isoformat()})
    client = world["state"]["client"]
    client.statuses = ["PUBLISHED"]
    client.recent = [
        {"media_id": "111", "media_type": "VIDEO", "caption_excerpt": "Exact caption",
         "published_at": (started - timedelta(hours=3)).isoformat()},  # too old
        {"media_id": "222", "media_type": "VIDEO", "caption_excerpt": "Exact caption",
         "published_at": datetime.now(UTC).isoformat()},
    ]
    row = publisher.reconcile(attempt["id"])
    assert row["state"] == "published" and row["media_id"] == "222"
    publisher.resume(attempt["id"])
    publisher.run(attempt["id"])
    assert publisher.get(attempt["id"])["state"] == "mapped"
    assert PUBLISH not in client.slugs() and CREATE not in client.slugs()


def test_publish_timeout_becomes_unknown_without_blind_retry(world):
    world["add_clip"]()
    world["add_account"]()
    world["state"]["client"].errors = {PUBLISH: [ComposioError("timed out", code="timeout")]}
    publisher, attempt = post(world)
    publisher.run(attempt["id"])
    row = publisher.get(attempt["id"])
    assert row["state"] == "unknown" and row["pending_effect"] == "publish"
    assert world["state"]["client"].slugs().count(PUBLISH) == 1
    with pytest.raises(PublishError):
        publisher.resume(attempt["id"])
    with pytest.raises(PublishError) as error:
        post(world, publisher)  # a fresh post for the same clip/account is refused too
    assert error.value.code == "attempt_exists"


def test_unknown_container_creation_reconciles_back_to_uploaded(world):
    world["add_clip"]()
    world["add_account"]()
    world["state"]["client"].errors = {CREATE: [ComposioError("network", code="network")]}
    publisher, attempt = post(world)
    publisher.run(attempt["id"])
    assert publisher.get(attempt["id"])["state"] == "unknown"
    row = publisher.reconcile(attempt["id"])
    assert row["state"] == "uploaded" and "list_media" in world["state"]["client"].slugs()
    publisher.resume(attempt["id"])
    publisher.run(attempt["id"])
    assert publisher.get(attempt["id"])["state"] == "mapped"


def test_unknown_upload_reconciles_by_public_head(world):
    world["add_clip"]()
    world["add_account"]()
    world["state"]["storage"].fail = PublishStorageError("timed out", "timeout", 504)
    publisher, attempt = post(world)
    publisher.run(attempt["id"])
    assert publisher.get(attempt["id"])["state"] == "unknown"
    row = publisher.reconcile(attempt["id"])
    assert row["state"] == "created"  # nothing public: safe to upload again
    world["state"]["storage"].fail = None
    publisher.resume(attempt["id"])
    publisher.run(attempt["id"])
    assert publisher.get(attempt["id"])["state"] == "mapped"


def test_refused_container_and_processing_error_fail_definitely(world):
    world["add_clip"]()
    world["add_account"]()
    world["state"]["client"].errors = {CREATE: [ComposioError("no", code="tool_failed")]}
    publisher, attempt = post(world)
    publisher.run(attempt["id"])
    row = publisher.get(attempt["id"])
    assert row["state"] == "failed" and "instagram_business_content_publish" in row["error"]["message"]
    # A definite failure allows a new attempt; this one hits a processing ERROR.
    world["state"]["client"].statuses = ["ERROR"]
    _, second = post(world, publisher)
    publisher.run(second["id"])
    assert publisher.get(second["id"])["state"] == "failed"
    assert PUBLISH not in world["state"]["client"].slugs()


def test_quota_exhausted_stops_before_any_container(world):
    world["add_clip"]()
    world["add_account"]()
    world["state"]["client"].quota = (50, 50)
    publisher, attempt = post(world)
    publisher.run(attempt["id"])
    assert publisher.get(attempt["id"])["error"]["code"] == "quota"
    assert CREATE not in world["state"]["client"].slugs()


def test_caption_readback_mismatch_is_flagged(world):
    world["add_clip"]()
    world["add_account"]()
    world["state"]["client"].caption = "Watch this %23reel"
    publisher, attempt = post(world)
    publisher.run(attempt["id"])
    row = publisher.get(attempt["id"])
    assert row["state"] == "mapped" and "caption_readback_mismatch" in row["warnings"]


def test_no_learning_policy_leaves_published_awaiting_policy(world):
    world["add_clip"]()
    world["add_account"]()
    world["state"]["learning"].policies = False
    publisher, attempt = post(world)
    publisher.run(attempt["id"])
    row = publisher.get(attempt["id"])
    assert row["state"] == "published" and row["mapping"]["status"] == "awaiting_policy"
    world["state"]["learning"].policies = True
    publisher.resume(attempt["id"])
    publisher.run(attempt["id"])
    assert publisher.get(attempt["id"])["state"] == "mapped"
    assert world["state"]["client"].slugs().count(PUBLISH) == 1


@pytest.mark.parametrize("case", ["archived", "unapproved", "changed", "unbound", "unverified", "legacy",
                                  "unresolved_review"])
def test_rejections(world, case):
    extra = {"unapproved": {"approved": False}, "legacy": {"publish_attempt": {"id": "j"}},
             "unresolved_review": {"team_review_status": "fail"}}.get(case, {})
    world["add_clip"](**extra)
    world["add_account"](**({"profile_id": "other"} if case == "unbound" else
                            {"verified_at": None} if case == "unverified" else {}))
    if case == "archived":
        world["store"].put("campaigns", {"id": "camp-1", "archived_at": "2026-11-14T00:00:00+00:00"})
    kwargs = {"sha256": "0" * 64} if case == "changed" else {}
    with pytest.raises(PublishError) as error:
        post(world, **kwargs)
    assert error.value.status in {409, 422}
    assert world["store"].all("publish_attempts") == []


def test_sign_in_required_and_quality_hold_override(world):
    world["add_clip"]()
    world["add_account"]()
    world["state"]["storage"].signed_in = False
    with pytest.raises(PublishError) as error:
        post(world)
    assert error.value.code == "sign_in_required"
    world["state"]["storage"].signed_in = True
    publisher = world["make"](gate=holding_gate)
    with pytest.raises(PublishError) as error:
        post(world, publisher)
    assert error.value.code == "quality_hold" and error.value.details["report"]["verdict"] == "hold"
    with pytest.raises(PublishError):
        post(world, publisher, override_reason="short")
    _, attempt = post(world, publisher, override_reason="Captions are in the video description instead.")
    assert attempt["override_reason"].startswith("Captions") and attempt["quality"]["verdict"] == "hold"


def test_attempt_stops_if_approval_changes_before_external_effects(world):
    world["add_clip"]()
    world["add_account"]()
    publisher, attempt = post(world)
    world["store"].patch("clips", "clip-1", approved=False)
    publisher.run(attempt["id"])
    row = publisher.get(attempt["id"])
    assert row["state"] == "created" and row["error"]["code"] == "not_approved"
    assert world["state"]["storage"].uploads == [] and world["state"]["client"].calls == []


def test_batch_is_validated_all_or_nothing_and_runs_sequentially(world):
    world["add_clip"]("clip-1")
    world["add_clip"]("clip-2")
    world["add_clip"]("clip-3", campaign_id="other")
    world["add_account"]("acct-1")
    world["add_account"]("acct-2")
    publisher = world["make"](start_worker=True)
    with pytest.raises(PublishError) as error:
        publisher.request_batch("camp-1", ["acct-1", "acct-2"], ["clip-1", "clip-3"])
    assert error.value.code == "batch_invalid" and world["store"].all("publish_attempts") == []
    result = publisher.request_batch("camp-1", ["acct-1", "acct-2"], ["clip-1", "clip-2"],
                                     captions={"clip-2": "Second caption"})
    assert [(a["clip_id"], a["account_id"]) for a in result["attempts"]] == [
        ("clip-1", "acct-1"), ("clip-1", "acct-2"), ("clip-2", "acct-1"), ("clip-2", "acct-2")]
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and any(
            r["state"] != "mapped" for r in world["store"].all("publish_attempts")):
        time.sleep(0.02)
    publisher.close()
    rows = world["store"].all("publish_attempts")
    assert {r["state"] for r in rows} == {"mapped"}
    client = world["state"]["client"]
    assert client.max_running == 1  # one provider call at a time
    publishes = [c for c in client.calls if c[0] == PUBLISH]
    assert len(publishes) == 4
    order = [c[2] for c in client.calls if c[0] == CREATE]
    assert order == ["acct-1", "acct-2", "acct-1", "acct-2"]
    assert any(c[1].get("caption") == "Second caption" for c in client.calls if c[0] == CREATE)


# ---------------------------------------------------------------- permitted-tool separation

def test_read_adapter_allowlist_is_unchanged_and_refuses_publish_tools():
    assert ComposioClient.READ_TOOLS == {"INSTAGRAM_GET_USER_INFO", "INSTAGRAM_GET_IG_USER_MEDIA",
                                         "INSTAGRAM_GET_IG_MEDIA", "INSTAGRAM_GET_IG_MEDIA_INSIGHTS"}
    assert ComposioClient.PERMITTED_TOOLS == ComposioClient.READ_TOOLS
    client = ComposioClient("key", transport=httpx.MockTransport(lambda r: pytest.fail("no network")))
    for slug in (CREATE, PUBLISH, NODES, QUOTA):
        with pytest.raises(ComposioError) as error:
            client.tool_schema(slug)
        assert error.value.code == "unsupported_tool"
    assert ComposioPublishingClient.PUBLISH_TOOLS == {CREATE, PUBLISH, NODES, QUOTA}
    publishing = ComposioPublishingClient("key", transport=httpx.MockTransport(lambda r: pytest.fail("no")))
    with pytest.raises(ComposioError):
        publishing.run("INSTAGRAM_DELETE_COMMENT", {}, connected_account_id="ca_1", user_id="u")


def test_publishing_client_pins_version_and_exact_account():
    seen = []
    schema = {"type": "object", "required": ["ig_user_id", "creation_id"],
              "properties": {"ig_user_id": {"type": "string"}, "creation_id": {"type": "string"},
                             "max_wait_seconds": {"type": "integer"}}}

    def handler(request):
        seen.append(request)
        if request.url.path == f"/api/v3.1/tools/{PUBLISH}":
            return httpx.Response(200, json={"slug": PUBLISH, "version": "20261112_00", "toolkit": {"slug": "instagram"},
                                             "input_parameters": schema})
        if request.url.path == "/api/v3/connected_accounts/ca_1":
            return httpx.Response(200, json={"id": "ca_1", "user_id": "gf-user", "toolkit": {"slug": "instagram"},
                                             "status": "ACTIVE", "auth_config": {"id": "ac_1"}})
        if request.url.path == f"/api/v3.1/tools/execute/{PUBLISH}":
            return httpx.Response(200, json={"successful": True, "data": {"id": "1799"}})
        raise AssertionError(request.url)

    client = ComposioPublishingClient("key", transport=httpx.MockTransport(handler))
    data = client.run(PUBLISH, {"ig_user_id": "1784", "creation_id": "555", "max_wait_seconds": 0},
                      connected_account_id="ca_1", user_id="gf-user")
    assert data == {"id": "1799"}
    assert seen[0].url.params["version"] == "20261112_00"
    body = json.loads(seen[-1].content)
    assert body["version"] == "20261112_00" and body["connected_account_id"] == "ca_1"
    assert body["user_id"] == "gf-user"
    with pytest.raises(ComposioError) as error:
        client.run(PUBLISH, {"ig_user_id": "1784"}, connected_account_id="ca_1", user_id="gf-user")
    assert error.value.code == "invalid_arguments"


def attribution_gate(clip, path, expected_sha256=None, source_video=None):
    """Real production gate with only local file probing stubbed for tiny fixture bytes."""
    from clip_factory import quality
    return quality.evaluate(clip, path, expected_sha256=expected_sha256, source_video=source_video,
                            inspect=lambda _: {"duration": 30, "video": {"codec": "h264", "width": 1080,
                                                                         "height": 1920},
                                               "audio": {"codec": "aac"}},
                            detect=lambda _: {"black_segments": [], "frozen_segments": []})


def attribution_world(world, speech):
    clip = world["add_clip"](video_id="source-1", start=0, end=10, subtitles_burned=True,
                             technical_checks={"playback_format_passed": True, "captions": [
                                 {"id": "timing", "status": "pass"}]})
    world["add_account"]()
    world["store"].put("videos", {"id": "source-1", "verified_speakers": ["Ana"], "transcript": {
        "segments": [{"start": 0, "end": 10, "text": speech}]}})
    return clip, world["make"](gate=attribution_gate)


def test_submitted_caption_unknown_attribution_blocks_before_any_external_effect(world):
    clip, publisher = attribution_world(world, "Ana is mentioned. The speaker questions this claim.")
    # A cached pass for a neutral stored caption cannot authorize changed post copy.
    assert publisher.quality_report(clip)["verdict"] == "pass"
    with pytest.raises(PublishError) as error:
        post(world, publisher, caption="Ana points out that the sourcing is vague.")
    assert error.value.code == "quality_hold"
    assert "Ana points out" in str(error.value)
    assert error.value.details["report"]["source_attribution"]["editorial_hold"]
    assert world["store"].all("publish_attempts") == []
    assert world["state"]["client"].calls == [] and world["state"]["storage"].uploads == []
    # An explicit, recorded override is still required and remains visible.
    _, attempt = post(world, publisher, caption="Ana points out that the sourcing is vague.",
                      override_reason="I independently verified the speaker and accept this attribution.")
    assert attempt["quality"]["verdict"] == "hold" and attempt["override_reason"]


def test_stored_source_supports_reported_attribution_and_source_change_invalidates_cache(world):
    clip, publisher = attribution_world(world, "Ana points out that the sourcing is vague.")
    submitted = {**clip, "caption": "Ana points out that the sourcing is vague."}
    report = publisher.quality_report(submitted)
    assert report["verdict"] == "pass"
    video = world["store"].get("videos", "source-1")
    video["transcript"]["segments"][0]["text"] = "The sourcing is vague. Ana is a person discussed."
    world["store"].put("videos", video)
    changed = publisher.quality_report(submitted)
    assert changed["context_identity"] != report["context_identity"]
    assert changed["verdict"] == "hold"
    assert changed["source_attribution"]["speaker_context"] == "unknown"
    with pytest.raises(PublishError, match="Ana points out"):
        post(world, publisher, caption=submitted["caption"])
    assert world["state"]["client"].calls == []


def test_queued_post_rechecks_exact_caption_against_changed_source_before_upload(world):
    _, publisher = attribution_world(world, "Ana points out that the sourcing is vague.")
    _, attempt = post(world, publisher, caption="Ana points out that the sourcing is vague.")
    video = world["store"].get("videos", "source-1")
    video["transcript"]["segments"][0]["text"] = "The speaker questions this claim."
    world["store"].put("videos", video)
    publisher.run(attempt["id"])
    assert publisher.get(attempt["id"])["error"]["code"] == "quality_hold"
    assert world["state"]["storage"].uploads == [] and world["state"]["client"].calls == []


def test_container_status_reads_the_live_composio_shape():
    from clip_factory.publisher import _container_status

    live = {"data": {"objects": {"18092637188505740": {"id": "18092637188505740", "status": "FINISHED",
                                                       "status_code": "FINISHED"}}}}
    assert _container_status(live, "18092637188505740") == "FINISHED"
    assert _container_status(live["data"], "18092637188505740") == "FINISHED"
    assert _container_status({"data": {"objects": {}}}, "18092637188505740") is None
