"""Plans and Billing in the engine: Entitlement cache, Usage, Plan Limits, server plan refusals, holds."""

import json
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from clip_factory import billing
from clip_factory.app import create_app
from clip_factory.billing import (
    BillingClient,
    EntitlementService,
    PlanGate,
    PlanLimitError,
    Usage,
    install,
    install_gate,
    route_limits,
)
from clip_factory.cloud import AuthSession, CloudError
from clip_factory.post_schedule import HELD, KIND, LANE, NOTE, RELEASED_LATE, PostScheduler
from clip_factory.posting_server import _error
from clip_factory.publish_api import _http
from clip_factory.publisher import PublishError, _from_server
from clip_factory.store import Store

pytestmark = pytest.mark.plans

ROOT = Path(__file__).resolve().parents[1]
SESSION = "billing-session-token"
T0 = datetime(2026, 11, 19, 12, 0, tzinfo=UTC)


# ---------------------------------------------------------------------------------------------- fakes
class FakeSupabase:
    def __init__(self, user="user-1"):
        self.config = SimpleNamespace(url="https://example.supabase.co", publishable_key="sb_publishable_test")
        self.session = AuthSession(user, "a@example.com", "token-1")
        self.user, self.refreshed, self.fail_refresh = user, 0, False

    def refresh(self):
        self.refreshed += 1
        if self.fail_refresh:
            raise CloudError("Your cloud session expired. Sign in again.", 401)
        self.session = AuthSession(self.user, "a@example.com", f"token-{self.refreshed + 1}")
        return self.session


class FakeAccount:
    def __init__(self, user="user-1", signed_in=True):
        self.client, self.user, self.signed_in = FakeSupabase(user), user, signed_in

    def link(self):
        return {"user_id": self.user, "workspace_id": "w"} if self.signed_in else None

    def status(self):
        return {"configured": True, "signed_in": self.signed_in}


def entitlement(plan="pro", **overrides):
    return {"plan": plan, "status": "active" if plan != "free" else "none", "interval": "month",
            "current_period_end": "2026-12-19T12:00:00+00:00", "cancel_at_period_end": False,
            "payment_problem": False, "has_subscription": plan != "free",
            "limits": dict(billing.PLANS[plan]["limits"]), **overrides}


class Cloud:
    """A scripted billing function: answers, request log, and an offline switch."""

    def __init__(self, plan="pro"):
        self.plan, self.calls, self.offline, self.expired_once = plan, [], False, False
        self.override = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        if self.offline:
            raise httpx.ConnectError("offline", request=request)
        if self.expired_once:
            self.expired_once = False
            return httpx.Response(401, json={"error": {"code": "unauthorized", "message": "expired"}})
        if self.override is not None:
            return self.override
        path = request.url.path.removeprefix("/functions/v1/billing")
        if path == "/entitlement":
            return httpx.Response(200, json={"entitlement": entitlement(self.plan), "plans": [], "checked_at": "x"})
        if path == "/checkout":
            return httpx.Response(200, json={"url": "https://checkout.stripe.com/c/pay/cs_test"})
        if path == "/portal":
            return httpx.Response(200, json={"url": "https://billing.stripe.com/p/session/test"})
        return httpx.Response(404, json={"error": {"code": "not_found", "message": "Not found."}})

    def factory(self, account):
        return BillingClient(account, transport=httpx.MockTransport(self.handler))


class Clock:
    def __init__(self, moment=T0):
        self.moment = moment

    def __call__(self):
        return self.moment

    def advance(self, **delta):
        self.moment += timedelta(**delta)


def service(tmp_path, cloud=None, account=None, clock=None):
    store = Store(tmp_path)
    account = account if account is not None else FakeAccount()
    cloud = cloud or Cloud()
    clock = clock or Clock()
    return EntitlementService(store, lambda: account, client_factory=cloud.factory, clock=clock), store, cloud, clock


class Fixed:
    """An EntitlementService stand-in for gate tests."""

    def __init__(self, plan="free"):
        self.plan = plan

    def current(self, refresh=False):
        return {**entitlement(self.plan), "name": billing.PLANS[self.plan]["name"], "state": "confirmed"}


# ---------------------------------------------------------------------------------------------- plans
def test_plans_match_the_published_price_list():
    published = json.loads((ROOT / "landing-page" / "plans.json").read_text())
    assert published["currency"] == "usd"
    assert billing.plan_list() == published["plans"]


# ---------------------------------------------------------------------------------------------- client
def test_client_sends_the_session_and_refreshes_once_on_401(tmp_path):
    cloud, account = Cloud(), FakeAccount()
    cloud.expired_once = True
    result = cloud.factory(account).entitlement()
    assert result["plan"] == "pro"
    assert account.client.refreshed == 1
    first, second = cloud.calls
    assert first.headers["authorization"] == "Bearer token-1" and second.headers["authorization"] == "Bearer token-2"
    assert second.headers["apikey"] == "sb_publishable_test"
    assert str(second.url) == "https://example.supabase.co/functions/v1/billing/entitlement"


def test_client_errors_are_short_and_credential_safe():
    cloud = Cloud()
    cloud.override = httpx.Response(409, json={"error": {"code": "subscription_exists", "message": "Use Manage billing."}})
    with pytest.raises(billing.BillingError) as error:
        cloud.factory(FakeAccount()).checkout("pro", "month")
    assert (error.value.status, error.value.code, error.value.message) == (409, "subscription_exists", "Use Manage billing.")
    cloud.override = httpx.Response(200, json={"url": "http://not-https.example"})
    with pytest.raises(billing.BillingError, match="invalid billing link"):
        cloud.factory(FakeAccount()).portal()
    cloud.override, cloud.offline = None, True
    with pytest.raises(billing.BillingError) as error:
        cloud.factory(FakeAccount()).entitlement()
    assert error.value.code == "network"
    with pytest.raises(billing.BillingError) as error:
        cloud.factory(FakeAccount(signed_in=False)).entitlement()
    assert error.value.status == 401


# ---------------------------------------------------------------------------------------------- entitlement
def test_free_when_not_configured_or_signed_out(tmp_path):
    store = Store(tmp_path)
    assert EntitlementService(store, lambda: None).current()["state"] == "not_configured"
    signed_out, _, cloud, _ = service(tmp_path, account=FakeAccount(signed_in=False))
    result = signed_out.current()
    assert (result["plan"], result["state"], result["limits"]["posting"]) == ("free", "signed_out", False)
    assert cloud.calls == []


def test_confirmed_entitlement_is_cached_for_ten_minutes(tmp_path):
    entitlements, store, cloud, clock = service(tmp_path)
    first = entitlements.current()
    assert (first["plan"], first["name"], first["state"]) == ("pro", "Pro", "confirmed")
    assert first["confirmed_at"] == T0.isoformat()
    assert store.get("billing", "entitlement")["user_id"] == "user-1"
    clock.advance(minutes=9)
    entitlements.current()
    assert len(cloud.calls) == 1
    clock.advance(minutes=2)
    cloud.plan = "business"
    assert entitlements.current()["plan"] == "business"
    assert len(cloud.calls) == 2
    cloud.plan = "pro"
    assert entitlements.current(refresh=True)["plan"] == "pro"
    entitlements.mark_stale()
    entitlements.current()
    assert len(cloud.calls) == 4


def test_offline_grace_then_free_until_confirmed_again(tmp_path):
    entitlements, _, cloud, clock = service(tmp_path)
    entitlements.current()
    cloud.offline = True
    clock.advance(days=6, hours=23)
    held = entitlements.current()
    assert (held["plan"], held["state"], held["confirmed_at"]) == ("pro", "offline", T0.isoformat())
    assert held["grace_ends_at"] == (T0 + timedelta(days=7)).isoformat()
    calls = len(cloud.calls)
    entitlements.current()  # backs off: no network wait for every gated request
    assert len(cloud.calls) == calls
    clock.advance(hours=2)
    expired = entitlements.current()
    assert (expired["plan"], expired["state"], expired["limits"]) == ("free", "expired", billing.PLANS["free"]["limits"])
    cloud.offline = False
    clock.advance(seconds=61)
    assert entitlements.current()["state"] == "confirmed"  # reconnects without the creator's action


def test_cache_belongs_to_one_user_and_expired_sessions_are_free(tmp_path):
    entitlements, store, cloud, _ = service(tmp_path)
    entitlements.current()
    other = FakeAccount(user="user-2")
    cloud.offline = True
    result = EntitlementService(store, lambda: other, client_factory=cloud.factory, clock=Clock()).current()
    assert (result["plan"], result["state"]) == ("free", "expired")
    cloud.offline = False
    gone = FakeAccount()
    gone.client.session, gone.client.fail_refresh = None, True
    result = EntitlementService(store, lambda: gone, client_factory=cloud.factory, clock=Clock()).current(refresh=True)
    assert (result["plan"], result["state"]) == ("free", "signed_out")


def test_server_limits_win_when_well_formed(tmp_path):
    assert billing.normalize(entitlement("pro", limits={"brands": 5}))["limits"]["brands"] == 5
    odd = billing.normalize(entitlement("pro", limits={"brands": "9", "posting": "yes", "clips_per_month": -1}))
    assert odd["limits"] == billing.PLANS["pro"]["limits"]
    assert billing.normalize({"plan": "enterprise"}) is None


# ---------------------------------------------------------------------------------------------- usage
def test_clip_usage_counts_this_calendar_month_in_the_creators_time_zone(tmp_path):
    store = Store(tmp_path)
    zone = ZoneInfo("America/Los_Angeles")
    store.put_many([
        ("clips", {"id": "october", "created_at": "2026-11-01T06:00:00+00:00"}),  # Oct 31, 11pm in LA
        ("clips", {"id": "november", "created_at": "2026-11-01T08:00:00+00:00"}),  # Nov 1, 1am in LA
        ("clips", {"id": "sim-clip-1"}),
        ("clips", {"id": "demo", "simulated": True, "created_at": "2026-11-10T00:00:00+00:00"}),
    ])
    usage = Usage(store, clock=lambda: T0, zone=zone)
    assert usage.clips_this_month() == 1
    summary = usage.summary()
    assert summary["resets_at"].startswith("2026-12-01T00:00:00")
    assert Usage(store, clock=lambda: datetime(2026, 12, 1, 9, tzinfo=UTC), zone=zone).clips_this_month() == 0


def test_connected_accounts_count_only_live_posting_accounts(tmp_path):
    store = Store(tmp_path)
    store.put_many([
        ("connected_accounts", {"id": "a", "provider": "zernio", "status": "active"}),
        ("connected_accounts", {"id": "b", "provider": "zernio", "status": "disconnected"}),
        ("connected_accounts", {"id": "c", "provider": "composio", "status": "active"}),
    ])
    assert Usage(store).connected_accounts() == 1


# ---------------------------------------------------------------------------------------------- gate
def test_route_table():
    assert route_limits("POST", "/api/profiles") == ("brands",)
    assert route_limits("GET", "/api/profiles") == ()
    assert route_limits("POST", "/api/videos/v1/team") == ("clips_per_month",)
    assert route_limits("POST", "/api/clips/c1/post") == ("posting", "over_limit")
    assert route_limits("POST", "/api/posting/connect") == ("posting", "connected_accounts")
    for open_route in ("/api/clips/c1/export", "/api/demo-loop/p/simulate", "/api/automation/publications",
                       "/api/posting/accounts/a/disconnect", "/api/videos/v1/storyboard"):
        assert route_limits("POST", open_route) == ()


def test_gate_limits_and_messages(tmp_path):
    store = Store(tmp_path)
    store.put("profiles", {"id": "p1"})
    store.put_many([("clips", {"id": f"c{i}", "created_at": T0.isoformat()}) for i in range(20)])
    usage = Usage(store, clock=lambda: T0, zone=UTC)
    free = PlanGate(Fixed("free"), usage)
    brands = free.refusal(("brands",))
    assert (brands.limit, brands.usage, brands.max, brands.plan) == ("brands", 1, 1, "free")
    assert "Free plan includes 1 brand" in brands.message
    clips = free.refusal(("clips_per_month",))
    assert (clips.usage, clips.max) == (20, 20) and "December 1" in clips.message
    assert free.refusal(("posting",)).limit == "posting"
    assert free.refusal(("factory_builder",)).limit == "factory_builder"
    pro = PlanGate(Fixed("pro"), usage)
    assert pro.refusal(("clips_per_month", "brands", "posting")) is None
    assert pro.refusal(("factory_builder",)).limit == "factory_builder"
    store.put_many([("connected_accounts", {"id": f"a{i}", "provider": "zernio", "status": "active"})
                    for i in range(4)])
    assert pro.refusal(("posting", "connected_accounts")).usage == 4
    over = pro.posting_refusal()
    assert (over.limit, over.usage, over.max) == ("connected_accounts", 4, 3)
    assert PlanGate(Fixed("business"), usage).posting_refusal() is None


def test_free_app_returns_402_after_the_session_check(tmp_path, monkeypatch):
    with TestClient(create_app(tmp_path, token=SESSION), base_url="http://127.0.0.1",
                    headers={"X-Clip-Token": SESSION}) as client:
        # The bundled cloud config with no sign-in: the Free plan.
        state = client.get("/api/billing").json()
        assert state["entitlement"]["plan"] == "free"
        assert state["usage"]["brands"] == 0 and [p["id"] for p in state["plans"]] == ["free", "pro", "business"]
        assert client.post("/api/profiles", json={"name": "One", "audience": "A"}).status_code == 201
        blocked = client.post("/api/profiles", json={"name": "Two", "audience": "B"})
        assert blocked.status_code == 402
        body = blocked.json()
        assert body["detail"].startswith("The Free plan includes 1 brand")
        assert body["error"] == {"code": "plan_limit", "limit": "brands", "usage": 1, "max": 1, "plan": "free",
                                 "message": body["detail"]}
        assert len(client.get("/api/profiles").json()) == 1
        assert client.post("/api/clips/c1/post", json={}).json()["error"]["limit"] == "posting"
        assert client.post("/api/factory-builder/requests/r1/build", json={}).status_code == 402
        # Without the local session the request never reaches the plan check.
        assert client.post("/api/profiles", json={}, headers={"X-Clip-Token": "wrong"}).status_code == 401


def test_a_broken_plan_check_never_blocks_work(tmp_path):
    app = FastAPI()
    install_gate(app)

    class Broken:
        def refusal(self, limits):
            raise RuntimeError("boom")

    app.state.plan_gate = Broken()

    @app.post("/api/profiles")
    def create():
        return {"ok": True}

    assert TestClient(app).post("/api/profiles").json() == {"ok": True}


# ---------------------------------------------------------------------------------------------- routes
def billing_app(tmp_path, account, cloud):
    app = FastAPI()
    install_gate(app)
    store = Store(tmp_path)
    opened = []
    entitlements = EntitlementService(store, lambda: account, client_factory=cloud.factory)
    install(app, store, lambda: account, open_url=lambda url: opened.append(url) or True, entitlements=entitlements)
    return TestClient(app), opened, entitlements


def test_checkout_and_portal_open_in_the_system_browser(tmp_path):
    cloud = Cloud(plan="free")
    client, opened, _ = billing_app(tmp_path, FakeAccount(), cloud)
    assert client.get("/api/billing").json()["entitlement"]["plan"] == "free"
    response = client.post("/api/billing/checkout", json={"plan": "pro", "interval": "year"})
    assert response.json() == {"url": "https://checkout.stripe.com/c/pay/cs_test", "opened": True}
    assert json.loads(cloud.calls[-1].content) == {"plan": "pro", "interval": "year"}
    assert opened == ["https://checkout.stripe.com/c/pay/cs_test"]
    cloud.plan = "pro"
    assert client.get("/api/billing").json()["entitlement"]["plan"] == "pro"  # checked again after Checkout
    assert client.post("/api/billing/portal").json()["opened"] is True
    assert client.post("/api/billing/checkout", json={"plan": "free"}).status_code == 422


def test_billing_errors_keep_the_plan_and_explain(tmp_path):
    cloud = Cloud()
    client, opened, _ = billing_app(tmp_path, FakeAccount(signed_in=False), cloud)
    response = client.post("/api/billing/checkout", json={"plan": "pro"})
    assert response.status_code == 409 and response.json()["error"]["code"] == "sign_in_required"
    assert opened == [] and cloud.calls == []
    client, opened, _ = billing_app(tmp_path / "b", FakeAccount(), cloud)
    cloud.override = httpx.Response(503, json={"error": {"code": "not_configured", "message": "Not on sale yet."}})
    response = client.post("/api/billing/checkout", json={"plan": "business"})
    assert response.status_code == 502 and response.json()["detail"] == "Not on sale yet."
    app = FastAPI()
    install(app, Store(tmp_path / "c"), lambda: None, open_url=lambda url: True)
    response = TestClient(app).post("/api/billing/portal")
    assert response.status_code == 409 and response.json()["error"]["code"] == "not_configured"
    assert TestClient(app).get("/api/billing").json()["available"] is False


# ---------------------------------------------------------------------------------------------- server refusals
def test_posting_server_plan_refusals_become_upgrade_prompts():
    response = httpx.Response(402, json={"error": {"code": "plan_over_limit", "message": "4 accounts are connected.",
                                                   "limit": "connected_accounts", "usage": 4, "max": 3,
                                                   "plan": "pro"}})
    error = _error(response, write=True)
    assert error.details == {"limit": "connected_accounts", "usage": 4, "max": 3, "plan": "pro"}
    publish = _from_server(error)
    assert (publish.status, publish.code) == (402, "plan_limit")
    limit = _http(publish)
    assert isinstance(limit, PlanLimitError)
    assert limit.body()["error"] == {"code": "plan_limit", "limit": "connected_accounts", "usage": 4, "max": 3,
                                     "plan": "pro", "message": "4 accounts are connected."}
    required = _from_server(_error(httpx.Response(402, json={"error": {"code": "plan_required", "message": "No."}}),
                                   write=False))
    assert required.details["limit"] == "posting"
    other = _from_server(_error(httpx.Response(402, json={"error": {"code": "payment", "message": "x"}}), write=False))
    assert other.code == "payment"


# ---------------------------------------------------------------------------------------------- holds
class FakePublisher:
    def __init__(self):
        self.lock, self.started, self.cancelled = threading.RLock(), [], []

    def start_scheduled(self, attempt_id, note):
        self.started.append(attempt_id)

    def cancel_scheduled(self, attempt_id):
        self.cancelled.append(attempt_id)

    def reschedule(self, attempt_id, stamp):
        pass


def schedule_row(store, identifier, publish_at):
    store.put(KIND, {"id": identifier, "lane": LANE, "clip_id": "c", "account_ids": ["a"], "attempt_ids": [identifier],
                     "publish_at": publish_at.isoformat(), "status": "scheduled", "overdue_at": None, "note": NOTE})


def test_scheduled_posts_are_held_by_the_plan_and_released(tmp_path):
    store, publisher, clock = Store(tmp_path), FakePublisher(), Clock()
    blocked = {"on": True}
    refusal = PublishError(402, "Posting from the app is not included in the Free plan.", "plan_limit",
                           {"limit": "posting", "plan": "free"})
    scheduler = PostScheduler(store, publisher, clock=clock, plan_check=lambda: refusal if blocked["on"] else None)
    schedule_row(store, "soon", T0 + timedelta(minutes=1))
    schedule_row(store, "later", T0 + timedelta(days=2))
    clock.advance(minutes=1, seconds=10)
    scheduler.tick()
    soon, later = store.get(KIND, "soon"), store.get(KIND, "later")
    assert publisher.started == []
    assert (soon["status"], soon["held_code"], soon["note"]) == ("scheduled", HELD, refusal.message)
    assert later["held_code"] == HELD and scheduler.pending()
    with pytest.raises(PublishError) as error:
        scheduler.decide("soon", "post_now")
    assert (error.value.status, error.value.code) == (402, "plan_limit")
    blocked["on"] = False
    scheduler.list()
    soon, later = store.get(KIND, "soon"), store.get(KIND, "later")
    assert soon["overdue_at"] and soon["note"] == RELEASED_LATE and soon["held_code"] is None
    assert later["held_code"] is None and later["note"] == NOTE and not later["overdue_at"]
    scheduler.tick()
    assert publisher.started == []  # a time that passed during the hold always waits for a click
    clock.advance(days=2)
    scheduler.tick()
    assert publisher.started == ["later"]
    scheduler.decide("soon", "post_now")
    assert publisher.started == ["later", "soon"]
