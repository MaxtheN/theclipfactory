"""Offline contract tests: exact-account Composio reads, no OAuth grants or publication."""

import json
import logging

import httpx
import pytest

from clip_factory.composio import ComposioClient, ComposioError, ToolSchema, _count

KEY = "project-key-secret"
ACCOUNT = "ca_exact"
USER = "growth-user-1"
PIN = "20261112_00"


@pytest.fixture
def service():
    state = {
        "account": {
            "id": ACCOUNT,
            "user_id": USER,
            "status": "ACTIVE",
            "is_disabled": False,
            "toolkit": {"slug": "instagram"},
            "auth_config": {"id": "ac_instagram"},
            "state": {"access_token": "provider-secret"},
            "params": {"token": KEY},
        },
        "profile": {"id": "900", "user_id": "100", "username": "growth_factory", "account_type": "BUSINESS"},
        "media": {"id": "200", "owner": {"id": "100"}, "timestamp": "2026-01-01T12:00:00+0000"},
        "catalog": {
            "data": [
                {
                    "id": "200",
                    "owner": {"id": "100"},
                    "timestamp": "2026-01-01T12:00:00Z",
                    "media_type": "VIDEO",
                    "permalink": "https://www.instagram.com/reel/RealCode/",
                    "caption": "Actual display caption",
                }
            ]
        },
        "insights": {
            "data": [
                {"name": "views", "total_value": {"value": 23}},
                {"name": "saved", "values": [{"value": 0}]},
            ]
        },
        "calls": [],
    }
    fields = {
        "INSTAGRAM_GET_USER_INFO": {"ig_user_id": {"type": "string"}, "fields": {"type": "string"}},
        "INSTAGRAM_GET_IG_MEDIA": {
            "ig_media_id": {"type": "string", "required": True},
            "fields": {"type": "string"},
        },
        "INSTAGRAM_GET_IG_MEDIA_INSIGHTS": {
            "ig_media_id": {"type": "string", "required": True},
            "metric": {"type": "array", "items": {"type": "string"}, "required": True},
            "period": {"type": "string"},
        },
        "INSTAGRAM_GET_IG_USER_MEDIA": {
            "ig_user_id": {"type": "string", "required": True},
            "limit": {"type": "integer", "maximum": 100},
            "fields": {"type": "string"},
            "after": {"type": "string"},
        },
    }

    def handler(request):
        assert request.url.host == "backend.composio.dev"
        assert request.headers["x-api-key"] == KEY
        state["calls"].append(request)
        if request.url.path == "/api/v3/connected_accounts/link":
            return httpx.Response(
                201,
                json={
                    "connected_account_id": ACCOUNT,
                    "redirect_url": "https://connect.composio.dev/link/private-link",
                    "expires_at": "2026-11-14T15:00:00Z",
                    "link_token": "private-link",
                },
            )
        if request.url.path == f"/api/v3/connected_accounts/{ACCOUNT}":
            return httpx.Response(200, json=state["account"])
        slug = request.url.path.split("/")[-1]
        if request.method == "GET" and slug in fields:
            return httpx.Response(
                200,
                json={
                    "slug": slug,
                    "version": PIN,
                    "toolkit": {"slug": "instagram"},
                    "input_parameters": state.get("schema", fields[slug]),
                },
            )
        if request.method == "POST" and slug in fields:
            body = json.loads(request.content)
            assert body["connected_account_id"] == ACCOUNT and body["user_id"] == USER
            assert body["version"] == PIN
            payload = {
                "INSTAGRAM_GET_USER_INFO": "profile",
                "INSTAGRAM_GET_IG_MEDIA": "media",
                "INSTAGRAM_GET_IG_MEDIA_INSIGHTS": "insights",
                "INSTAGRAM_GET_IG_USER_MEDIA": "catalog",
            }[slug]
            return httpx.Response(200, json={"successful": True, "data": state[payload], "error": None})
        pytest.fail(f"Unexpected adapter route: {request.method} {request.url.path}")

    state["client"] = ComposioClient(KEY, transport=httpx.MockTransport(handler))
    return state


def test_managed_oauth_uses_connect_link_and_drops_link_token(service):
    result = service["client"].initiate_connection("ac_instagram", USER, "http://127.0.0.1:8765/callback")
    request = service["calls"][0]
    assert json.loads(request.content) == {
        "auth_config_id": "ac_instagram",
        "user_id": USER,
        "callback_url": "http://127.0.0.1:8765/callback",
    }
    assert "link_token" not in result and result["connected_account_id"] == ACCOUNT


@pytest.mark.parametrize(
    "url",
    [
        "http://evil.test/callback",
        "https://user:secret@host.test",
        "javascript:alert(1)",
        "https://host.test:bad",
        None,
    ],
)
def test_invalid_callback_does_not_create_link(service, url):
    if url is None:
        result = service["client"].initiate_connection("ac_instagram", USER)
        assert result["redirect_url"].startswith("https:")
    else:
        with pytest.raises(ComposioError):
            service["client"].initiate_connection("ac_instagram", USER, url)
        assert not service["calls"]


def test_account_read_redacts_provider_state(service):
    result = service["client"].read_account(ACCOUNT, USER, "ac_instagram")
    assert result == {
        "connected_account_id": ACCOUNT,
        "user_id": USER,
        "auth_config_id": "ac_instagram",
        "toolkit": "instagram",
        "status": "ACTIVE",
    }
    assert "secret" not in json.dumps(result)


def test_account_owner_discovers_only_exact_connection_owner_and_redacts_state(service):
    service["account"]["user_id"] = "authoritative-composio-owner"
    service["account"]["data"] = {"api_key": KEY}
    result = service["client"].account_owner(ACCOUNT, "ac_instagram")
    assert result == {
        "connected_account_id": ACCOUNT,
        "user_id": "authoritative-composio-owner",
        "auth_config_id": "ac_instagram",
        "toolkit": "instagram",
        "status": "ACTIVE",
    }
    assert len(service["calls"]) == 1
    assert service["calls"][0].method == "GET"
    assert service["calls"][0].url.path == f"/api/v3/connected_accounts/{ACCOUNT}"
    assert not service["calls"][0].url.query
    assert KEY not in json.dumps(result) and "state" not in result and "data" not in result


@pytest.mark.parametrize(
    "change",
    [
        {"id": "ca_foreign"},
        {"auth_config": {"id": "ac_foreign"}},
        {"auth_config": {"id": "ac_instagram", "is_disabled": True}},
        {"status": "EXPIRED"},
        {"status": "INITIALIZING"},
        {"is_disabled": True},
        {"toolkit": {"slug": "gmail"}},
        {"user_id": None},
        {"user_id": ""},
        {"user_id": " owner"},
        {"user_id": "owner\nforeign"},
    ],
)
def test_account_owner_foreign_inactive_non_instagram_or_missing_owner_fails_closed(service, change):
    service["account"].update(change)
    with pytest.raises(ComposioError):
        service["client"].account_owner(ACCOUNT, "ac_instagram")
    assert len(service["calls"]) == 1


def test_account_owner_requires_expected_configuration_before_request(service):
    with pytest.raises(ComposioError):
        service["client"].account_owner(ACCOUNT, None)
    assert not service["calls"]


@pytest.mark.parametrize(
    "change",
    [
        {"id": "ca_other"},
        {"user_id": "foreign"},
        {"status": "EXPIRED"},
        {"status": "INITIALIZING"},
        {"is_disabled": True},
        {"toolkit": {"slug": "gmail"}},
        {"auth_config": {"id": "ac_instagram", "is_disabled": True}},
        {"user_id": None},
        {"auth_config": {}},
    ],
)
def test_foreign_inactive_malformed_accounts_are_rejected(service, change):
    service["account"].update(change)
    with pytest.raises(ComposioError):
        service["client"].read_account(ACCOUNT, USER)


def test_auth_config_must_match_when_supplied(service):
    with pytest.raises(ComposioError, match="another auth"):
        service["client"].read_account(ACCOUNT, USER, "ac_foreign")


def test_identity_is_actual_bound_instagram_profile(service):
    result = service["client"].account_identity(ACCOUNT, USER)
    assert result["instagram_user_id"] == "100" and result["username"] == "growth_factory"
    posts = [r for r in service["calls"] if "/execute/" in r.url.path]
    assert json.loads(posts[0].content)["arguments"] == {
        "ig_user_id": "me",
        "fields": "id,user_id,username,account_type",
    }
    assert sum(r.url.path.endswith(ACCOUNT) for r in service["calls"]) == 2  # Revalidate before execution.


def test_exact_media_owner_and_nullable_counts(service):
    result = service["client"].collect_insights(ACCOUNT, USER, "200", instagram_user_id="100")
    assert result["media_id"] == "200" and result["owner_verified"] is True
    assert result["attribution"] == "not_separated" and result["tool_version"] == PIN
    assert result["published_at"] == "2026-01-01T12:00:00+00:00"
    assert result["metrics"] == {
        "views": 23,
        "reach": None,
        "saved": 0,
        "shares": None,
        "likes": None,
        "comments": None,
        "total_interactions": None,
    }
    posts = [json.loads(r.content) for r in service["calls"] if "/execute/" in r.url.path]
    assert posts[1]["arguments"] == {"ig_media_id": "200", "fields": "id,owner,timestamp"}
    assert posts[2]["arguments"] == {
        "ig_media_id": "200",
        "metric": list(ComposioClient.METRICS),
        "period": "lifetime",
    }
    schema_queries = [r.url.params["version"] for r in service["calls"] if "/tools/INSTAGRAM" in r.url.path]
    assert schema_queries == ["latest", PIN, PIN]


@pytest.mark.parametrize(
    "media",
    [
        {"id": "200"},
        {"id": "200", "owner": {"id": "999"}},
        {"id": "999", "owner": {"id": "100"}},
        {"id": "200", "owner": "100"},
    ],
)
def test_missing_or_foreign_media_owner_never_collects(service, media):
    service["media"] = media
    with pytest.raises(ComposioError, match="ownership"):
        service["client"].collect_insights(ACCOUNT, USER, "200")
    assert not any(r.url.path.endswith("execute/INSTAGRAM_GET_IG_MEDIA_INSIGHTS") for r in service["calls"])


def test_expected_instagram_identity_change_stops_collection(service):
    with pytest.raises(ComposioError, match="identity changed"):
        service["client"].collect_insights(ACCOUNT, USER, "200", instagram_user_id="999")
    assert not any(r.url.path.endswith("execute/INSTAGRAM_GET_IG_MEDIA") for r in service["calls"])


def test_schema_is_fetched_pinned_and_cannot_be_mutated(service):
    client = service["client"]
    schema = client.tool_schema("INSTAGRAM_GET_IG_MEDIA")
    with pytest.raises(ComposioError, match="pin"):
        client.execute_tool(
            schema.slug,
            {"ig_media_id": "200"},
            connected_account_id=ACCOUNT,
            user_id=USER,
            version="latest",
            schema=schema,
        )
    schema.input_parameters["properties"]["secret"] = {"type": "string"}
    with pytest.raises(ComposioError, match="pin"):
        client.execute_tool(
            schema.slug,
            {"ig_media_id": "200"},
            connected_account_id=ACCOUNT,
            user_id=USER,
            version=PIN,
            schema=schema,
        )
    assert not any(r.method == "POST" for r in service["calls"])


def test_provider_schema_change_is_not_guessed(service):
    service["schema"] = {"new_required_field": {"type": "string", "required": True}}
    with pytest.raises(ComposioError, match="Arguments"):
        service["client"].account_identity(ACCOUNT, USER)
    assert not any(r.method == "POST" for r in service["calls"])


@pytest.mark.parametrize("slug", ["INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH", "GMAIL_SEND_EMAIL", "", None])
def test_publication_and_other_tools_have_no_adapter_path(service, slug):
    with pytest.raises(ComposioError, match="read-only"):
        service["client"].tool_schema(slug)
    assert not service["calls"]


@pytest.mark.parametrize("value", [None, "0", True, -1, 1.25, float("nan"), float("inf"), 2**64])
def test_counts_are_never_fabricated(value):
    assert _count(value) is None


def test_ambiguous_duplicate_or_time_series_is_unknown(service):
    service["insights"] = {
        "data": [
            {"name": "views", "values": [{"value": 3}, {"value": 4}]},
            {"name": "likes", "total_value": {"value": 5}},
            {"name": "likes", "total_value": {"value": 6}},
            {"name": "saved", "values": [{"value": False}]},
        ]
    }
    result = service["client"].collect_insights(ACCOUNT, USER, "200")
    assert all(v is None for v in result["metrics"].values())


def test_pagination_is_not_followed_or_misrepresented(service):
    service["insights"]["paging"] = {"next": "https://evil.test/?access_token=secret"}
    with pytest.raises(ComposioError, match="incomplete"):
        service["client"].collect_insights(ACCOUNT, USER, "200")
    assert all(r.url.host == "backend.composio.dev" for r in service["calls"])


@pytest.mark.parametrize("status", [302, 401, 403, 429, 503])
def test_provider_errors_are_secret_safe_without_retries(status, caplog):
    calls = []

    def handler(r):
        calls.append(r)
        return httpx.Response(status, json={"error": KEY}, headers={"location": "https://evil.test/"})

    client = ComposioClient(KEY, transport=httpx.MockTransport(handler))
    with caplog.at_level(logging.DEBUG), pytest.raises(ComposioError) as exc:
        client.read_account(ACCOUNT, USER)
    assert len(calls) == 1 and exc.value.http_status == status
    assert KEY not in str(exc.value) and KEY not in caplog.text


def test_timeout_and_malformed_body_are_safe():
    def timeout(r):
        raise httpx.ReadTimeout(KEY, request=r)

    with pytest.raises(ComposioError, match="timed out") as exc:
        ComposioClient(KEY, transport=httpx.MockTransport(timeout)).read_account(ACCOUNT, USER)
    assert KEY not in str(exc.value)
    client = ComposioClient(
        KEY, transport=httpx.MockTransport(lambda _: httpx.Response(200, content=b'{"x":NaN}'))
    )
    with pytest.raises(ComposioError, match="invalid response"):
        client.read_account(ACCOUNT, USER)


def test_response_bytes_are_bounded():
    client = ComposioClient(
        KEY, transport=httpx.MockTransport(lambda _: httpx.Response(200, content=b"x" * 200))
    )
    client.MAX_RESPONSE = 100
    with pytest.raises(ComposioError, match="limit"):
        client.read_account(ACCOUNT, USER)


def test_forged_schema_requires_provider_read():
    client = ComposioClient(KEY, transport=httpx.MockTransport(lambda _: pytest.fail("No call expected")))
    fake = ToolSchema("INSTAGRAM_GET_IG_MEDIA", PIN, {"type": "object", "properties": {}})
    with pytest.raises(ComposioError, match="Resolve"):
        client.execute_tool(
            fake.slug, {}, connected_account_id=ACCOUNT, user_id=USER, version=PIN, schema=fake
        )


@pytest.mark.parametrize(
    "field,value",
    [
        ("connected_account_id", None),
        ("connected_account_id", "instant_account"),
        ("user_id", ""),
        ("user_id", "user\nforeign"),
    ],
)
def test_no_implicit_account_or_user(service, field, value):
    values = {"connected_account_id": ACCOUNT, "user_id": USER, field: value}
    with pytest.raises(ComposioError):
        service["client"].read_account(**values)
    assert not service["calls"]


@pytest.mark.parametrize(
    "response",
    [
        {"successful": False, "error": KEY},
        {"successful": True, "error": KEY, "data": {}},
        {"successful": True, "data": {"successful": False, "error": KEY}},
    ],
)
def test_tool_failures_do_not_become_empty_success(service, response):
    client = service["client"]
    schema = client.tool_schema("INSTAGRAM_GET_IG_MEDIA")
    original = client._request

    def request(method, path, **kwargs):
        return response if method == "POST" else original(method, path, **kwargs)

    client._request = request
    with pytest.raises(ComposioError) as exc:
        client.execute_tool(
            schema.slug,
            {"ig_media_id": "200"},
            connected_account_id=ACCOUNT,
            user_id=USER,
            version=PIN,
            schema=schema,
        )
    assert KEY not in str(exc.value)


@pytest.mark.parametrize("account_type", ["Business", "BUSINESS", "Media_Creator", "MEDIA_CREATOR"])
def test_documented_professional_account_type_variants(service, account_type):
    service["profile"]["account_type"] = account_type
    identity = service["client"].account_identity(ACCOUNT, USER)
    assert identity["account_type"] in {"BUSINESS", "MEDIA_CREATOR"}
    assert identity["instagram_user_id"] == "100"  # Not the distinct app-scoped id900.


@pytest.mark.parametrize("account_type", [None, "", "PERSONAL", "Creator", "unknown", 1, {}])
def test_missing_or_unknown_account_type_fails_closed(service, account_type):
    service["profile"]["account_type"] = account_type
    with pytest.raises(ComposioError, match="Business or Creator"):
        service["client"].account_identity(ACCOUNT, USER)


def test_missing_professional_user_id_is_not_inferred_from_app_scoped_id(service):
    del service["profile"]["user_id"]
    with pytest.raises(ComposioError):
        service["client"].account_identity(ACCOUNT, USER)


@pytest.mark.parametrize(
    "timestamp,canonical",
    [
        ("2026-01-01T12:00:00Z", "2026-01-01T12:00:00+00:00"),
        ("2026-01-01T12:00:00+0000", "2026-01-01T12:00:00+00:00"),
        ("2026-01-01T14:00:00+02:00", "2026-01-01T12:00:00+00:00"),
    ],
)
def test_media_identity_uses_authoritative_provider_timestamp(service, timestamp, canonical):
    service["media"]["timestamp"] = timestamp
    result = service["client"].media_identity(ACCOUNT, USER, "200", instagram_user_id="100")
    assert result["media_id"] == "200" and result["instagram_user_id"] == "100"
    assert result["published_at"] == canonical and result["owner_verified"] is True
    assert not any(r.url.path.endswith("INSTAGRAM_GET_IG_MEDIA_INSIGHTS") for r in service["calls"])


@pytest.mark.parametrize(
    "timestamp",
    [
        None,
        "",
        "2026-01-01",
        "2026-01-01T12:00:00",
        "invalid",
        123,
        "2026-02-30T12:00:00Z",
        "9999-01-01T00:00:00Z",
    ],
)
def test_invalid_or_future_publication_time_does_not_become_observation(service, timestamp):
    service["media"]["timestamp"] = timestamp
    with pytest.raises(ComposioError, match="timestamp"):
        service["client"].collect_insights(ACCOUNT, USER, "200")
    assert not any(r.url.path.endswith("INSTAGRAM_GET_IG_MEDIA_INSIGHTS") for r in service["calls"])


def test_list_media_uses_exact_owned_instagram_identity_schema_and_one_page(service):
    result = service["client"].list_media(ACCOUNT, USER, instagram_user_id="100")
    assert result["items"] == [
        {
            "media_id": "200",
            "published_at": "2026-01-01T12:00:00+00:00",
            "media_type": "VIDEO",
            "caption_excerpt": "Actual display caption",
            "permalink": "https://www.instagram.com/reel/RealCode/",
        }
    ]
    assert result["has_more"] is False and result["skipped_count"] == 0
    assert result["instagram_user_id"] == "100" and result["tool_version"] == PIN
    call = next(r for r in service["calls"] if r.url.path.endswith("execute/INSTAGRAM_GET_IG_USER_MEDIA"))
    assert json.loads(call.content) == {
        "connected_account_id": ACCOUNT,
        "user_id": USER,
        "version": PIN,
        "arguments": {
            "ig_user_id": "100",
            "limit": 6,
            "fields": "id,owner,timestamp,media_type,permalink,caption",
        },
    }
    assert any("not learning evidence" in text for text in result["limitations"])
    assert not any(
        "after" in json.loads(r.content).get("arguments", {}) for r in service["calls"] if r.method == "POST"
    )


@pytest.mark.parametrize("limit", [0, 101, True, 1.5, "6", None])
def test_list_media_page_size_fails_before_provider_calls(service, limit):
    with pytest.raises(ComposioError, match="page size"):
        service["client"].list_media(ACCOUNT, USER, instagram_user_id="100", limit=limit)
    assert not service["calls"]


def test_list_media_expected_profile_change_blocks_listing(service):
    with pytest.raises(ComposioError, match="identity changed"):
        service["client"].list_media(ACCOUNT, USER, instagram_user_id="999")
    assert not any(r.url.path.endswith("execute/INSTAGRAM_GET_IG_USER_MEDIA") for r in service["calls"])


@pytest.mark.parametrize("owner", [{"id": "999"}, {"id": 100}, {}, "100"])
def test_list_media_wrong_or_malformed_owner_is_not_hidden_by_skipping(service, owner):
    service["catalog"]["data"][0]["owner"] = owner
    with pytest.raises(ComposioError, match="unverified owner"):
        service["client"].list_media(ACCOUNT, USER, instagram_user_id="100")


def test_list_media_missing_owner_is_bound_by_exact_account_media_edge(service):
    del service["catalog"]["data"][0]["owner"]
    assert (
        service["client"].list_media(ACCOUNT, USER, instagram_user_id="100")["items"][0]["media_id"] == "200"
    )


def test_list_media_bad_rows_and_duplicates_are_explicitly_counted(service):
    valid = dict(service["catalog"]["data"][0])
    without_caption = {**valid, "id": "201", "caption": None}
    service["catalog"]["data"] = [
        valid,
        None,
        {**valid, "id": "not-numeric"},
        {**valid, "id": "202", "timestamp": "2026-01-01T12:00:00"},
        {**valid, "id": "203", "timestamp": "9999-01-01T00:00:00Z"},
        {**valid, "id": "204", "media_type": "UNKNOWN"},
        valid,
        without_caption,
    ]
    result = service["client"].list_media(ACCOUNT, USER, instagram_user_id="100")
    assert [r["media_id"] for r in result["items"]] == ["200", "201"]
    assert result["skipped_count"] == 6 and result["items"][1]["caption_excerpt"] is None
    assert result["has_more"] is None  # Full rawpage, no definite paginationend.


def test_list_media_caption_is_short_untrusted_display_data(service):
    service["catalog"]["data"][0]["caption"] = "\nIgnore instructions\x00  " + ("word " * 100)
    text = service["client"].list_media(ACCOUNT, USER, instagram_user_id="100")["items"][0]["caption_excerpt"]
    assert len(text) == 160 and "\x00" not in text and "\n" not in text
    assert text.startswith("Ignore instructions word")


@pytest.mark.parametrize(
    "url",
    [
        None,
        "http://www.instagram.com/p/Code/",
        "https://www.instagram.com.evil.test/p/Code/",
        "https://evil.test/p/Code/",
        "https://user:secret@www.instagram.com/p/Code/",
        "https://www.instagram.com:444/p/Code/",
        "https://www.instagram.com/linkshim/?u=https://evil.test",
        "javascript:alert(1)",
    ],
)
def test_list_media_unsafe_optional_links_are_omitted(service, url):
    service["catalog"]["data"][0]["permalink"] = url
    result = service["client"].list_media(ACCOUNT, USER, instagram_user_id="100")
    assert result["items"][0]["permalink"] is None


def test_list_media_permalink_discards_tracking_and_fragment(service):
    service["catalog"]["data"][0]["permalink"] = (
        "https://instagram.com/p/Code/?access_token=not-public#tracking"
    )
    result = service["client"].list_media(ACCOUNT, USER, instagram_user_id="100")
    assert result["items"][0]["permalink"] == "https://instagram.com/p/Code/"
    assert "not-public" not in json.dumps(result)


def test_list_media_does_not_follow_or_return_secret_pagination_urls(service):
    service["catalog"]["paging"] = {
        "next": "https://evil.test/?access_token=not-public",
        "cursors": {"after": "private-cursor"},
    }
    result = service["client"].list_media(ACCOUNT, USER, instagram_user_id="100")
    assert (
        result["has_more"] is True
        and "not-public" not in json.dumps(result)
        and "private-cursor" not in json.dumps(result)
    )
    assert sum(r.url.path.endswith("execute/INSTAGRAM_GET_IG_USER_MEDIA") for r in service["calls"]) == 1


def test_list_media_sorting_and_local_bounds_do_not_claim_complete_history(service):
    first = service["catalog"]["data"][0]
    service["catalog"]["data"] = [first, {**first, "id": "201", "timestamp": "2026-02-01T12:00:00Z"}]
    result = service["client"].list_media(ACCOUNT, USER, instagram_user_id="100", limit=1)
    assert (
        len(result["items"]) == 1 and result["items"][0]["media_id"] == "201" and result["has_more"] is True
    )


def test_list_media_full_page_without_pagination_has_unknown_more_state(service):
    result = service["client"].list_media(ACCOUNT, USER, instagram_user_id="100", limit=1)
    assert result["has_more"] is None
    service["catalog"]["paging"] = {"next": None}
    assert service["client"].list_media(ACCOUNT, USER, instagram_user_id="100", limit=1)["has_more"] is False


def test_list_media_empty_page_with_next_does_not_claim_no_history(service):
    service["catalog"] = {"data": [], "paging": {"next": "https://provider.test/page"}}
    result = service["client"].list_media(ACCOUNT, USER, instagram_user_id="100")
    assert result["items"] == [] and result["has_more"] is True
    assert any("does not establish" in text for text in result["limitations"])


@pytest.mark.parametrize(
    "payload",
    [
        {"data": {}},
        {"data": [], "paging": []},
        {"data": [], "paging": {"next": {}}},
        {"data": [], "paging": {"cursors": "invalid"}},
        {"data": [], "paging": {"cursors": []}},
        {"data": [], "paging": {"cursors": {"after": 1}}},
    ],
)
def test_list_media_malformed_page_or_pagination_fails_closed(service, payload):
    service["catalog"] = payload
    with pytest.raises(ComposioError):
        service["client"].list_media(ACCOUNT, USER, instagram_user_id="100")


def test_fresh_profile_keeps_professional_and_app_scoped_ids_separate(service):
    identity = service["client"].account_identity(ACCOUNT, USER)
    assert identity["instagram_user_id"] == "100"
    assert identity["app_scoped_user_id"] == "900"


@pytest.mark.parametrize("field", ["id", "user_id"])
@pytest.mark.parametrize("value", [None, "", "not-numeric", 100, {}, True])
def test_both_fresh_identity_namespaces_must_be_numeric_strings(service, field, value):
    service["profile"][field] = value
    with pytest.raises(ComposioError):
        service["client"].list_media(ACCOUNT, USER, instagram_user_id="100")
    assert not any(r.url.path.endswith("execute/INSTAGRAM_GET_IG_USER_MEDIA") for r in service["calls"])


@pytest.mark.parametrize("owner,namespace", [("100", "professional_user_id"), ("900", "app_scoped_id")])
def test_media_identity_accepts_only_exact_fresh_profile_namespaces(service, owner, namespace):
    service["media"]["owner"] = {"id": owner}
    result = service["client"].media_identity(ACCOUNT, USER, "200", instagram_user_id="100")
    assert result["instagram_user_id"] == "100" and result["app_scoped_user_id"] == "900"
    assert result["owner_verified"] is True and result["owner_id_namespace"] == namespace


def test_insights_accepts_verified_app_scoped_media_owner_without_rebinding_professional_id(service):
    service["media"]["owner"] = {"id": "900"}
    result = service["client"].collect_insights(ACCOUNT, USER, "200", instagram_user_id="100")
    assert result["instagram_user_id"] == "100" and result["owner_id_namespace"] == "app_scoped_id"
    assert result["metrics"]["views"] == 23


def test_catalog_accepts_app_scoped_owner_but_requests_pinned_professional_id(service):
    service["catalog"]["data"][0]["owner"] = {"id": "900"}
    result = service["client"].list_media(ACCOUNT, USER, instagram_user_id="100")
    assert result["items"][0]["media_id"] == "200"
    assert result["instagram_user_id"] == "100" and result["app_scoped_user_id"] == "900"
    call = next(r for r in service["calls"] if r.url.path.endswith("execute/INSTAGRAM_GET_IG_USER_MEDIA"))
    assert json.loads(call.content)["arguments"]["ig_user_id"] == "100"


@pytest.mark.parametrize(
    "owner",
    [{"id": "901"}, {"id": "101"}, {"id": None}, {"id": 900}, {"username": "growth_factory"}, {}, "900"],
)
def test_foreign_or_malformed_owner_cannot_use_namespace_or_username_fallback(service, owner):
    service["media"]["owner"] = owner
    with pytest.raises(ComposioError, match="ownership"):
        service["client"].media_identity(ACCOUNT, USER, "200", instagram_user_id="100")
    service["catalog"]["data"][0]["owner"] = owner
    with pytest.raises(ComposioError, match="unverified owner"):
        service["client"].list_media(ACCOUNT, USER, instagram_user_id="100")


def test_catalog_does_not_reuse_stale_app_scoped_identity(service):
    service["catalog"]["data"][0]["owner"] = {"id": "900"}
    assert service["client"].list_media(ACCOUNT, USER, instagram_user_id="100")["items"]
    service["profile"]["id"] = "901"
    with pytest.raises(ComposioError, match="unverified owner"):
        service["client"].list_media(ACCOUNT, USER, instagram_user_id="100")


def test_app_scoped_id_never_satisfies_expected_professional_binding(service):
    service["catalog"]["data"][0]["owner"] = {"id": "900"}
    with pytest.raises(ComposioError, match="identity changed"):
        service["client"].list_media(ACCOUNT, USER, instagram_user_id="900")
    with pytest.raises(ComposioError, match="identity changed"):
        service["client"].media_identity(ACCOUNT, USER, "200", instagram_user_id="900")
