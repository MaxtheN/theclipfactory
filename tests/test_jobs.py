"""Real single-worker tests; all waits are bounded and teardown always stops it."""
import sys
import threading
import time

import pytest

from clip_factory.jobs import Jobs, WorkError
from clip_factory.store import Store


def wait_job(store, identifier, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = store.get("jobs", identifier)
        if job and job["status"] in {"completed", "failed", "cancelled"}:
            return job
        time.sleep(0.01)
    pytest.fail(f"Job did not terminate: {store.get('jobs', identifier)}")


@pytest.fixture
def worker(tmp_path):
    store = Store(tmp_path)
    jobs = Jobs(store)
    try:
        yield jobs, store
    finally:
        jobs.close()
    assert not jobs.thread.is_alive()


def test_serial_worker_queued_cancel_and_reuse(worker):
    jobs, store = worker
    entered, release = threading.Event(), threading.Event()
    order = []

    def first(identifier):
        entered.set()
        assert release.wait(4)
        jobs.check(identifier)
        order.append("first")
        return {"real_result": 17}

    a = jobs.submit("first", first, video_id="source")
    try:
        assert entered.wait(2)
        assert jobs.busy("video_id", "source")
        b = jobs.submit("never", lambda _: pytest.fail("Cancelled queued operation ran"))
        c = jobs.submit("third", lambda _: order.append("third") or {"ok": True})
        assert store.get("jobs", c["id"])["status"] == "queued"
        assert jobs.cancel(b["id"])["status"] == "cancelled"
    finally:
        release.set()
    assert wait_job(store, a["id"])["result"] == {"real_result": 17}
    assert wait_job(store, b["id"])["status"] == "cancelled"
    assert wait_job(store, c["id"])["status"] == "completed"
    assert order == ["first", "third"]
    assert not jobs.busy("video_id", "source")
    assert jobs.cancel(a["id"])["status"] == "completed"


def test_running_cancellation_is_cooperative(worker):
    jobs, store = worker
    entered = threading.Event()

    def operation(identifier):
        entered.set()
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            jobs.check(identifier)
            time.sleep(0.01)
        pytest.fail("Cancellation was not observed")

    job = jobs.submit("cooperative", operation)
    assert entered.wait(2)
    jobs.cancel(job["id"])
    final = wait_job(store, job["id"])
    assert final["status"] == "cancelled"
    assert final["error"] is None
    assert final["result"] is None
    assert wait_job(store, jobs.submit("after", lambda _: 42)["id"])["result"] == 42


@pytest.mark.parametrize("safe", [False, True])
def test_failures_redacted_and_worker_recovers(worker, safe):
    jobs, store = worker

    def fail(_):
        raise WorkError("Install local tools first.") if safe else RuntimeError("secret-token-123")

    final = wait_job(store, jobs.submit("failure", fail)["id"])
    assert final["status"] == "failed"
    assert final["result"] is None
    assert "secret-token-123" not in str(final)
    if safe:
        assert final["error"] == "Install local tools first."
    assert wait_job(store, jobs.submit("recover", lambda _: "done")["id"])["status"] == "completed"


def test_durable_interrupted_jobs_fail_without_reexecution(tmp_path):
    store = Store(tmp_path)
    for status in ("queued", "running", "completed", "cancelled"):
        store.put("jobs", {"id": status, "status": status, "result": None})
    jobs = Jobs(Store(tmp_path))
    try:
        for status in ("queued", "running"):
            job = store.get("jobs", status)
            assert job["status"] == "failed"
            assert "Interrupted" in job["error"]
        assert store.get("jobs", "completed")["status"] == "completed"
        assert store.get("jobs", "cancelled")["status"] == "cancelled"
    finally:
        jobs.close()
    with pytest.raises(WorkError, match="shutting down"):
        jobs.submit("late", lambda _: None)


def test_subprocess_output_failure_timeout_and_recovery(worker):
    jobs, store = worker
    result = wait_job(store, jobs.submit("output", lambda identifier: jobs.process(
        identifier, [sys.executable, "-c", "print('x' * 100000)"]
    ))["id"])
    assert result["status"] == "completed"
    assert len(result["result"]) == 65536
    failure = wait_job(store, jobs.submit("exit", lambda identifier: jobs.process(
        identifier, [sys.executable, "-c", "raise SystemExit(2)"], failure="Tool exited."
    ))["id"])
    assert failure["error"] == "Tool exited."
    timed = wait_job(store, jobs.submit("timeout", lambda identifier: jobs.process(
        identifier, [sys.executable, "-c", "import time; time.sleep(30)"], timeout=0.1
    ))["id"])
    assert timed["status"] == "failed"
    assert "timed out" in timed["error"]
    assert wait_job(store, jobs.submit("after", lambda _: True)["id"])["result"] is True


def test_cancel_running_child_process(worker):
    jobs, store = worker
    entered = threading.Event()

    def child(identifier):
        entered.set()
        return jobs.process(identifier, [sys.executable, "-c", "import time; time.sleep(30)"], timeout=5)

    job = jobs.submit("child", child)
    assert entered.wait(2)
    jobs.cancel(job["id"])
    assert wait_job(store, job["id"])["status"] == "cancelled"
