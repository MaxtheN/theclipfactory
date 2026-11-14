"""Launcher tests use a real local server and a minimal parent-app seam."""

import argparse
import signal
import socket
import sys
import threading
import types
from contextlib import asynccontextmanager
from urllib.parse import parse_qs, urlparse
from urllib.request import ProxyHandler, Request, build_opener

import pytest
from fastapi import FastAPI
from fastapi import Request as FastAPIRequest

from clip_factory import main as launcher


@pytest.fixture
def parent(monkeypatch):
    state = {"stopped": False}

    def create_app(data_dir=None, token=None):
        state.update(data_dir=data_dir, token=token)

        @asynccontextmanager
        async def lifespan(app):
            yield
            state["stopped"] = True

        app = FastAPI(lifespan=lifespan)

        @app.get("/api/health")
        def health(request: FastAPIRequest):
            assert request.headers["x-clip-token"] == token
            return {"status": "ready"}

        @app.get("/api/system")
        def system(request: FastAPIRequest):
            assert request.headers["x-clip-token"] == token
            return {"desktop": app.state.desktop}

        state["app"] = app
        return app

    monkeypatch.setitem(sys.modules, "clip_factory.app", types.SimpleNamespace(create_app=create_app))
    return state


@pytest.mark.parametrize("host", ["0.0.0.0", "192.168.1.4", "::", "example.com"])
def test_nonloopback_rejected(host):
    with pytest.raises(argparse.ArgumentTypeError):
        launcher.loopback_host(host)


@pytest.mark.parametrize("host", ["127.0.0.1", "127.0.0.2", "::1", "localhost"])
def test_loopback_allowed(host):
    assert launcher.loopback_host(host)


@pytest.mark.parametrize("port", ["-1", "65536", "foo"])
def test_invalid_port(port):
    with pytest.raises(argparse.ArgumentTypeError):
        launcher.port_number(port)


def test_browser_ready_then_shutdown(monkeypatch, parent, tmp_path):
    opened = []
    previous = signal.getsignal(signal.SIGTERM)

    def open_browser(url):
        opened.append(url)
        parts = urlparse(url)
        token = parse_qs(parts.query)["boot"][0]
        assert token == parent["token"] and len(token) >= 32
        request = Request(f"http://{parts.netloc}/api/system", headers={"X-Clip-Token": token})
        with build_opener(ProxyHandler({})).open(request) as response:
            assert response.status == 200
        signal.raise_signal(signal.SIGTERM)
        return True

    monkeypatch.setattr(launcher.webbrowser, "open", open_browser)
    assert launcher.main(["--browser", "--data-dir", str(tmp_path)]) == 0
    assert parent["data_dir"] == tmp_path
    assert not parent["app"].state.desktop
    assert parent["stopped"]
    assert signal.getsignal(signal.SIGTERM) == previous
    assert len(opened) == 1
    port = urlparse(opened[0]).port
    with socket.socket() as probe:
        assert probe.connect_ex(("127.0.0.1", port)) != 0


def test_native_close_cleanup(monkeypatch, parent):
    class Event:
        def __iadd__(self, callback):
            self.callback = callback
            return self

    event = Event()
    window = types.SimpleNamespace(events=types.SimpleNamespace(closed=event), destroy=lambda: None)

    def start(callback, **kwargs):
        assert kwargs["private_mode"] is True
        event.callback()
        callback()

    monkeypatch.setitem(
        sys.modules,
        "webview",
        types.SimpleNamespace(create_window=lambda *args, **kwargs: window, start=start),
    )
    assert launcher.main([]) == 0
    assert parent["app"].state.desktop
    assert parent["stopped"]


def test_no_implicit_browser_fallback(monkeypatch, parent, capsys):
    def fail(*args, **kwargs):
        raise RuntimeError("sensitive GUI failure")

    monkeypatch.setitem(sys.modules, "webview", types.SimpleNamespace(create_window=fail))
    monkeypatch.setattr(launcher.webbrowser, "open", lambda _: pytest.fail("implicit browser fallback"))
    assert launcher.main([]) == 1
    output = capsys.readouterr()
    assert "--browser" in output.err
    assert "sensitive" not in output.err
    assert parent["token"] not in output.err
    assert parent["stopped"]


def test_headless_prints_url_without_opening_gui(monkeypatch, parent, capsys):
    monkeypatch.setattr(launcher.webbrowser, "open", lambda _: pytest.fail("browser opened"))
    original = launcher.wait_ready

    def ready(*args, **kwargs):
        original(*args, **kwargs)
        signal.raise_signal(signal.SIGINT)

    monkeypatch.setattr(launcher, "wait_ready", ready)
    assert launcher.main(["--headless"]) == 0
    assert f"/?boot={parent['token']}" in capsys.readouterr().out
    assert not parent["app"].state.desktop
    assert parent["stopped"]


def test_readiness_timeout():
    server = types.SimpleNamespace(started=False)
    thread = types.SimpleNamespace(is_alive=lambda: True)
    with pytest.raises(launcher.LauncherError, match="did not become ready"):
        launcher.wait_ready(server, thread, "http://127.0.0.1:1", "secret", threading.Event(), timeout=0.01)


def test_path_preserved(monkeypatch):
    monkeypatch.setenv("PATH", "/custom/bin:/usr/bin")
    launcher.preserve_tool_path()
    assert launcher.os.environ["PATH"].startswith("/custom/bin:/usr/bin:")
    assert "/opt/homebrew/bin" in launcher.os.environ["PATH"].split(":")


def test_occupied_port_fails_without_token_leak(parent, capsys):
    with socket.socket() as busy:
        busy.bind(("127.0.0.1", 0))
        busy.listen()
        assert launcher.main(["--headless", "--port", str(busy.getsockname()[1])]) == 1
    output = capsys.readouterr()
    assert parent["token"] not in output.err + output.out


def test_browser_failure_stops_server(monkeypatch, parent, capsys):
    monkeypatch.setattr(launcher.webbrowser, "open", lambda _: False)
    assert launcher.main(["--browser"]) == 1
    assert parent["stopped"]
    assert "--headless" in capsys.readouterr().err


def test_startup_thread_failure():
    server = types.SimpleNamespace(started=False)
    thread = types.SimpleNamespace(is_alive=lambda: False)
    with pytest.raises(launcher.LauncherError, match="stopped during startup"):
        launcher.wait_ready(server, thread, "http://127.0.0.1:1", "secret", threading.Event())
