"""Schedule an approved Reel for later, executed by this app while it is open.

Schedules reuse the app's durable ``schedules`` kind (so campaign archive and draft-cleanup
guards already see them) with ``lane = "instagram_post"``; the legacy direct-Meta runner in
``app.py`` skips that lane. Each schedule owns one publish attempt per account in state
``scheduled``; at the time it re-checks everything and hands them to the same durable
publish lane (``Publisher.start_scheduled``), so the attempt state machine and
reconcile-before-retry rules are unchanged.

The app must be open at the scheduled time. A schedule whose time passed while the app was
closed (or asleep beyond a short grace) is never posted late on its own: it becomes
``overdue`` and waits for the person to choose Post now / Reschedule / Cancel.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from .publisher import Publisher, PublishError
from .store import new_id, now

KIND = "schedules"
LANE = "instagram_post"
# How late the open app may still post on time (tick interval, a short sleep). Later than this,
# or due before the app was opened, needs a click.
GRACE = timedelta(minutes=2)
MAX_AHEAD = timedelta(days=60)
NOTE = "The app must be open at that time."
log = logging.getLogger(__name__)


def parse_time(value) -> datetime:
    try:
        moment = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        raise PublishError(422, "Choose a date and time including its timezone.", "invalid_time") from None
    if moment.tzinfo is None:
        raise PublishError(422, "Choose a date and time including its timezone.", "invalid_time")
    return moment.astimezone(UTC)


class PostScheduler:
    def __init__(self, store, publisher: Publisher, *, clock: Callable[[], datetime] = lambda: datetime.now(UTC),
                 interval: float = 2.0):
        self.store, self.publisher, self.clock, self.interval = store, publisher, clock, interval
        # Anything due before this moment was due while the app was closed: it needs a click.
        self.opened_at = clock()
        self.stopping = threading.Event()
        self.thread: threading.Thread | None = None
        self.thread_lock = threading.Lock()
        self.thread_exiting = False  # start() and the loop's exit decision never interleave

    # ------------------------------------------------------------------ records
    def _rows(self) -> list[dict]:
        return [r for r in self.store.all(KIND) if isinstance(r, dict) and r.get("lane") == LANE]

    def get(self, identifier: str) -> dict:
        row = self.store.get(KIND, identifier)
        if not row or row.get("lane") != LANE:
            raise PublishError(404, "Scheduled post not found.", "not_found")
        return self.view(row)

    def view(self, row: dict) -> dict:
        attempts = [a for a in (self.store.get("publish_attempts", i) for i in row.get("attempt_ids", [])) if a]
        return {**row, "attempts": attempts}

    def list(self, clip_id: str | None = None) -> list[dict]:
        self.mark_overdue()
        rows = [r for r in self._rows() if clip_id is None or r.get("clip_id") == clip_id]
        return [self.view(r) for r in sorted(rows, key=lambda r: r.get("publish_at") or "")]

    # ------------------------------------------------------------------ create
    def schedule(self, clip_id: str, account_ids: list[str], captions: dict[str, str], sha256: str,
                 publish_at: str, *, override_reason: str | None = None, package: dict | None = None,
                 timezone: str | None = None) -> dict:
        moment = parse_time(publish_at)
        current = self.clock()
        if moment <= current + timedelta(minutes=1):
            raise PublishError(422, "Pick a time at least a minute from now, or post now.", "invalid_time")
        if moment > current + MAX_AHEAD:
            raise PublishError(422, "Schedule at most 60 days ahead.", "invalid_time")
        if not account_ids or len(set(account_ids)) != len(account_ids) or len(account_ids) > 3:
            raise PublishError(422, "Choose one to three different accounts.", "invalid_accounts")
        with self.publisher.lock:
            # Same checks as posting now, for every account, before anything is saved (all-or-nothing).
            self.publisher._require_storage()
            validated, problems = [], []
            for account_id in account_ids:
                try:
                    validated.append(self.publisher._validate(clip_id, account_id, captions.get(account_id),
                                                              sha256, override_reason, package))
                except PublishError as error:
                    problems.append(f"{account_id}: {error.message}")
            if problems:
                raise PublishError(422, "Nothing was scheduled. " + " ".join(problems), "schedule_invalid")
            clip = validated[0][0]
            identifier, stamp = new_id(), moment.isoformat()
            attempts = [self.publisher.create_scheduled(item, scheduled_for=stamp, schedule_id=identifier)
                        for item in validated]
            row = {"id": identifier, "lane": LANE, "clip_id": clip_id, "campaign_id": clip.get("campaign_id"),
                   "profile_id": clip.get("profile_id"), "account_ids": list(account_ids),
                   "attempt_ids": [a["id"] for a in attempts], "publish_at": stamp, "timezone": timezone,
                   "status": "scheduled", "overdue_at": None, "executed_at": None, "decision": None,
                   "created_at": now(), "note": NOTE}
            self.store.put(KIND, row)
            return self.view(row)

    # ------------------------------------------------------------------ run
    def mark_overdue(self) -> None:
        """Flag (never post) schedules whose time passed while the app was closed or asleep."""
        current = self.clock()
        for row in self._rows():
            if row.get("status") != "scheduled" or row.get("overdue_at"):
                continue
            due = datetime.fromisoformat(row["publish_at"])
            if due <= current and (due < self.opened_at or current - due > GRACE):
                self.store.patch(KIND, row["id"], overdue_at=now(),
                                 note="This time passed while the app was closed. Post now, reschedule or cancel.")

    def tick(self) -> None:
        self.mark_overdue()
        current = self.clock()
        for row in self._rows():
            if row.get("status") == "cancelled":
                self._cancel_attempts(row)  # also covers a cancel made through the legacy endpoint
                continue
            if row.get("status") != "scheduled" or row.get("overdue_at"):
                continue
            if datetime.fromisoformat(row["publish_at"]) <= current:
                self._execute(row, "Scheduled time reached; posting.")

    def _execute(self, row: dict, note: str) -> dict:
        with self.publisher.lock:
            self.store.patch(KIND, row["id"], status="submitted", executed_at=now())
            for attempt_id in row.get("attempt_ids", []):
                self.publisher.start_scheduled(attempt_id, note)
        return self.get(row["id"])

    def _cancel_attempts(self, row: dict) -> None:
        for attempt_id in row.get("attempt_ids", []):
            if (self.store.get("publish_attempts", attempt_id) or {}).get("state") == "scheduled":
                self.publisher.cancel_scheduled(attempt_id)

    # ------------------------------------------------------------------ decisions (always a click)
    def decide(self, identifier: str, action: str, publish_at: str | None = None) -> dict:
        with self.publisher.lock:
            row = self.store.get(KIND, identifier)
            if not row or row.get("lane") != LANE:
                raise PublishError(404, "Scheduled post not found.", "not_found")
            if row.get("status") != "scheduled":
                raise PublishError(409, "This scheduled post already ran or was cancelled.", "not_scheduled")
            if action == "cancel":
                self.store.patch(KIND, identifier, status="cancelled", decision={"action": action, "at": now()})
                self._cancel_attempts(row)
                return self.get(identifier)
            if action == "post_now":
                self.store.patch(KIND, identifier, decision={"action": action, "at": now()})
                return self._execute(row, "Posting now at the person's request.")
            if action == "reschedule":
                moment = parse_time(publish_at)
                if moment <= self.clock() + timedelta(minutes=1) or moment > self.clock() + MAX_AHEAD:
                    raise PublishError(422, "Pick a time between a minute and 60 days from now.", "invalid_time")
                stamp = moment.isoformat()
                self.store.patch(KIND, identifier, publish_at=stamp, overdue_at=None, note=NOTE,
                                 decision={"action": action, "at": now()})
                for attempt_id in row.get("attempt_ids", []):
                    self.publisher.reschedule(attempt_id, stamp)
                return self.get(identifier)
            raise PublishError(422, "Choose post_now, reschedule or cancel.", "invalid_action")

    # ------------------------------------------------------------------ thread
    def pending(self) -> bool:
        return any(r.get("status") == "scheduled" for r in self._rows())

    def start(self) -> None:
        with self.thread_lock:
            if self.thread and self.thread.is_alive() and not self.thread_exiting:
                return
            self.thread_exiting = False
            self.thread = threading.Thread(target=self._loop, name="growth-post-scheduler", daemon=True)
            self.thread.start()

    def _loop(self) -> None:
        while not self.stopping.wait(self.interval):
            try:
                self.tick()
                with self.thread_lock:
                    if not any(r.get("status") == "scheduled" and not r.get("overdue_at") for r in self._rows()):
                        self.thread_exiting = True
                        return  # nothing left to run on time; a new schedule starts the thread again
            except Exception:  # noqa: BLE001 - keep the scheduler alive; attempts record their own errors
                log.warning("Scheduled post tick failed; retrying on the next tick.", exc_info=False)

    def close(self) -> None:
        self.stopping.set()
        if self.thread:
            self.thread.join(timeout=3)
