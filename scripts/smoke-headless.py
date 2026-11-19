"""CI integration smoke: actual app/bootstrap cookie, no GUI, no persistent token log."""
import argparse
import json
import os
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.request import HTTPCookieProcessor, ProxyHandler, build_opener


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", type=Path)
    parser.add_argument("--expect-ffmpeg", action="store_true",
                        help="require /api/system to report FFmpeg that can burn captions (bundled in Windows/Linux)")
    args = parser.parse_args()
    command = [str(args.executable.resolve())] if args.executable else [sys.executable, "-m", "clip_factory.main"]
    with tempfile.TemporaryDirectory(prefix="clip-factory-smoke-") as directory:
        process = subprocess.Popen(
            [*command, "--headless", "--data-dir", directory],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
            # Windows: a separate process group can receive Ctrl+Break, the console's polite stop.
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
        )
        lines = queue.Queue()

        def read_output():
            for line in process.stdout:
                lines.put(line)

        threading.Thread(target=read_output, daemon=True).start()
        try:
            deadline = time.monotonic() + 45
            url = None
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError("headless launcher exited before bootstrap")
                try:
                    line = lines.get(timeout=0.2)
                except queue.Empty:
                    continue
                prefix = "Clip Factory local bootstrap URL: "
                if line.startswith(prefix):
                    url = line[len(prefix):].strip()
                    break
            if url is None:
                raise RuntimeError("headless readiness timed out")
            opener = build_opener(ProxyHandler({}), HTTPCookieProcessor(CookieJar()))
            with opener.open(url, timeout=5) as response:
                assert response.status == 200, "bootstrap did not serve UI"
                assert "boot=" not in response.url, "bootstrap token not removed from URL"
            origin = url.split("/?", 1)[0]
            with opener.open(f"{origin}/api/system", timeout=30) as response:
                assert response.status == 200, "session cookie did not authenticate"
                system = json.loads(response.read())
            if args.expect_ffmpeg:
                assert system.get("ffmpeg") and system.get("ffprobe"), "packaged app did not find FFmpeg and ffprobe"
                assert system.get("ffmpeg_captions") is True, "packaged FFmpeg cannot burn captions"
            with opener.open(f"{origin}/api/demo-loop/viewer", timeout=5) as response:
                assert response.status == 200 and b"/api/demo-loop/assets/app.js" in response.read(), "packaged demo viewer missing"
            for filename in ("app.js", "styles.css"):
                with opener.open(f"{origin}/api/demo-loop/assets/{filename}", timeout=5) as response:
                    assert response.status == 200 and response.read(), "packaged demo viewer asset missing"
            print("Headless bootstrap, redirect, frontend, session cookie and packaged demo viewer passed (not native GUI).")
        finally:
            if os.name == "nt":
                process.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                process.terminate()
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
                raise RuntimeError("headless launcher did not shut down") from None
            process.stdout.close()
        assert process.returncode == 0, "headless shutdown failed"


if __name__ == "__main__":
    main()
