"""Plans, the cached Entitlement, local Plan Limits, and the Plan and Billing routes.

Growth Factory cloud (Supabase Edge Function ``billing``) is the source of truth for the Plan; the
desktop app caches the last confirmed Entitlement in SQLite (kind ``billing``, id ``entitlement``) and
applies it locally:

* fresh for ten minutes, then confirmed again on the next check (or at once via ``/api/billing/refresh``);
* while the cloud cannot be reached, the cached Entitlement holds for a seven-day Offline Grace Period,
  then the Free Plan Limits apply until a confirmation succeeds; failed checks back off for a minute so
  an offline app does not wait on the network for every gated request;
* signed out (or no cloud project in this build): the Free Plan.

Local limits (brands, clips per month, factory builder, and a posting pre-check) are a convenience for
honest clients. Posting is also enforced by the posting server, so a modified app cannot post beyond the
Plan. See docs/billing.md.
"""

from __future__ import annotations

import copy
import logging
import re
import threading
from collections.abc import Callable
from datetime import UTC, datetime, timedelta, tzinfo
from typing import Literal

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from .cloud import CloudError

log = logging.getLogger(__name__)

# Mirror of supabase/functions/_shared/plans.ts and landing-page/plans.json (parity: tests/test_billing.py).
PLANS: dict[str, dict] = {
    "free": {"id": "free", "name": "Free", "price": {"month": 0, "year": 0},
             "limits": {"brands": 1, "clips_per_month": 20, "posting": False, "connected_accounts": 0,
                        "factory_builder": False}},
    "pro": {"id": "pro", "name": "Pro", "price": {"month": 24, "year": 19},
            "limits": {"brands": 3, "clips_per_month": None, "posting": True, "connected_accounts": 3,
                       "factory_builder": False}},
    "business": {"id": "business", "name": "Business", "price": {"month": 200, "year": 160},
                 "limits": {"brands": 15, "clips_per_month": None, "posting": True, "connected_accounts": 30,
                            "factory_builder": True}},
}
PAID_PLANS = ("pro", "business")
CACHE_KIND, CACHE_ID = "billing", "entitlement"
FRESH = timedelta(minutes=10)
GRACE = timedelta(days=7)
RETRY = timedelta(seconds=60)
_MAX_RESPONSE = 256 * 1024
_STATUSES = {"none", "trialing", "active", "past_due", "unpaid", "paused", "canceled", "incomplete",
             "incomplete_expired"}

LIMIT_LABELS = {"brands": "Brands", "clips_per_month": "Clips per month", "posting": "In-app posting",
                "connected_accounts": "Connected accounts", "factory_builder": "Factory builder"}


def plan_list() -> list[dict]:
    return [copy.deepcopy(plan) for plan in PLANS.values()]


def _parse(value) -> datetime | None:
    try:
        moment = datetime.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        return None
    return moment.astimezone(UTC) if moment is not None and moment.tzinfo is not None else None


def _stamp(moment: datetime | None) -> str | None:
    return moment.astimezone(UTC).isoformat() if moment is not None else None


# ---------------------------------------------------------------------------------------------- errors
class BillingError(Exception):
    """Credential-safe: only the server's short code and message."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class PlanLimitError(Exception):
    """An action blocked by a Plan Limit. The API answers 402 with a plain ``detail`` message (shown by any
    client) and a structured ``error`` the Upgrade Prompt reads."""

    def __init__(self, limit: str, message: str, *, usage: int | None = None, max: int | None = None,
                 plan: str = "free"):
        super().__init__(message)
        self.limit, self.message, self.usage, self.max, self.plan = limit, message, usage, max, plan

    def body(self) -> dict:
        return {"detail": self.message,
                "error": {"code": "plan_limit", "limit": self.limit, "usage": self.usage, "max": self.max,
                          "plan": self.plan, "message": self.message}}

    def details(self) -> dict:
        return {"limit": self.limit, "usage": self.usage, "max": self.max, "plan": self.plan}

    def response(self) -> JSONResponse:
        return JSONResponse(self.body(), status_code=402)


# ---------------------------------------------------------------------------------------------- client
class BillingClient:
    """Calls the cloud ``billing`` function with the signed-in session (refreshing once on a 401)."""

    def __init__(self, account, *, transport=None, timeout: float = 10):
        self.account, self._transport, self._timeout = account, transport, timeout
        self.base_url = account.client.config.url.rstrip("/") + "/functions/v1/billing"

    def user_id(self) -> str:
        link = self.account.link() or {}
        if not self.account.status().get("signed_in") or not link.get("user_id"):
            raise BillingError(401, "sign_in_required", "Sign in to Growth Factory cloud to manage your plan.")
        client = self.account.client
        try:
            if client.session is None:
                client.refresh()
        except CloudError as error:
            raise BillingError(401, "sign_in_required", error.message) from None
        if client.session is None or client.session.user_id != link["user_id"]:
            raise BillingError(401, "sign_in_required", "Cloud session does not match the linked account. Sign in again.")
        return link["user_id"]

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        self.user_id()
        client = self.account.client

        def send():
            headers = {"Accept": "application/json", "apikey": client.config.publishable_key,
                       "Authorization": f"Bearer {client.session.access_token}"}
            with httpx.Client(transport=self._transport, timeout=httpx.Timeout(self._timeout), trust_env=False,
                              follow_redirects=False) as http:
                response = http.request(method, self.base_url + path, json=body, headers=headers)
                response.read()
                return response

        try:
            response = send()
            if response.status_code == 401:
                client.refresh()  # expired access token; the server rejected before doing anything
                response = send()
        except CloudError as error:
            raise BillingError(401, "sign_in_required", error.message) from None
        except httpx.TimeoutException:
            raise BillingError(504, "timeout", "Growth Factory cloud timed out.") from None
        except httpx.HTTPError:
            raise BillingError(502, "network", "Cannot reach Growth Factory cloud. Check your connection.") from None
        if len(response.content) > _MAX_RESPONSE:
            raise BillingError(502, "invalid_response", "Growth Factory cloud sent an oversized reply.")
        try:
            data = response.json()
        except ValueError:
            data = None
        if not response.is_success:
            detail = data.get("error") if isinstance(data, dict) else None
            detail = detail if isinstance(detail, dict) else {}
            code = detail.get("code") if isinstance(detail.get("code"), str) else "billing_error"
            message = detail.get("message") if isinstance(detail.get("message"), str) else (
                "Growth Factory cloud refused the billing request.")
            raise BillingError(response.status_code, code[:64], message[:500])
        if not isinstance(data, dict):
            raise BillingError(502, "invalid_response", "Growth Factory cloud sent an invalid reply.")
        return data

    def entitlement(self) -> dict:
        data = self._request("GET", "/entitlement")
        if not isinstance(data.get("entitlement"), dict):
            raise BillingError(502, "invalid_response", "Growth Factory cloud sent an invalid plan.")
        return data["entitlement"]

    def _url(self, data: dict) -> str:
        url = data.get("url")
        if not isinstance(url, str) or not url.startswith("https://"):
            raise BillingError(502, "invalid_response", "Growth Factory cloud sent an invalid billing link.")
        return url

    def checkout(self, plan: str, interval: str) -> str:
        return self._url(self._request("POST", "/checkout", {"plan": plan, "interval": interval}))

    def portal(self) -> str:
        return self._url(self._request("POST", "/portal", {}))


# ---------------------------------------------------------------------------------------------- entitlement
def _count(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _limits(plan: str, value) -> dict:
    """Server limits when well formed (the server may change them ahead of this app), else the local mirror."""
    local = copy.deepcopy(PLANS[plan]["limits"])
    if not isinstance(value, dict):
        return local
    for key in ("brands", "connected_accounts"):
        if _count(value.get(key)):
            local[key] = value[key]
    if "clips_per_month" in value and (value["clips_per_month"] is None or _count(value["clips_per_month"])):
        local["clips_per_month"] = value["clips_per_month"]
    for key in ("posting", "factory_builder"):
        if isinstance(value.get(key), bool):
            local[key] = value[key]
    return local


def normalize(raw) -> dict | None:
    """A server Entitlement reduced to known fields, or None when it is unusable."""
    if not isinstance(raw, dict) or raw.get("plan") not in PLANS:
        return None
    plan = raw["plan"]
    status = raw.get("status") if raw.get("status") in _STATUSES else "none"
    interval = raw.get("interval") if raw.get("interval") in ("month", "year") else None
    return {
        "plan": plan,
        "status": status,
        "interval": interval if plan != "free" else None,
        "current_period_end": _stamp(_parse(raw.get("current_period_end"))),
        "cancel_at_period_end": raw.get("cancel_at_period_end") is True,
        "payment_problem": raw.get("payment_problem") is True,
        "has_subscription": raw.get("has_subscription") is True,
        "limits": _limits(plan, raw.get("limits")),
    }


FREE = {"plan": "free", "status": "none", "interval": None, "current_period_end": None,
        "cancel_at_period_end": False, "payment_problem": False, "has_subscription": False}


def free_entitlement(state: str, message: str | None = None, confirmed_at: str | None = None) -> dict:
    return {**FREE, "name": "Free", "limits": copy.deepcopy(PLANS["free"]["limits"]), "state": state,
            "confirmed_at": confirmed_at, "grace_ends_at": None, "message": message}


MESSAGES = {
    "signed_out": "Sign in to Growth Factory cloud to upgrade. The Free plan applies while you are signed out.",
    "not_configured": "Plans are not available in this build. The Free plan applies.",
    "expired": "Growth Factory could not confirm your plan for seven days. Free plan limits apply until it "
               "reconnects.",
    "offline": "Growth Factory cloud cannot be reached. Showing the plan last confirmed.",
}


class EntitlementService:
    def __init__(self, store, account: Callable[[], object | None], *,
                 client_factory: Callable[[object], BillingClient] = BillingClient,
                 clock: Callable[[], datetime] = lambda: datetime.now(UTC)):
        self.store, self.account, self.client_factory, self.clock = store, account, client_factory, clock
        self._lock = threading.Lock()
        self._retry_at: datetime | None = None
        self._stale = False

    def client(self) -> BillingClient | None:
        account = self.account()
        return self.client_factory(account) if account is not None else None

    def mark_stale(self) -> None:
        """After Checkout or the Billing Portal opens: the next check asks the cloud again."""
        self._stale, self._retry_at = True, None

    @staticmethod
    def _signed_in_user(account) -> str | None:
        try:
            if not account.status().get("signed_in"):
                return None
        except CloudError:
            return None
        return (account.link() or {}).get("user_id")

    @staticmethod
    def _view(entry: dict, state: str, message: str | None = None) -> dict:
        confirmed = _parse(entry.get("confirmed_at"))
        entitlement = entry["entitlement"]
        return {**entitlement, "name": PLANS[entitlement["plan"]]["name"], "state": state,
                "confirmed_at": _stamp(confirmed), "grace_ends_at": _stamp(confirmed + GRACE if confirmed else None),
                "message": message}

    def _cached(self, user: str) -> dict | None:
        cached = self.store.get(CACHE_KIND, CACHE_ID)
        if not cached or cached.get("user_id") != user or not _parse(cached.get("confirmed_at")):
            return None
        entitlement = normalize(cached.get("entitlement"))
        return {**cached, "entitlement": entitlement} if entitlement else None

    def current(self, refresh: bool = False) -> dict:
        account = self.account()
        if account is None:
            return free_entitlement("not_configured", MESSAGES["not_configured"])
        user = self._signed_in_user(account)
        if not user:
            return free_entitlement("signed_out", MESSAGES["signed_out"])
        with self._lock:
            current = self.clock()
            entry = self._cached(user)
            confirmed = _parse(entry["confirmed_at"]) if entry else None
            if entry and not refresh and not self._stale and current - confirmed < FRESH:
                return self._view(entry, "confirmed")
            failure = None
            if refresh or self._stale or self._retry_at is None or current >= self._retry_at:
                try:
                    fresh = normalize(self.client_factory(account).entitlement())
                    if fresh is None:
                        raise BillingError(502, "invalid_response", "Growth Factory cloud sent an invalid plan.")
                    entry = {"id": CACHE_ID, "user_id": user, "entitlement": fresh, "confirmed_at": _stamp(current)}
                    self.store.put(CACHE_KIND, entry)
                    self._retry_at, self._stale = None, False
                    return self._view(entry, "confirmed")
                except BillingError as error:
                    if error.status == 401:
                        return free_entitlement("signed_out", error.message)
                    failure = error.message
                    self._retry_at = current + RETRY
                    log.info("Plan confirmation failed (%s); using the cached plan if it is recent.", error.code)
            if entry and current - confirmed < GRACE:
                return self._view(entry, "offline", failure or MESSAGES["offline"])
            return free_entitlement("expired", MESSAGES["expired"], _stamp(confirmed))


# ---------------------------------------------------------------------------------------------- usage
def month_start(moment: datetime, zone: tzinfo | None = None) -> datetime:
    """Start of the calendar month in the creator's time zone (the machine's, unless given)."""
    local = moment.astimezone(zone) if zone is not None else moment.astimezone()
    return local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def next_month(start: datetime) -> datetime:
    return (start.replace(day=28) + timedelta(days=4)).replace(day=1)


def _real_clip(clip: dict) -> bool:
    identifier = str(clip.get("id") or "")
    return not clip.get("simulated") and not identifier.startswith("sim-")


class Usage:
    def __init__(self, store, *, clock: Callable[[], datetime] = lambda: datetime.now(UTC),
                 zone: tzinfo | None = None):
        self.store, self.clock, self.zone = store, clock, zone

    def brands(self) -> int:
        return len(self.store.all("profiles"))

    def clips_this_month(self) -> int:
        start = month_start(self.clock(), self.zone)
        count = 0
        for clip in self.store.all("clips"):
            created = _parse(clip.get("created_at")) if isinstance(clip, dict) else None
            if created is not None and created >= start and _real_clip(clip):
                count += 1
        return count

    def connected_accounts(self) -> int:
        from .posting_accounts import ACCOUNTS
        from .publisher import PROVIDER

        return sum(1 for row in self.store.all(ACCOUNTS)
                   if row.get("provider") == PROVIDER and row.get("status") != "disconnected")

    def summary(self) -> dict:
        start = month_start(self.clock(), self.zone)
        return {"brands": self.brands(), "clips_this_month": self.clips_this_month(),
                "connected_accounts": self.connected_accounts(), "month_start": start.isoformat(),
                "resets_at": next_month(start).isoformat()}


# ---------------------------------------------------------------------------------------------- gate
POSTING = "posting"
OVER_LIMIT = "over_limit"
# POST routes and the limits each one needs. Exports, results, Learning Loop tracking and its account
# connections, demo/simulation, listing and disconnecting are never gated.
ROUTES: list[tuple[re.Pattern, tuple[str, ...]]] = [(re.compile(pattern), limits) for pattern, limits in [
    (r"/api/profiles", ("brands",)),
    (r"/api/campaigns/[^/]+/(?:render|produce)", ("clips_per_month",)),
    (r"/api/videos/[^/]+/(?:produce|team|render|baseline)", ("clips_per_month",)),
    (r"/api/growth/profiles/[^/]+/(?:ab|recut)", ("clips_per_month",)),
    (r"/api/reference-research/[^/]+/use", ("clips_per_month",)),
    (r"/api/factory-builder/requests/[^/]+/build", ("factory_builder",)),
    (r"/api/posting/connect", (POSTING, "connected_accounts")),
    (r"/api/clips/[^/]+/(?:post|schedule-post|publish|schedule)", (POSTING, OVER_LIMIT)),
    (r"/api/campaigns/[^/]+/post-batch", (POSTING, OVER_LIMIT)),
    (r"/api/publish-attempts/[^/]+/resume", (POSTING, OVER_LIMIT)),
]]


def route_limits(method: str, path: str) -> tuple[str, ...]:
    if method != "POST":
        return ()
    for pattern, limits in ROUTES:
        if pattern.fullmatch(path):
            return limits
    return ()


def _plural(count: int, word: str) -> str:
    return f"{count} {word}" + ("" if count == 1 else "s")


class PlanGate:
    def __init__(self, entitlements: EntitlementService, usage: Usage):
        self.entitlements, self.usage = entitlements, usage

    def refusal(self, limits: tuple[str, ...]) -> PlanLimitError | None:
        if not limits:
            return None
        entitlement = self.entitlements.current()
        plan, name, caps = entitlement["plan"], entitlement["name"], entitlement["limits"]
        for limit in limits:
            refusal = self._refuse(limit, plan, name, caps)
            if refusal is not None:
                return refusal
        return None

    def _refuse(self, limit: str, plan: str, name: str, caps: dict) -> PlanLimitError | None:
        if limit == "brands":
            used, cap = self.usage.brands(), caps["brands"]
            if used >= cap:
                return PlanLimitError("brands", f"The {name} plan includes {_plural(cap, 'brand')} and you have "
                                      f"{used}. Upgrade to add another brand; every existing brand stays available.",
                                      usage=used, max=cap, plan=plan)
        elif limit == "clips_per_month":
            cap = caps["clips_per_month"]
            if cap is None:
                return None
            used = self.usage.clips_this_month()
            if used >= cap:
                resets = next_month(month_start(self.usage.clock(), self.usage.zone))
                return PlanLimitError("clips_per_month", f"The {name} plan includes {_plural(cap, 'clip')} a month "
                                      f"and {used} were made this month. Upgrade for unlimited clips, or wait until "
                                      f"{resets:%B} {resets.day}.", usage=used, max=cap, plan=plan)
        elif limit == "factory_builder":
            if not caps["factory_builder"]:
                return PlanLimitError("factory_builder", f"The factory builder is not included in the {name} plan. "
                                      "Upgrade to Business to build new editing abilities; extensions already "
                                      "built keep working.", plan=plan)
        elif limit == POSTING:
            if not caps["posting"]:
                return PlanLimitError("posting", f"Posting from the app is not included in the {name} plan. Export "
                                      "the clip to post it yourself, or upgrade to Pro or Business.", plan=plan)
        elif limit == "connected_accounts":
            used, cap = self.usage.connected_accounts(), caps["connected_accounts"]
            if used >= cap:
                return PlanLimitError("connected_accounts", f"The {name} plan includes "
                                      f"{_plural(cap, 'connected account')} and {used} are connected. Disconnect "
                                      "one or upgrade.", usage=used, max=cap, plan=plan)
        elif limit == OVER_LIMIT:
            used, cap = self.usage.connected_accounts(), caps["connected_accounts"]
            if used > cap:
                return PlanLimitError("connected_accounts", f"{used} accounts are connected but the {name} plan "
                                      f"includes {cap}. Disconnect accounts down to {cap} or upgrade to post again.",
                                      usage=used, max=cap, plan=plan)
        return None

    def check(self, *limits: str) -> None:
        refusal = self.refusal(limits)
        if refusal is not None:
            raise refusal

    def posting_refusal(self) -> PlanLimitError | None:
        """For scheduled posts: whatever would block posting now."""
        return self.refusal((POSTING, OVER_LIMIT))


def install_gate(app) -> None:
    """Register before the local session middleware, so the session check runs first (Starlette runs the
    most recently added middleware outermost). The gate itself is attached later by ``install``."""

    @app.exception_handler(PlanLimitError)
    async def plan_limit(request: Request, error: PlanLimitError):
        return error.response()

    @app.middleware("http")
    async def plan_limits(request: Request, call_next):
        gate = getattr(request.app.state, "plan_gate", None)
        limits = route_limits(request.method, request.url.path) if gate is not None else ()
        if limits:
            try:
                refusal = await run_in_threadpool(gate.refusal, limits)
            except Exception:  # a broken plan check must not stop the creator's work
                log.warning("Plan check failed; allowing the request.", exc_info=True)
                refusal = None
            if refusal is not None:
                return refusal.response()
        return await call_next(request)


# ---------------------------------------------------------------------------------------------- routes
class CheckoutRequest(BaseModel):
    plan: Literal["pro", "business"]
    interval: Literal["month", "year"] = "month"


def _billing_error(error: BillingError) -> JSONResponse:
    # 401 on the local API means the local session token, so a cloud sign-in problem is a conflict.
    status = 409 if error.status == 401 else 502 if error.status >= 500 or error.status < 400 else error.status
    return JSONResponse({"detail": error.message, "error": {"code": error.code, "message": error.message}},
                        status_code=status)


def install(app, store, account: Callable[[], object | None], *, open_url: Callable[[str], bool],
            entitlements: EntitlementService | None = None, usage: Usage | None = None) -> PlanGate:
    entitlements = entitlements or EntitlementService(store, account)
    usage = usage or Usage(store)
    gate = PlanGate(entitlements, usage)
    app.state.entitlements, app.state.plan_gate = entitlements, gate

    def summary(refresh: bool = False) -> dict:
        current = account()
        signed_in = False
        if current is not None:
            try:
                signed_in = bool(current.status().get("signed_in"))
            except CloudError:
                signed_in = False
        return {"entitlement": entitlements.current(refresh=refresh), "usage": usage.summary(),
                "plans": plan_list(), "signed_in": signed_in, "available": current is not None}

    def open_billing(action: Callable[[BillingClient], str]):
        client = entitlements.client()
        if client is None:
            return _billing_error(BillingError(409, "not_configured", MESSAGES["not_configured"]))
        try:
            url = action(client)
        except BillingError as error:
            return _billing_error(error)
        entitlements.mark_stale()
        opened = False
        try:
            opened = bool(open_url(url))
        except Exception:  # noqa: BLE001 - the link is returned so the page can offer it instead
            log.warning("Could not open the system browser for billing.", exc_info=False)
        return {"url": url, "opened": opened}

    @app.get("/api/billing")
    def billing():
        return summary()

    @app.post("/api/billing/refresh")
    def refresh_billing():
        return summary(refresh=True)

    @app.post("/api/billing/checkout")
    def checkout(body: CheckoutRequest):
        return open_billing(lambda client: client.checkout(body.plan, body.interval))

    @app.post("/api/billing/portal")
    def portal():
        return open_billing(lambda client: client.portal())

    return gate
