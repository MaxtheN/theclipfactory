"""One heavy worker, durable job states, cooperative cancellation, bounded child processes."""

from __future__ import annotations

import contextlib
import os
import queue
import signal
import subprocess
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path

from .store import Store, new_id, now


class JobCancelled(Exception):
    pass


class WorkError(RuntimeError):
    """An actionable, credential-free error safe to display."""


DOWNLOAD_WORKERS = 3
TERMINAL = {"completed", "failed", "cancelled"}


class Jobs:
    def __init__(self, store: Store):
        self.store = store
        self.pending: queue.Queue = queue.Queue()
        self.download_pending: queue.Queue = queue.Queue()
        self.stopping = threading.Event()
        self.lock = store.lock
        self.cancellations: dict[str, threading.Event] = {}
        # Optional: called with the job id after every job, whatever its outcome.
        self.cleanup: Callable[[str], None] | None = None
        for job in store.all("jobs"):
            if job["status"] in {"queued", "running"}:
                store.patch(
                    "jobs",
                    job["id"],
                    status="failed",
                    error="Interrupted by app shutdown. Review before retrying.",
                    message="Interrupted",
                    updated_at=now(),
                    finished_at=now(),
                )
        self.thread = threading.Thread(
            target=self._run, args=(self.pending,), name="factory-heavy-worker", daemon=True
        )
        self.download_threads = [
            threading.Thread(
                target=self._run,
                args=(self.download_pending,),
                name=f"factory-download-worker-{i + 1}",
                daemon=True,
            )
            for i in range(DOWNLOAD_WORKERS)
        ]
        for worker in [self.thread, *self.download_threads]:
            worker.start()

    def submit(self, kind: str, operation: Callable, **context) -> dict:
        with self.lock:
            if self.stopping.is_set():
                raise WorkError("The application is shutting down.")
            identifier = new_id()
            item = {
                "id": identifier,
                "kind": kind,
                "lane": "download" if kind == "download" else "heavy",
                "status": "queued",
                "progress": 0,
                "message": "Queued",
                "error": None,
                "result": None,
                "context": context,
                "created_at": now(),
                "updated_at": now(),
            }
            self.cancellations[identifier] = threading.Event()
            self.store.put("jobs", item)
            pending = self.download_pending if kind == "download" else self.pending
            pending.put((identifier, operation))
            return item

    def update(self, identifier: str, **changes):
        stamp = now()
        if changes.get("status") in TERMINAL:
            changes.setdefault("finished_at", stamp)
        return self.store.patch("jobs", identifier, updated_at=stamp, **changes)

    def cancelled(self, identifier: str) -> bool:
        return self.stopping.is_set() or self.cancellations.get(identifier, threading.Event()).is_set()

    def check(self, identifier: str):
        if self.cancelled(identifier):
            raise JobCancelled()

    def cancel(self, identifier: str) -> dict:
        with self.lock:
            job = self.store.get("jobs", identifier)
            if not job:
                raise KeyError(identifier)
            if job["status"] in {"queued", "running"}:
                self.cancellations[identifier].set()
                if job["status"] == "queued":
                    return self.update(identifier, status="cancelled", message="Cancelled before starting")
                return self.update(
                    identifier, message="Cancellation requested; external writes cannot be undone"
                )
            return job

    def busy(self, key: str, value: str) -> bool:
        return any(
            j["status"] in {"queued", "running"} and j.get("context", {}).get(key) == value
            for j in self.store.all("jobs")
        )

    def _run(self, pending: queue.Queue):
        while not self.stopping.is_set():
            try:
                identifier, operation = pending.get(timeout=0.2)
            except queue.Empty:
                continue
            try:
                with self.lock:
                    self.check(identifier)
                    self.update(identifier, status="running", message="Starting", started_at=now())
                result = operation(identifier)
                # Do not erase an external success with a late cancellation. Operations check before writes.
                self.update(identifier, status="completed", progress=100, message="Completed", result=result)
            except JobCancelled:
                self.update(identifier, status="cancelled", message="Cancelled", error=None)
            except Exception as exc:  # noqa: BLE001 - task boundary must preserve queue availability
                from .meta import MetaError

                if isinstance(exc, MetaError) and exc.code == "cancelled":
                    self.update(
                        identifier,
                        status="cancelled",
                        message="Cancelled; reconcile external container",
                        error=str(exc),
                    )
                    continue
                error = (
                    str(exc)
                    if isinstance(exc, (WorkError, MetaError))
                    else "Local task failed. Check tools, model compatibility, and available memory."
                )
                self.update(identifier, status="failed", message="Failed", error=error)
            finally:
                with self.lock:
                    self.cancellations.pop(identifier, None)
                if self.cleanup:
                    # Housekeeping must never take the worker down.
                    with contextlib.suppress(Exception):
                        self.cleanup(identifier)
                pending.task_done()

    def process(
        self,
        identifier: str,
        command: list[str],
        *,
        timeout=3600,
        cwd: Path | None = None,
        env: dict | None = None,
        failure="Local tool failed.",
        log_path: Path | None = None,
    ) -> str:
        self.check(identifier)
        # File-backed output prevents a verbose tool from deadlocking a pipe or consuming unbounded RAM.
        with tempfile.TemporaryFile() as output:
            process = subprocess.Popen(
                command, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True
            )
            deadline = time.monotonic() + timeout
            try:
                while process.poll() is None:
                    self.check(identifier)
                    if time.monotonic() > deadline:
                        raise WorkError("Task timed out. Try a smaller input or shorter context.")
                    time.sleep(0.15)
                output.seek(0)
                # Keep at most 64KB of diagnostic output, local only. Never use for credential-bearing jobs.
                raw = output.read(65536).decode("utf-8", errors="replace")
                if log_path:
                    log_path.write_text(raw, encoding="utf-8")
                    log_path.chmod(0o600)
                if process.returncode:
                    raise WorkError(failure)
                self.check(identifier)
                return raw
            finally:
                if process.poll() is None:
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                        process.wait(timeout=3)
                    except (ProcessLookupError, subprocess.TimeoutExpired):
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        process.wait(timeout=3)

    def close(self):
        self.stopping.set()
        with self.lock:
            for event in self.cancellations.values():
                event.set()
        deadline = time.monotonic() + 12
        for worker in [self.thread, *self.download_threads]:
            worker.join(timeout=max(0, deadline - time.monotonic()))
        for job in self.store.all("jobs"):
            if job["status"] == "queued":
                self.update(job["id"], status="cancelled", message="Cancelled on shutdown")
