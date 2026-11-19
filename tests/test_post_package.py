"""Post package: limits, cover hosting/fallback, scheduling and per-account captions. Offline only:
fake Composio client and storage; no Composio write tool and no Instagram call is ever made."""

import sys
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from clip_factory import post_package
from clip_factory.post_schedule import PostScheduler
from clip_factory.publish_storage import PublishStorage, PublishStorageError
from clip_factory.publisher import PublishError
from tests.test_publisher import CREATE, PUBLISH, USER, FakeStorage, holding_gate, post, world  # noqa: F401

# Properties of the pinned INSTAGRAM_POST_IG_USER_MEDIA 20261112_00 schema (additionalProperties false),
# read from tool metadata only. Note: no `collaborators`.
PINNED_CREATE_PROPERTIES = {
    "caption", "alt_text", "children", "cover_url", "image_url", "user_tags", "video_url", "audio_name",
    "ig_user_id", "image_file", "media_type", "video_file", "location_id", "thumb_offset", "share_to_feed",
    "is_carousel_item", "graph_api_version",
}


class CoverStorage(FakeStorage):
    def __init__(self, store, *, cover_fail=None, **kw):
        super().__init__(store, **kw)
        self.cover_fail, self.covers, self.sizes = cover_fail, [], {}

    def upload(self, path, sha):
        hosted = super().upload(path, sha)
        self.sizes[hosted["url"]] = (path.stat().st_size, "video/mp4")
        return hosted

    def upload_cover(self, path, sha):
        if self.cover_fail:
            raise self.cover_fail
        name = f"{USER}/{sha}.jpg"
        url = self.public_url(name)
        self.covers.append(name)
        self.public.add(url)
        self.sizes[url] = (path.stat().st_size, "image/jpeg")
        return {"url": url, "object": name, "bytes": path.stat().st_size, "reused": False}

    def verify_public(self, url, size, content_type="video/mp4"):
        return url in self.public and self.sizes.get(url, (size, content_type)) == (size, content_type)


def fake_extract(clip_path, time_ms, output):
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"\xff\xd8jpeg-frame-" + str(time_ms).encode())


@pytest.fixture
def cover_world(world, tmp_path):  # noqa: F811
    world["state"]["storage"] = CoverStorage(world["store"])
    clip = world["add_clip"](duration=20.0, craft={"cover": {"mode": "best_frame", "time": 4.25}})
    (tmp_path / "clips" / "clip-1.jpg").write_bytes(b"\xff\xd8auto-cover")
    world["add_account"]()
    world["add_account"]("acct-2", display_name="second")
    from clip_factory.post_package import Covers
    world["make_covers"] = lambda **kw: world["make"](covers=Covers(tmp_path, extract=fake_extract), **kw)
    world["clip"] = clip
    return world


def create_args(w):
    return [c[1] for c in w["state"]["client"].calls if c[0] == CREATE]


# ----------------------------------------------------------------------------- limits

def test_caption_limits_and_features():
    ok = "Hook line\n\nGet it — link in bio.\n\n" + " ".join(f"#t{i}" for i in range(30))
    features = post_package.caption_features(ok)
    assert features["hashtag_count"] == 30 and features["cta"] == "link_in_bio"
    assert features["caption_sha256"] == post_package.caption_sha256(ok)
    assert post_package.limit_problems(ok) == []
    assert post_package.limit_problems(ok + " #t30") == ["Instagram allows at most 30 hashtags."]
    assert post_package.limit_problems(" ".join(f"@u{i}" for i in range(21))) == [
        "Instagram allows at most 20 mentions."]
    assert post_package.limit_problems("x" * 2201) == ["Instagram captions are limited to 2,200 characters."]
    assert post_package.mentions("email a@b.com and @real.name") == ["real.name"]
    assert post_package.clean_collaborators(["@a", "b", "A"]) == ["a", "b"]
    with pytest.raises(ValueError, match="at most 3"):
        post_package.clean_collaborators(["a", "b", "c", "d"])


@pytest.mark.parametrize("caption,code", [
    ("x" * 2201, "invalid_caption"),
    (" ".join(f"#t{i}" for i in range(31)), "invalid_caption"),
    (" ".join(f"@u{i}" for i in range(21)), "invalid_caption"),
])
def test_publisher_refuses_over_limit_captions(cover_world, caption, code):
    with pytest.raises(PublishError) as error:
        post(cover_world, publisher=cover_world["make_covers"](), caption=caption)
    assert error.value.code == code and not cover_world["state"]["client"].calls


def test_collaborators_are_refused_because_the_pinned_tool_has_no_such_field(cover_world):
    assert "collaborators" not in PINNED_CREATE_PROPERTIES and not post_package.COLLABORATORS_SUPPORTED
    with pytest.raises(PublishError) as error:
        post(cover_world, publisher=cover_world["make_covers"](), package={"collaborators": ["friend"]})
    assert error.value.code == "collaborators_unsupported"
    with pytest.raises(PublishError) as error:
        post(cover_world, publisher=cover_world["make_covers"](), package={"collaborators": list("abcd")})
    assert error.value.code == "invalid_collaborators"


# ----------------------------------------------------------------------------- cover

def test_chosen_cover_is_hosted_and_sent_as_cover_url_with_package_recorded(cover_world):
    publisher = cover_world["make_covers"]()
    caption = "Most founders hire too early. Get the checklist, link in bio. #founders #hiring @mentor"
    _, attempt = post(cover_world, publisher=publisher, caption=caption,
                      package={"cover_time_ms": 7000, "share_to_feed": False})
    package = attempt["package"]
    assert package["cover"]["source"] == "chosen_frame" and package["cover"]["time_ms"] == 7000
    assert package["hashtags"] == ["founders", "hiring"] and package["mentions"] == ["mentor"]
    assert package["cta"] == "link_in_bio" and package["share_to_feed"] is False
    assert package["caption_sha256"] == post_package.caption_sha256(caption)
    publisher.run(attempt["id"])
    row = publisher.get(attempt["id"])
    assert row["state"] == "mapped" and row["cover_mode"] == "cover_url" and row["posted_at"]
    args = create_args(cover_world)[0]
    assert set(args) <= PINNED_CREATE_PROPERTIES
    assert args["cover_url"].endswith(".jpg") and "thumb_offset" not in args and args["share_to_feed"] is False
    assert row["container_arguments"]["cover_url"] == args["cover_url"]
    storage = cover_world["state"]["storage"]
    assert storage.covers == [row["cover_object"]] and row["cover_object"] in storage.deleted


@pytest.mark.xfail(sys.platform == "win32", strict=True, reason="WO-28: stored media paths use the OS separator (videos\\...) instead of POSIX")
def test_auto_cover_uses_the_render_cover_jpg(cover_world):
    publisher = cover_world["make_covers"]()
    _, attempt = post(cover_world, publisher=publisher)
    assert attempt["package"]["cover"]["source"] == "auto_best_frame"
    assert attempt["package"]["cover"]["time_ms"] == 4250
    assert attempt["package"]["cover"]["local_path"] == "clips/clip-1.jpg"
    publisher.run(attempt["id"])
    assert "cover_url" in create_args(cover_world)[0]


def test_cover_upload_refused_falls_back_to_thumb_offset_and_still_posts(cover_world):
    cover_world["state"]["storage"].cover_fail = PublishStorageError("Rejected", "upload_rejected", 502)
    publisher = cover_world["make_covers"]()
    _, attempt = post(cover_world, publisher=publisher, package={"cover_time_ms": 7000})
    publisher.run(attempt["id"])
    row = publisher.get(attempt["id"])
    args = create_args(cover_world)[0]
    assert row["state"] == "mapped" and row["cover_mode"] == "thumb_offset"
    assert args["thumb_offset"] == 7000 and "cover_url" not in args
    assert "cover_upload_failed" in row["warnings"]


def test_hosted_cover_that_vanished_before_container_falls_back(cover_world):
    publisher = cover_world["make_covers"]()
    _, attempt = post(cover_world, publisher=publisher)
    publisher._upload(attempt, cover_world["store"].get("clips", "clip-1"))
    storage = cover_world["state"]["storage"]
    storage.public.discard(publisher.get(attempt["id"])["cover_url"])
    publisher.run(attempt["id"])
    row = publisher.get(attempt["id"])
    assert create_args(cover_world)[0]["thumb_offset"] == 4250 and "cover_url_unavailable" in row["warnings"]


def test_cover_candidates_include_the_auto_frame_and_stay_inside_the_clip(cover_world):
    times = post_package.candidate_times(cover_world["clip"])
    assert len(times) == 6 and 4250 in times and min(times) >= 0 and max(times) <= 20000
    publisher = cover_world["make_covers"]()
    with pytest.raises(PublishError) as error:
        post(cover_world, publisher=publisher, package={"cover_time_ms": 25000})
    assert error.value.code == "invalid_cover"


def test_storage_cover_upload_path_and_type(tmp_path):
    class Session:
        user_id, access_token = USER, "token"

    class Client:
        session = Session()

        class config:
            url, publishable_key = "https://cloud.example", "pk"

        def refresh(self):
            pass

    class Account:
        client = Client()

        def link(self):
            return {"user_id": USER}

        def status(self):
            return {"signed_in": True}

    seen = []

    def handler(request):
        seen.append((request.method, str(request.url), request.headers.get("content-type")))
        if request.method == "HEAD":
            return httpx.Response(200, headers={"content-type": "image/jpeg", "content-length": "5"})
        return httpx.Response(200, json={"Key": "ok"})

    jpg = tmp_path / "c.jpg"
    jpg.write_bytes(b"\xff\xd8abc")
    storage = PublishStorage(Account(), transport=httpx.MockTransport(handler))
    hosted = storage.upload_cover(jpg, "a" * 64)
    assert hosted["object"] == f"{USER}/{'a' * 64}.jpg"
    assert seen[0] == ("POST", f"https://cloud.example/storage/v1/object/gf-publish/{USER}/{'a' * 64}.jpg",
                       "image/jpeg")
    big = tmp_path / "big.jpg"
    big.write_bytes(b"x" * (8 * 1024 * 1024 + 1))
    with pytest.raises(PublishStorageError, match="8 MB"):
        storage.upload_cover(big, "b" * 64)


# ----------------------------------------------------------------------------- scheduling

class Clock:
    def __init__(self):
        self.now = datetime(2026, 11, 14, 12, 0, tzinfo=UTC)

    def __call__(self):
        return self.now


def schedule(w, scheduler, *, at=None, captions=None, accounts=("acct-1", "acct-2"), **kw):
    at = at or (scheduler.clock() + timedelta(hours=7)).isoformat()
    captions = captions or {a: "Shared caption #reel" for a in accounts}
    return scheduler.schedule("clip-1", list(accounts), captions, w["clip"]["sha256"], at, **kw)


def test_schedule_lifecycle_posts_on_time_with_per_account_captions(cover_world):
    clock, publisher = Clock(), cover_world["make_covers"]()
    scheduler = PostScheduler(cover_world["store"], publisher, clock=clock)
    row = schedule(cover_world, scheduler, captions={"acct-1": "Shared caption #reel",
                                                     "acct-2": "Second account's own words"},
                   timezone="America/New_York", package={"cover_time_ms": 7000})
    assert row["lane"] == "instagram_post" and row["status"] == "scheduled"
    assert row["note"] == "The app must be open at that time."
    assert [a["state"] for a in row["attempts"]] == ["scheduled", "scheduled"]
    assert {a["caption"] for a in row["attempts"]} == {"Shared caption #reel", "Second account's own words"}
    assert all(a["scheduled_for"] == row["publish_at"] and a["schedule_id"] == row["id"] for a in row["attempts"])
    # Archive guard sees it (same `schedules` kind and status).
    assert cover_world["store"].get("schedules", row["id"])["status"] == "scheduled"
    scheduler.tick()
    assert not cover_world["state"]["client"].calls and not cover_world["state"]["storage"].uploads
    with pytest.raises(PublishError) as error:  # one attempt per account per clip, even scheduled
        post(cover_world, publisher=publisher)
    assert error.value.code == "attempt_exists"
    clock.now += timedelta(hours=7, seconds=3)
    scheduler.tick()
    current = scheduler.get(row["id"])
    assert current["status"] == "submitted"
    assert [a["state"] for a in current["attempts"]] == ["created", "created"]
    for attempt in current["attempts"]:
        publisher.run(attempt["id"])
    done = scheduler.get(row["id"])["attempts"]
    assert [a["state"] for a in done] == ["mapped", "mapped"]
    assert all(a["posted_at"] and a["scheduled_for"] for a in done)
    sent = sorted(a["caption"] for a in create_args(cover_world))
    assert sent == ["Second account's own words", "Shared caption #reel"]


def test_overdue_after_reopen_never_posts_without_a_click(cover_world):
    clock, publisher = Clock(), cover_world["make_covers"]()
    first = PostScheduler(cover_world["store"], publisher, clock=clock)
    row = schedule(cover_world, first)
    # App closes; reopens three hours after the scheduled time.
    clock.now += timedelta(hours=10)
    reopened = PostScheduler(cover_world["store"], publisher, clock=clock)
    assert reopened.pending()
    reopened.tick()
    current = reopened.get(row["id"])
    assert current["overdue_at"] and current["status"] == "scheduled"
    assert [a["state"] for a in current["attempts"]] == ["scheduled", "scheduled"]
    for _ in range(3):
        reopened.tick()
    assert not cover_world["state"]["client"].calls and not cover_world["state"]["storage"].uploads
    posted = reopened.decide(row["id"], "post_now")
    assert posted["status"] == "submitted" and posted["decision"]["action"] == "post_now"
    assert [a["state"] for a in posted["attempts"]] == ["created", "created"]


def test_overdue_reschedule_and_cancel(cover_world):
    clock, publisher = Clock(), cover_world["make_covers"]()
    row = schedule(cover_world, PostScheduler(cover_world["store"], publisher, clock=clock))
    clock.now += timedelta(hours=8)
    scheduler = PostScheduler(cover_world["store"], publisher, clock=clock)
    scheduler.tick()
    with pytest.raises(PublishError):
        scheduler.decide(row["id"], "reschedule", (clock.now - timedelta(minutes=5)).isoformat())
    later = (clock.now + timedelta(days=1)).isoformat()
    moved = scheduler.decide(row["id"], "reschedule", later)
    assert moved["overdue_at"] is None and moved["publish_at"] == datetime.fromisoformat(later).isoformat()
    assert all(a["scheduled_for"] == moved["publish_at"] for a in moved["attempts"])
    cancelled = scheduler.decide(row["id"], "cancel")
    assert cancelled["status"] == "cancelled" and {a["state"] for a in cancelled["attempts"]} == {"cancelled"}
    with pytest.raises(PublishError) as error:
        scheduler.decide(row["id"], "post_now")
    assert error.value.code == "not_scheduled"
    _, again = post(cover_world, publisher=publisher)  # cancelled attempts do not block a new post
    assert again["state"] == "created"
    assert not cover_world["state"]["client"].calls


def test_mac_asleep_past_grace_is_overdue_not_late_posted(cover_world):
    clock, publisher = Clock(), cover_world["make_covers"]()
    scheduler = PostScheduler(cover_world["store"], publisher, clock=clock)
    row = schedule(cover_world, scheduler)
    clock.now += timedelta(hours=7, minutes=30)
    scheduler.tick()
    assert scheduler.get(row["id"])["overdue_at"] and not cover_world["state"]["storage"].uploads


def test_schedule_is_all_or_nothing_and_rechecks_at_post_time(cover_world):
    clock, publisher = Clock(), cover_world["make_covers"]()
    scheduler = PostScheduler(cover_world["store"], publisher, clock=clock)
    with pytest.raises(PublishError) as error:
        schedule(cover_world, scheduler, captions={"acct-1": "ok", "acct-2": "x" * 2201})
    assert error.value.code == "schedule_invalid"
    assert not cover_world["store"].all("schedules") and not cover_world["store"].all("publish_attempts")
    with pytest.raises(PublishError):
        schedule(cover_world, scheduler, at=(clock.now + timedelta(seconds=20)).isoformat())
    with pytest.raises(PublishError):
        schedule(cover_world, scheduler, at="2026-11-15T09:00:00")  # no timezone
    row = schedule(cover_world, scheduler, accounts=("acct-1",))
    # The gate holds at post time and there is no override: nothing is sent; the attempt fails definitely.
    publisher.gate = holding_gate
    publisher.store.delete("quality_reports", f"clip-1:{cover_world['clip']['sha256']}")
    clock.now += timedelta(hours=7, seconds=1)
    scheduler.tick()
    attempt = scheduler.get(row["id"])["attempts"][0]
    assert attempt["state"] == "failed" and attempt["error"]["code"] == "quality_hold"
    assert not cover_world["state"]["client"].calls


def test_legacy_runner_skips_post_lane_and_legacy_cancel_cancels_attempts(cover_world):
    clock, publisher = Clock(), cover_world["make_covers"]()
    scheduler = PostScheduler(cover_world["store"], publisher, clock=clock)
    row = schedule(cover_world, scheduler, accounts=("acct-1",))
    cover_world["store"].patch("schedules", row["id"], status="cancelled")  # DELETE /api/schedules/{id}
    scheduler.tick()
    assert scheduler.get(row["id"])["attempts"][0]["state"] == "cancelled"


def test_no_write_tool_was_executed_in_this_module(cover_world):
    # The fake client records every tool; scheduling and packaging alone never reach it.
    clock, publisher = Clock(), cover_world["make_covers"]()
    schedule(cover_world, PostScheduler(cover_world["store"], publisher, clock=clock))
    assert CREATE not in cover_world["state"]["client"].slugs()
    assert PUBLISH not in cover_world["state"]["client"].slugs()
