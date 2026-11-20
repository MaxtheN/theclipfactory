"""Human-approved clip posting through the Growth Factory posting server (Zernio), with durable attempts.

One attempt posts one approved clip revision to one connected account. Every external write is
preceded by a durable ``pending_effect`` record. A post whose outcome is uncertain (timeout, lost
connection, crash, server 5xx) moves the attempt to ``unknown``; an unknown attempt is never sent
again until ``reconcile`` has read the server's state (find by external id). Reconcile reads only and
never reposts under a new idempotency key.

States: created → uploading → uploaded(video_url) → submitted(zernio_post_id) → published(url)
→ mapped; plus failed (definite: nothing was published), cancelled and unknown.
A scheduled post waits in ``scheduled`` (nothing external yet) until the person's chosen time or
click moves it to ``created``. Scheduling happens in the app (post_schedule); the posting server is
always asked to publish now.

Every attempt carries its ``package`` (caption hash/features, platform options, cover, scheduled_for)
and ``posted_at`` so learning can use them later.
"""

from __future__ import annotations

import inspect
import queue
import re
import threading
import time
from collections.abc import Callable
from pathlib import Path

from fastapi import HTTPException

from . import post_package, quality
from .learning import Publication
from .posting_server import PLATFORM_LABELS, PLATFORMS, ZERNIO_ID, PostingServerError, platform_entry
from .store import new_id, now

KIND = "publish_attempts"
REPORTS = "quality_reports"
PROVIDER = "zernio"
STATES = ("scheduled", "created", "uploading", "uploaded", "submitted", "published", "mapped", "failed",
          "cancelled", "unknown")
RESUMABLE = {"created", "uploaded", "submitted", "published"}
FINAL = {"mapped", "failed", "cancelled"}
# Attempt states that never reached a platform and do not block a new attempt for the account.
CLOSED_UNSENT = {"failed", "cancelled"}
# Definite refusals that leave the attempt resumable: nothing was created, and the cause is fixable.
RETRYABLE = {"sign_in_required", "session_expired", "rate_limited", "zernio_rate_limited", "not_configured",
             "posting_plan_limit", "workspace_forbidden"}
# Legacy Composio/Instagram states from before the posting server.
LEGACY_SENT = {"container_created", "container_ready", "published", "unknown"}
CAPTION_LIMITS = {"instagram": 2200, "tiktok": 2200, "youtube": 5000, "facebook": 63206, "linkedin": 3000,
                  "twitter": 280, "threads": 500}
YOUTUBE_VISIBILITY = {"public", "unlisted", "private"}
TIKTOK_TOGGLES = ("allow_comment", "allow_duet", "allow_stitch")


class PublishError(Exception):
    def __init__(self, status: int, message: str, code: str = "invalid", details=None):
        super().__init__(message)
        self.status, self.message, self.code, self.details = status, message, code, details


def _from_server(error: PostingServerError) -> PublishError:
    # A cloud sign-in problem is a conflict on the local API: 401 there means the local session token.
    status = 409 if error.status == 401 else error.status if 400 <= error.status < 600 else 502
    return PublishError(status, error.message, error.code)


def normalize_caption(value: str) -> str:
    return re.sub(r"[\x00-\x1f\x7f\s]+", " ", value or "").strip()


def validate_caption(caption, platform: str = "instagram") -> str:
    label = PLATFORM_LABELS.get(platform, platform)
    if not isinstance(caption, str) or not caption.strip():
        raise PublishError(422, "Write a caption for the post.", "invalid_caption")
    limit = CAPTION_LIMITS.get(platform, 2200)
    if len(caption) > limit:
        raise PublishError(422, f"{label} captions are limited to {limit:,} characters.", "invalid_caption")
    if any(ord(c) < 32 and c not in "\n\t" for c in caption) or "\x7f" in caption:
        raise PublishError(422, "Remove control characters from the caption.", "invalid_caption")
    if platform == "instagram":
        if len(re.findall(r"(?:^|\s)#\w", caption)) > 30:
            raise PublishError(422, "Instagram allows at most 30 hashtags.", "invalid_caption")
        if len(re.findall(r"(?:^|\s)@\w", caption)) > 20:
            raise PublishError(422, "Instagram allows at most 20 mentions.", "invalid_caption")
    return caption


class Publisher:
    def __init__(self, store, *, root: Path, server_factory: Callable, learning, campaigns,
                 gate: Callable = quality.evaluate, enabled: Callable[[], bool] = lambda: True,
                 sleep: Callable[[float], None] = time.sleep, poll_interval: float = 5, max_polls: int = 60,
                 item_gap: float = 5, start_worker: bool = True, covers: post_package.Covers | None = None):
        self.store, self.root = store, Path(root)
        self.covers = covers or post_package.Covers(self.root)
        self.server_factory, self.enabled = server_factory, enabled
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
        """After a restart: a post in flight has an unknown outcome; an upload in flight is simply redone;
        attempts from the retired Composio publisher are closed or flagged for a manual check."""
        for row in self.store.all(KIND):
            if row.get("provider") != PROVIDER:
                self._recover_legacy(row)
                continue
            if not row.get("active"):
                continue
            if row.get("pending_effect") == "upload":
                self._save(row, "App stopped during the upload; it will upload again on resume.",
                           state="created", pending_effect=None, active=False)
            elif row.get("pending_effect"):
                self._save(row, "App stopped while posting; outcome unknown. Check status.",
                           state="unknown", previous_state=row["state"], active=False)
            else:
                self._save(row, "App stopped; resume when ready.", active=False)

    def _recover_legacy(self, row: dict):
        if row.get("legacy") or row["state"] in {"mapped", "failed", "cancelled"}:
            return
        if row["state"] in LEGACY_SENT:
            self._save(row, "Posted with the retired Instagram connection. Check Instagram directly; "
                       "this app will not resume it.", legacy=True, active=False)
        else:
            self._save(row, "Posting moved to the new posting service; nothing was published. "
                       "Post this clip again from a connected account.", state="cancelled", legacy=True,
                       active=False, pending_effect=None)

    @staticmethod
    def _require_current(row: dict):
        if row.get("provider") != PROVIDER:
            raise PublishError(409, "This attempt used the retired Instagram connection. Check Instagram "
                                    "directly; it cannot be resumed here.", "legacy_attempt")

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
        if (not account or account.get("status") != "active" or account.get("provider") != PROVIDER
                or account.get("platform") not in PLATFORMS
                or not ZERNIO_ID.fullmatch(account.get("zernio_account_id") or "")):
            raise PublishError(422, "Choose an active connected account.", "account_unverified")
        if account.get("profile_id") != clip.get("profile_id"):
            raise PublishError(422, "This account is bound to another workspace profile.", "account_unbound")
        if account.get("publishing_permitted") is not True:
            raise PublishError(403, "Posting is turned off for this account. Allow posting for it first.",
                               "account_not_permitted")
        return account

    def _require_server(self):
        """Posting must be enabled in Settings and the cloud session must be usable."""
        if not self.enabled():
            raise PublishError(403, "Posting is turned off. Turn on publishing in Settings first.",
                               "publishing_disabled")
        return self._server()

    def _server(self):
        server = self.server_factory()
        if server is None:
            raise PublishError(409, "Growth Factory cloud is not configured; posting needs the posting server.",
                               "cloud_not_configured")
        try:
            server.workspace_id()
        except PostingServerError as error:
            raise _from_server(error) from None
        return server

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

    def _tiktok(self, clip: dict, account: dict, settings) -> dict:
        """TikTok requires the creator's own preview confirmation, consent, privacy level and interaction
        choices on every post, checked against the creator's current options."""
        settings = settings if isinstance(settings, dict) else {}
        if settings.get("content_preview_confirmed") is not True or settings.get("express_consent_given") is not True:
            raise PublishError(422, "TikTok needs you to preview the video and agree to TikTok's terms before "
                                    "posting.", "tiktok_consent_required")
        privacy = settings.get("privacy_level")
        toggles = {name: settings.get(name) for name in TIKTOK_TOGGLES}
        if not isinstance(privacy, str) or any(type(v) is not bool for v in toggles.values()):
            raise PublishError(422, "Choose who can see the TikTok post and whether comments, duets and "
                                    "stitches are allowed.", "tiktok_settings_required")
        try:
            info = self._server().creator_info(account["zernio_account_id"])
        except PostingServerError as error:
            raise _from_server(error) from None
        creator = info.get("creator") if isinstance(info.get("creator"), dict) else {}
        if creator.get("canPostMore") is False:
            raise PublishError(409, "TikTok says this account cannot post more right now. Try again later.",
                               "tiktok_cannot_post")
        levels = {item.get("value") for item in info.get("privacyLevels") or [] if isinstance(item, dict)}
        if privacy not in levels:
            raise PublishError(422, "That TikTok privacy option is not available for this account.",
                               "invalid_privacy_level")
        limits = info.get("postingLimits") if isinstance(info.get("postingLimits"), dict) else {}
        interaction = limits.get("interactionSettings") if isinstance(limits.get("interactionSettings"), dict) else {}
        for name, value in toggles.items():
            option = interaction.get(name) if isinstance(interaction.get(name), dict) else {}
            if value and option.get("enabled") is False:
                raise PublishError(422, f"This TikTok account has {name.removeprefix('allow_')}s turned off.",
                                   "tiktok_interaction_disabled")
        longest, length = limits.get("maxVideoDurationSec"), post_package.duration_of(clip)
        if isinstance(longest, (int, float)) and length and length > longest:
            raise PublishError(422, f"TikTok allows videos up to {int(longest)} seconds for this account.",
                               "too_long")
        return {"privacy_level": privacy, **toggles, "content_preview_confirmed": True,
                "express_consent_given": True, "nickname": creator.get("nickname")}

    def _package(self, clip: dict, caption: str, package: dict | None, account: dict | None = None) -> dict:
        """The exact post package recorded on the attempt (and later usable as learning variables)."""
        package = package or {}
        platform = (account or {}).get("platform", "instagram")
        share = package.get("share_to_feed", True)
        if type(share) is not bool:
            raise PublishError(422, "share_to_feed must be true or false.", "invalid_package")
        try:
            collaborators = post_package.clean_collaborators(package.get("collaborators"))
        except ValueError as error:
            raise PublishError(422, str(error), "invalid_collaborators") from None
        if collaborators and platform != "instagram":
            raise PublishError(422, "Collaborator invites are only available for Instagram Reels.",
                               "collaborators_unsupported")
        try:
            cover = self.covers.resolve(clip, self.clip_path(clip), package.get("cover_time_ms"))
        except ValueError as error:
            raise PublishError(422, str(error), "invalid_cover") from None
        result = {**post_package.caption_features(caption), "platform": platform, "share_to_feed": share,
                  "collaborators": collaborators, "location_id": None, "cover": cover}
        if platform == "youtube":
            title = (package.get("youtube_title") or clip.get("hook") or caption).strip()
            title = normalize_caption(title)[:100].strip()
            visibility = package.get("youtube_visibility") or "public"
            if not title:
                raise PublishError(422, "Give the YouTube video a title.", "invalid_title")
            if visibility not in YOUTUBE_VISIBILITY:
                raise PublishError(422, "YouTube visibility must be public, unlisted or private.", "invalid_package")
            result["youtube"] = {"title": title, "visibility": visibility}
        if platform == "tiktok" and account is not None:
            result["tiktok"] = self._tiktok(clip, account, package.get("tiktok"))
        return result

    def _validate(self, clip_id, account_id, caption, sha256, override_reason, package=None):
        clip = self._require_clip(clip_id, sha256)
        account = self._require_account(account_id, clip)
        caption = validate_caption(caption, account["platform"])
        existing = self._existing(clip_id, account_id)
        if existing:
            message = ("Already posted to this account." if existing["state"] in {"published", "mapped"}
                       else "This account already has a scheduled post for this clip."
                       if existing["state"] == "scheduled"
                       else "An attempt for this account exists. Check its status or resume it.")
            raise PublishError(409, message, "attempt_exists", {"attempt_id": existing["id"]})
        report, override = self._check_quality({**clip, "caption": caption}, override_reason)
        self.clip_path(clip)
        return clip, account, caption, report, override, self._package(clip, caption, package, account)

    def _new_attempt(self, clip, account, caption, report, override, package=None, batch_id=None, *,
                     state="created", scheduled_for=None, schedule_id=None) -> dict:
        stamp = now()
        identifier = new_id()
        row = {
            "id": identifier, "provider": PROVIDER, "clip_id": clip["id"], "campaign_id": clip.get("campaign_id"),
            "profile_id": clip.get("profile_id"), "account_id": account["id"], "platform": account["platform"],
            "zernio_account_id": account["zernio_account_id"], "account_name": account.get("display_name"),
            "sha256": clip["sha256"].lower(), "revision_number": clip.get("revision_number") or 1,
            "caption": caption, "state": state, "pending_effect": None, "active": False,
            # The same key and external id are reused for every send of this attempt, so a resend after an
            # uncertain outcome can never create a second post.
            "idempotency_key": f"gf-attempt-{identifier}", "external_id": f"gf-{identifier}",
            "video_url": None, "cover_url": None, "cover_mode": None, "zernio_post_id": None,
            "platform_status": None, "platform_post_id": None, "permalink": None, "published_at": None,
            "mapping": {"status": "pending"}, "warnings": [], "error": None, "batch_id": batch_id,
            "quality": {k: report.get(k) for k in ("verdict", "reasons", "rubric", "gate_version", "evaluated_at")},
            "override_reason": override, "created_at": stamp, "updated_at": stamp,
            "package": package or self._package(clip, caption, None, account),
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
            self._require_server()
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
                self._require_current(row)
                self._require_server()
                clip = self._require_clip(row["clip_id"], row["sha256"])
                account = self._require_account(row["account_id"], clip)
                validate_caption(row["caption"], account["platform"])
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
            self._require_server()
            accepted, problems = [], []
            for clip_id in clip_ids:
                clip = self.store.get("clips", clip_id)
                if clip and clip.get("campaign_id") != campaign_id:
                    problems.append({"clip_id": clip_id, "message": "Clip belongs to another campaign."})
                    continue
                caption = captions.get(clip_id) or (clip or {}).get("caption") or (clip or {}).get("hook")
                for account_id in account_ids:
                    account = self.store.get("connected_accounts", account_id) or {}
                    if account.get("platform") == "tiktok":
                        # TikTok needs the creator to preview each video and consent per post.
                        problems.append({"clip_id": clip_id, "account_id": account_id,
                                         "code": "tiktok_consent_required",
                                         "message": "Post to TikTok from each clip so you can preview it and "
                                                    "give TikTok's consent."})
                        continue
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
            self._require_current(row)
            if row.get("active"):
                raise PublishError(409, "This attempt is already running.", "active")
            if row["state"] == "unknown":
                raise PublishError(409, "Outcome unknown. Check status before continuing.", "needs_reconcile")
            if row["state"] not in RESUMABLE:
                raise PublishError(409, f"Nothing to resume from state {row['state']}.", "not_resumable")
            if row["state"] in {"created", "uploaded"}:
                self._require_server()
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
            self._require_current(row)
            self._advance(row)
        except Exception as exc:  # noqa: BLE001 - lane boundary; errors are recorded, never lost
            message = exc.message if isinstance(exc, (PublishError, PostingServerError)) else (
                "Posting stopped on an unexpected local error.")
            code = getattr(exc, "code", None) or "error"
            current = self.store.get(KIND, identifier) or row
            definite = isinstance(exc, PublishError) or (isinstance(exc, PostingServerError) and not exc.uncertain)
            effect = current.get("pending_effect")
            if effect == "create_post" and not definite:
                self._save(current, "Outcome of the post is unknown.", state="unknown",
                           previous_state=current["state"], error={"code": code, "message": message})
            elif effect == "upload":
                # An upload publishes nothing, so it is safe to redo.
                self._save(current, "Upload stopped; resume to upload again.", state="created",
                           pending_effect=None, error={"code": code, "message": message})
            elif effect:
                self._save(current, None, pending_effect=None, error={"code": code, "message": message})
            else:
                self._save(current, None, error={"code": code, "message": message})
        finally:
            current = self.store.get(KIND, identifier)
            if current and current.get("active"):
                self._save(current, None, active=False)

    def _precheck(self, row: dict) -> dict:
        """Before anything is sent: the clip, account, caption and gate must all still hold."""
        clip = self._require_clip(row["clip_id"], row["sha256"])
        account = self._require_account(row["account_id"], clip)
        if account["zernio_account_id"] != row["zernio_account_id"]:
            raise PublishError(409, "The connected account changed. Start a new post.", "account_changed")
        self._check_quality({**clip, "caption": validate_caption(row["caption"], row["platform"])},
                            row.get("override_reason"))
        return clip

    def _advance(self, row: dict):
        server = None
        while not self.stopping.is_set():
            state = row["state"]
            if state in {"created", "uploading", "uploaded"}:
                clip = self._precheck(row)
                server = self._require_server()
                step = self._upload(row, clip, server) if state != "uploaded" else self._submit(row, server)
                if not step:
                    return
            elif state == "submitted":
                server = server or self._server()
                if not self._poll(row, server):
                    return
            elif state == "published":
                self._map(row)
                return
            else:
                return

    # ------------------------------------------------------------------ steps
    def _upload(self, row, clip, server) -> bool:
        path = self.clip_path(clip)
        if quality.media.sha256_file(path) != row["sha256"]:
            raise PublishError(409, "Clip bytes no longer match the approved revision.", "revision_changed")
        self._save(row, "Uploading the approved video.", state="uploading", pending_effect="upload",
                   bytes=path.stat().st_size)
        try:
            url = server.upload(path, "video/mp4", filename=f"{row['sha256'][:16]}.mp4")
        except PostingServerError as error:
            if error.code in RETRYABLE or error.code in {"upload_timeout", "upload_failed", "network", "timeout"}:
                raise
            self._save(row, error.message, state="failed", pending_effect=None,
                       error={"code": error.code, "message": error.message})
            return False
        cover = self._host_cover(row, server)
        self._save(row, "Uploaded; ready to post.", state="uploaded", pending_effect=None, video_url=url,
                   uploaded_at=now(), **cover)
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

    def _host_cover(self, row, server) -> dict:
        """Instagram only, best effort: upload the cover still as the Reel cover; otherwise fall back to the
        same frame's time offset. A cover upload publishes nothing, so a failure is never unknown."""
        if row["platform"] != "instagram":
            return {"cover_mode": "time_offset"}
        path, cover = self._cover_file(row)
        warnings = list(row.get("warnings") or [])
        if path is None:
            if cover.get("local_path"):
                warnings.append("cover_file_missing")
            return {"cover_mode": "time_offset", "warnings": warnings}
        try:
            url = server.upload(path, "image/jpeg", filename=f"{cover['sha256'][:16]}.jpg")
        except PostingServerError as error:
            warnings.append("cover_upload_failed")
            return {"cover_mode": "time_offset", "warnings": warnings, "cover_error": error.message}
        return {"cover_mode": "cover_url", "cover_url": url}

    def payload(self, row: dict) -> dict:
        """The posting-server request for this attempt: one account, publish now, our external id."""
        package = row.get("package") or {}
        cover = package.get("cover") or {}
        offset = cover.get("time_ms") if type(cover.get("time_ms")) is int else 0
        specific: dict = {}
        if row["platform"] == "instagram":
            specific["shareToFeed"] = package.get("share_to_feed", True)
            if row.get("cover_url"):
                specific["instagramThumbnail"] = row["cover_url"]
            else:
                specific["thumbOffset"] = offset
            if package.get("collaborators"):
                specific["collaborators"] = list(package["collaborators"])
        elif row["platform"] == "youtube":
            specific.update(package.get("youtube") or {})
        elif row["platform"] == "tiktok":
            tiktok = package.get("tiktok") or {}
            specific.update({k: tiktok.get(k) for k in ("privacy_level", *TIKTOK_TOGGLES,
                                                         "content_preview_confirmed", "express_consent_given")})
            specific["video_cover_timestamp_ms"] = offset
        target = {"accountId": row["zernio_account_id"], **({"platformSpecificData": specific} if specific else {})}
        return {"content": row["caption"], "mediaItems": [{"url": row["video_url"], "type": "video"}],
                "platforms": [target], "publishNow": True, "externalId": row["external_id"]}

    def _submit(self, row, server) -> bool:
        if not row.get("video_url"):
            self._save(row, "No uploaded video recorded; uploading again.", state="created")
            return True
        self._save(row, "Posting.", pending_effect="create_post", posted_at=row.get("posted_at") or now())
        try:
            reply = server.create_post(self.payload(row), row["idempotency_key"])
        except PostingServerError as error:
            if error.uncertain:
                raise
            if error.code == "in_progress":
                self._save(row, "The post is still being created. Check status shortly.", state="unknown",
                           previous_state="uploaded", error={"code": error.code, "message": error.message})
                return False
            if error.code in RETRYABLE:
                self._save(row, "Nothing was posted; resume when ready.", pending_effect=None,
                           error={"code": error.code, "message": error.message})
                return False
            self._save(row, "The post was refused; nothing was published.", state="failed", pending_effect=None,
                       error={"code": error.code, "message": error.message})
            return False
        post = reply["post"]
        self._save(row, "Sent to the posting service." + (" (already sent earlier)" if reply["replayed"] else ""),
                   state="submitted", pending_effect=None, zernio_post_id=post["id"], submitted_at=now())
        return self._apply(row, post) != "stop"

    def _apply(self, row, post: dict) -> str:
        """Fold the server's view of the post into the attempt: ``published``, ``pending`` or ``stop``."""
        entry = platform_entry(post, row["zernio_account_id"]) or {}
        status = entry.get("status")
        changes = {"platform_status": status}
        if entry.get("platformPostId"):
            changes["platform_post_id"] = str(entry["platformPostId"])[:200]
        if entry.get("url"):
            changes["permalink"] = str(entry["url"])[:500]
        if status == "published":
            self._save(row, "Published.", state="published", published_at=post.get("publishedAt") or now(),
                       error=None, **changes)
            return "published"
        if status in {"failed", "cancelled"}:
            label = PLATFORM_LABELS.get(row["platform"], row["platform"])
            message = entry.get("error") or f"{label} did not publish this post."
            self._save(row, f"{label} did not publish the post.", state="failed",
                       error={"code": entry.get("errorCategory") or f"platform_{status}", "message": message,
                              "source": entry.get("errorSource")}, **changes)
            return "stop"
        self._save(row, None, **changes)
        return "pending"

    def _poll(self, row, server) -> bool:
        failures = 0
        for attempt in range(self.max_polls):
            if self.stopping.is_set():
                return False
            try:
                result = self._apply(row, server.get_post(row["zernio_post_id"])["post"])
                failures = 0
            except PostingServerError:
                result, failures = "pending", failures + 1
                if failures >= 3:
                    self._save(row, "Post status could not be read; check status later.")
                    return False
            if result == "published":
                return True
            if result == "stop":
                return False
            if attempt + 1 < self.max_polls:
                self.sleep(self.poll_interval)
        self._save(row, "Still publishing. Check status in a few minutes.")
        return False

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
                media_id=row["zernio_post_id"], published_at=row["published_at"], sha256=row["sha256"]))
        except HTTPException as error:
            self._save(row, "Learning mapping was refused.", mapping={"status": "refused", "detail": error.detail})
            return
        self.store.patch("learning_publications", publication["id"], mapping_source="app_published",
                         mapping_detail="App uploaded these exact bytes (sha256) and posted them through the "
                                        "posting service, which reported the platform post.",
                         publish_attempt_id=row["id"], provider=PROVIDER, platform=row["platform"],
                         platform_post_id=row.get("platform_post_id"), permalink=row.get("permalink"))
        self._save(row, "Learning will measure this post.", state="mapped",
                   mapping={"status": "mapped", "publication_id": publication["id"], "policy_id": policies[0]["id"]})

    # ------------------------------------------------------------------ reconcile (reads only)
    def reconcile(self, identifier: str) -> dict:
        with self.lock:
            row = self.get(identifier)
            self._require_current(row)
            if row.get("active"):
                raise PublishError(409, "This attempt is running; wait for it to stop.", "active")
            if row["state"] == "unknown" and row.get("pending_effect") == "upload":
                return self._save(row, "Upload outcome does not matter; it will upload again.", state="created",
                                  pending_effect=None, error=None)
            if row["state"] not in {"unknown", "submitted", "published"}:
                return row
            server = self._server()
            try:
                if not row.get("zernio_post_id"):
                    found = server.find_posts(row["external_id"])
                    if len(found) > 1:
                        return self._save(row, "Several posts match this attempt; check the account directly.")
                    if not found:
                        return self._save(row, "No post was created; resume to send it (the same request key "
                                          "is reused, so it cannot post twice).", state="uploaded",
                                          pending_effect=None, error=None)
                    self._save(row, "Found the post on the posting service.", state="submitted",
                               pending_effect=None, zernio_post_id=found[0]["id"], error=None)
                    post = found[0]
                else:
                    post = server.get_post(row["zernio_post_id"])["post"]
                    if row["state"] == "unknown":
                        self._save(row, None, state="submitted", pending_effect=None, error=None)
                if self._apply(row, post) == "published":
                    self._map(row)
                return self.get(identifier)
            except PostingServerError as error:
                return self._save(row, "Status check failed; still unknown.",
                                  last_reconcile_error={"code": error.code, "message": error.message})
