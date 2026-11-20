"""Offline publisher state machine against a fake posting server: no cloud, Zernio or platform calls."""

import hashlib
import threading
import time

import pytest
from fastapi import HTTPException

from clip_factory.posting_server import PostingServerError
from clip_factory.publisher import Publisher, PublishError
from clip_factory.store import Store

WORKSPACE = "0f6c3b0e-6a5e-4a4e-9a55-2b6a7c1d9e10"
CREATOR = {"creator": {"nickname": "maker", "canPostMore": True},
           "privacyLevels": [{"value": "PUBLIC_TO_EVERYONE", "label": "Everyone"},
                             {"value": "SELF_ONLY", "label": "Only me"}],
           "postingLimits": {"maxVideoDurationSec": 600, "interactionSettings": {
               "allow_comment": {"enabled": True}, "allow_duet": {"enabled": True},
               "allow_stitch": {"enabled": False}}}}
TIKTOK = {"privacy_level": "PUBLIC_TO_EVERYONE", "allow_comment": True, "allow_duet": False,
          "allow_stitch": False, "content_preview_confirmed": True, "express_consent_given": True}


def zernio_id(identifier: str) -> str:
    return hashlib.sha256(identifier.encode()).hexdigest()[:24]


class FakeServer:
    """In-memory posting server. Asserts the durable record precedes every external write."""

    def __init__(self, store, *, statuses=("processing", "published")):
        self.store, self.statuses = store, list(statuses)
        self.signed_in, self.creator = True, CREATOR
        self.errors: dict[str, list] = {}
        self.uploads, self.created, self.posts, self.keys = [], [], {}, {}
        self.calls, self.running, self.max_running = [], 0, 0
        self.lock = threading.Lock()
        self.create_then_fail = None

    def _pending(self, effect):
        return any(r.get("pending_effect") == effect for r in self.store.all("publish_attempts"))

    def _enter(self, name):
        with self.lock:
            self.running += 1
            self.max_running = max(self.max_running, self.running)
        time.sleep(0.001)
        self.calls.append(name)
        if self.errors.get(name):
            error = self.errors[name].pop(0)
            self._exit()
            raise error

    def _exit(self):
        with self.lock:
            self.running -= 1

    def workspace_id(self):
        if not self.signed_in:
            raise PostingServerError(401, "sign_in_required", "Sign in to Growth Factory cloud to post.")
        return WORKSPACE

    def upload(self, path, content_type, *, filename=None):
        self._enter("upload")
        try:
            if content_type == "video/mp4":
                assert self._pending("upload"), "durable record must precede the upload"
            self.uploads.append((filename, content_type, path.read_bytes()))
            return f"https://media.example/{len(self.uploads)}/{filename}"
        finally:
            self._exit()

    def creator_info(self, account_id):
        self.calls.append("creator_info")
        return self.creator

    def _entry_status(self):
        return self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]

    def _apply(self, post):
        status = self._entry_status()
        entry = post["platforms"][0]
        entry["status"] = status
        if status == "published":
            entry.update(platformPostId="1799" + post["id"][:6], url=f"https://example.social/p/{post['id'][:8]}")
            post.update(status="published", publishedAt="2026-11-19T10:00:00+00:00")
        elif status == "failed":
            entry.update(error="Media processing failed: video too short", errorCategory="user_content",
                         errorSource="user")
            post["status"] = "failed"
        return post

    def create_post(self, payload, idempotency_key):
        self._enter("create_post")
        try:
            assert self._pending("create_post"), "durable record must precede the post"
            if idempotency_key in self.keys:
                return {"replayed": True, "post": self.posts[self.keys[idempotency_key]]}
            identifier = f"{len(self.posts) + 1:024x}"
            target = payload["platforms"][0]
            post = {"id": identifier, "status": "publishing", "externalId": payload["externalId"],
                    "publishedAt": None, "scheduledFor": None,
                    "platforms": [{"platform": None, "accountId": target["accountId"], "status": "pending"}]}
            self.posts[identifier], self.keys[idempotency_key] = post, identifier
            self.created.append((payload, idempotency_key))
            self._apply(post)
            if self.create_then_fail:
                error, self.create_then_fail = self.create_then_fail, None
                raise error
            return {"replayed": False, "post": post}
        finally:
            self._exit()

    def get_post(self, post_id):
        self._enter("get_post")
        try:
            post = self.posts[post_id]
            if post["platforms"][0]["status"] not in {"published", "failed"}:
                self._apply(post)
            return {"post": post, "events": []}
        finally:
            self._exit()

    def find_posts(self, external_id):
        self.calls.append("find_posts")
        return [p for p in self.posts.values() if p["externalId"] == external_id]


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
                            "revision_number": 2, "duration": 30.0, **extra})
        return store.get("clips", identifier)

    def add_account(identifier="acct-1", platform="instagram", **extra):
        store.put("connected_accounts", {"id": identifier, "profile_id": "prof-1", "provider": "zernio",
                                         "platform": platform, "zernio_account_id": zernio_id(identifier),
                                         "status": "active", "publishing_permitted": True,
                                         "verified_at": "2026-11-14T00:00:00+00:00",
                                         "display_name": identifier, **extra})

    state = {"server": FakeServer(store), "learning": FakeLearning(store), "enabled": True}

    def make(gate=passing_gate, start_worker=False, **options):
        return Publisher(store, root=tmp_path, server_factory=lambda: state["server"], learning=state["learning"],
                         campaigns=FakeCampaigns(store), gate=gate, enabled=lambda: state["enabled"],
                         sleep=lambda _: None, start_worker=start_worker, poll_interval=0, max_polls=5,
                         item_gap=0, **options)

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
    assert attempt["state"] == "created" and attempt["active"] is True and attempt["provider"] == "zernio"
    assert attempt["external_id"] == f"gf-{attempt['id']}" and attempt["idempotency_key"]
    publisher.run(attempt["id"])
    row = publisher.get(attempt["id"])
    assert row["state"] == "mapped" and row["active"] is False and row["pending_effect"] is None
    assert row["permalink"].startswith("https://example.social/p/") and row["platform_post_id"].startswith("1799")
    states = [h["state"] for h in row["history"]]
    for expected in ("uploading", "uploaded", "submitted", "published", "mapped"):
        assert expected in states
    assert [h["pending_effect"] for h in row["history"]].count("create_post") == 1
    server = world["state"]["server"]
    assert len(server.created) == 1
    payload, key = server.created[0]
    assert key == row["idempotency_key"] and payload["publishNow"] is True
    assert payload["externalId"] == row["external_id"] and payload["content"] == "Watch this #reel"
    assert payload["mediaItems"] == [{"url": row["video_url"], "type": "video"}]
    target = payload["platforms"][0]
    assert target["accountId"] == zernio_id("acct-1")
    assert target["platformSpecificData"] == {"shareToFeed": True, "thumbOffset": 0}
    assert server.uploads[0][2] == (world["store"].get("clips", "clip-1") and b"approved bytes clip-1")
    registered = world["state"]["learning"].registered[0]
    assert registered["sha256"] == clip["sha256"] and registered["media_id"] == row["zernio_post_id"]
    publication = world["store"].get("learning_publications", "pub-" + row["zernio_post_id"])
    assert publication["mapping_source"] == "app_published" and publication["publish_attempt_id"] == row["id"]
    assert publication["provider"] == "zernio" and publication["platform"] == "instagram"
    assert publication["platform_post_id"] == row["platform_post_id"]


def test_crash_while_posting_is_unknown_and_never_resent_before_reconcile(world):
    world["add_clip"]()
    world["add_account"]()
    _, attempt = post(world)
    store = world["store"]
    # Simulate a process crash after the durable "create_post" marker but before any reply.
    store.patch("publish_attempts", attempt["id"], state="uploaded", video_url="https://media.example/v.mp4",
                pending_effect="create_post", active=True)
    publisher = world["make"]()
    row = publisher.get(attempt["id"])
    assert row["state"] == "unknown" and row["previous_state"] == "uploaded"
    with pytest.raises(PublishError) as error:
        publisher.resume(attempt["id"])
    assert error.value.code == "needs_reconcile"
    publisher.run(attempt["id"])  # a stray run does nothing for unknown
    assert world["state"]["server"].created == []
    # Nothing was created upstream: reconcile reads, finds none, and allows a resend with the same key.
    row = publisher.reconcile(attempt["id"])
    assert row["state"] == "uploaded" and row["pending_effect"] is None
    publisher.resume(attempt["id"])
    publisher.run(attempt["id"])
    assert publisher.get(attempt["id"])["state"] == "mapped"
    assert [k for _, k in world["state"]["server"].created] == [row["idempotency_key"]]


def test_uncertain_create_reconciles_to_the_post_that_was_made(world):
    world["add_clip"]()
    world["add_account"]()
    server = world["state"]["server"]
    server.statuses = ["published"]
    server.create_then_fail = PostingServerError(504, "timeout", "The posting server timed out.", uncertain=True)
    publisher, attempt = post(world)
    publisher.run(attempt["id"])
    row = publisher.get(attempt["id"])
    assert row["state"] == "unknown" and row["pending_effect"] == "create_post" and row["error"]["code"] == "timeout"
    with pytest.raises(PublishError):
        publisher.resume(attempt["id"])
    row = publisher.reconcile(attempt["id"])
    assert row["state"] == "mapped" and row["zernio_post_id"] and len(server.created) == 1
    assert "find_posts" in server.calls


def test_server_5xx_after_send_is_unknown_not_failed(world):
    world["add_clip"]()
    world["add_account"]()
    server = world["state"]["server"]
    server.errors["create_post"] = [PostingServerError(502, "zernio_unavailable", "Zernio had a problem.",
                                                       uncertain=True)]
    publisher, attempt = post(world)
    publisher.run(attempt["id"])
    assert publisher.get(attempt["id"])["state"] == "unknown"
    assert publisher.reconcile(attempt["id"])["state"] == "uploaded"


def test_in_progress_replay_waits_for_reconcile(world):
    world["add_clip"]()
    world["add_account"]()
    world["state"]["server"].errors["create_post"] = [
        PostingServerError(409, "in_progress", "This post is still being created.")]
    publisher, attempt = post(world)
    publisher.run(attempt["id"])
    row = publisher.get(attempt["id"])
    assert row["state"] == "unknown" and row["pending_effect"] == "create_post"


def test_definite_refusal_fails_and_retryable_refusal_stays_resumable(world):
    world["add_clip"]()
    world["add_clip"]("clip-2")
    world["add_account"]()
    server = world["state"]["server"]
    server.errors["create_post"] = [PostingServerError(403, "media_not_allowed", "Attach only your media."),
                                    PostingServerError(402, "posting_plan_limit", "Plan limit.")]
    publisher, first = post(world)
    publisher.run(first["id"])
    row = publisher.get(first["id"])
    assert row["state"] == "failed" and row["error"]["code"] == "media_not_allowed" and row["pending_effect"] is None
    _, second = post(world, publisher, clip_id="clip-2")
    publisher.run(second["id"])
    row = publisher.get(second["id"])
    assert row["state"] == "uploaded" and row["error"]["code"] == "posting_plan_limit"
    publisher.resume(second["id"])
    publisher.run(second["id"])
    assert publisher.get(second["id"])["state"] == "mapped"


def test_platform_failure_is_definite_with_its_category(world):
    world["add_clip"]()
    world["add_account"]()
    world["state"]["server"].statuses = ["processing", "failed"]
    publisher, attempt = post(world)
    publisher.run(attempt["id"])
    row = publisher.get(attempt["id"])
    assert row["state"] == "failed" and row["error"]["code"] == "user_content"
    assert "too short" in row["error"]["message"] and row["zernio_post_id"]


def test_still_publishing_after_polls_stays_submitted_until_checked(world):
    world["add_clip"]()
    world["add_account"]()
    server = world["state"]["server"]
    server.statuses = ["processing"]
    publisher, attempt = post(world)
    publisher.run(attempt["id"])
    row = publisher.get(attempt["id"])
    assert row["state"] == "submitted" and server.calls.count("get_post") == 5
    server.statuses = ["published"]
    assert publisher.reconcile(attempt["id"])["state"] == "mapped"
    assert len(server.created) == 1


def test_upload_failure_is_redone_not_unknown(world):
    world["add_clip"]()
    world["add_account"]()
    server = world["state"]["server"]
    server.errors["upload"] = [PostingServerError(502, "upload_failed", "Uploading the video failed.")]
    publisher, attempt = post(world)
    publisher.run(attempt["id"])
    row = publisher.get(attempt["id"])
    assert row["state"] == "created" and row["error"]["code"] == "upload_failed" and server.created == []
    publisher.resume(attempt["id"])
    publisher.run(attempt["id"])
    assert publisher.get(attempt["id"])["state"] == "mapped"
    # An upload in flight at a crash is simply redone.
    world["add_clip"]("clip-2")
    _, other = post(world, publisher, clip_id="clip-2")
    world["store"].patch("publish_attempts", other["id"], state="uploading", pending_effect="upload", active=True)
    assert world["make"]().get(other["id"])["state"] == "created"


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
    assert len(world["state"]["server"].created) == 1


@pytest.mark.parametrize("case", ["archived", "unapproved", "changed", "unbound", "inactive", "not_permitted",
                                  "composio", "legacy", "unresolved_review"])
def test_rejections(world, case):
    extra = {"unapproved": {"approved": False}, "legacy": {"publish_attempt": {"id": "j"}},
             "unresolved_review": {"team_review_status": "fail"}}.get(case, {})
    world["add_clip"](**extra)
    world["add_account"](**{"unbound": {"profile_id": "other"}, "inactive": {"status": "disconnected"},
                            "not_permitted": {"publishing_permitted": False},
                            "composio": {"provider": "composio", "toolkit": "instagram"}}.get(case, {}))
    if case == "archived":
        world["store"].put("campaigns", {"id": "camp-1", "archived_at": "2026-11-14T00:00:00+00:00"})
    kwargs = {"sha256": "0" * 64} if case == "changed" else {}
    with pytest.raises(PublishError) as error:
        post(world, **kwargs)
    assert error.value.status in {403, 409, 422}
    if case == "not_permitted":
        assert error.value.code == "account_not_permitted"
    assert world["store"].all("publish_attempts") == []


def test_publishing_disabled_sign_in_and_quality_hold_override(world):
    world["add_clip"]()
    world["add_account"]()
    world["state"]["enabled"] = False
    with pytest.raises(PublishError) as error:
        post(world)
    assert error.value.code == "publishing_disabled" and error.value.status == 403
    world["state"]["enabled"] = True
    world["state"]["server"].signed_in = False
    with pytest.raises(PublishError) as error:
        post(world)
    assert error.value.code == "sign_in_required"
    world["state"]["server"].signed_in = True
    publisher = world["make"](gate=holding_gate)
    with pytest.raises(PublishError) as error:
        post(world, publisher)
    assert error.value.code == "quality_hold" and error.value.details["report"]["verdict"] == "hold"
    with pytest.raises(PublishError):
        post(world, publisher, override_reason="short")
    _, attempt = post(world, publisher, override_reason="Captions are in the video description instead.")
    assert attempt["override_reason"].startswith("Captions") and attempt["quality"]["verdict"] == "hold"


def test_attempt_stops_if_approval_or_setting_changes_before_external_effects(world):
    world["add_clip"]()
    world["add_account"]()
    publisher, attempt = post(world)
    world["store"].patch("clips", "clip-1", approved=False)
    publisher.run(attempt["id"])
    row = publisher.get(attempt["id"])
    assert row["state"] == "created" and row["error"]["code"] == "not_approved"
    world["store"].patch("clips", "clip-1", approved=True)
    world["state"]["enabled"] = False
    publisher.run(attempt["id"])
    assert publisher.get(attempt["id"])["error"]["code"] == "publishing_disabled"
    world["store"].patch("connected_accounts", "acct-1", publishing_permitted=False)
    world["state"]["enabled"] = True
    publisher.run(attempt["id"])
    assert publisher.get(attempt["id"])["error"]["code"] == "account_not_permitted"
    assert world["state"]["server"].calls == []


def test_batch_is_validated_all_or_nothing_and_runs_sequentially(world):
    world["add_clip"]("clip-1")
    world["add_clip"]("clip-2")
    world["add_clip"]("clip-3", campaign_id="other")
    world["add_account"]("acct-1")
    world["add_account"]("acct-2", platform="youtube")
    world["add_account"]("acct-3", platform="tiktok")
    publisher = world["make"](start_worker=True)
    with pytest.raises(PublishError) as error:
        publisher.request_batch("camp-1", ["acct-1", "acct-2"], ["clip-1", "clip-3"])
    assert error.value.code == "batch_invalid" and world["store"].all("publish_attempts") == []
    with pytest.raises(PublishError) as error:
        publisher.request_batch("camp-1", ["acct-1", "acct-3"], ["clip-1"])
    assert error.value.details["problems"][0]["code"] == "tiktok_consent_required"
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
    server = world["state"]["server"]
    assert server.max_running == 1  # one server call at a time
    order = [p["platforms"][0]["accountId"] for p, _ in server.created]
    assert order == [zernio_id("acct-1"), zernio_id("acct-2")] * 2
    assert any(p["content"] == "Second caption" for p, _ in server.created)
    youtube = next(p for p, _ in server.created if p["platforms"][0]["accountId"] == zernio_id("acct-2"))
    assert youtube["platforms"][0]["platformSpecificData"] == {"title": "A hook", "visibility": "public"}


# ---------------------------------------------------------------- platforms

def test_tiktok_requires_consent_and_creator_options(world):
    world["add_clip"](craft={"cover": {"mode": "best_frame", "time": 2.0}})
    world["add_account"](platform="tiktok")
    for settings, code in ((None, "tiktok_consent_required"),
                           ({**TIKTOK, "express_consent_given": False}, "tiktok_consent_required"),
                           ({**TIKTOK, "allow_duet": None}, "tiktok_settings_required"),
                           ({**TIKTOK, "privacy_level": "FOLLOWER_OF_CREATOR"}, "invalid_privacy_level"),
                           ({**TIKTOK, "allow_stitch": True}, "tiktok_interaction_disabled")):
        with pytest.raises(PublishError) as error:
            post(world, package={"tiktok": settings})
        assert error.value.code == code, settings
    world["state"]["server"].creator = {**CREATOR, "creator": {"canPostMore": False}}
    with pytest.raises(PublishError) as error:
        post(world, package={"tiktok": TIKTOK})
    assert error.value.code == "tiktok_cannot_post"
    world["state"]["server"].creator = {**CREATOR, "postingLimits": {"maxVideoDurationSec": 15}}
    with pytest.raises(PublishError) as error:
        post(world, package={"tiktok": TIKTOK})
    assert error.value.code == "too_long"
    assert world["store"].all("publish_attempts") == []
    world["state"]["server"].creator = CREATOR
    publisher, attempt = post(world, package={"tiktok": TIKTOK})
    assert attempt["package"]["tiktok"]["privacy_level"] == "PUBLIC_TO_EVERYONE"
    publisher.run(attempt["id"])
    payload, _ = world["state"]["server"].created[0]
    assert payload["platforms"][0]["platformSpecificData"] == {
        "privacy_level": "PUBLIC_TO_EVERYONE", "allow_comment": True, "allow_duet": False, "allow_stitch": False,
        "content_preview_confirmed": True, "express_consent_given": True, "video_cover_timestamp_ms": 2000}


def test_platform_caption_limits_titles_and_collaborators(world):
    world["add_clip"](hook="H" * 140)
    world["add_account"]("acct-x", platform="twitter")
    world["add_account"]("acct-y", platform="youtube")
    world["add_account"]("acct-i", platform="instagram")
    with pytest.raises(PublishError) as error:
        post(world, account="acct-x", caption="x" * 281)
    assert error.value.code == "invalid_caption" and "280" in error.value.message
    # Hashtag limits are Instagram's; other platforms do not apply them.
    _, tweet = post(world, account="acct-x", caption=" ".join(f"#t{i}" for i in range(31))[:280])
    assert tweet["state"] == "created"
    with pytest.raises(PublishError) as error:
        post(world, account="acct-y", package={"collaborators": ["friend"]})
    assert error.value.code == "collaborators_unsupported"
    _, video = post(world, account="acct-y", package={"youtube_visibility": "unlisted"})
    assert video["package"]["youtube"] == {"title": "H" * 100, "visibility": "unlisted"}
    publisher, reel = post(world, account="acct-i", package={"collaborators": ["friend.one"], "share_to_feed": False})
    publisher.run(reel["id"])
    payload = next(p for p, _ in world["state"]["server"].created
               if p["platforms"][0]["accountId"] == zernio_id("acct-i"))
    assert payload["platforms"][0]["platformSpecificData"] == {"shareToFeed": False, "thumbOffset": 0,
                                                               "collaborators": ["friend.one"]}


def test_legacy_composio_attempts_are_closed_or_flagged_on_start(world):
    world["add_clip"]()
    store = world["store"]
    base = {"clip_id": "clip-1", "account_id": "ca_old", "campaign_id": "camp-1", "active": False,
            "pending_effect": None, "history": []}
    store.put("publish_attempts", {**base, "id": "old-created", "state": "uploaded"})
    store.put("publish_attempts", {**base, "id": "old-container", "state": "container_ready"})
    store.put("publish_attempts", {**base, "id": "old-mapped", "state": "mapped"})
    publisher = world["make"]()
    assert publisher.get("old-created")["state"] == "cancelled"
    container = publisher.get("old-container")
    assert container["state"] == "container_ready" and container["legacy"] is True
    assert "legacy" not in publisher.get("old-mapped")
    for action in (publisher.resume, publisher.reconcile):
        with pytest.raises(PublishError) as error:
            action("old-container")
        assert error.value.code == "legacy_attempt"
    publisher.run("old-container")
    assert publisher.get("old-container")["state"] == "container_ready"
    assert world["state"]["server"].calls == []


# ---------------------------------------------------------------- source attribution (quality gate)

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
    assert world["state"]["server"].calls == []
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
    assert world["state"]["server"].calls == []


def test_queued_post_rechecks_exact_caption_against_changed_source_before_upload(world):
    _, publisher = attribution_world(world, "Ana points out that the sourcing is vague.")
    _, attempt = post(world, publisher, caption="Ana points out that the sourcing is vague.")
    video = world["store"].get("videos", "source-1")
    video["transcript"]["segments"][0]["text"] = "The speaker questions this claim."
    world["store"].put("videos", video)
    publisher.run(attempt["id"])
    assert publisher.get(attempt["id"])["error"]["code"] == "quality_hold"
    assert world["state"]["server"].calls == []
