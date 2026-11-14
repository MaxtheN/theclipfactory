"""Local desktop entry point; application lifespan owns all pipeline processes."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import platform
import secrets
import signal
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path
from urllib.error import URLError
from urllib.request import ProxyHandler, Request, build_opener

import uvicorn


class LauncherError(RuntimeError):
    """A credential-free error safe to display in the launcher."""


def preserve_tool_path() -> None:
    """Finder does not inherit the user's shell PATH. Keep it, then add brew paths."""
    paths = os.environ.get("PATH", "").split(os.pathsep)
    for path in ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"):
        if path not in paths:
            paths.append(path)
    os.environ["PATH"] = os.pathsep.join(filter(None, paths))


def loopback_host(value: str) -> str:
    # Use IP literals, not DNS names that can change after validation.
    if value == "localhost":
        return "127.0.0.1"
    try:
        address = ipaddress.ip_address(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("host must be a loopback IP literal or localhost") from exc
    if not address.is_loopback:
        raise argparse.ArgumentTypeError("non-loopback hosts are forbidden")
    return str(address)


def port_number(value: str) -> int:
    try:
        port = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("port must be an integer from 0 to 65535") from exc
    if not 0 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be from 0 to 65535")
    return port


def wait_ready(
    server: uvicorn.Server,
    thread: threading.Thread,
    url: str,
    token: str,
    stop: threading.Event,
    timeout: float = 30.0,
) -> None:
    """Check authenticated HTTP readiness without consuming the bootstrap cookie."""
    opener = build_opener(ProxyHandler({}))  # Never send the token through a system proxy.
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if stop.is_set():
            raise LauncherError("startup interrupted")
        if not thread.is_alive():
            raise LauncherError("local server stopped during startup")
        if server.started:
            try:
                request = Request(f"{url}/api/health", headers={"X-Clip-Token": token})
                with opener.open(request, timeout=0.5) as response:
                    if response.status == 200:
                        return
            except (OSError, URLError):
                pass
        stop.wait(0.1)
    raise LauncherError("local server did not become ready within 30 seconds")


def startup_event(root: Path | None, event: str, message: str | None = None):
    """Credential-free launch diagnostics, including Finder's windowed launches."""
    if root is None:
        return
    try:
        if root.is_symlink():
            return
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        directory = root / "logs"
        if directory.is_symlink():
            return
        directory.mkdir(exist_ok=True)
        path = directory / "startup.log"
        if path.is_symlink():
            return
        if path.exists() and path.stat().st_size > 65536:
            path.unlink()
        with path.open("a", encoding="utf-8") as output:
            output.write(json.dumps({"time": time.time(), "event": event, "message": message}) + "\n")
        path.chmod(0o600)
    except OSError:
        pass  # Diagnostics must not introduce a new launch failure.


def show_launch_error(message: str):
    if not getattr(sys, "frozen", False) or platform.system() != "Darwin":
        return
    try:
        from AppKit import NSAlert

        alert = NSAlert.alloc().init()
        alert.setMessageText_("Clip Factory could not start")
        alert.setInformativeText_(message + "\n\nDetails: Application Support/ClipFactory/logs/startup.log")
        alert.addButtonWithTitle_("OK")
        alert.runModal()
    except Exception:  # noqa: BLE001 - best-effort native alert must not cause another crash
        return


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Clip Factory local desktop")
    parser.add_argument("--host", type=loopback_host, default="127.0.0.1")
    parser.add_argument("--port", type=port_number, default=0, help="0 selects an available local port")
    parser.add_argument("--data-dir", type=Path, help="override the application's local data directory")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--browser", action="store_true", help="explicitly use the system browser")
    mode.add_argument("--headless", action="store_true", help="serve only; print a local bootstrap URL")
    parser.add_argument("--native-smoke", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.native_smoke and (args.browser or args.headless or args.data_dir is None):
        parser.error("--native-smoke requires an explicit --data-dir and native mode")
    preserve_tool_path()
    stop = threading.Event()
    previous_handlers = {}
    server = None
    thread = None
    listener = None
    diagnostic_root = args.data_dir
    try:
        # Import lazily: CLI help/validation do not require desktop GUI or app startup.
        if getattr(sys, "frozen", False) and diagnostic_root is None:
            from platformdirs import user_data_dir

            diagnostic_root = Path(user_data_dir("ClipFactory", "ClipFactory"))
        from clip_factory.app import create_app

        token = secrets.token_urlsafe(32)
        app = create_app(data_dir=args.data_dir, token=token)
        diagnostic_root = getattr(app.state, "root", diagnostic_root)
        startup_event(diagnostic_root, "server-starting")
        # The parent exposes this flag in /api/system. Native only means native.
        app.state.desktop = not (args.browser or args.headless)
        family = socket.AF_INET6 if ":" in args.host else socket.AF_INET
        listener = socket.socket(family, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind((args.host, args.port))
        listener.listen(128)
        host = f"[{args.host}]" if family == socket.AF_INET6 else args.host
        url = f"http://{host}:{listener.getsockname()[1]}"
        bootstrap = f"{url}/?boot={token}"
        server = uvicorn.Server(
            uvicorn.Config(
                app,
                host=args.host,
                port=args.port,
                log_level="warning",
                access_log=False,
                timeout_graceful_shutdown=10,
            )
        )
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous_handlers[sig] = signal.signal(sig, lambda *_: stop.set())
        thread = threading.Thread(
            target=server.run, kwargs={"sockets": [listener]}, name="clip-factory-server", daemon=True
        )
        thread.start()
        wait_ready(server, thread, url, token, stop)
        startup_event(diagnostic_root, "server-ready")
        if args.headless:
            print(f"Clip Factory local bootstrap URL: {bootstrap}", flush=True)
        elif args.browser:
            if not webbrowser.open(bootstrap):
                raise LauncherError("could not open browser; use --headless to obtain a local URL")
            print("Clip Factory is running in browser mode. Press Ctrl-C to stop.", flush=True)
        else:
            try:
                import webview

                webview.settings["ALLOW_DOWNLOADS"] = True
                startup_event(diagnostic_root, "native-window-starting")
                window = webview.create_window(
                    "Clip Factory", bootstrap, width=1440, height=960, min_size=(900, 640)
                )
                closed = threading.Event()

                def on_closed():
                    closed.set()
                    stop.set()
                    startup_event(diagnostic_root, "native-window-closed")

                window.events.closed += on_closed
                if hasattr(window.events, "loaded"):

                    def on_loaded():
                        startup_event(diagnostic_root, "native-window-loaded")

                    window.events.loaded += on_loaded

                # Signal callbacks only set an event; GUI destruction stays out of signal handlers.
                def monitor_window():
                    while not stop.wait(0.2):
                        if not thread.is_alive():
                            break
                    if not closed.is_set():
                        window.destroy()

                smoke_result = {"passed": False}

                def smoke_window():
                    deadline = time.monotonic() + 30
                    try:
                        while time.monotonic() < deadline and not stop.is_set():
                            if window.run_js(
                                "document.title === 'Clip Factory' && !!document.querySelector('#root') && document.querySelector('#root').textContent.includes('Clip Factory')"
                            ):
                                break
                            time.sleep(0.2)
                        else:
                            return
                        window.run_js(
                            "window.__clipSmokeHealth = 'checking'; fetch('/api/health', {credentials:'same-origin'}).then(r => {window.__clipSmokeHealth = r.ok ? 'ready' : 'failed'}).catch(() => {window.__clipSmokeHealth = 'failed'}); true"
                        )
                        while time.monotonic() < deadline and not stop.is_set():
                            state = window.run_js("window.__clipSmokeHealth")
                            if state == "ready":
                                smoke_result["passed"] = True
                                (args.data_dir / "native-smoke.json").write_text(
                                    json.dumps({"native_window": True, "ui": True, "authenticated": True})
                                )
                                startup_event(diagnostic_root, "native-window-verified")
                                return
                            if state == "failed":
                                return
                            time.sleep(0.2)
                    finally:
                        window.destroy()

                webview.start(smoke_window if args.native_smoke else monitor_window, private_mode=True)
                if args.native_smoke and not smoke_result["passed"]:
                    raise LauncherError("native window smoke failed before authenticated UI was verified")
            except Exception:  # noqa: BLE001 - native backends vary; never expose URL-bearing errors
                # GUI exceptions can contain the bootstrap URL. Never log those details.
                raise LauncherError(
                    "native window failed; see startup.log, or explicitly launch with --browser"
                ) from None
            return 0
        while not stop.wait(0.2):
            if not thread.is_alive():
                raise LauncherError("local server stopped unexpectedly")
        return 0
    except Exception as exc:  # noqa: BLE001 - redact errors at the process boundary
        # Only our credential-free messages are exposed; app errors may contain secrets.
        message = str(exc) if isinstance(exc, LauncherError) else None
        safe_message = message or "startup failed; check local dependencies and port availability"
        startup_event(diagnostic_root, "startup-failed", safe_message)
        if sys.stderr is not None:
            print(f"Clip Factory: {safe_message}", file=sys.stderr)
        stop.set()
        if server is not None:
            server.should_exit = True
        if not args.browser and not args.headless and not args.native_smoke:
            show_launch_error(safe_message)
        return 1
    finally:
        stop.set()
        if server is not None:
            server.should_exit = True
        if thread is not None:
            thread.join(timeout=15)
            if thread.is_alive():
                server.force_exit = True
                thread.join(timeout=2)
                print("Clip Factory: shutdown timed out; check for unfinished local jobs.", file=sys.stderr)
        if listener is not None:
            listener.close()
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    raise SystemExit(main())
