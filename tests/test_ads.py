"""Mocked Graph contracts; these tests never create actual paid resources."""

import httpx
import pytest

from clip_factory.ads import AdsClient
from clip_factory.meta import MetaError

TOKEN = "private-user-token"
PAGE_TOKEN = "private-page-token"


@pytest.fixture
def spec():
    return {
        "ad_account_id": "act_10",
        "instagram_account_id": "30",
        "page_id": "20",
        "instagram_media_id": "40",
        "name": "User approved candidate",
        "destination_url": "https://creator.com/offer",
        "country": "US",
        "lifetime_budget_minor": 1000,
        "duration_days": 7,
    }


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr("clip_factory.meta.time.sleep", lambda _: None)


def account(**overrides):
    return {"id": "act_10", "name": "Real account", "currency": "USD", "account_status": 1, **overrides}


def graph_handler(calls, *, accounts=None, page_id="20", ig_id="30", media=None):
    def handler(request):
        calls.append(request)
        assert request.method == "GET", "Public paid adapter must never write"
        assert TOKEN not in str(request.url)
        assert PAGE_TOKEN not in str(request.url)
        path = request.url.path
        if path == "/v22.0/me/adaccounts":
            assert request.headers["Authorization"] == f"Bearer {TOKEN}"
            assert request.url.params["fields"] == "id,name,currency,account_status"
            rows = [account()] if accounts is None else accounts
            return httpx.Response(200, json={"data": rows})
        if path == "/v22.0/me/accounts":
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": page_id,
                            "access_token": PAGE_TOKEN,
                            "instagram_business_account": {"id": ig_id, "username": "creator"},
                        }
                    ]
                },
            )
        if path == "/v22.0/30/media":
            assert request.headers["Authorization"] == f"Bearer {PAGE_TOKEN}"
            assert request.url.params["fields"] == "id,media_type,media_product_type"
            rows = [{"id": "40", "media_type": "VIDEO", "media_product_type": "REELS"}]
            return httpx.Response(200, json={"data": rows if media is None else media})
        if path == "/v22.0/act_10/insights":
            assert request.url.params["level"] == "ad"
            assert request.url.params["date_preset"] == "last_30d"
            assert request.url.params["time_increment"] == "1"
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "ad_id": "60",
                            "spend": "1.25",
                            "clicks": "4",
                            "actions": [{"action_type": "link_click", "value": "4"}],
                        }
                    ]
                },
            )
        raise AssertionError(path)

    return handler


def client(handler):
    return AdsClient(TOKEN, transport=httpx.MockTransport(handler))


def test_accounts_only_live_allowlisted_fields():
    calls = []
    rows = [account(access_token=TOKEN, ignored={"secret": PAGE_TOKEN}), account(id="11", account_status=2)]
    with client(graph_handler(calls, accounts=rows)) as ads:
        result = ads.accounts()
    assert result == [account(), account(id="act_11", account_status=2)]
    assert TOKEN not in repr(result) and PAGE_TOKEN not in repr(result)
    assert len(calls) == 1


def test_accounts_pagination_does_not_follow_external_token_url():
    calls = []

    def handler(request):
        calls.append(request)
        assert request.url.path == "/v22.0/me/adaccounts"
        assert request.url.host == "graph.facebook.com"
        if "after" not in request.url.params:
            return httpx.Response(
                200,
                json={
                    "data": [account()],
                    "paging": {
                        "next": f"https://evil.com/?access_token={TOKEN}",
                        "cursors": {"after": "next"},
                    },
                },
            )
        assert request.url.params["after"] == "next"
        return httpx.Response(200, json={"data": [account(id="act_11")]})

    with client(handler) as ads:
        assert [row["id"] for row in ads.accounts()] == ["act_10", "act_11"]
    assert len(calls) == 2


@pytest.mark.parametrize(
    "row",
    [
        {"id": "act_10"},
        account(account_status=True),
        account(currency=None),
        account(name=None),
        account(id="act_bad"),
    ],
)
def test_malformed_accounts_refused(row):
    with client(graph_handler([], accounts=[row])) as ads, pytest.raises(MetaError):
        ads.accounts()


def test_live_preflight_currency_ownership_and_intended_constraints(spec):
    calls = []
    spec["ad_account_id"] = "10"
    with client(graph_handler(calls)) as ads:
        result = ads.preflight(spec)
    assert [request.url.path for request in calls] == [
        "/v22.0/me/adaccounts",
        "/v22.0/me/accounts",
        "/v22.0/30/media",
    ]
    assert result["spec"] == {**spec, "ad_account_id": "act_10"}
    assert spec["ad_account_id"] == "10"  # caller input not mutated
    assert result["stage"] == "preflight_only"
    assert result["can_create"] is False and result["can_activate"] is False
    assert result["currency"] == "USD" and result["currency_exponent"] == 2
    assert result["intended_constraints"] == {
        "objective": "OUTCOME_TRAFFIC",
        "special_ad_categories": [],
        "billing_event": "IMPRESSIONS",
        "optimization_goal": "LINK_CLICKS",
        "country": "US",
        "age_min": 18,
        "placement": "instagram_reels_only",
        "initial_status": "PAUSED",
        "lifetime_budget_minor": 1000,
    }
    assert not any(key in result for key in ("campaign_id", "adset_id", "creative_id", "ad_id"))
    assert TOKEN not in repr(result) and PAGE_TOKEN not in repr(result)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("country", "GB"),
        ("lifetime_budget_minor", True),
        ("lifetime_budget_minor", 1.5),
        ("lifetime_budget_minor", 0),
        ("lifetime_budget_minor", -10),
        ("lifetime_budget_minor", 2**31),
        ("duration_days", False),
        ("duration_days", 1.5),
        ("duration_days", 0),
        ("duration_days", 91),
        ("name", " "),
        ("name", "x" * 201),
        ("destination_url", "http://creator.com"),
        ("destination_url", "https://127.0.0.1"),
        ("destination_url", "https://user:secret@creator.com"),
        ("ad_account_id", "../10"),
        ("instagram_media_id", "act_40"),
        ("instagram_account_id", None),
    ],
)
def test_invalid_spec_rejected_before_network(spec, field, value):
    spec[field] = value
    calls = []
    with client(graph_handler(calls)) as ads, pytest.raises(MetaError):
        ads.preflight(spec)
    assert calls == []


@pytest.mark.parametrize(
    "extra",
    [
        {"currency": "USD"},
        {"access_token": TOKEN},
        {"special_ad_categories": ["HOUSING"]},
        {"targeting": {"age_min": 13}},
        {"daily_budget": 100},
        {"status": "ACTIVE"},
    ],
)
def test_overrides_and_regulated_categories_refused(spec, extra):
    calls = []
    with client(graph_handler(calls)) as ads, pytest.raises(MetaError, match="no overrides"):
        ads.preflight({**spec, **extra})
    assert calls == []


@pytest.mark.parametrize("currency", ["JPY", "EUR", "KWD", "ZZZ", "usd"])
def test_currency_must_be_supported_and_live(spec, currency):
    calls = []
    with (
        client(graph_handler(calls, accounts=[account(currency=currency)])) as ads,
        pytest.raises(MetaError, match="currency"),
    ):
        ads.preflight(spec)
    assert len(calls) == 1


@pytest.mark.parametrize("rows", [[], [account(id="act_11")]])
def test_inaccessible_ad_account_refused(spec, rows):
    calls = []
    with client(graph_handler(calls, accounts=rows)) as ads, pytest.raises(MetaError) as caught:
        ads.preflight(spec)
    assert caught.value.code == "ownership"
    assert len(calls) == 1


def test_inactive_live_account_refused(spec):
    calls = []
    with (
        client(graph_handler(calls, accounts=[account(account_status=2)])) as ads,
        pytest.raises(MetaError, match="not active"),
    ):
        ads.preflight(spec)
    assert len(calls) == 1


@pytest.mark.parametrize("overrides", [{"page_id": "21"}, {"ig_id": "31"}])
def test_page_and_instagram_ownership_checked_before_media(spec, overrides):
    calls = []
    with client(graph_handler(calls, **overrides)) as ads, pytest.raises(MetaError) as caught:
        ads.preflight(spec)
    assert caught.value.code == "ownership"
    assert len(calls) == 2


@pytest.mark.parametrize("media", [[], [{"id": "41", "media_type": "VIDEO", "media_product_type": "REELS"}]])
def test_foreign_or_unpublished_media_refused(spec, media):
    with client(graph_handler([], media=media)) as ads, pytest.raises(MetaError) as caught:
        ads.preflight(spec)
    assert caught.value.code == "ownership"


@pytest.mark.parametrize(
    "media",
    [
        {"id": "40", "media_type": "IMAGE", "media_product_type": "FEED"},
        {"id": "40", "media_type": "VIDEO", "media_product_type": "FEED"},
        {"id": "40", "media_type": "VIDEO"},
    ],
)
def test_not_a_reel_refused(spec, media):
    with (
        client(graph_handler([], media=[media])) as ads,
        pytest.raises(MetaError, match="not an Instagram Reel"),
    ):
        ads.preflight(spec)


def test_media_ownership_search_uses_pagination(spec):
    calls = []
    base = graph_handler(calls)

    def handler(request):
        if request.url.path.endswith("/media") and "after" not in request.url.params:
            calls.append(request)
            return httpx.Response(
                200,
                json={
                    "data": [],
                    "paging": {
                        "next": "ignored",
                        "cursors": {"after": "owned-media"},
                    },
                },
            )
        return base(request)

    with client(handler) as ads:
        assert ads.preflight(spec)["can_create"] is False
    assert calls[-1].url.params["after"] == "owned-media"


def test_create_explicitly_blocked_no_writes_no_persist(spec):
    calls, records = [], []
    with client(graph_handler(calls)) as ads, pytest.raises(MetaError) as caught:
        ads.create_experiment(spec, records.append)
    assert caught.value.code == "paid_creative_unverified"
    assert "source_instagram_media_id" in str(caught.value)
    assert "destination URL" in str(caught.value)
    assert "No resources" in str(caught.value)
    assert records == []
    assert len(calls) == 3 and all(request.method == "GET" for request in calls)


def test_create_requires_persist_callback_before_io(spec):
    calls = []
    with client(graph_handler(calls)) as ads, pytest.raises(MetaError, match="persistence callback"):
        ads.create_experiment(spec, None)
    assert calls == []


@pytest.mark.parametrize("status", ["ACTIVE", "PAUSED"])
def test_both_status_methods_block_even_forged_consent_and_budget(status):
    calls, records = [], []
    record = {
        "campaign_id": "50",
        "adset_id": "51",
        "ad_id": "52",
        "explicit_user_approved": True,
        "lifetime_budget_minor": 1000,
    }
    with client(graph_handler(calls)) as ads:
        with pytest.raises(MetaError) as caught:
            ads.set_status("50", status)
        assert caught.value.code == "paid_creative_unverified"
        with pytest.raises(MetaError) as caught:
            ads.set_experiment_status(record, status, persist=records.append)
        assert caught.value.code == "paid_creative_unverified"
    assert calls == [] and records == []


def test_invalid_status_refused_without_io():
    calls = []
    with client(graph_handler(calls)) as ads, pytest.raises(MetaError, match="ACTIVE or PAUSED"):
        ads.set_status("50", "DELETED")
    assert calls == []


@pytest.mark.parametrize("cancel_on", [1, 2, 3, 4])
def test_cancel_preflight_without_writes(spec, cancel_on):
    calls, records = [], []
    checks = 0

    def cancelled():
        nonlocal checks
        checks += 1
        return checks == cancel_on

    with client(graph_handler(calls)) as ads, pytest.raises(MetaError) as caught:
        ads.create_experiment(spec, records.append, cancel_check=cancelled)
    assert caught.value.code == "cancelled"
    assert len(calls) == cancel_on - 1
    assert records == [] and all(request.method == "GET" for request in calls)


def test_insights_real_rows_no_organic_attribution():
    calls = []
    with client(graph_handler(calls)) as ads:
        result = ads.insights("10")
    assert result == [
        {
            "ad_id": "60",
            "spend": "1.25",
            "clicks": "4",
            "actions": [{"action_type": "link_click", "value": "4"}],
        }
    ]
    assert [request.url.path for request in calls] == ["/v22.0/me/adaccounts", "/v22.0/act_10/insights"]


def test_foreign_insights_account_refused():
    calls = []
    with client(graph_handler(calls)) as ads, pytest.raises(MetaError) as caught:
        ads.insights("999")
    assert caught.value.code == "ownership"
    assert len(calls) == 1


@pytest.mark.parametrize("failure", ["auth", "permission", "network"])
def test_errors_safe_no_credentials(failure, caplog):
    calls = []

    def handler(request):
        calls.append(request)
        if failure == "network":
            raise httpx.ConnectError(f"{TOKEN} {PAGE_TOKEN}", request=request)
        return httpx.Response(
            400,
            json={
                "error": {
                    "code": 190 if failure == "auth" else 200,
                    "message": f"{TOKEN} {PAGE_TOKEN}",
                }
            },
        )

    with client(handler) as ads, pytest.raises(MetaError) as caught:
        ads.accounts()
    assert len(calls) == (3 if failure == "network" else 1)
    diagnostic = str(caught.value) + repr(caught.value.__dict__) + caplog.text
    assert TOKEN not in diagnostic and PAGE_TOKEN not in diagnostic
    assert caught.value.__cause__ is None


@pytest.mark.parametrize("failure", ["network", "transient"])
def test_inherited_transport_never_retries_uncertain_writes(failure):
    """Exercise inherited low-level contract only; no public paid method issues this POST."""
    calls = []

    def handler(request):
        calls.append(request)
        if failure == "network":
            raise httpx.ReadTimeout(TOKEN, request=request)
        return httpx.Response(503, json={"error": {"code": 2, "message": TOKEN}})

    with client(handler) as ads, pytest.raises(MetaError) as caught:
        ads._request("POST", "act_10/campaigns", data={"status": "PAUSED"})
    assert len(calls) == 1
    assert caught.value.retryable is False
    assert TOKEN not in str(caught.value)
