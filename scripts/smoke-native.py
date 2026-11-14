"""Packaged Cocoa/WKWebView smoke: open, authenticate, close, and reopen with slow status."""

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import tempfile
from pathlib import Path

from clip_factory.models import RUNTIME_VERSIONS


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", type=Path, required=True)
    args = parser.parse_args()
    assert platform.system() == "Darwin" and platform.machine() == "arm64"
    with tempfile.TemporaryDirectory(prefix="clip-native-smoke-") as temporary:
        root = Path(temporary)
        for attempt in range(2):
            if attempt == 1:
                # Test-only stand-in for slow MLX/Torch/spaCy imports. It verifies
                # the reopen failure without asserting actual model inference.
                runtime = root / "runtime"
                (runtime / "bin").mkdir(parents=True)
                marker = {"python": [3, 12], "machine": "arm64", "packages": RUNTIME_VERSIONS}
                (runtime / ".ready").write_text(json.dumps(marker))
                output = json.dumps({**marker, "system": "Darwin"})
                python = runtime / "bin" / "python"
                python.write_text("#!/bin/sh\nsleep 2\nprintf '%s\\n' '" + output + "'\n")
                python.chmod(0o700)
            result = root / "native-smoke.json"
            result.unlink(missing_ok=True)
            process = subprocess.Popen(
                [str(args.executable.resolve()), "--native-smoke", "--data-dir", str(root)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env={**os.environ, "PYTHONUNBUFFERED": "1"},
            )
            try:
                code = process.wait(timeout=60)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
                raise AssertionError("Native window launch/close timed out") from None
            if code != 0 or not result.is_file():
                log = root / "logs" / "startup.log"
                diagnostic = log.read_text()[-4000:] if log.is_file() else "No launch log available"
                raise AssertionError("Native window smoke failed: " + diagnostic)
            assert json.loads(result.read_text()) == {
                "native_window": True,
                "ui": True,
                "authenticated": True,
            }
        print(
            "Packaged Cocoa window, rendered UI, authenticated cookie, close, and reopen with slow runtime status passed."
        )
        print("Slow runtime is a test double; this is not model inference or target-M5 validation.")


if __name__ == "__main__":
    main()
