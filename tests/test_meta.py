"""Contract tests use httpx's transport seam; production always makes real Graph calls."""

import sys
from urllib.parse import parse_qs

import httpx
import pytest

from clip_factory.meta import MetaClient, MetaError, MetaOAuth, SecureTokenStore, validate_public_video_url

TOKEN = "secret-user-token"
PAGE_TOKEN = "secret-page-token"


def discovery():
    return {
        "data": [
            {
                "id": "20",
                "name": "Page",
                "access_token": PAGE_TOKEN,
                "instagram_business_account": {"id": "30", "username": "creator", "name": "Creator"},
            }
        ]
    }


def client(handler):
    return MetaClient(TOKEN, transport=httpx.MockTransport(handler))


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr("clip_factory.meta.time.sleep", lambda _: None)


def test_discovery_and_validate_no_credentials():
    def handler(request):
        assert request.url.path == "/v22.0/me/accounts"
        assert request.headers["Authorization"] == f"Bearer {TOKEN}"
        assert TOKEN not in str(request.url)
        return httpx.Response(200, json=discovery())

    with client(handler) as meta:
        assert meta.discover_account() == {
            "id": "30",
            "username": "creator",
            "name": "Creator",
            "page_id": "20",
        }
        result = meta.validate_token()
        assert result["valid"] is True
        assert "token" not in repr(result)


def test_arbitrary_account_is_rejected_without_reading_it():
    requests = []

    def handler(request):
        requests.append(request.url.path)
        return httpx.Response(200, json=discovery())

    with client(handler) as meta, pytest.raises(MetaError, match="not linked"):
        meta.publish_reel("999", "https://cdn.creator.com/reel.mp4", "Caption")
    assert requests == ["/v22.0/me/accounts"]


def test_page_token_ownership():
    def handler(request):
        if request.url.path.endswith("/accounts"):
            return httpx.Response(400, json={"error": {"code": 100}})
        assert request.url.path == "/v22.0/me"
        return httpx.Response(
            200,
            json={
                "id": "20",
                "instagram_business_account": {"id": "30", "username": "creator", "name": "Creator"},
            },
        )

    with client(handler) as meta:
        assert meta.discover_account("30")["page_id"] == "20"


def test_empty_pages_and_missing_page_token_rejected():
    for payload in ({"data": []}, {"data": [{"id": "20", "instagram_business_account": {"id": "30"}}]}):
        with (
            client(lambda _, payload=payload: httpx.Response(200, json=payload)) as meta,
            pytest.raises(MetaError),
        ):
            meta.discover_account("30")


def test_multiple_accounts_require_selection():
    payload = discovery()
    payload["data"].append(
        {"id": "21", "access_token": PAGE_TOKEN, "instagram_business_account": {"id": "31"}}
    )
    with client(lambda _, payload=payload: httpx.Response(200, json=payload)) as meta:
        with pytest.raises(MetaError, match="select an account"):
            meta.discover_account()
        assert meta.discover_account("31")["id"] == "31"


def test_paging_reconstructs_cursor_never_follows_next_url():
    calls = []

    def handler(request):
        calls.append(str(request.url))
        assert request.url.host == "graph.facebook.com"
        if "after" not in request.url.params:
            return httpx.Response(
                200,
                json={
                    "data": [],
                    "paging": {
                        "next": f"https://evil.com/?access_token={TOKEN}",
                        "cursors": {"after": "cursor"},
                    },
                },
            )
        assert request.url.params["after"] == "cursor"
        return httpx.Response(200, json=discovery())

    with client(handler) as meta:
        assert meta.discover_account()["id"] == "30"
    assert len(calls) == 2
    assert all(TOKEN not in url for url in calls)


@pytest.mark.parametrize("kind", ["api", "network", "non-json", "string-code"])
def test_error_redaction(kind):
    def handler(request):
        if kind == "network":
            raise httpx.ConnectError(f"Leaked {TOKEN} and {PAGE_TOKEN}", request=request)
        if kind == "non-json":
            return httpx.Response(400, text=f"Leaked {TOKEN}")
        return httpx.Response(
            400,
            json={
                "error": {
                    "message": f"Leaked {TOKEN} and {PAGE_TOKEN}",
                    "code": TOKEN if kind == "string-code" else 190,
                }
            },
        )

    with client(handler) as meta, pytest.raises(MetaError) as caught:
        meta.discover_account()
    assert TOKEN not in str(caught.value)
    assert PAGE_TOKEN not in str(caught.value)
    assert TOKEN not in repr(caught.value.__dict__)
    assert caught.value.__cause__ is None


def test_safe_get_retry_bounded():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(429, headers={"Retry-After": "999999"}, json={"error": {"code": 4}})

    with client(handler) as meta, pytest.raises(MetaError) as caught:
        meta.discover_account()
    assert len(requests) == 3
    assert caught.value.retryable is True


def publish_handler(states, *, write_error=None, fail_publish=False):
    calls = []
    iterator = iter(states)

    def handler(request):
        calls.append(request)
        if request.url.path.endswith("/accounts"):
            return httpx.Response(200, json=discovery())
        assert request.headers["Authorization"] == f"Bearer {PAGE_TOKEN}"
        if request.method == "POST":
            if write_error and (request.url.path.endswith("/media_publish") == fail_publish):
                if write_error == "network":
                    raise httpx.ReadTimeout(TOKEN, request=request)
                return httpx.Response(503, json={"error": {"code": 2, "message": TOKEN}})
            if request.url.path.endswith("/media_publish"):
                assert parse_qs(request.content.decode()) == {"creation_id": ["40"]}
                return httpx.Response(200, json={"id": "50"})
            body = parse_qs(request.content.decode())
            assert body["media_type"] == ["REELS"]
            assert "access_token" not in body
            return httpx.Response(200, json={"id": "40"})
        return httpx.Response(200, json={"status_code": next(iterator)})

    return handler, calls


def test_publish_finished_only_and_callback():
    handler, calls = publish_handler(["IN_PROGRESS", "FINISHED"])
    events = []
    with client(handler) as meta:
        assert meta.publish_reel("30", "https://cdn.creator.com/reel.mp4", "Caption", events.append) == {
            "id": "50",
            "container_id": "40",
        }
    assert [event["status_code"] for event in events] == ["CREATED", "IN_PROGRESS", "FINISHED"]
    assert len([r for r in calls if r.url.path.endswith("/media_publish")]) == 1


@pytest.mark.parametrize("state", ["ERROR", "EXPIRED", "PUBLISHED", "UNKNOWN"])
def test_processing_failure_never_publishes(state):
    handler, calls = publish_handler([state])
    with client(handler) as meta, pytest.raises(MetaError):
        meta.publish_reel("30", "https://cdn.creator.com/reel.mp4", "")
    assert not any(r.url.path.endswith("/media_publish") for r in calls)


@pytest.mark.parametrize("write_error", ["network", "api"])
@pytest.mark.parametrize("fail_publish", [False, True])
def test_never_retry_post(write_error, fail_publish):
    handler, calls = publish_handler(["FINISHED"], write_error=write_error, fail_publish=fail_publish)
    with client(handler) as meta, pytest.raises(MetaError) as caught:
        meta.publish_reel("30", "https://cdn.creator.com/reel.mp4", "")
    path = "/media_publish" if fail_publish else "/media"
    assert len([r for r in calls if r.method == "POST" and r.url.path.endswith(path)]) == 1
    assert caught.value.retryable is False


def test_poll_bounded_and_cancellation(monkeypatch):
    handler, calls = publish_handler(["IN_PROGRESS"] * 2)
    with client(handler) as meta:
        meta.MAX_POLL_ATTEMPTS = 2
        with pytest.raises(MetaError) as caught:
            meta.publish_reel("30", "https://cdn.creator.com/reel.mp4", "")
        assert caught.value.code == "processing_timeout"
    assert not any(r.url.path.endswith("/media_publish") for r in calls)
    handler, calls = publish_handler(["FINISHED"])
    with client(handler) as meta, pytest.raises(MetaError) as caught:
        meta.publish_reel("30", "https://cdn.creator.com/reel.mp4", "", cancel_check=lambda: True)
    assert caught.value.code == "cancelled"
    assert calls == []


def test_cancel_after_processing_blocks_publish():
    handler, calls = publish_handler(["FINISHED"])
    cancelled = []
    with client(handler) as meta, pytest.raises(MetaError):
        meta.publish_reel(
            "30",
            "https://cdn.creator.com/reel.mp4",
            "",
            poll_callback=lambda _: cancelled.append(True),
            cancel_check=lambda: bool(cancelled),
        )
    assert not any(r.url.path.endswith("/media_publish") for r in calls)


@pytest.mark.parametrize(
    "url",
    [
        "http://cdn.creator.com/x",
        "file:///tmp/x",
        "https://localhost/x",
        "https://localhost./x",
        "https://foo.localhost/x",
        "https://host.local/x",
        "https://127.0.0.1/x",
        "https://10.1.2.3/x",
        "https://169.254.169.254/x",
        "https://192.168.1.1/x",
        "https://[::1]/x",
        "https://[fe80::1]/x",
        "https://[fc00::1]/x",
        "https://[::ffff:127.0.0.1]/x",
        "https://2130706433/x",
        "https://127.1/x",
        "https://0x7f000001/x",
        "https://user:secret@cdn.creator.com/x",
        "https://cdn.creator.com:8000/x",
        "https://cdn.creator.com/x#fragment",
        "https://evil\\host.com/x",
        "https://cdn.creator.com/ x",
    ],
)
def test_ssrf_url_rejected_before_any_network(url):
    with client(lambda _: pytest.fail("must not call Graph")) as meta, pytest.raises(MetaError):
        meta.publish_reel("30", url, "")


@pytest.mark.parametrize(
    "url",
    ["https://cdn.creator.com/x?signature=opaque", "https://8.8.8.8/x", "https://[2606:4700:4700::1111]/x"],
)
def test_public_url_accepted_without_dereference(url):
    assert validate_public_video_url(url) == url


def test_insights_dynamic_unsupported_missing_and_real_zero():
    def handler(request):
        if request.url.path.endswith("/accounts"):
            return httpx.Response(200, json=discovery())
        if request.url.path.endswith("/media"):
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "50",
                            "caption": "Actual",
                            "timestamp": "2026-01-01",
                            "media_type": "VIDEO",
                            "media_product_type": "REELS",
                        }
                    ]
                },
            )
        metric = request.url.params["metric"]
        assert metric not in {"plays", "impressions", "video_views"}
        if metric == "reach":
            return httpx.Response(400, json={"error": {"code": 100, "message": "unsupported"}})
        if metric == "saved":
            return httpx.Response(200, json={"data": [{"name": metric, "values": [{"value": 0}]}]})
        if metric == "views":
            return httpx.Response(200, json={"data": [{"name": metric, "total_value": {"value": 23}}]})
        if metric == "likes":
            return httpx.Response(200, json={"data": [{"name": metric, "values": [{"value": "unknown"}]}]})
        return httpx.Response(200, json={"data": []})

    with client(handler) as meta:
        rows = meta.fetch_insights("30")
    assert rows[0]["id"] == "50"
    assert rows[0]["metrics"] == {
        "views": 23,
        "reach": None,
        "saved": 0,
        "shares": None,
        "likes": None,
        "comments": None,
        "total_interactions": None,
    }


def test_insight_auth_errors_propagate():
    def handler(request):
        if request.url.path.endswith("/accounts"):
            return httpx.Response(200, json=discovery())
        if request.url.path.endswith("/media"):
            return httpx.Response(200, json={"data": [{"id": "50"}]})
        return httpx.Response(400, json={"error": {"code": 190}})

    with client(handler) as meta, pytest.raises(MetaError, match="Reconnect"):
        meta.fetch_insights("30")


def test_paid_insights_read_only():
    def handler(request):
        assert request.method == "GET"
        assert request.url.path == "/v22.0/act_70/insights"
        assert request.headers["Authorization"] == f"Bearer {TOKEN}"
        return httpx.Response(200, json={"data": [{"ad_id": "80", "spend": "2.50"}]})

    with client(handler) as meta:
        assert meta.fetch_paid_insights("act_70") == [{"ad_id": "80", "spend": "2.50"}]


def test_token_store_native_namespace_and_no_fallback(monkeypatch):
    saved = {}

    class Native:
        __module__ = "keyring.backends.macOS"
        priority = 1

        def set_password(self, service, name, value):
            saved[(service, name)] = value

        def get_password(self, service, name):
            return saved.get((service, name))

        def delete_password(self, service, name):
            del saved[(service, name)]

    monkeypatch.setattr("clip_factory.meta.keyring.get_keyring", lambda: Native())
    store = SecureTokenStore()
    store.set_token("30", TOKEN)
    assert saved == {("clip-factory", "instagram:30"): TOKEN}
    assert store.get_token("30") == TOKEN
    store.delete_token("30")
    store.delete_token("30")
    assert store.get_token("30") is None

    class Plaintext(Native):
        __module__ = "keyrings.alt.file"

    monkeypatch.setattr("clip_factory.meta.keyring.get_keyring", lambda: Plaintext())
    with pytest.raises(MetaError, match="never saved in plain text"):
        store.set_token("30", TOKEN)


def test_keychain_errors_redacted(monkeypatch):
    class Native:
        __module__ = "keyring.backends.macOS"
        priority = 1

        def get_password(self, *_):
            raise RuntimeError(TOKEN)

    monkeypatch.setattr("clip_factory.meta.keyring.get_keyring", lambda: Native())
    with pytest.raises(MetaError) as caught:
        SecureTokenStore().get_token("30")
    assert TOKEN not in str(caught.value)


def test_oauth_exchange_and_one_use_state():
    calls = []

    def handler(request):
        calls.append(request)
        assert request.method == "GET"  # documented Facebook code exchange, not Instagram Login
        assert request.url.path == "/v22.0/oauth/access_token"
        assert "Authorization" not in request.headers
        assert request.url.params["code"] == "code-secret"
        assert request.url.params["client_secret"] == "app-secret"
        return httpx.Response(200, json={"access_token": TOKEN})

    oauth = MetaOAuth(
        "1", "app-secret", "https://app.creator.com/callback", transport=httpx.MockTransport(handler)
    )
    url, state = oauth.authorization_url()
    assert "app-secret" not in url
    assert len(state) >= 32
    assert "instagram_content_publish" in url
    assert oauth.exchange_code("code-secret", state) == TOKEN
    with pytest.raises(MetaError, match="state"):
        oauth.exchange_code("code-secret", state)
    assert len(calls) == 1


def test_oauth_invalid_expired_state_and_no_retry(monkeypatch):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(503, json={"error": {"code": 2, "message": "app-secret"}})

    oauth = MetaOAuth(
        "1", "app-secret", "https://app.creator.com/callback", transport=httpx.MockTransport(handler)
    )
    _, state = oauth.authorization_url()
    assert oauth.verify_state("wrong") is False
    assert oauth.verify_state("é") is False
    with pytest.raises(MetaError) as caught:
        oauth.exchange_code("code-secret", state)
    assert "app-secret" not in str(caught.value)
    assert not caught.value.retryable
    assert len(calls) == 1
    _, state = oauth.authorization_url()
    oauth._states[state] = 0
    assert oauth.verify_state(state) is False


def test_invalid_ids_do_not_reach_graph():
    with client(lambda _: pytest.fail("unexpected network")) as meta:
        with pytest.raises(MetaError):
            meta.discover_account("../../me")
        with pytest.raises(MetaError):
            meta.fetch_paid_insights("act_../me")


def test_library_logging_cannot_leak_oauth_url_or_headers(caplog):
    import logging

    import clip_factory.meta as module

    def handler(request):
        # Covers library debug records as well as HTTPX's own automatic INFO URL record.
        logging.getLogger("httpcore.http11").debug("request=%s token=%s", request.url, TOKEN)
        return httpx.Response(200, json={"access_token": TOKEN})

    caplog.set_level(logging.DEBUG)
    oauth = MetaOAuth(
        "1", "app-secret", "https://app.creator.com/callback", transport=httpx.MockTransport(handler)
    )
    _, state = oauth.authorization_url()
    assert oauth.exchange_code("code-secret", state) == TOKEN
    assert "app-secret" not in caplog.text
    assert "code-secret" not in caplog.text
    assert TOKEN not in caplog.text
    assert module._sensitive_io.get() is False
    logging.getLogger("httpx").info("unrelated request still logged")
    assert "unrelated request still logged" in caplog.text


@pytest.mark.parametrize("status,code", [(400, 190), (403, 200), (400, 100), (302, None)])
def test_nontransient_or_redirect_not_retried(status, code):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            status, headers={"Location": "https://evil.com"}, json={"error": {"code": code}}
        )

    with client(handler) as meta, pytest.raises(MetaError):
        meta.discover_account("30")
    # Code 100 permits exactly the ownership-safe Page-token fallback, not a retry.
    assert len(calls) == (2 if code == 100 else 1)
    assert all(r.url.host == "graph.facebook.com" for r in calls)


@pytest.mark.parametrize("state", [None, {}, []])
def test_malformed_processing_status_is_safe_error(state):
    handler, calls = publish_handler([state])
    with client(handler) as meta, pytest.raises(MetaError, match="unknown container status"):
        meta.publish_reel("30", "https://cdn.creator.com/reel.mp4", "")
    assert not any(r.url.path.endswith("/media_publish") for r in calls)


def test_pagination_loop_is_bounded():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            200,
            json={
                "data": [],
                "paging": {"next": "https://graph.facebook.com/next", "cursors": {"after": "same-cursor"}},
            },
        )

    with client(handler) as meta, pytest.raises(MetaError, match="pagination"):
        meta.discover_account()
    assert len(calls) == 2


def test_malformed_insights_collection_is_not_fake_success():
    def handler(request):
        if request.url.path.endswith("/accounts"):
            return httpx.Response(200, json=discovery())
        if request.url.path.endswith("/media"):
            return httpx.Response(200, json={"data": [{"id": "50"}]})
        return httpx.Response(200, json={"data": None})

    with client(handler) as meta, pytest.raises(MetaError, match="invalid insights"):
        meta.fetch_insights("30")


@pytest.mark.parametrize("url", ["https://224.0.0.1/x", "https://[ff02::1]/x"])
def test_multicast_assets_are_not_public(url):
    with pytest.raises(MetaError):
        validate_public_video_url(url)


@pytest.mark.skipif(sys.platform != "darwin", reason="keyring's macOS backend only loads on macOS")
def test_frozen_app_without_backend_discovery_uses_the_macos_keychain(monkeypatch):
    import sys as _sys

    from keyring.backends import macOS

    class Fail:
        __module__ = "keyring.backends.fail"
        priority = 0

    picked = []
    monkeypatch.setattr(_sys, "platform", "darwin")
    monkeypatch.setattr("clip_factory.meta.keyring.get_keyring", lambda: Fail())
    monkeypatch.setattr("clip_factory.meta.keyring.set_keyring", picked.append)
    monkeypatch.setattr(macOS.Keyring, "priority", 5, raising=False)
    backend = SecureTokenStore._backend()
    assert isinstance(backend, macOS.Keyring) and picked == [backend]


def test_linux_without_a_secret_service_names_it_and_never_falls_back(monkeypatch):
    """No keyring daemon: a clear message naming GNOME Keyring/KWallet, and no plain-text store."""
    import sys as _sys

    from clip_factory import keystore
    from clip_factory.meta import KeyStoreUnavailableError

    class Fail:
        __module__ = "keyring.backends.fail"
        priority = 0

    picked = []
    monkeypatch.setattr(_sys, "platform", "linux")
    monkeypatch.setattr("clip_factory.meta.keyring.get_keyring", lambda: Fail())
    monkeypatch.setattr("clip_factory.meta.keyring.set_keyring", picked.append)
    with pytest.raises(KeyStoreUnavailableError) as error:
        SecureTokenStore._backend()
    message = str(error.value)
    assert "Secret Service" in message and "GNOME Keyring" in message and "plain text" in message
    assert isinstance(error.value, MetaError) and picked == []
    # Every key wrapper passes that guidance through instead of a generic "unlock it".
    assert keystore.key_store_failure("Cannot read the Groq key from", error.value) == message
    assert keystore.key_store_failure("Cannot read the Groq key from", OSError()).startswith(
        "Cannot read the Groq key from system keyring"
    )


def test_frozen_windows_app_without_backend_discovery_uses_credential_manager(monkeypatch):
    import sys as _sys
    import types

    class Fail:
        __module__ = "keyring.backends.fail"
        priority = 0

    class WinVaultKeyring:
        __module__ = "keyring.backends.Windows"
        priority = 5

    picked = []
    monkeypatch.setattr(_sys, "platform", "win32")
    monkeypatch.setitem(_sys.modules, "keyring.backends.Windows", types.SimpleNamespace(WinVaultKeyring=WinVaultKeyring))
    monkeypatch.setattr("clip_factory.meta.keyring.get_keyring", lambda: Fail())
    monkeypatch.setattr("clip_factory.meta.keyring.set_keyring", picked.append)
    backend = SecureTokenStore._backend()
    assert isinstance(backend, WinVaultKeyring) and picked == [backend]


@pytest.mark.parametrize(
    ("platform_name", "name"),
    [("darwin", "macOS Keychain"), ("win32", "Windows Credential Manager"), ("linux", "system keyring")],
)
def test_key_store_is_named_for_the_operating_system(platform_name, name):
    from clip_factory import keystore

    assert keystore.key_store_name(platform_name) == name
    assert "never saved in plain text" in keystore.key_store_unavailable(platform_name)
