"""Human-approved Instagram Reel publishing through Composio, with durable attempts.

Every external effect is preceded by a durable ``pending_effect`` write. An effect whose
outcome is uncertain (timeout, network loss, crash) moves the attempt to ``unknown``;
an unknown attempt is never retried until ``reconcile`` has read the provider state.

States: created → uploading → uploaded(url) → container_created(id) → container_ready
→ published(media_id) → mapped; plus failed (definite, nothing published) and unknown.
A scheduled post waits in ``scheduled`` (nothing external yet) until the person's chosen time
or click moves it to ``created``; ``cancelled`` is terminal and nothing was published.

Every attempt carries its ``package`` (caption hash/features, share_to_feed, cover source and
frame time, collaborators, scheduled_for) and ``posted_at`` so learning can use them later.
"""

from __future__ import annotations

import inspect
import queue
import re
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

from fastapi import HTTPException

from . import post_package, quality
from .composio import ComposioError, ComposioPublishingClient, _instagram_permalink
from .learning import Publication
from .publish_storage import PublishStorageError
from .store import new_id, now

KIND = "publish_attempts"
REPORTS = "quality_reports"
STATES = ("scheduled", "created", "uploading", "uploaded", "container_created", "container_ready",
          "published", "mapped", "failed", "cancelled", "unknown")
RESUMABLE = {"created", "uploaded", "container_created", "container_ready", "published"}
FINAL = {"mapped", "failed", "cancelled"}
# Attempt states that never reached Instagram and do not block a new attempt for the account.
CLOSED_UNSENT = {"failed", "cancelled"}
# Raised by our adapter before any provider write: the write certainly did not happen.
LOCAL_CODES = {"invalid_schema", "invalid_arguments", "unsupported_tool", "invalid_id", "invalid_user",
               "missing_key", "invalid_key", "invalid_version", "invalid_timeout", "invalid_url"}
_MEDIA_ID = re.compile(r"^\d{1,100}$")


class PublishError(Exception):
    def __init__(self, status: int, message: str, code: str = "invalid", details=None):
        super().__init__(message)
        self.status, self.message, self.code, self.details = status, message, code, details


def normalize_caption(value: str) -> str:
    return re.sub(r"[\x00-\x1f\x7f\s]+", " ", value or "").strip()


def validate_caption(caption) -> str:
    if not isinstance(caption, str) or not caption.strip():
        raise PublishError(422, "Write a caption for the post.", "invalid_caption")
    if len(caption) > 2200:
        raise PublishError(422, "Instagram captions are limited to 2,200 characters.", "invalid_caption")
    if any(ord(c) < 32 and c not in "\n\t" for c in caption) or "\x7f" in caption:
        raise PublishError(422, "Remove control characters from the caption.", "invalid_caption")
    if len(re.findall(r"(?:^|\s)#\w", caption)) > 30:
        raise PublishError(422, "Instagram allows at most 30 hashtags.", "invalid_caption")
    if len(re.findall(r"(?:^|\s)@\w", caption)) > 20:
        raise PublishError(422, "Instagram allows at most 20 mentions.", "invalid_caption")
    return caption


def _container_status(payload, container_id):
    """INSTAGRAM_GET_MULTIPLE_NODES result keyed by node ID; parsed defensively (shape unverified)."""
    candidates = [payload]
    if isinstance(payload, dict):
        for key in ("data", "nodes", "results"):
            if key in payload:
                candidates.append(payload[key])
    for item in candidates:
        if isinstance(item, dict) and isinstance(item.get(container_id), dict):
            item = item[container_id]
        if isinstance(item, list):
            item = next((n for n in item if isinstance(n, dict) and n.get("id") == container_id), None)
        if isinstance(item, dict) and item.get("id", container_id) == container_id:
            code = item.get("status_code")
            if isinstance(code, str) and code in {"FINISHED", "IN_PROGRESS", "ERROR", "EXPIRED", "PUBLISHED"}:
                return code
    return None


def _quota(payload):
    rows = payload.get("data") if isinstance(payload, dict) and "data" in payload else payload
    row = rows[0] if isinstance(rows, list) and rows else rows
    if not isinstance(row, dict):
        return None, None
    usage = row.get("quota_usage")
    total = (row.get("config") or {}).get("quota_total") if isinstance(row.get("config"), dict) else None
    return (usage if type(usage) is int else None), (total if type(total) is int else None)


class Publisher:
    def __init__(self, store, *, root: Path, client_factory: Callable[[], ComposioPublishingClient],
                 storage_factory: Callable, learning, campaigns, gate: Callable = quality.evaluate,
                 sleep: Callable[[float], None] = time.sleep, poll_interval: float = 5, max_polls: int = 60,
                 item_gap: float = 5, start_worker: bool = True, covers: post_package.Covers | None = None):
        self.store, self.root = store, Path(root)
        self.covers = covers or post_package.Covers(self.root)
        self.client_factory, self.storage_factory = client_factory, storage_factory
        self.learning, self.campaigns, self.gate = learning, campaigns, gate
        self.sleep, self.poll_interval, self.max_polls, self.item_gap = sleep, poll_interval, max_polls, item_gap
        self.lock = threading.RLock()
        self.pending: queue.Queue = queue.Queue()
        self.stopping = threading.Event()
        self.start_worker, self.thread = start_worker, None
        self.recover()

    # ------------------------------------------------------------------ records
    def get(self, identifier: str) -> dict:
        row = self.store.get(KIND, identifier)
        if not row:
            raise PublishError(404, "Post attempt not found.", "not_found")
        return row

    def list(self, clip_id: str | None = None, campaign_id: str | None = None) -> list[dict]:
        rows = self.store.all(KIND)
        return [r for r in rows if (clip_id is None or r["clip_id"] == clip_id)
                and (campaign_id is None or r.get("campaign_id") == campaign_id)]

    def _save(self, attempt: dict, note: str | None = None, **changes) -> dict:
        with self.lock:
            current = self.store.get(KIND, attempt["id"]) or attempt
            current.update(changes)
            stamp = now()
            current["updated_at"] = stamp
            if note or "state" in changes or "pending_effect" in changes:
                current.setdefault("history", []).append(
                    {"at": stamp, "state": current["state"], "pending_effect": current.get("pending_effect"),
                     "note": note})
                current["history"] = current["history"][-60:]
            self.store.put(KIND, current)
            attempt.clear()
            attempt.update(current)
            return current

    def recover(self):
        """After a crash: an effect in flight has an unknown outcome; everything else is resumable."""
        for row in self.store.all(KIND):
            if not row.get("active"):
                continue
            if row.get("pending_effect"):
                self._save(row, "App stopped during an external step; outcome unknown. Check status.",
                           state="unknown", previous_state=row["state"], active=False)
            else:
                self._save(row, "App stopped; resume when ready.", active=False)

    # ------------------------------------------------------------------ validation
    def clip_path(self, clip: dict) -> Path:
        path = (self.root / clip.get("path", "")).resolve()
        if not path.is_relative_to(self.root) or not path.is_file():
            raise PublishError(404, "Clip file no longer exists in the local library.", "missing_file")
        return path

    def quality_report(self, clip: dict, expected_sha256: str | None = None, *, refresh=False) -> dict:
        sha = (expected_sha256 or clip.get("sha256") or "").lower()
        key = f"{clip['id']}:{sha}"
        cached = self.store.get(REPORTS, key)
        source_video = self.store.get("videos", clip.get("video_id") or "") or {}
        context = quality.context_identity(clip, source_video)
        # Critic status may change after a recheck; the file checks cannot (immutable bytes).
        if (cached and not refresh and cached.get("gate_version") == quality.GATE_VERSION
                and cached.get("context_identity") == context
                and (cached.get("critic") or {}).get("status") == clip.get("team_review_status")
                and (cached.get("critic") or {}).get("overridden_at_approval") == bool(clip.get("approval_override"))):
            return cached
        parameters = inspect.signature(self.gate).parameters
        source_aware = "source_video" in parameters or any(
            parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in parameters.values())
        kwargs = {"expected_sha256": sha or None}
        if source_aware:
            kwargs["source_video"] = source_video
        report = {**self.gate(clip, self.clip_path(clip), **kwargs), "context_identity": context}
        self.store.put(REPORTS, {**report, "id": key})
        return report

    def _require_clip(self, clip_id: str, sha256: str | None) -> dict:
        clip = self.store.get("clips", clip_id)
        if not clip:
            raise PublishError(404, "Clip not found.", "not_found")
        try:
            self.campaigns.ensure_clip_campaign_active(clip)
        except HTTPException as error:
            raise PublishError(409, error.detail, "campaign_archived") from None
        if clip.get("approved") is not True:
            raise PublishError(409, "Approve this exact revision before posting.", "not_approved")
        if clip.get("team_review_status") in {"fail", "unknown"} and not clip.get("approval_override"):
            raise PublishError(409, "Resolve or explicitly approve over the critic's findings first.",
                               "unresolved_review")
        if sha256 is not None and (sha256 or "").lower() != (clip.get("sha256") or "").lower():
            raise PublishError(409, "The clip changed since you approved it. Review the current revision.",
                               "revision_changed")
        if clip.get("publish_attempt") or clip.get("instagram_media_id"):
            raise PublishError(409, "This clip has a direct-Meta publish record. Reconcile it there first.",
                               "legacy_attempt")
        if not clip.get("profile_id") or not clip.get("campaign_id"):
            raise PublishError(422, "Only campaign clips with a workspace profile can be posted.", "no_profile")
        return clip

    def _require_account(self, account_id: str, clip: dict) -> dict:
        account = self.store.get("connected_accounts", account_id)
        if (not account or account.get("status") != "active" or account.get("provider") != "composio"
                or account.get("toolkit") != "instagram" or not account.get("verified_at")
                or not isinstance(account.get("user_id"), str) or not account["user_id"].strip()
                or not isinstance(account.get("instagram_user_id"), str)
                or not account["instagram_user_id"].isdigit()):
            raise PublishError(422, "Choose an active, verified Instagram account.", "account_unverified")
        if account.get("profile_id") != clip.get("profile_id"):
            raise PublishError(422, "This account is bound to another workspace profile.", "account_unbound")
        return account

    def _require_storage(self):
        storage = self.storage_factory()
        if storage is None:
            raise PublishError(409, "Growth Factory cloud is not configured; posting needs cloud hosting.",
                               "cloud_not_configured")
        try:
            storage.user_id()
        except PublishStorageError as error:
            raise PublishError(error.status, error.message, error.code) from None
        return storage

    def _check_quality(self, clip: dict, override_reason: str | None) -> tuple[dict, str | None]:
        report = self.quality_report(clip)
        reason = (override_reason or "").strip() or None
        if report["verdict"] != "pass":
            if not reason or not 10 <= len(reason) <= 500:
                raise PublishError(409, "Quality gate is on hold: " + "; ".join(report["reasons"])[:600]
                                   + " Add an override reason (10+ characters) to post anyway.",
                                   "quality_hold", {"report": report})
        elif reason and len(reason) > 500:
            raise PublishError(422, "Keep the override reason under 500 characters.", "invalid_override")
        return report, reason if report["verdict"] != "pass" else None

    def _existing(self, clip_id: str, account_id: str):
        for row in self.store.all(KIND):
            if (row["clip_id"] == clip_id and row["account_id"] == account_id
                    and row["state"] not in CLOSED_UNSENT):
                return row
        return None

    def _package(self, clip: dict, caption: str, package: dict | None) -> dict:
        """The exact post package recorded on the attempt (and later usable as learning variables)."""
        package = package or {}
        share = package.get("share_to_feed", True)
        if type(share) is not bool:
            raise PublishError(422, "share_to_feed must be true or false.", "invalid_package")
        try:
            collaborators = post_package.clean_collaborators(package.get("collaborators"))
        except ValueError as error:
            raise PublishError(422, str(error), "invalid_collaborators") from None
        if collaborators and not post_package.COLLABORATORS_SUPPORTED:
            raise PublishError(422, "Collaborator invites are not available through the connected Instagram "
                                    "tool. Mention them with @ in the caption instead.", "collaborators_unsupported")
        try:
            cover = self.covers.resolve(clip, self.clip_path(clip), package.get("cover_time_ms"))
        except ValueError as error:
            raise PublishError(422, str(error), "invalid_cover") from None
        return {**post_package.caption_features(caption), "share_to_feed": share,
                "collaborators": collaborators, "location_id": None, "cover": cover}

    def _validate(self, clip_id, account_id, caption, sha256, override_reason, package=None):
        clip = self._require_clip(clip_id, sha256)
        account = self._require_account(account_id, clip)
        caption = validate_caption(caption)
        existing = self._existing(clip_id, account_id)
        if existing:
            message = ("Already posted to this account." if existing["state"] in {"published", "mapped"}
                       else "This account already has a scheduled post for this clip."
                       if existing["state"] == "scheduled"
                       else "An attempt for this account exists. Check its status or resume it.")
            raise PublishError(409, message, "attempt_exists", {"attempt_id": existing["id"]})
        report, override = self._check_quality({**clip, "caption": caption}, override_reason)
        self.clip_path(clip)
        return clip, account, caption, report, override, self._package(clip, caption, package)

    def _new_attempt(self, clip, account, caption, report, override, package=None, batch_id=None, *,
                     state="created", scheduled_for=None, schedule_id=None) -> dict:
        stamp = now()
        row = {
            "id": new_id(), "clip_id": clip["id"], "campaign_id": clip.get("campaign_id"),
            "profile_id": clip.get("profile_id"), "account_id": account["id"],
            "account_name": account.get("display_name"), "instagram_user_id": account["instagram_user_id"],
            "sha256": clip["sha256"].lower(), "revision_number": clip.get("revision_number") or 1,
            "caption": caption, "state": state, "pending_effect": None, "active": False,
            "video_url": None, "storage_object": None, "container_id": None, "container_status": None,
            "media_id": None, "permalink": None, "published_at": None, "readback": None,
            "mapping": {"status": "pending"}, "warnings": [], "error": None, "batch_id": batch_id,
            "quality": {k: report.get(k) for k in ("verdict", "reasons", "rubric", "gate_version", "evaluated_at")},
            "override_reason": override, "created_at": stamp, "updated_at": stamp,
            "package": package or self._package(clip, caption, None),
            "cover_mode": None, "cover_url": None, "cover_object": None,
            "scheduled_for": scheduled_for, "schedule_id": schedule_id, "posted_at": None,
            "history": [{"at": stamp, "state": state, "pending_effect": None,
                         "note": f"Scheduled for {scheduled_for}." if state == "scheduled"
                         else "Approved revision queued for posting."}],
        }
        self.store.put(KIND, row)
        return row

    # ------------------------------------------------------------------ requests
    def request_post(self, clip_id, account_id, caption, sha256, override_reason=None, package=None) -> dict:
        with self.lock:
            self._require_storage()
            row = self._new_attempt(*self._validate(clip_id, account_id, caption, sha256, override_reason,
                                                    package))
            self._enqueue(row)
            return self.get(row["id"])

    # ------------------------------------------------------------------ scheduled posts
    def create_scheduled(self, validated: tuple, *, scheduled_for: str, schedule_id: str) -> dict:
        """A durable attempt that waits; nothing external happens until start_scheduled."""
        return self._new_attempt(*validated, state="scheduled", scheduled_for=scheduled_for,
                                 schedule_id=schedule_id)

    def start_scheduled(self, identifier: str, note: str) -> dict:
        """Re-check everything at the moment of posting, then hand the attempt to the lane.
        A failed re-check ends the attempt as ``failed`` (nothing was sent anywhere)."""
        with self.lock:
            row = self.get(identifier)
            if row["state"] != "scheduled":
                return row
            try:
                self._require_storage()
                clip = self._require_clip(row["clip_id"], row["sha256"])
                self._require_account(row["account_id"], clip)
                validate_caption(row["caption"])
                self._check_quality({**clip, "caption": row["caption"]}, row.get("override_reason"))
            except PublishError as error:
                return self._save(row, "Scheduled post stopped before anything was sent.", state="failed",
                                  error={"code": error.code, "message": error.message})
            self._save(row, note, state="created")
            self._enqueue(row)
            return self.get(identifier)

    def cancel_scheduled(self, identifier: str, note: str = "Scheduled post cancelled.") -> dict:
        with self.lock:
            row = self.get(identifier)
            if row["state"] != "scheduled":
                return row
            return self._save(row, note, state="cancelled")

    def reschedule(self, identifier: str, scheduled_for: str) -> dict:
        with self.lock:
            row = self.get(identifier)
            if row["state"] != "scheduled":
                return row
            return self._save(row, f"Rescheduled for {scheduled_for}.", scheduled_for=scheduled_for)

    def request_batch(self, campaign_id, account_ids, clip_ids, captions=None, override_reasons=None) -> dict:
        captions, override_reasons = captions or {}, override_reasons or {}
        if len(set(account_ids)) != len(account_ids) or len(set(clip_ids)) != len(clip_ids):
            raise PublishError(422, "Choose each account and clip once.", "duplicate_items")
        with self.lock:
            self._require_storage()
            accepted, problems = [], []
            for clip_id in clip_ids:
                clip = self.store.get("clips", clip_id)
                if clip and clip.get("campaign_id") != campaign_id:
                    problems.append({"clip_id": clip_id, "message": "Clip belongs to another campaign."})
                    continue
                caption = captions.get(clip_id) or (clip or {}).get("caption") or (clip or {}).get("hook")
                for account_id in account_ids:
                    try:
                        accepted.append(self._validate(clip_id, account_id, caption, None,
                                                       override_reasons.get(clip_id)))
                    except PublishError as error:
                        problems.append({"clip_id": clip_id, "account_id": account_id, "code": error.code,
                                         "message": error.message})
            if problems:
                raise PublishError(422, "Nothing was queued; fix these items first.", "batch_invalid",
                                   {"problems": problems})
            batch_id = new_id()
            rows = [self._new_attempt(*item, batch_id=batch_id) for item in accepted]
            for row in rows:
                self._enqueue(row)
            return {"batch_id": batch_id, "attempts": [self.get(r["id"]) for r in rows],
                    "order": "sequential"}

    def resume(self, identifier: str) -> dict:
        with self.lock:
            row = self.get(identifier)
            if row.get("active"):
                raise PublishError(409, "This attempt is already running.", "active")
            if row["state"] == "unknown":
                raise PublishError(409, "Outcome unknown. Check status before continuing.", "needs_reconcile")
            if row["state"] not in RESUMABLE or (row["state"] == "published"
                                                  and row["mapping"].get("status") == "mapped"):
                raise PublishError(409, f"Nothing to resume from state {row['state']}.", "not_resumable")
            self._enqueue(row)
            return self.get(identifier)

    def _enqueue(self, row: dict):
        self._save(row, "Queued on the publish lane.", active=True, error=None)
        self.pending.put(row["id"])
        # One lazily started lane: posts run strictly one after another, outside the heavy render queue.
        if self.start_worker and (self.thread is None or not self.thread.is_alive()):
            self.thread = threading.Thread(target=self._worker, name="growth-publish-lane", daemon=True)
            self.thread.start()

    # ------------------------------------------------------------------ worker
    def _worker(self):
        while not self.stopping.is_set():
            try:
                identifier = self.pending.get(timeout=0.2)
            except queue.Empty:
                continue
            try:
                self.run(identifier)
            finally:
                self.pending.task_done()
                if not self.pending.empty() and not self.stopping.is_set():
                    self.sleep(self.item_gap)

    def close(self):
        self.stopping.set()
        if self.thread:
            self.thread.join(timeout=3)

    def run(self, identifier: str):
        """Advance one attempt as far as is safe. Never raises."""
        row = self.store.get(KIND, identifier)
        if not row:
            return
        try:
            self._advance(row)
        except Exception as exc:  # noqa: BLE001 - lane boundary; errors are recorded, never lost
            message = exc.message if isinstance(exc, (PublishError, PublishStorageError)) else (
                str(exc) if isinstance(exc, ComposioError) else "Posting stopped on an unexpected local error.")
            code = getattr(exc, "code", None) or "error"
            current = self.store.get(KIND, identifier) or row
            if current.get("pending_effect"):
                self._save(current, "Outcome of the external step is unknown.", state="unknown",
                           previous_state=current["state"], error={"code": code, "message": message})
            else:
                self._save(current, None, error={"code": code, "message": message})
        finally:
            current = self.store.get(KIND, identifier)
            if current and current.get("active"):
                self._save(current, None, active=False)

    def _precheck(self, row: dict) -> tuple[dict, dict]:
        clip = self._require_clip(row["clip_id"], row["sha256"])
        account = self._require_account(row["account_id"], clip)
        if account["instagram_user_id"] != row["instagram_user_id"]:
            raise PublishError(409, "The Instagram identity for this account changed. Start a new post.",
                               "account_changed")
        if row["state"] != "published":
            self._check_quality({**clip, "caption": validate_caption(row["caption"])}, row.get("override_reason"))
        return clip, account

    def _advance(self, row: dict):
        clip, account = self._precheck(row)
        client = None
        while not self.stopping.is_set():
            state = row["state"]
            if state in {"created", "uploading"}:
                if not self._upload(row, clip):
                    return
            elif state in {"uploaded", "container_created", "container_ready", "published"}:
                client = client or self.client_factory()
                step = {"uploaded": self._create_container, "container_created": self._poll,
                        "container_ready": self._publish, "published": self._finish}[state]
                if not step(row, client, account) or state == "published":
                    return
            else:
                return

    # ------------------------------------------------------------------ steps
    def _upload(self, row, clip) -> bool:
        path = self.clip_path(clip)
        if quality.media.sha256_file(path) != row["sha256"]:
            raise PublishError(409, "Clip bytes no longer match the approved revision.", "revision_changed")
        storage = self._require_storage()
        user = storage.user_id()
        name = storage.object_path(user, row["sha256"])
        self._save(row, "Uploading the approved MP4 to cloud hosting.", state="uploading",
                   pending_effect="upload", storage_object=name, video_url=storage.public_url(name),
                   bytes=path.stat().st_size, external_started_at=row.get("external_started_at") or now())
        try:
            hosted = storage.upload(path, row["sha256"])
        except PublishStorageError as error:
            if error.code in {"timeout", "network"}:
                raise
            # Upload refused or not publicly readable: nothing was given to Instagram.
            self._save(row, error.message, state="failed", pending_effect=None,
                       error={"code": error.code, "message": error.message})
            return False
        cover = self._host_cover(row, storage)
        self._save(row, "Hosted at a public URL and verified." + (" (reused)" if hosted["reused"] else ""),
                   state="uploaded", pending_effect=None, video_url=hosted["url"], **cover)
        return True

    def _cover_file(self, row) -> tuple[Path | None, dict]:
        cover = (row.get("package") or {}).get("cover") or {}
        if not cover.get("local_path") or not cover.get("sha256"):
            return None, cover
        path = (self.root / cover["local_path"]).resolve()
        if (not path.is_relative_to(self.root.resolve()) or not path.is_file()
                or quality.media.sha256_file(path) != cover["sha256"]):
            return None, cover
        return path, cover

    def _host_cover(self, row, storage) -> dict:
        """Best effort: host the cover still for ``cover_url``; otherwise fall back to ``thumb_offset``
        (the same frame's time). A cover upload never touches Instagram, so failure is not unknown."""
        path, cover = self._cover_file(row)
        warnings = list(row.get("warnings") or [])
        if path is None:
            if cover.get("local_path"):
                warnings.append("cover_file_missing")
            return {"cover_mode": "thumb_offset", "warnings": warnings}
        try:
            hosted = storage.upload_cover(path, cover["sha256"])
        except (PublishStorageError, AttributeError) as error:
            warnings.append("cover_upload_failed")
            return {"cover_mode": "thumb_offset", "warnings": warnings,
                    "cover_error": getattr(error, "message", "Cover hosting is unavailable.")}
        return {"cover_mode": "cover_url", "cover_url": hosted["url"], "cover_object": hosted["object"]}

    def _cover_arguments(self, row) -> tuple[dict, dict]:
        """``cover_url`` when the hosted still is publicly readable right now, else ``thumb_offset``."""
        cover = (row.get("package") or {}).get("cover") or {}
        offset = cover.get("time_ms") if type(cover.get("time_ms")) is int else 0
        if row.get("cover_url"):
            try:
                storage = self.storage_factory()
                ok = bool(storage and storage.verify_public(row["cover_url"], cover.get("bytes"), "image/jpeg"))
            except PublishStorageError:
                ok = False
            if ok:
                return {"cover_url": row["cover_url"]}, {"cover_mode": "cover_url"}
            return {"thumb_offset": offset}, {"cover_mode": "thumb_offset",
                                              "warnings": [*row["warnings"], "cover_url_unavailable"]}
        return {"thumb_offset": offset}, {"cover_mode": "thumb_offset"}

    def _call(self, client, account, slug, arguments):
        return client.run(slug, arguments, connected_account_id=account["id"], user_id=account["user_id"])

    def _check_quota(self, row, client, account):
        try:
            usage, total = _quota(self._call(client, account, "INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT",
                                             {"ig_user_id": account["instagram_user_id"],
                                              "fields": "quota_usage,config"}))
        except ComposioError:
            self._save(row, None, warnings=[*row["warnings"], "Publishing quota could not be read."])
            return True
        if usage is not None and total is not None and usage >= total:
            self._save(row, "Daily publishing limit reached.", state="failed",
                       error={"code": "quota", "message": f"Instagram daily publishing limit reached ({usage}/{total})."})
            return False
        return True

    def _create_container(self, row, client, account) -> bool:
        identity = client.account_identity(account["id"], account["user_id"],
                                           version=client.PINNED_VERSION)
        if identity["instagram_user_id"] != row["instagram_user_id"]:
            raise PublishError(409, "Connected Instagram identity changed; nothing was posted.", "account_changed")
        if not self._check_quota(row, client, account):
            return False
        package = row.get("package") or {}
        cover_args, cover_changes = self._cover_arguments(row)
        # Only parameters the pinned INSTAGRAM_POST_IG_USER_MEDIA schema accepts (no collaborators).
        arguments = {"ig_user_id": row["instagram_user_id"], "media_type": "REELS", "video_url": row["video_url"],
                     "caption": row["caption"], "share_to_feed": package.get("share_to_feed", True), **cover_args}
        self._save(row, "Creating the Reel container.", pending_effect="create_container",
                   external_started_at=row.get("external_started_at") or now(),
                   container_arguments={k: v for k, v in arguments.items() if k != "caption"}, **cover_changes)
        try:
            data = self._call(client, account, "INSTAGRAM_POST_IG_USER_MEDIA", arguments)
        except ComposioError as error:
            if error.code in LOCAL_CODES or error.code == "account_mismatch":
                self._save(row, "Stopped before contacting Instagram.", pending_effect=None,
                           error={"code": error.code, "message": str(error)})
                return False
            if error.code == "tool_failed":
                self._save(row, "Instagram refused the container.", state="failed", pending_effect=None,
                           error={"code": error.code, "message": "Instagram refused the Reel container. "
                                  "Check the publish permission (instagram_business_content_publish) and the video."})
                return False
            raise
        container = data.get("id") if isinstance(data, dict) else None
        if not isinstance(container, str) or not _MEDIA_ID.fullmatch(container):
            raise PublishError(502, "Instagram returned no container ID.", "invalid_response")
        self._save(row, "Container created; Instagram is processing the video.", state="container_created",
                   pending_effect=None, container_id=container, container_created_at=now())
        return True

    def _read_container(self, row, client, account):
        payload = self._call(client, account, "INSTAGRAM_GET_MULTIPLE_NODES",
                             {"object_ids": [row["container_id"]], "fields": "id,status_code,status"})
        return _container_status(payload, row["container_id"])

    def _poll(self, row, client, account) -> bool:
        failures = 0
        for attempt in range(self.max_polls):
            if self.stopping.is_set():
                return False
            try:
                status = self._read_container(row, client, account)
                failures = 0
            except ComposioError:
                status, failures = None, failures + 1
                if failures >= 3:
                    self._save(row, "Container status could not be read; check status later.")
                    return False
            if status:
                self._save(row, None, container_status=status)
            if status == "FINISHED":
                self._save(row, "Container is ready to publish.", state="container_ready")
                return True
            if status in {"ERROR", "EXPIRED"}:
                self._save(row, f"Container {status.lower()}; nothing was published.", state="failed",
                           error={"code": status.lower(),
                                  "message": "Instagram could not process this video. Nothing was published."})
                return False
            if status == "PUBLISHED":
                self._save(row, "Container already published; identify the post before anything else.",
                           state="unknown", previous_state=row["state"], pending_effect="publish")
                return False
            if attempt + 1 < self.max_polls:
                self.sleep(self.poll_interval)
        self._save(row, "Instagram is still processing. Check status in a few minutes.")
        return False

    def _publish(self, row, client, account) -> bool:
        self._save(row, "Publishing the Reel.", pending_effect="publish")
        try:
            data = self._call(client, account, "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH", {
                "ig_user_id": row["instagram_user_id"], "creation_id": row["container_id"],
                "max_wait_seconds": 0})
        except ComposioError as error:
            if error.code in LOCAL_CODES or error.code == "account_mismatch":
                self._save(row, "Stopped before publishing.", pending_effect=None,
                           error={"code": error.code, "message": str(error)})
                return False
            raise  # any provider-side failure is treated as unknown and reconciled by reading
        media_id = data.get("id") if isinstance(data, dict) else None
        if not isinstance(media_id, str) or not _MEDIA_ID.fullmatch(media_id):
            raise PublishError(502, "Instagram returned no media ID.", "invalid_response")
        self._save(row, "Published.", state="published", pending_effect=None, media_id=media_id,
                   posted_at=now())
        return True

    def _finish(self, row, client, account) -> bool:
        if not row.get("published_at"):
            identity = client.media_identity(account["id"], account["user_id"], row["media_id"],
                                             version=client.PINNED_VERSION,
                                             instagram_user_id=row["instagram_user_id"])
            media = self._call(client, account, "INSTAGRAM_GET_IG_MEDIA", {
                "ig_media_id": row["media_id"], "fields": "id,caption,permalink,timestamp,media_product_type"})
            media = media if isinstance(media, dict) else {}
            caption = media.get("caption") if isinstance(media.get("caption"), str) else None
            matches = caption is not None and normalize_caption(caption) == normalize_caption(row["caption"])
            warnings = row["warnings"] + ([] if matches else ["caption_readback_mismatch"])
            self._save(row, "Read back from Instagram: owner and time verified.",
                       published_at=identity["published_at"], permalink=_instagram_permalink(media.get("permalink")),
                       readback={"owner_verified": True, "owner_id_namespace": identity.get("owner_id_namespace"),
                                 "caption_matches": matches, "media_product_type": media.get("media_product_type")},
                       warnings=warnings)
        self._map(row)
        self._cleanup(row)
        return True

    def _map(self, row):
        if row["mapping"].get("status") == "mapped":
            return
        policies = self.learning.list_policies(campaign_id=row["campaign_id"], profile_id=row["profile_id"],
                                               account_id=row["account_id"])
        policies.sort(key=lambda p: not p.get("enabled"))
        if not policies:
            self._save(row, "Published; learning will track it once a policy exists for this account.",
                       mapping={"status": "awaiting_policy",
                                "detail": "Create a learning policy for this campaign/account, then resume."})
            return
        try:
            publication = self.learning.register_publication(Publication(
                policy_id=policies[0]["id"], clip_id=row["clip_id"], account_id=row["account_id"],
                media_id=row["media_id"], published_at=row["published_at"], sha256=row["sha256"]))
        except HTTPException as error:
            self._save(row, "Learning mapping was refused.", mapping={"status": "refused", "detail": error.detail})
            return
        self.store.patch("learning_publications", publication["id"], mapping_source="app_published",
                         mapping_detail="App uploaded these exact bytes (sha256) and published them; provider "
                                        "verified owner, media identity and timestamp.",
                         publish_attempt_id=row["id"])
        self._save(row, "Learning will measure this post.", state="mapped",
                   mapping={"status": "mapped", "publication_id": publication["id"], "policy_id": policies[0]["id"]})

    def _cleanup(self, row):
        for field, stamp in (("storage_object", "hosted_deleted_at"), ("cover_object", "cover_deleted_at")):
            name = row.get(field)
            if not name or row.get(stamp):
                continue
            others = [r for r in self.store.all(KIND) if r["id"] != row["id"] and r.get(field) == name
                      and r["state"] not in {"published", "mapped", "failed", "cancelled"}]
            if others:
                continue
            try:
                storage = self.storage_factory()
                if storage and storage.delete(name):
                    self._save(row, None, **{stamp: now()})
            except PublishStorageError:
                pass  # best effort; the object is public anyway and is reused on a later post

    # ------------------------------------------------------------------ reconcile (reads only)
    def _match_recent(self, row, client, account):
        page = client.list_media(account["id"], account["user_id"], instagram_user_id=row["instagram_user_id"],
                                 limit=10, version=client.PINNED_VERSION)
        started = row.get("external_started_at") or row["created_at"]
        floor = datetime.fromisoformat(started).astimezone(UTC) - timedelta(minutes=2)
        claimed = {r.get("media_id") for r in self.store.all(KIND) if r["id"] != row["id"]}
        wanted = normalize_caption(row["caption"])[:160]
        found = [item for item in page["items"]
                 if item["media_type"] == "VIDEO" and item["media_id"] not in claimed
                 and datetime.fromisoformat(item["published_at"]) >= floor
                 and (item.get("caption_excerpt") or "") == wanted]
        return found

    def reconcile(self, identifier: str) -> dict:
        with self.lock:
            row = self.get(identifier)
            if row.get("active"):
                raise PublishError(409, "This attempt is running; wait for it to stop.", "active")
            effect = row.get("pending_effect") if row["state"] == "unknown" else None
            if row["state"] == "unknown" and effect == "upload":
                storage = self.storage_factory()
                ok = bool(storage and row.get("video_url") and storage.verify_public(row["video_url"], row["bytes"]))
                return self._save(row, "Hosting checked." if ok else "Upload not found; safe to upload again.",
                                  state="uploaded" if ok else "created", pending_effect=None, error=None)
            if row["state"] not in {"unknown", "container_created"}:
                return row
            client = self.client_factory()
            account = self.store.get("connected_accounts", row["account_id"]) or {}
            try:
                if effect == "create_container":
                    found = self._match_recent(row, client, account)
                    if len(found) == 1:
                        return self._save(row, "Found the post on Instagram.", state="published",
                                          pending_effect=None, media_id=found[0]["media_id"], error=None)
                    if found:
                        return self._save(row, "Several matching posts; check Instagram manually.")
                    return self._save(row, "No post found. A leftover unpublished container (if any) expires "
                                      "in 24 hours; safe to create a new one.", state="uploaded",
                                      pending_effect=None, error=None)
                if not row.get("container_id"):
                    return self._save(row, "No container ID recorded; check Instagram manually.")
                status = self._read_container(row, client, account)
                if status == "PUBLISHED":
                    found = self._match_recent(row, client, account)
                    if len(found) == 1:
                        return self._save(row, "Container published; matched the post.", state="published",
                                          pending_effect=None, media_id=found[0]["media_id"],
                                          container_status=status, error=None)
                    return self._save(row, "Container is published but the post could not be matched uniquely. "
                                      "Check Instagram; do not post again.", state="unknown",
                                      container_status=status)
                target = {"FINISHED": "container_ready", "IN_PROGRESS": "container_created",
                          "ERROR": "failed", "EXPIRED": "failed"}.get(status)
                if not target:
                    return self._save(row, "Container status unreadable; still unknown.")
                return self._save(row, f"Container status {status}.", state=target, pending_effect=None,
                                  container_status=status, error=None if target != "failed" else
                                  {"code": status.lower(), "message": "Instagram did not publish this container."})
            except ComposioError as error:
                return self._save(row, "Status check failed; still unknown.",
                                  last_reconcile_error={"code": error.code, "message": str(error)})

    # ------------------------------------------------------------------ readiness (read-only)
    def readiness(self, account_id: str) -> dict:
        account = self.store.get("connected_accounts", account_id)
        if not account or account.get("status") != "active" or not account.get("instagram_user_id"):
            raise PublishError(404, "Active connected account not found.", "not_found")
        client = self.client_factory()
        try:
            usage, total = _quota(self._call(client, account, "INSTAGRAM_GET_IG_USER_CONTENT_PUBLISHING_LIMIT",
                                             {"ig_user_id": account["instagram_user_id"],
                                              "fields": "quota_usage,config"}))
        except ComposioError as error:
            return {"account_id": account_id, "status": "missing_publish_scope_or_error", "code": error.code,
                    "message": "The read-only publishing-limit check failed. The account may lack "
                               "instagram_business_content_publish; reconnect with that scope."}
        return {"account_id": account_id, "status": "ready", "quota_usage": usage, "quota_total": total,
                "tool_version": ComposioPublishingClient.PINNED_VERSION}
