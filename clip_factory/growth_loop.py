"""Review preferences and traceable, one-variable draft iterations.

Quality is an editorial score, preference is human evidence, and audience observations
are a third kind of evidence. None of these records approves or publishes a clip.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path

from fastapi import HTTPException

from . import craft, media, moments, ranking
from .campaigns import Production
from .store import now

MIN_TASTE_REVIEWS = 4
MAX_TASTE_ADJUSTMENT = 5
SUPPORTED_RULES = {"hooks", "duration_seconds", "framing", "caption_style"}
OBSERVATIONAL = "Observational comparison, not causal lift. A preference or quality score is not an audience outcome."


def _count(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def compare_observations(before: dict, after: dict, *, metric="views", min_views=100,
                         window_complete=False) -> dict:
    """Bounded comparison shared by real-loop readouts and the synthetic rehearsal.

    Counts are never imputed; rates require every numerator and an explicit denominator.
    ``window_complete`` means BOTH observations use the declared equal-age window.
    """
    if metric not in {"views", "engagement_rate", "completion_rate", "click_rate"}:
        raise ValueError("Unsupported comparison metric.")
    if isinstance(min_views, bool) or not isinstance(min_views, int) or min_views < 1:
        raise ValueError("Minimum views must be a positive integer.")
    reasons = []
    if window_complete is not True:
        reasons.append("The declared measurement window is not complete for both variants.")
    source_kinds = {bool(before.get("simulated")), bool(after.get("simulated"))}
    if len(source_kinds) > 1:
        reasons.append("Real and simulated observations cannot be compared.")
    if source_kinds != {True}:
        for key in ("profile_id", "account_id", "window_days"):
            if before.get(key) is None or after.get(key) is None or before.get(key) != after.get(key):
                reasons.append(f"Both real observations need the same explicit {key}.")
        if not _count(before.get("window_days")) or before.get("window_days", 0) <= 0:
            reasons.append("A positive declared observation window is required.")

    def measure(snapshot):
        values = snapshot.get("metrics", snapshot)
        views = values.get("views")
        if not _count(views) or not float(views).is_integer() or views < min_views:
            reasons.append("Each variant needs a known view denominator meeting the minimum sample.")
            return None
        if metric == "views":
            return float(views)
        keys = {"engagement_rate": ("likes", "comments", "shares", "saves"),
                "completion_rate": ("completions",), "click_rate": ("link_clicks",)}[metric]
        if any(not _count(values.get(key)) or not float(values[key]).is_integer() for key in keys):
            reasons.append("A required numerator is unavailable; unknown is not zero.")
            return None
        numerator = sum(values[key] for key in keys)
        if metric in {"completion_rate", "click_rate"} and numerator > views:
            reasons.append("The numerator exceeds the view denominator for this rate.")
            return None
        return numerator / views

    first, second = measure(before), measure(after)
    diff = None if first is None or second is None else second - first
    status = "insufficient_evidence" if reasons else (
        "no_clear_difference" if math.isclose(diff, 0, abs_tol=1e-12) else
        "favors_variant" if diff > 0 else "favors_parent")
    return {"status": status, "metric": metric, "before_value": first, "after_value": second,
            "difference": diff, "min_views": min_views, "window_complete": bool(window_complete),
            "reasons": list(dict.fromkeys(reasons)), "evidence_kind": "observational",
            "simulated": True in source_kinds, "caveat": OBSERVATIONAL,
            "decision": "wait" if reasons else "test" if status == "favors_variant" else "keep"}


def _digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()[:24]


def _timestamp(value):
    """Do not interpret timezone-free or invalid stored timestamps as evidence."""
    try:
        parsed = datetime.fromisoformat(str(value))
        return parsed.astimezone(UTC) if parsed.tzinfo is not None else None
    except (TypeError, ValueError):
        return None


def preference_model(store, profile_id: str) -> dict:
    """Latest human decision per exact clip revision; repeat clicks never add votes."""
    latest = {}
    rows = sorted(store.all("taste_labels"), key=lambda r: (r["created_at"], r["id"]))
    for row in rows:
        if row.get("profile_id") == profile_id:
            latest[(row["clip_id"], row["sha256"])] = row
    reviews = list(latest.values())
    positive = [r for r in reviews if r["decision"] == "approve"]
    negative = [r for r in reviews if r["decision"] in {"reject", "request_change"}]
    ready = len(reviews) >= MIN_TASTE_REVIEWS and bool(positive) and bool(negative)
    weights = {}
    if ready:
        for name in set().union(*(r.get("signals", {}).keys() for r in reviews)):
            yes = [r["signals"][name] for r in positive if _count(r.get("signals", {}).get(name))]
            no = [r["signals"][name] for r in negative if _count(r.get("signals", {}).get(name))]
            if yes and no:
                # Shrink small samples and never alter the underlying rubric score.
                weights[name] = (sum(yes) / len(yes) - sum(no) / len(no)) * len(reviews) / (len(reviews) + 8)
    return {"profile_id": profile_id, "status": "ready" if ready else "insufficient_preference_evidence",
            "sample_size": len(reviews), "positive": len(positive), "negative": len(negative),
            "minimum": MIN_TASTE_REVIEWS, "weights": weights, "evidence_kind": "human_preference",
            "caveat": "Preference alignment index, not a probability, audience metric, or quality score."}


def taste_alignment(model: dict, signals: dict) -> dict:
    weights = model.get("weights") or {}
    known = {k: v for k, v in weights.items() if _count(signals.get(k))}
    denominator = sum(abs(v) for v in known.values())
    if model["status"] != "ready" or not denominator:
        return {"index": None, "adjustment": 0, "sample_size": model["sample_size"],
                "status": "insufficient_preference_evidence", "evidence_kind": "human_preference"}
    agreement = sum(v * (2 * min(1, signals[k]) - 1) for k, v in known.items()) / denominator
    adjustment = round(MAX_TASTE_ADJUSTMENT * agreement, 2)
    return {"index": round(50 + 50 * agreement), "adjustment": adjustment,
            "sample_size": model["sample_size"], "status": "preference_alignment",
            "evidence_kind": "human_preference", "caveat": model["caveat"]}


def personalize_rankings(store, clips: list[dict], records: dict, profile_id: str | None) -> dict:
    """Reorder review priority by at most five points; hard holds and rubric scores persist."""
    if not profile_id:
        return records
    model = preference_model(store, profile_id)
    result = deepcopy(records)
    by_id = {c["id"]: c for c in clips}
    for identifier, record in result.items():
        taste = taste_alignment(model, record.get("signals") or {})
        record.update(taste=taste, review_priority=round(record["score"] + taste["adjustment"], 2))
    eligible = sorted((key for key in result if not result[key]["below_bar"]),
                      key=lambda key: (-result[key]["review_priority"], by_id[key].get("start", 0), key))
    picks = sum(bool(record["top_pick"]) for record in records.values())
    for position, identifier in enumerate(eligible, 1):
        result[identifier].update(position=position, top_pick=position <= picks)
    return result


class GrowthLoop:
    def __init__(self, store, campaigns, render, *, root=None, scorecard=None):
        self.store, self.campaigns, self.render, self.root = store, campaigns, render, root
        self.scorecard = scorecard

    def rubric_edit(self, clip):
        """Choose only a measured, source-supported hook repair; no arbitrary style toggles."""
        from .creative_score import evidence_for, scorecard

        video = self.store.get("videos", clip["video_id"]) or {}
        view = self.scorecard(clip["id"]) if self.scorecard else {
            "ranking": scorecard(clip), "assessments": [], "integrity": {"status": "verified"}}
        current = [row for row in view.get("assessments", [])
                   if row.get("current") is True and row.get("status") == "assessed"
                   and row.get("sha256") == clip["sha256"]]
        current.sort(key=lambda row: (row.get("finished_at") or "", row["id"]), reverse=True)
        assessment = current[0] if current else None
        rubric = {"ranking": deepcopy(view.get("ranking")), "integrity": deepcopy(view.get("integrity")),
                  "assessment": deepcopy(assessment)}
        old_hook = str(clip["edit_plan"].get("hook") or "").strip()
        proposal = {"status": "no_supported_rubric_edit", "variable": "hooks", "before": old_hook,
                    "after": None, "weak_dimension": None, "assessment_id": assessment["id"] if assessment else None,
                    "reason": "No safely supported rubric weakness maps to an available single-field hook repair."}
        supplied = evidence_for(clip, video)["source_speech"]

        def tokens(value):
            return re.findall(r"\w+(?:'\w+)?", value.casefold().replace("’", "'"))

        def grounded(quote):
            wanted, source = tokens(quote), tokens(supplied)
            return bool(len(wanted) >= 3 and any(source[i:i + len(wanted)] == wanted
                        for i in range(len(source) - len(wanted) + 1)))

        ai = (assessment or {}).get("assessment") or {}
        faithful = (ai.get("source_faithfulness") or {}).get("score")
        unsafe = ai.get("editorial_hold") is True or (
            isinstance(faithful, (int, float)) and not isinstance(faithful, bool) and faithful <= 2)
        if unsafe:
            quote = str((clip.get("swarm") or {}).get("payoff_quote") or "").strip()
            proposal.update(weak_dimension="source_faithfulness",
                            reason="Current exact-file AI review found a source-faithfulness weakness; repair from the verified source payoff.")
            if not (clip.get("swarm") or {}).get("payoff_verified") or not grounded(quote):
                proposal["reason"] = "The current AI review holds source faithfulness, but no verified in-range payoff quote supports a safe repair."
                return rubric, proposal
        elif ranking.hook_signal({"hook": old_hook}) < 1 and len(old_hook.split()) > 8:
            quote = old_hook
            proposal.update(weak_dimension="hook", reason="The measured hook-length rubric is below full credit; shorten a source-grounded hook to at most eight words.")
            if not grounded(quote):
                proposal["reason"] = "The hook is long, but its wording is not a verified in-range source quote; automatic shortening abstains."
                return rubric, proposal
        else:
            return rubric, proposal
        changed = moments.hook_from_quote(quote)
        if (not changed or len(changed.split()) > 8 or tokens(changed) == tokens(old_hook)
            or not grounded(changed) or (moments.has_negation(quote) and not moments.has_negation(changed))):
            proposal["reason"] = "No genuinely changed, source-grounded short hook preserves the available evidence and negation."
            return rubric, proposal
        proposal.update(status="supported_rubric_edit", after=changed,
                        source_quote=quote, evidence_source="source_speech", source_clip_id=clip["id"])
        return rubric, proposal

    def _existing(self, profile_id, request_id, payload):
        """A lost response must reconcile the accepted request before mutable validation."""
        identifier = "loop_" + _digest([profile_id, request_id])
        existing = self.store.get("growth_loops", identifier)
        if existing:
            if existing["fingerprint"] != _digest(payload):
                raise HTTPException(409, "This request already started a different loop.")
            return self.reconcile(identifier)
        return None

    def _verify_file(self, clip):
        if self.root is None:
            return
        root = Path(self.root).resolve()
        path = (root / str(clip.get("path") or "")).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise HTTPException(409, "The exact rendered clip file is unavailable.")
        try:
            matches = media.sha256_file(path) == clip.get("sha256")
        except OSError:
            matches = False
        if not matches:
            raise HTTPException(409, "The rendered clip bytes changed. Re-render before continuing.")

    def record_review(self, profile_id, clip_id, decision, *, request_id, reason="", expected_sha256=None):
        """Record a successful human operation. This does not approve or edit the clip itself."""
        if decision not in {"approve", "reject", "request_change"}:
            raise HTTPException(422, "Use approve, reject, or request_change.")
        with self.store.lock:
            self.campaigns.active_workspace(profile_id)
            clip = self.campaigns.require("clips", clip_id)
            if clip.get("profile_id") != profile_id:
                raise HTTPException(422, "Review evidence belongs to another workspace.")
            checksum = clip.get("sha256")
            if not checksum or (expected_sha256 and expected_sha256 != checksum):
                raise HTTPException(409, "The exact clip revision changed. Reload before recording preference.")
            self._verify_file(clip)
            payload = {"profile_id": profile_id, "clip_id": clip_id, "sha256": checksum,
                       "decision": decision, "reason": reason.strip()}
            identifier = "taste_" + _digest([profile_id, request_id])
            existing = self.store.get("taste_labels", identifier)
            if existing:
                if any(existing.get(k) != v for k, v in payload.items()):
                    raise HTTPException(409, "This review request already recorded a different decision.")
                return existing
            return self.store.put("taste_labels", {"id": identifier, **payload, "created_at": now(),
                "signals": (clip.get("rank") or {}).get("signals") or {}, "source": "human_review",
                "evidence_kind": "human_preference"})

    def policy(self, profile_id, *, auto_ab=None):
        self.campaigns.active_workspace(profile_id)
        row = self.store.get("growth_loop_policies", profile_id) or {
            "id": profile_id, "profile_id": profile_id, "auto_ab": False, "top_picks": 3,
            "variable": "hook_format", "publishing_policy": "human_approval"}
        if auto_ab is not None:
            row = self.store.put("growth_loop_policies", {**row, "auto_ab": auto_ab, "updated_at": now()})
        return row

    def _parent(self, profile_id, clip_id):
        clip = self.campaigns.require("clips", clip_id)
        if clip.get("profile_id") != profile_id or not clip.get("campaign_id"):
            raise HTTPException(422, "The clip must belong to this workspace and campaign.")
        if (clip.get("rank") or {}).get("below_bar") or clip.get("made_without_speech"):
            raise HTTPException(409, "Held or below-the-bar clips cannot seed an experiment.")
        video = self.store.get("videos", clip["video_id"]) or {}
        reason = ranking.bar_reason(clip, speech_source=video.get("has_audio") is True)
        if reason:
            raise HTTPException(409, reason)
        from .creative_score import source_attribution_guard

        if source_attribution_guard(clip, video)["editorial_hold"]:
            raise HTTPException(409, "Unsupported named attribution must be corrected before an experiment.")
        if not clip.get("sha256") or not isinstance(clip.get("edit_plan"), dict):
            raise HTTPException(409, "A completed, versioned clip is required.")
        self._verify_file(clip)
        return clip

    def _body(self, clip, snapshot, *, variable, value, reason):
        plan = clip["edit_plan"]
        # Campaign revisions inherit their parent's actual framing, captions and motion.
        # A rule recut changes only its declared field; a presentation A/B keeps the
        # production treatment, including explicit swarm departures, unchanged.
        fields = {key: deepcopy(plan[key]) for key in craft.CRAFT_FIELDS if key in plan}
        fields.pop("variants", None)
        fields.update(video_id=clip["video_id"], profile_id=clip["profile_id"],
                      expected_strategy_version_id=snapshot["strategy_version_id"],
                      start=plan["start"], end=plan["end"], hook=plan.get("hook", clip.get("hook", "")),
                      caption=plan.get("caption", clip.get("caption", "")),
                      subtitles=plan.get("subtitles", True), opening_treatment=plan.get("opening_treatment"),
                      cold_open_start=plan.get("cold_open_start"), cold_open_end=plan.get("cold_open_end"),
                      focus_x=plan.get("focus_x", 0.5), parent_clip_id=clip["id"], changed_variable=variable,
                      change_reason=reason)
        if variable in {"framing", "caption_style"} and plan.get(variable) == value:
            raise HTTPException(422, "The approved rule already matches this clip's actual rendered treatment.")
        if variable == "duration_seconds":
            video = self.campaigns.require("videos", clip["video_id"])
            fields["end"] = min(video["duration"], fields["start"] + value)
            if fields["end"] == plan["end"]:
                raise HTTPException(422, "This rule would not change the rendered duration.")
        elif variable == "hooks":
            if not value or value[0] == fields["hook"]:
                raise HTTPException(422, "The approved rule needs a different hook for a real recut.")
            fields["hook"] = value[0]
        elif variable in craft.CRAFT_FIELDS:
            fields[variable] = value
        return Production.model_validate(fields)

    def _request(self, profile_id, request_id, payload, slots, *, kind, rule_id, evidence=None):
        identifier = "loop_" + _digest([profile_id, request_id])
        fingerprint = _digest(payload)
        with self.store.lock:
            existing = self._existing(profile_id, request_id, payload)
            if existing:
                return existing
            prior = [r for r in self.store.all("growth_loops") if r.get("profile_id") == profile_id]
            number = max((r.get("number", 0) for r in prior), default=0) + 1
            receipt = {"id": identifier, "profile_id": profile_id, "number": number,
                       "parent_loop_id": prior[0]["id"] if prior else None, "kind": kind,
                       "rule_id": rule_id, "fingerprint": fingerprint, "created_at": now(),
                       "status": "submitting", "slots": [], "simulated": False,
                       "publishing_policy": "human_approval", "evidence_kind": "production_receipt"}
            if evidence:
                receipt.update(deepcopy(evidence))
            for index, (clip, body) in enumerate(slots):
                receipt["slots"].append({"id": f"{identifier}:{index + 1}", "parent_clip_id": clip["id"],
                    "parent_sha256": clip["sha256"], "campaign_id": clip["campaign_id"],
                    "video_id": clip["video_id"], "variable": body.changed_variable,
                    "reason": body.change_reason, "variant_group": f"{identifier}:group:{index + 1}",
                    "status": "prepared", "job_id": None, "clip_id": None,
                    "evidence_kind": receipt["evidence_kind"],
                    "simulated_evidence": bool(receipt.get("simulated_evidence")),
                    "measurement": {"metric": self.campaigns.require("campaigns", clip["campaign_id"]).get("primary_metric"),
                                    "minimum_views": 100},
                    "before": clip["edit_plan"], "requested_plan": body.model_dump(mode="json")})
            self.store.put("growth_loops", receipt)
            self.store.put("growth_loops", receipt)
            self.tick()
            return self.reconcile(identifier)

    def tick(self):
        """Submit only prepared work once its source is free, using the existing heavy queue.

        Submitting/unknown slots are never retried here. An interrupted submission can be
        reconciled by the stable slot id placed in the existing job's experiment context.
        """
        with self.store.lock:
            for receipt in reversed(self.store.all("growth_loops")):
                if receipt.get("status") in {"completed", "no_draft"}:
                    continue
                receipt = self.reconcile(receipt["id"])
                for slot in receipt["slots"]:
                    if slot["status"] != "prepared":
                        continue
                    if any(j.get("status") in {"queued", "running"}
                           and j.get("context", {}).get("video_id") == slot["video_id"]
                           for j in self.store.all("jobs")):
                        continue
                    body = Production.model_validate(slot["requested_plan"])
                    # A queued plan does not silently adopt newly approved rules.
                    try:
                        parent = self._parent(receipt["profile_id"], slot["parent_clip_id"])
                        if parent["sha256"] != slot["parent_sha256"]:
                            raise HTTPException(409, "The parent revision changed after this loop was planned.")
                        self.campaigns.snapshot(slot["campaign_id"], receipt["profile_id"], slot["video_id"],
                                                body.expected_strategy_version_id)
                    except HTTPException as exc:
                        slot.update(status="held", error=exc.detail)
                        self.store.put("growth_loops", receipt)
                        continue
                    slot["status"] = "submitting"
                    self.store.put("growth_loops", receipt)
                    try:
                        job = self.render(slot["campaign_id"], body, experiment_id=slot["id"], provenance={
                            "growth_loop_id": receipt["id"], "growth_loop_slot_id": slot["id"],
                            "variant_group": slot["variant_group"], "variant_variable": body.changed_variable,
                            "variant_value": "B", "variant_index": 2, "variant_count": 2,
                            **({"simulated_evidence": True,
                                "evidence_kind": "simulated_observation_rehearsal",
                                "rehearsal_comparison": deepcopy(receipt["comparison"]),
                                "rubric_proposal": deepcopy(receipt["proposal"])}
                               if receipt.get("simulated_evidence") else {})})
                        if not isinstance(job, dict) or not job.get("id"):
                            raise ValueError("Render submission did not return a durable job identity.")
                        slot.update(job_id=job["id"], status="queued")
                    except Exception as exc:  # noqa: BLE001 - any uncertain submission must stop for reconciliation
                        # The callback might have queued work before raising; never blindly retry.
                        slot.update(status="unknown", error=f"{type(exc).__name__}: submission needs reconciliation.")
                    self.store.put("growth_loops", receipt)
                self.reconcile(receipt["id"])

    def start_ab(self, profile_id, *, request_id, clip_ids, expected_strategy_version_id):
        payload = {"kind": "ab", "clips": clip_ids, "rule_id": expected_strategy_version_id}
        with self.store.lock:
            existing = self._existing(profile_id, request_id, payload)
            if existing:
                return existing
        if not expected_strategy_version_id:
            raise HTTPException(409, "Select the exact approved rule version before creating an experiment.")
        if not 1 <= len(clip_ids) <= 3 or len(set(clip_ids)) != len(clip_ids):
            raise HTTPException(422, "Choose one to three distinct top clips.")
        with self.store.lock:
            slots = []
            for clip_id in clip_ids:
                clip = self._parent(profile_id, clip_id)
                if not str(clip["edit_plan"].get("hook") or "").strip():
                    raise HTTPException(422, "A hook-format experiment needs an existing rendered hook.")
                snapshot = self.campaigns.snapshot(clip["campaign_id"], profile_id, clip["video_id"],
                                                   expected_strategy_version_id)
                current = craft.with_legacy(clip["edit_plan"]).get("hook_format")
                changed = "overlay" if current == "title_card" else "title_card"
                body = self._body(clip, snapshot, variable="hook_format", value=changed,
                                  reason="Test hook presentation only; original A versus revised B.")
                slots.append((clip, body))
            return self._request(profile_id, request_id, payload, slots, kind="ab", rule_id=expected_strategy_version_id)

    def recut(self, profile_id, *, request_id, clip_ids, expected_strategy_version_id):
        payload = {"kind": "recut", "clips": clip_ids, "rule_id": expected_strategy_version_id}
        with self.store.lock:
            existing = self._existing(profile_id, request_id, payload)
            if existing:
                return existing
        if not expected_strategy_version_id:
            raise HTTPException(409, "Select the exact approved rule version before a recut.")
        if not 1 <= len(clip_ids) <= 3 or len(set(clip_ids)) != len(clip_ids):
            raise HTTPException(422, "Choose one to three distinct clips to recut.")
        with self.store.lock:
            slots = []
            for clip_id in clip_ids:
                clip = self._parent(profile_id, clip_id)
                snapshot = self.campaigns.snapshot(clip["campaign_id"], profile_id, clip["video_id"],
                                                   expected_strategy_version_id)
                before = clip.get("strategy_snapshot") or {}
                after = snapshot["strategy_snapshot"]
                changed = [key for key in SUPPORTED_RULES if before.get(key) != after.get(key)]
                if len(changed) != 1:
                    raise HTTPException(422, "A recut must apply exactly one changed, renderer-supported rule.")
                variable = changed[0]
                body = self._body(clip, snapshot, variable=variable, value=after[variable],
                                  reason=f"Apply approved rule {snapshot['strategy_version_id']}: {variable}.")
                slots.append((clip, body))
            return self._request(profile_id, request_id, payload, slots, kind="recut", rule_id=expected_strategy_version_id)

    def _read_snapshot(self, clip, profile_id, expected_strategy_version_id):
        """Read-only preflight; preview must not run legacy migration-on-read helpers."""
        profile = self.store.get("profiles", profile_id)
        campaign = self.store.get("campaigns", clip["campaign_id"])
        if not profile or not campaign:
            raise HTTPException(404, "The clip workspace or campaign was not found.")
        if profile.get("archived_at") or campaign.get("archived_at"):
            raise HTTPException(409, "Restore the workspace and campaign before rehearsing.")
        if profile_id not in campaign.get("profile_ids", []) or clip["video_id"] not in campaign.get("video_ids", []):
            raise HTTPException(422, "The source and workspace must belong to this campaign.")
        if profile.get("active_strategy_id") != expected_strategy_version_id:
            raise HTTPException(409, "Active strategy changed since it was displayed. Reload before rehearsing.")
        version = self.store.get("strategy_versions", expected_strategy_version_id)
        if not version or version.get("status") != "approved" or profile_id not in version.get("directions", {}):
            raise HTTPException(409, "Approve this workspace’s Style rules before rehearsing.")
        return {"strategy_version_id": expected_strategy_version_id,
                "strategy_snapshot": deepcopy(version["directions"][profile_id])}

    def _prepare_rehearsal(self, profile_id, *, clip_id, expected_strategy_version_id,
                           expected_sha256, scenario):
        """Shared read-only proposal computation for preview and explicit render admission."""
        if scenario not in {"mixed", "decline", "sparse"}:
            raise HTTPException(422, "Choose mixed, decline, or sparse rehearsal evidence.")
        if not expected_strategy_version_id:
            raise HTTPException(409, "Select the exact approved rule version before rehearsing.")
        with self.store.lock:
            clip = self._parent(profile_id, clip_id)
            if expected_sha256 != clip["sha256"]:
                raise HTTPException(409, "The selected clip bytes changed. Reload the exact revision.")
            snapshot = self._read_snapshot(clip, profile_id, expected_strategy_version_id)
            if not str(clip["edit_plan"].get("hook") or "").strip():
                raise HTTPException(422, "This rehearsal needs an existing rendered hook.")
            rubric_before, proposal = self.rubric_edit(clip)
            first = {"id": "synthetic-parent", "simulated": True, "profile_id": profile_id,
                     "account_id": "synthetic-instagram-account", "window_days": 3,
                     "metrics": {"views": 1000, "completions": 350, "likes": 20, "comments": 4,
                                 "shares": 2, "saves": 6, "link_clicks": 8}}
            second = {**deepcopy(first), "id": "synthetic-hypothetical-variant"}
            if scenario == "sparse":
                second["metrics"].update(views=12, completions=6)
            else:
                second["metrics"]["completions"] = 500 if scenario == "mixed" else 260
            comparison = compare_observations(first, second, metric="completion_rate", min_views=100,
                                              window_complete=True)
            evidence = {"simulated_evidence": True, "evidence_kind": "simulated_observation_rehearsal",
                        "scenario": scenario, "source_clip_id": clip_id, "source_sha256": expected_sha256,
                        "synthetic_observations": [first, second], "comparison": comparison,
                        "rubric_before": rubric_before, "proposal": proposal,
                        "draft_decision": proposal["status"] if proposal["status"] != "supported_rubric_edit" else comparison["decision"],
                        "assumption": "Synthetic completion rates illustrate a hypothetical rubric-guided hook repair. "
                        "The revised MP4 is real; its audience outcome is unknown until actual publication and measurement."}
            slots = []
            if comparison["decision"] == "test" and proposal["status"] == "supported_rubric_edit":
                body = self._body(clip, snapshot, variable="hooks", value=[proposal["after"]],
                    reason=proposal["reason"] + " Synthetic engagement supports a test; real audience outcome unknown.")
                slots.append((clip, body))
            return evidence, slots

    def rehearsal_preview(self, profile_id, *, request_id, clip_id, expected_strategy_version_id,
                          expected_sha256, scenario="mixed"):
        del request_id  # A preview neither reserves an ID nor accepts a render request.
        evidence, slots = self._prepare_rehearsal(profile_id, clip_id=clip_id,
            expected_strategy_version_id=expected_strategy_version_id, expected_sha256=expected_sha256,
            scenario=scenario)
        return {**evidence, "profile_id": profile_id, "clip_id": clip_id,
                "expected_sha256": expected_sha256, "expected_strategy_version_id": expected_strategy_version_id,
                "decision": evidence["draft_decision"], "can_render": bool(slots),
                "persisted": False, "actual_render": False, "publication_permission": False}

    def rehearse(self, profile_id, *, request_id, clip_id, expected_strategy_version_id,
                 expected_sha256, scenario="mixed"):
        """Explicitly render a supported rubric edit only when synthetic evidence favors a test."""
        payload = {"kind": "rehearsal", "clip_id": clip_id, "sha256": expected_sha256,
                   "scenario": scenario, "rule_id": expected_strategy_version_id}
        with self.store.lock:
            existing = self._existing(profile_id, request_id, payload)
            if existing:
                return existing
            evidence, slots = self._prepare_rehearsal(profile_id, clip_id=clip_id,
                expected_strategy_version_id=expected_strategy_version_id, expected_sha256=expected_sha256,
                scenario=scenario)
            return self._request(profile_id, request_id, payload, slots, kind="rehearsal",
                                 rule_id=expected_strategy_version_id, evidence=evidence)

    def demo_recut(self, profile_id, *, request_id, clip_id, hook, payoff_start, payoff_end, rule):
        """Learning-loop demo: one real, unapproved hook re-edit backed by SIMULATED evidence only.

        The clip opens on a sentence it already contains (hook-first teaser of that span) under a
        title card with that line; everything else keeps the parent's rendered treatment.
        """
        payload = {"kind": "demo_loop_hook", "clip_id": clip_id, "hook": hook,
                   "payoff": [payoff_start, payoff_end]}
        with self.store.lock:
            existing = self._existing(profile_id, request_id, payload)
            if existing:
                return existing
            profile = self.campaigns.require("profiles", profile_id)
            version_id = profile.get("active_strategy_id")
            if not version_id:
                raise HTTPException(409, "Approve this brand's Style rules once before running the demo re-edit.")
            clip = self._parent(profile_id, clip_id)
            plan = clip["edit_plan"]
            if not plan["start"] + craft.SETUP_MIN <= payoff_start < payoff_end <= plan["end"]:
                raise HTTPException(422, "The new opening line must be spoken inside this clip, after its setup.")
            snapshot = self.campaigns.snapshot(clip["campaign_id"], profile_id, clip["video_id"], version_id)
            body = self._body(clip, snapshot, variable="hooks", value=[hook],
                              reason=f"Learning-loop demo (simulated results): {rule}.")
            body = Production.model_validate({
                **body.model_dump(), "structure": "hook_first", "payoff_start": payoff_start,
                "payoff_end": payoff_end, "hook_format": "title_card", "changed_variable": "hook"})
            evidence = {"simulated_evidence": True, "evidence_kind": "simulated_observation_rehearsal",
                        "source_clip_id": clip_id, "source_sha256": clip["sha256"],
                        "comparison": {"status": "simulated", "decision": "test", "metric": "hold_3s"},
                        "proposal": {"status": "learning_demo", "variable": "hook",
                                     "before": plan.get("hook"), "after": hook, "reason": rule,
                                     "next_test": "jump_cuts"}}
            return self._request(profile_id, request_id, payload, [(clip, body)], kind="demo_loop",
                                 rule_id=version_id, evidence=evidence)

    def reconcile(self, identifier):
        with self.store.lock:
            receipt = self.campaigns.require("growth_loops", identifier)
            outputs = {c.get("growth_loop_slot_id"): c for c in self.store.all("clips")
                       if c.get("growth_loop_id") == identifier and c.get("profile_id") == receipt["profile_id"]}
            for slot in receipt["slots"]:
                output = outputs.get(slot["id"])
                if output and output.get("parent_clip_id") != slot["parent_clip_id"]:
                    output = None
                if output:
                    slot.update(status="completed", clip_id=output["id"], sha256=output.get("sha256"),
                                approved=bool(output.get("approved")), actual_plan=output.get("edit_plan"))
                elif not slot.get("job_id") and slot["status"] in {"unknown", "submitting"}:
                    matches = [j for j in self.store.all("jobs")
                               if j.get("context", {}).get("experiment_id") == slot["id"]]
                    if len(matches) == 1:
                        slot.update(job_id=matches[0]["id"], status=matches[0]["status"])
                if not output and slot.get("job_id"):
                    job = self.store.get("jobs", slot["job_id"])
                    if job:
                        slot["status"] = job["status"] if job["status"] != "completed" else "unknown"
                slot["outcomes"] = self.slot_outcomes(receipt["profile_id"], slot)
            statuses = {s["status"] for s in receipt["slots"]}
            receipt["status"] = "no_draft" if not statuses else "completed" if statuses == {"completed"} else (
                "held" if statuses & {"unknown", "failed", "cancelled", "submitting", "held"} else "running")
            return self.store.put("growth_loops", receipt)

    def slot_outcomes(self, profile_id, slot):
        """Read exact real publication/snapshot mappings without collecting or changing strategy.

        A cumulative provider snapshot is measured through its actual ``window_end``.
        Collection time and demo_override.real_elapsed_hours never stand in for that age.
        Only a declared equal-age window (one-second timestamp tolerance) can be compared.
        """
        metric = (slot.get("measurement") or {}).get("metric")
        minimum = (slot.get("measurement") or {}).get("minimum_views", 100)
        current_time = datetime.now(UTC)
        policies = {p["id"]: p for p in self.store.all("learning_policies")}
        snapshots = self.store.all("learning_snapshots")
        has_demo_override = False

        def side(clip_id, checksum):
            nonlocal has_demo_override
            result = {"clip_id": clip_id, "publications": [], "selected": None}
            if not clip_id or not checksum:
                return result
            for publication in self.store.all("learning_publications"):
                if publication.get("clip_id") != clip_id:
                    continue
                policy = policies.get(publication.get("policy_id")) or {}
                if (publication.get("sha256") != checksum or policy.get("profile_id") != profile_id
                    or policy.get("campaign_id") != slot["campaign_id"]
                    or publication.get("account_id") != policy.get("account_id")):
                    continue
                published = _timestamp(publication.get("published_at"))
                item = {"publication_id": publication["id"], "policy_id": policy["id"],
                        "account_id": publication.get("account_id"), "media_id": publication.get("media_id"),
                        "published_at": publication.get("published_at"), "sha256": publication.get("sha256"),
                        "declared_window_days": policy.get("cadence_days"), "snapshots": []}
                for snapshot in snapshots:
                    if snapshot.get("publication_id") != publication["id"]:
                        continue
                    # Never infer identity from a current login or a coincidentally equal clip name.
                    if (snapshot.get("policy_id") != policy["id"] or snapshot.get("clip_id") != clip_id
                        or snapshot.get("profile_id") != profile_id or snapshot.get("campaign_id") != slot["campaign_id"]
                        or snapshot.get("account_id") != publication.get("account_id")
                        or snapshot.get("media_id") != publication.get("media_id")):
                        continue
                    start = _timestamp(snapshot.get("window_start"))
                    end = _timestamp(snapshot.get("window_end"))
                    collected = _timestamp(snapshot.get("collected_at"))
                    valid = bool(published and start and end and collected
                                 and published <= current_time and start == published
                                 and start < end <= collected <= current_time
                                 and snapshot.get("cumulative") is True)
                    simulated = bool(publication.get("simulated") or policy.get("simulated") or snapshot.get("simulated"))
                    override = snapshot.get("trigger") == "demo_override"
                    has_demo_override = has_demo_override or override
                    entry = {"snapshot_id": snapshot["id"], "publication_id": publication["id"],
                             "profile_id": profile_id, "account_id": publication.get("account_id"),
                             "window_start": snapshot.get("window_start"), "window_end": snapshot.get("window_end"),
                             "collected_at": snapshot.get("collected_at"), "source": snapshot.get("source"),
                             "metrics": deepcopy(snapshot.get("metrics") or {}),
                             "units": deepcopy(snapshot.get("units") or {}),
                             "simulated": simulated, "trigger": snapshot.get("trigger", "schedule"),
                             "label": "synthetic" if simulated else "demo_override" if override else "real_observations",
                             "actual_elapsed_hours": round((end - published).total_seconds() / 3600, 6)
                             if valid else None, "valid_window": valid}
                    item["snapshots"].append(entry)
                result["publications"].append(item)
            return result

        parent = side(slot["parent_clip_id"], slot["parent_sha256"])
        variant = side(slot.get("clip_id"), slot.get("sha256"))
        result = {"status": "awaiting_publication", "metric": metric, "minimum_views": minimum,
                  "label": "demo_override" if has_demo_override else "pending", "parent": parent,
                  "variant": variant, "comparison": None, "evidence_ids": [], "caveat": OBSERVATIONAL}

        def abstain(status, reason):
            result["status"] = status
            result["comparison"] = {"status": "insufficient_evidence", "metric": metric,
                                    "before_value": None, "after_value": None, "difference": None,
                                    "decision": "wait", "reasons": [reason], "evidence_kind": "observational",
                                    "simulated": False, "caveat": OBSERVATIONAL}
            return result

        if slot.get("evidence_kind") == "simulated_observation_rehearsal":
            return abstain("awaiting_publication", "The draft was driven by synthetic rehearsal evidence; real outcome remains unknown.")
        if not slot.get("clip_id"):
            return abstain("awaiting_publication", "The revised draft has not completed and been mapped to a publication.")
        if not parent["publications"] or not variant["publications"]:
            return abstain("awaiting_publication", "Map both exact clip revisions to their real published posts before comparing.")
        pairs = [(a, b) for a in parent["publications"] for b in variant["publications"]
                 if a["account_id"] == b["account_id"]]
        if len(pairs) != 1:
            return abstain("incomparable", "Select unambiguous publications from the same explicit Instagram account.")
        first, second = pairs[0]
        days = first["declared_window_days"]
        result["declared_window_days"] = days
        if days not in (3, 6) or days != second["declared_window_days"]:
            return abstain("incomparable", "The publication policies do not declare the same three- or six-day window.")
        target_hours = days * 24

        def eligible(publication):
            return [s for s in publication["snapshots"] if s["valid_window"] and not s["simulated"]
                    and s["trigger"] != "demo_override"]

        first_real, second_real = eligible(first), eligible(second)
        if not first_real or not second_real:
            message = "Both posts need real, scoped metric snapshots; synthetic and demo-override observations are excluded."
            return abstain("awaiting_measurement", message)
        # Never relabel a later cumulative observation as a three-day result.
        def at_window(rows):
            return [s for s in rows if abs(s["actual_elapsed_hours"] - target_hours) <= 1 / 3600]
        first_ready, second_ready = at_window(first_real), at_window(second_real)
        if not first_ready or not second_ready:
            if any(s["actual_elapsed_hours"] < target_hours - 1 / 3600 for s in first_real + second_real):
                return abstain("pending_window", "A real observation was taken before the declared window elapsed.")
            return abstain("incomparable", "Actual cumulative snapshot ages do not match the declared equal-age window.")
        candidates = [(a, b) for a in first_ready for b in second_ready
                      if abs(a["actual_elapsed_hours"] - b["actual_elapsed_hours"]) <= 1 / 3600]
        if not candidates:
            return abstain("incomparable", "The observed parent and variant windows have different actual ages.")
        a, b = max(candidates, key=lambda pair: (pair[0]["collected_at"], pair[1]["collected_at"],
                                               pair[0]["snapshot_id"], pair[1]["snapshot_id"]))
        parent["selected"], variant["selected"] = a, b
        result.update(label="real_observations", evidence_ids=[a["snapshot_id"], b["snapshot_id"]])
        if metric not in {"views", "engagement_rate", "completion_rate", "click_rate"}:
            return abstain("incomparable", "No supported primary metric was declared for this experiment; inspect metrics separately.")
        a, b = ({**row, "window_days": days} for row in (a, b))
        result.update(status="compared", comparison=compare_observations(a, b, metric=metric,
                      min_views=minimum, window_complete=True))
        return result

    def view(self, profile_id):
        self.campaigns.active_workspace(profile_id)
        return {"profile_id": profile_id, "policy": self.policy(profile_id),
                "taste": preference_model(self.store, profile_id),
                "loops": [self.reconcile(r["id"]) for r in self.store.all("growth_loops")
                          if r.get("profile_id") == profile_id], "caveat": OBSERVATIONAL}

    def after_ranking(self, run_id):
        """Optional, off-by-default top-three experiment dispatch after a completed ranking."""
        clips = [c for c in self.store.all("clips") if c.get("team_run_id") == run_id
                 and not (c.get("rank") or {}).get("below_bar") and (c.get("rank") or {}).get("position")]
        clips.sort(key=lambda c: c["rank"]["position"])
        if not clips:
            return None
        profile_id = clips[0].get("profile_id")
        try:
            if not profile_id or not self.policy(profile_id)["auto_ab"]:
                return None
            ids = [c["id"] for c in clips[:3] if c.get("profile_id") == profile_id]
            return self.start_ab(profile_id, request_id=f"auto-ab:{run_id}", clip_ids=ids,
                                 expected_strategy_version_id=clips[0].get("strategy_version_id"))
        except HTTPException as exc:
            self.store.patch("team_runs", run_id, auto_ab={"status": "held", "reason": exc.detail})
            return None
