"""Read-only paid-experiment preflight; paid writes are deliberately unavailable.

Official existing-post documentation does not establish the exact published-Reel
plus landing-page creative payload needed here. Never create even paused partial
resources until that gap is resolved. Reuses MetaClient IO/keychain integration;
there is no credential storage, alternate HTTP transport, or write retry logic.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import ClassVar

from .meta import MetaClient, MetaError, _id, validate_public_video_url


class AdsClient(MetaClient):
    """Live account discovery, ownership/budget preflight and paid insights only.

    create_experiment, set_status and set_experiment_status always fail closed.
    A successful preflight is NOT launch authorization or spend reservation.
    """

    # Deliberately narrow: only USD minor-unit interpretation is supported.
    CURRENCY_EXPONENTS: ClassVar[dict[str, int]] = {"USD": 2}
    SPEC_FIELDS: ClassVar[set[str]] = {
        "ad_account_id",
        "instagram_account_id",
        "page_id",
        "instagram_media_id",
        "name",
        "destination_url",
        "country",
        "lifetime_budget_minor",
        "duration_days",
    }
    VERIFICATION_GAP = (
        "Paid experiment writes are disabled: official Meta documentation did not verify "
        "the exact creative payload combining an existing published Instagram Reel "
        "(source_instagram_media_id) with a landing-page destination URL, or the "
        "Reels-only OUTCOME_TRAFFIC/LINK_CLICKS placement combination. "
        "No resources were created or changed."
    )

    @staticmethod
    def _ad_account_id(value: str) -> str:
        if not isinstance(value, str):
            raise MetaError("Invalid ad account ID.")
        return f"act_{_id(value.removeprefix('act_'))}"

    @staticmethod
    def _cancel(cancel_check: Callable[[], bool] | None) -> None:
        if cancel_check is not None and cancel_check():
            raise MetaError("Paid experiment preflight cancelled; no writes performed.", code="cancelled")

    def accounts(self) -> list[dict]:
        """Enumerate live /me/adaccounts; return only credential-free allowlisted fields."""
        accounts = []
        for row in self._pages("me/adaccounts", {"fields": "id,name,currency,account_status", "limit": 100}):
            account_id = self._ad_account_id(row.get("id"))
            if (
                not isinstance(row.get("name"), str)
                or not isinstance(row.get("currency"), str)
                or type(row.get("account_status")) is not int
            ):
                raise MetaError("Meta returned incomplete ad account details.")
            accounts.append(
                {
                    "id": account_id,
                    "name": row["name"],
                    "currency": row["currency"],
                    "account_status": row["account_status"],
                }
            )
        return accounts

    def preflight(self, spec: dict, *, cancel_check: Callable[[], bool] | None = None) -> dict:
        """Validate a general-ad candidate via GETs, without reserving budget or creating objects.

        Only US adults, USD integer minor units, and owned published Reels are
        accepted. Currency comes from the live account, never from the caller.
        No eligibility claim for music, interactive elements or regulated ads.
        """
        if not isinstance(spec, dict) or set(spec) != self.SPEC_FIELDS:
            raise MetaError("Provide exactly the documented general-ad experiment fields; no overrides.")
        ad_account_id = self._ad_account_id(spec["ad_account_id"])
        ig_id = _id(spec["instagram_account_id"])
        page_id = _id(spec["page_id"])
        media_id = _id(spec["instagram_media_id"])
        name = spec["name"]
        if not isinstance(name, str) or not name.strip() or len(name) > 200 or any(ord(c) < 32 for c in name):
            raise MetaError("Experiment name must be nonempty text of at most 200 characters.")
        try:
            validate_public_video_url(spec["destination_url"])
        except MetaError:
            raise MetaError(
                "Destination must be a public HTTPS URL without credentials or fragment."
            ) from None
        if spec["country"] != "US":
            raise MetaError("Only US adult general-ad targeting is supported.")
        budget, days = spec["lifetime_budget_minor"], spec["duration_days"]
        if type(budget) is not int or not 1 <= budget <= 2**31 - 1:
            raise MetaError("Lifetime budget must be a positive integer in known currency minor units.")
        if type(days) is not int or not 1 <= days <= 90:
            raise MetaError("Duration must be an integer from 1 to 90 days.")
        self._cancel(cancel_check)
        account = next((row for row in self.accounts() if row["id"] == ad_account_id), None)
        if account is None:
            raise MetaError("Ad account is not accessible with this token.", code="ownership")
        if account["account_status"] != 1:
            raise MetaError("Ad account is not active; preflight refused.")
        exponent = self.CURRENCY_EXPONENTS.get(account["currency"])
        if exponent is None:
            raise MetaError("Unsupported live ad account currency; only USD minor units are validated.")
        self._cancel(cancel_check)
        # _account_token revalidates /me/accounts and obtains the linked Page token.
        token = self._account_token(ig_id)
        if self._accounts[ig_id][0]["page_id"] != page_id:
            raise MetaError("Page does not own the selected linked Instagram account.", code="ownership")
        self._cancel(cancel_check)
        media = None
        for row in self._pages(
            f"{ig_id}/media", {"fields": "id,media_type,media_product_type", "limit": 100}, token=token
        ):
            self._cancel(cancel_check)
            if row.get("id") == media_id:
                media = row
                break
        if media is None:
            raise MetaError("Published media not found on the selected Instagram account.", code="ownership")
        if media.get("media_type") != "VIDEO" or media.get("media_product_type") != "REELS":
            raise MetaError("Selected published media is not an Instagram Reel.")
        return {
            "stage": "preflight_only",
            "can_create": False,
            "can_activate": False,
            "verification_gap": self.VERIFICATION_GAP,
            "spec": {**spec, "ad_account_id": ad_account_id},
            "currency": account["currency"],
            "currency_exponent": exponent,
            # Intent only, not a verified Meta write payload.
            "intended_constraints": {
                "objective": "OUTCOME_TRAFFIC",
                "special_ad_categories": [],
                "billing_event": "IMPRESSIONS",
                "optimization_goal": "LINK_CLICKS",
                "country": "US",
                "age_min": 18,
                "placement": "instagram_reels_only",
                "initial_status": "PAUSED",
                "lifetime_budget_minor": budget,
            },
        }

    def create_experiment(
        self,
        spec: dict,
        persist: Callable[[dict], None],
        *,
        cancel_check: Callable[[], bool] | None = None,
    ) -> dict:
        """Preflight then refuse creation. No writes means no persistence callback."""
        if not callable(persist):
            raise MetaError("A durable persistence callback is required for experiment creation.")
        self.preflight(spec, cancel_check=cancel_check)
        raise MetaError(self.VERIFICATION_GAP, code="paid_creative_unverified")

    def set_status(self, campaign_id: str, status: str) -> dict:
        """Unavailable: a campaign ID alone cannot prove experiment ownership or budget consent."""
        _id(campaign_id)
        self._validate_status(status)
        raise MetaError(
            "Campaign-only status changes are disabled; use a verified experiment record. "
            + self.VERIFICATION_GAP,
            code="paid_creative_unverified",
        )

    @staticmethod
    def _validate_status(status: str) -> None:
        if status not in ("ACTIVE", "PAUSED"):
            raise MetaError("Status must be ACTIVE or PAUSED.")

    def set_experiment_status(
        self,
        record: dict,
        status: str,
        *,
        persist: Callable[[dict], None] | None = None,
        cancel_check: Callable[[], bool] | None = None,
    ) -> dict:
        """Unavailable for both activation and pause; never trust caller-supplied object IDs.

        Existing external campaigns must be managed in Meta Ads Manager. This
        adapter does not pretend to perform a remote pause it cannot safely verify.
        """
        self._validate_status(status)
        self._cancel(cancel_check)
        raise MetaError(self.VERIFICATION_GAP, code="paid_creative_unverified")

    def insights(self, ad_account_id: str) -> list[dict]:
        """Real ad-level daily last-30-day insights, after live account access discovery."""
        account_id = self._ad_account_id(ad_account_id)
        if not any(account["id"] == account_id for account in self.accounts()):
            raise MetaError("Ad account is not accessible with this token.", code="ownership")
        return self.fetch_paid_insights(account_id)
