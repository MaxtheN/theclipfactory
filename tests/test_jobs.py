"""Real bounded job-lane tests; waits are bounded and teardown stops every worker."""

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
    assert not any(t.is_alive() for t in [jobs.thread, *jobs.download_threads])


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
    result = wait_job(
        store,
        jobs.submit(
            "output",
            lambda identifier: jobs.process(identifier, [sys.executable, "-c", "print('x' * 100000)"]),
        )["id"],
    )
    assert result["status"] == "completed"
    assert len(result["result"]) == 65536
    failure = wait_job(
        store,
        jobs.submit(
            "exit",
            lambda identifier: jobs.process(
                identifier, [sys.executable, "-c", "raise SystemExit(2)"], failure="Tool exited."
            ),
        )["id"],
    )
    assert failure["error"] == "Tool exited."
    timed = wait_job(
        store,
        jobs.submit(
            "timeout",
            lambda identifier: jobs.process(
                identifier, [sys.executable, "-c", "import time; time.sleep(30)"], timeout=0.1
            ),
        )["id"],
    )
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


def test_cancel_also_stops_what_the_tool_started(worker, tmp_path):
    """A worker that runs FFmpeg must not leave FFmpeg running after a cancel, on any OS."""
    import psutil

    jobs, store = worker
    marker = tmp_path / "grandchild.pid"
    script = (
        "import subprocess, sys, time, pathlib;"
        "g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']);"
        f"pathlib.Path({str(marker)!r}).write_text(str(g.pid));"
        "time.sleep(60)"
    )
    job = jobs.submit("tree", lambda identifier: jobs.process(identifier, [sys.executable, "-c", script], timeout=30))
    deadline = time.monotonic() + 10
    while not (marker.exists() and marker.read_text()) and time.monotonic() < deadline:
        time.sleep(0.05)
    grandchild = int(marker.read_text())
    jobs.cancel(job["id"])
    assert wait_job(store, job["id"])["status"] == "cancelled"
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            if psutil.Process(grandchild).status() == psutil.STATUS_ZOMBIE:
                break
        except psutil.NoSuchProcess:
            break
        time.sleep(0.05)
    else:
        pytest.fail("the grandchild process is still running")


def test_downloads_overlap_heavy_work_with_bounded_concurrency(worker):
    jobs, store = worker
    heavy_entered, heavy_release = threading.Event(), threading.Event()
    download_release = threading.Event()
    entered = [threading.Event() for _ in range(4)]

    def heavy(identifier):
        heavy_entered.set()
        assert heavy_release.wait(5)
        jobs.check(identifier)
        return "heavy"

    def transfer(index):
        def run(identifier):
            entered[index].set()
            assert download_release.wait(5)
            jobs.check(identifier)
            return index

        return run

    heavy_job = jobs.submit("render", heavy)
    downloads = []
    try:
        assert heavy_entered.wait(2)
        downloads = [jobs.submit("download", transfer(i), model_id=str(i)) for i in range(4)]
        assert all(event.wait(2) for event in entered[:3])
        assert not entered[3].is_set()
        assert store.get("jobs", downloads[3]["id"])["status"] == "queued"
        assert heavy_job["lane"] == "heavy"
        assert all(job["lane"] == "download" for job in downloads)
        assert sum(store.get("jobs", j["id"])["status"] == "running" for j in downloads) == 3
        jobs.cancel(downloads[3]["id"])
    finally:
        download_release.set()
        heavy_release.set()
    assert wait_job(store, heavy_job["id"])["result"] == "heavy"
    assert all(wait_job(store, job["id"])["status"] == "completed" for job in downloads[:3])
    assert wait_job(store, downloads[3]["id"])["status"] == "cancelled"
    assert not entered[3].is_set()


def test_cancelling_one_download_does_not_cancel_another(worker):
    jobs, store = worker
    entered = [threading.Event(), threading.Event()]
    release = threading.Event()

    def run(index):
        def operation(identifier):
            entered[index].set()
            deadline = time.monotonic() + 5
            while not release.is_set() and time.monotonic() < deadline:
                jobs.check(identifier)
                time.sleep(0.01)
            jobs.check(identifier)
            return index

        return operation

    jobs_list = [jobs.submit("download", run(i), model_id=str(i)) for i in range(2)]
    try:
        assert all(event.wait(2) for event in entered)
        jobs.cancel(jobs_list[0]["id"])
        assert wait_job(store, jobs_list[0]["id"])["status"] == "cancelled"
        assert store.get("jobs", jobs_list[1]["id"])["status"] == "running"
    finally:
        release.set()
    assert wait_job(store, jobs_list[1]["id"])["result"] == 1


def test_shutdown_stops_every_lane_and_cancels_pending_downloads(worker):
    jobs, store = worker
    entered = [threading.Event() for _ in range(4)]

    def run(index):
        def operation(identifier):
            entered[index].set()
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                jobs.check(identifier)
                time.sleep(0.01)
            pytest.fail("Shutdown did not cancel running work")

        return operation

    active = [jobs.submit("render", run(0))]
    active += [jobs.submit("download", run(i)) for i in range(1, 4)]
    assert all(event.wait(2) for event in entered)
    queued = jobs.submit("download", lambda _: pytest.fail("Queued transfer ran during shutdown"))
    jobs.close()
    assert not any(thread.is_alive() for thread in [jobs.thread, *jobs.download_threads])
    assert all(store.get("jobs", j["id"])["status"] == "cancelled" for j in [*active, queued])
