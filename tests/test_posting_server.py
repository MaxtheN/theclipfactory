"""Posting-server client (mocked HTTP), analytics parsing, posting accounts and metric collection."""

import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest

from clip_factory.autonomy_runtime import AutonomyRuntime, WorkError
from clip_factory.cloud import CloudError
from clip_factory.posting_accounts import INTENTS, PostingAccounts
from clip_factory.posting_server import PostingServerClient, PostingServerError, parse_analytics
from clip_factory.publisher import PublishError
from clip_factory.store import Store
from tests.test_publisher import WORKSPACE, zernio_id

USER = "6c8f2b1e-4a1d-4f7e-9b0a-1d2c3e4f5a6b"
POST = zernio_id("post-1")
ACCT = zernio_id("acct-1")


class Cloud:
    """Just enough of CloudAccount for the client: a link, a status and a refreshable session."""

    def __init__(self, *, user=USER, workspace=WORKSPACE, signed_in=True):
        self.linked = {"user_id": USER, "workspace_id": workspace}
        self.signed_in, self.refreshes = signed_in, 0
        cloud = self

        class Client:
            config = SimpleNamespace(url="https://cloud.example/", publishable_key="pk-test")
            session = SimpleNamespace(user_id=user, access_token="token-1")

            def refresh(self):
                cloud.refreshes += 1
                if cloud.refresh_error:
                    raise cloud.refresh_error
                self.session = SimpleNamespace(user_id=self.session.user_id,
                                               access_token=f"token-{cloud.refreshes + 1}")
                return self.session

        self.refresh_error = None
        self.client = Client()

    def link(self):
        return self.linked

    def status(self):
        return {"signed_in": self.signed_in}


def client(handler, cloud=None):
    return PostingServerClient(cloud or Cloud(), transport=httpx.MockTransport(handler))


def reply(status, body=None, **kw):
    return httpx.Response(status, json=body if body is not None else {}, **kw)


# ---------------------------------------------------------------- client

def test_requests_carry_session_workspace_and_filter_accounts():
    seen = []

    def handler(request):
        seen.append(request)
        return reply(200, {"accounts": [{"id": ACCT, "platform": "tiktok"}, {"id": "short", "platform": "tiktok"},
                                        {"id": zernio_id("x"), "platform": "myspace"}, "junk"]})

    rows = client(handler).accounts()
    assert rows == [{"id": ACCT, "platform": "tiktok"}]
    request = seen[0]
    assert str(request.url) == "https://cloud.example/functions/v1/posting/accounts"
    assert request.headers["X-GF-Workspace"] == WORKSPACE and request.headers["apikey"] == "pk-test"
    assert request.headers["Authorization"] == "Bearer token-1" and "Idempotency-Key" not in request.headers


def test_expired_token_is_refreshed_once_and_resent():
    tokens = []

    def handler(request):
        tokens.append(request.headers["Authorization"])
        if len(tokens) == 1:
            return reply(401, {"error": {"code": "session_expired", "message": "expired"}})
        return reply(201, {"replayed": False, "post": {"id": POST, "platforms": []}})

    cloud = Cloud()
    created = client(handler, cloud).create_post({"content": "x"}, "gf-attempt-1234")
    assert created == {"replayed": False, "post": {"id": POST, "platforms": []}}
    assert tokens == ["Bearer token-1", "Bearer token-2"] and cloud.refreshes == 1
    # A second 401 is surfaced; it is the server's definite refusal, not uncertain.
    always = client(lambda r: reply(401, {"error": {"code": "session_expired", "message": "Sign in."}}))
    with pytest.raises(PostingServerError) as error:
        always.create_post({}, "gf-attempt-1234")
    assert error.value.status == 401 and error.value.uncertain is False
    cloud = Cloud()
    cloud.refresh_error = CloudError("Your cloud session expired. Sign in again.", 401)
    with pytest.raises(PostingServerError) as error:
        client(lambda r: reply(401), cloud).accounts()
    assert error.value.code == "sign_in_required"


@pytest.mark.parametrize("cloud,message", [
    (Cloud(signed_in=False), "Sign in"),
    (Cloud(user="someone-else"), "does not match"),
    (Cloud(workspace=None), "link a cloud workspace"),
])
def test_session_must_match_the_linked_workspace(cloud, message):
    calls = []
    with pytest.raises(PostingServerError) as error:
        client(lambda r: calls.append(r) or reply(200), cloud).accounts()
    assert error.value.code == "sign_in_required" and message in error.value.message and calls == []


def test_write_outcomes_unknown_after_timeout_network_or_5xx_but_reads_and_4xx_are_definite():
    def raising(exc):
        def handler(request):
            raise exc
        return handler

    for handler, code in ((raising(httpx.ReadTimeout("slow")), "timeout"),
                          (raising(httpx.ConnectError("down")), "network"),
                          (lambda r: reply(502, {"error": {"code": "zernio_unavailable", "message": "down"}}),
                           "zernio_unavailable")):
        with pytest.raises(PostingServerError) as error:
            client(handler).create_post({}, "gf-attempt-1234")
        assert error.value.code == code and error.value.uncertain is True
        with pytest.raises(PostingServerError) as error:
            client(handler).get_post(POST)
        assert error.value.uncertain is False
    limited = client(lambda r: reply(429, {"error": {"code": "zernio_rate_limited", "message": "Slow down."}},
                                     headers={"Retry-After": "30"}))
    with pytest.raises(PostingServerError) as error:
        limited.create_post({}, "gf-attempt-1234")
    assert (error.value.status, error.value.code, error.value.retry_after) == (429, "zernio_rate_limited", "30")
    assert error.value.uncertain is False
    garbled = client(lambda r: httpx.Response(400, content=b"<html>nope"))
    with pytest.raises(PostingServerError) as error:
        garbled.accounts()
    assert error.value.code == "posting_error" and "<html>" not in error.value.message


def test_post_routes_keys_and_ids():
    seen = []

    def handler(request):
        seen.append(request)
        if request.method == "GET" and request.url.path.endswith("/posts"):
            return reply(200, {"posts": [{"id": POST}, {"id": "bad"}]})
        if request.url.path.endswith("/analytics"):
            return reply(200, {"status": "syncing", "analytics": None})
        return reply(200, {"post": {"id": POST}, "replayed": True})

    api = client(handler)
    assert api.create_post({"content": "x"}, "gf-attempt-abcd")["replayed"] is True
    assert seen[-1].headers["Idempotency-Key"] == "gf-attempt-abcd"
    assert json.loads(seen[-1].content) == {"content": "x"}
    assert api.find_posts("gf-abcd") == [{"id": POST}]
    assert seen[-1].url.params["externalId"] == "gf-abcd"
    assert api.get_post(POST)["post"]["id"] == POST
    assert api.analytics(POST)["status"] == "syncing"
    count = len(seen)
    for call in (lambda: api.get_post("../accounts"), lambda: api.disconnect("x"),
                 lambda: api.create_post({}, "bad key!")):
        with pytest.raises(PostingServerError) as error:
            call()
        assert error.value.status == 400
    assert len(seen) == count  # rejected before any request
    broken = client(lambda r: reply(201, {"post": {"id": "nope"}}))
    with pytest.raises(PostingServerError) as error:
        broken.create_post({}, "gf-attempt-1234")
    assert error.value.uncertain is True  # it may exist; read it back


def test_upload_presigns_then_puts_the_exact_bytes(tmp_path):
    path = tmp_path / "clip.mp4"
    path.write_bytes(b"video-bytes")
    seen = []

    def handler(request):
        seen.append((request.method, str(request.url), dict(request.headers), request.read()))
        if request.url.host == "cloud.example":
            return reply(200, {"uploadUrl": "https://storage.example/put?sig=1",
                               "publicUrl": "https://media.example/clip.mp4"})
        return httpx.Response(200)

    assert client(handler).upload(path, "video/mp4") == "https://media.example/clip.mp4"
    presign, put = seen
    assert json.loads(presign[3]) == {"filename": "clip.mp4", "contentType": "video/mp4", "size": 11}
    assert put[0] == "PUT" and put[1] == "https://storage.example/put?sig=1" and put[3] == b"video-bytes"
    assert put[2]["content-type"] == "video/mp4" and put[2]["content-length"] == "11"
    assert "authorization" not in put[2] and "x-gf-workspace" not in put[2]

    def refusing(request):
        if request.url.host == "cloud.example":
            return reply(200, {"uploadUrl": "https://storage.example/put", "publicUrl": "https://media.example/x"})
        return httpx.Response(403)

    with pytest.raises(PostingServerError) as error:
        client(refusing).upload(path, "video/mp4")
    assert error.value.code == "upload_rejected" and error.value.uncertain is False
    with pytest.raises(PostingServerError) as error:
        client(lambda r: reply(200, {"uploadUrl": "http://plain"})).upload(path, "video/mp4")
    assert error.value.code == "invalid_response"


# ---------------------------------------------------------------- analytics

def zernio_analytics(values, *, platform="instagram", sync="synced"):
    return {"status": "ready", "analytics": {
        "postId": POST, "publishedAt": "2026-11-18T10:00:00Z", "platformPostUrl": "https://instagram.com/reel/x",
        "analytics": values, "platforms": [{"platform": platform, "syncStatus": sync}]}}


def test_unreported_metrics_are_none_never_zero():
    values = {"impressions": 0, "reach": 90, "likes": 7, "comments": 0, "shares": 1, "saves": 2, "clicks": 0,
              "views": 120, "engagementRate": 3.1}
    instagram = parse_analytics(zernio_analytics(values), "instagram")
    assert instagram["status"] == "ready" and instagram["url"] == "https://instagram.com/reel/x"
    assert instagram["metrics"] == {"views": 120.0, "reach": 90.0, "impressions": 0.0, "likes": 7.0,
                                    "comments": 0.0, "shares": 1.0, "saved": 2.0, "clicks": None}
    youtube = parse_analytics(zernio_analytics(values, platform="youtube"), "youtube")["metrics"]
    assert youtube["views"] == 120.0 and youtube["reach"] is None and youtube["saved"] is None
    assert youtube["impressions"] is None and youtube["shares"] is None
    odd = parse_analytics(zernio_analytics({"views": -1, "likes": True, "comments": "3"}), "instagram")
    assert odd["metrics"]["views"] is None and odd["metrics"]["likes"] is None and odd["metrics"]["comments"] is None


def test_syncing_pending_unavailable_and_list_shapes():
    assert parse_analytics({"status": "syncing", "analytics": None}, "instagram")["status"] == "syncing"
    assert parse_analytics(zernio_analytics({"views": 5}, sync="pending"), "instagram")["status"] == "syncing"
    unavailable = parse_analytics(zernio_analytics({"views": 0}, sync="unavailable"), "instagram")
    assert unavailable == {"status": "unavailable", "metrics": {}, "published_at": "2026-11-18T10:00:00Z",
                           "url": None}
    assert parse_analytics({"status": "ready", "analytics": {}}, "instagram")["status"] == "unavailable"
    listed = {"status": "ready", "analytics": {"posts": [zernio_analytics({"views": 4})["analytics"]]}}
    assert parse_analytics(listed, "instagram")["metrics"]["views"] == 4.0


# ---------------------------------------------------------------- metric collection

def collect(server, platform="tiktok"):
    runtime = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        posting_accounts=SimpleNamespace(server_factory=lambda: server))))
    account = {"id": ACCT, "platform": platform}
    publication = {"media_id": POST, "published_at": "2026-11-18T10:00:00+00:00"}
    return AutonomyRuntime._collect_posting(runtime, account, publication)


def test_runtime_collects_through_the_posting_server():
    class Server:
        def __init__(self, result):
            self.result = result

        def analytics(self, post_id):
            if isinstance(self.result, Exception):
                raise self.result
            return self.result

    snapshot = collect(Server(zernio_analytics({"views": 50, "likes": 4, "reach": 0}, platform="tiktok")))
    assert snapshot["metrics"]["views"] == 50.0 and snapshot["metrics"]["reach"] is None
    assert snapshot["source"] == "TikTok post metrics via the posting service (Zernio)"
    assert snapshot["media_id"] == POST and snapshot["cumulative"] is True
    with pytest.raises(WorkError, match="syncing"):
        collect(Server({"status": "syncing", "analytics": None}))
    with pytest.raises(WorkError, match="could not be read"):
        collect(Server(PostingServerError(502, "zernio_unavailable", "down")))
    failed = collect(Server(PostingServerError(424, "analytics_failed", "Every platform failed.")))
    assert failed["metrics"] and all(v is None for v in failed["metrics"].values())
    with pytest.raises(WorkError, match="Sign in"):
        collect(None)


# ---------------------------------------------------------------- posting accounts

class Remote:
    def __init__(self, rows):
        self.rows, self.urls, self.removed = rows, [], []

    def accounts(self):
        return [dict(r) for r in self.rows]

    def connect(self, platform, redirect_url):
        self.urls.append(redirect_url)
        return "https://zernio.example/connect"

    def disconnect(self, account_id):
        self.removed.append(account_id)


class Engine:
    def __init__(self, store):
        self.store = store

    def list_policies(self):
        return self.store.all("learning_policies")


@pytest.fixture
def accounts(tmp_path):
    store = Store(tmp_path)
    store.put("profiles", {"id": "prof-1"})
    remote = Remote([{"id": ACCT, "platform": "instagram", "username": "brand"}])
    clock = SimpleNamespace(now=datetime(2026, 11, 19, 12, tzinfo=UTC))
    manager = PostingAccounts(store, server_factory=lambda: remote, engine=Engine(store),
                              clock=lambda: clock.now)
    return SimpleNamespace(store=store, remote=remote, manager=manager, clock=clock)


def test_sync_creates_unbound_accounts_and_marks_needs_reconnect(accounts):
    rows = accounts.manager.sync()
    assert rows[0]["status"] == "unbound" and rows[0]["display_name"] == "brand"
    assert rows[0]["publishing_permitted"] is False and rows[0]["profile_id"] is None
    accounts.manager.bind(ACCT, "prof-1")
    accounts.remote.rows[0]["connected"] = False
    assert accounts.manager.sync()[0]["status"] == "needs_reconnect"
    with pytest.raises(PublishError) as error:
        accounts.manager.bind(ACCT, "prof-1")
    assert error.value.code == "account_unavailable"


def test_connect_intent_expires_and_never_binds_late(accounts):
    started = accounts.manager.connect("tiktok", "prof-1", lambda identifier: f"http://127.0.0.1/cb/{identifier}")
    assert accounts.remote.urls == [f"http://127.0.0.1/cb/{started['request_id']}"]
    assert started["opened"] is False  # no browser opener configured
    assert accounts.store.get(INTENTS, started["request_id"])["known_account_ids"] == []
    accounts.clock.now += timedelta(minutes=31)
    accounts.remote.rows.append({"id": zernio_id("tt"), "platform": "tiktok"})
    assert accounts.manager.is_pending(started["request_id"]) is False
    status = accounts.manager.connect_status(started["request_id"])
    assert status["status"] == "expired" and status["account"] is None
    assert accounts.store.get("connected_accounts", zernio_id("tt"))["status"] == "unbound"
    with pytest.raises(PublishError):
        accounts.manager.connect("tiktok", "missing-profile", lambda i: i)


def test_disconnect_disables_that_accounts_learning_policies(accounts):
    accounts.manager.sync()
    accounts.manager.bind(ACCT, "prof-1")
    accounts.manager.set_permission(ACCT, True)
    accounts.store.put("learning_policies", {"id": "p-1", "account_id": ACCT, "enabled": True})
    accounts.store.put("learning_policies", {"id": "p-2", "account_id": "other", "enabled": True})
    result = accounts.manager.disconnect(ACCT)
    assert result["provider_access_revoked"] is True and accounts.remote.removed == [ACCT]
    assert accounts.store.get("learning_policies", "p-1")["enabled"] is False
    assert accounts.store.get("learning_policies", "p-2")["enabled"] is True
    row = accounts.store.get("connected_accounts", ACCT)
    assert row["status"] == "disconnected" and row["publishing_permitted"] is False
