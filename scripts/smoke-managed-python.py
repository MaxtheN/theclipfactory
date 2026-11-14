#!/usr/bin/env python3
"""Real macOS bootstrap, private venv and pip smoke; no MLX/model-quality claim."""

from __future__ import annotations

import platform
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

from clip_factory.jobs import Jobs
from clip_factory.models import child_env
from clip_factory.python_runtime import bootstrap_python
from clip_factory.store import Store


def main():
    assert platform.system() == "Darwin" and platform.machine() == "arm64"
    with tempfile.TemporaryDirectory(prefix="clip-managed-python-") as temporary:
        root = Path(temporary)
        store = Store(root)
        jobs = Jobs(store)
        try:

            def operation(job_id):
                base = bootstrap_python(root, jobs, job_id, child_env())
                with patch(
                    "clip_factory.python_runtime.urllib.request.urlopen",
                    side_effect=AssertionError("Cached Python must not redownload"),
                ):
                    assert bootstrap_python(root, jobs, job_id, child_env()) == base
                venv = root / "venv"
                jobs.process(job_id, [str(base), "-I", "-m", "venv", str(venv)], env=child_env(), timeout=180)
                python = venv / "bin" / "python"
                jobs.process(
                    job_id,
                    [
                        str(python),
                        "-m",
                        "pip",
                        "install",
                        "--disable-pip-version-check",
                        "--no-input",
                        "packaging==25.0",
                    ],
                    env=child_env(),
                    timeout=180,
                )
                jobs.process(
                    job_id,
                    [
                        str(python),
                        "-I",
                        "-c",
                        "import platform,sys,packaging; assert platform.machine() == 'arm64'; assert sys.version_info[:2] == (3,12); assert packaging.__version__ == '25.0'",
                    ],
                    env=child_env(),
                    timeout=30,
                )
                return {"private_python": "verified", "venv": "verified", "pip": "verified"}

            job = jobs.submit("managed_python_smoke", operation)
            deadline = time.monotonic() + 300
            while time.monotonic() < deadline:
                state = store.get("jobs", job["id"])
                if state["status"] in {"completed", "failed", "cancelled"}:
                    break
                time.sleep(0.1)
            else:
                jobs.cancel(job["id"])
                raise AssertionError("Managed Python smoke timed out")
            assert state["status"] == "completed", state.get("error")
            print(
                "Private Apple Silicon Python download/checksum/cache, isolated venv, and real pip install passed."
            )
        finally:
            jobs.close()


if __name__ == "__main__":
    main()
