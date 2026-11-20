"""Help: open a page of the user guide in the system browser.

The guide's source is ``docs/guide/*.md``; the website renders it under ``/guide/`` (clean URLs, so
``guide/factory.md`` is served at ``/guide/factory``). The app never builds a URL from free text: the page
must be one of ``PAGES`` and the anchor a plain heading slug. ``GF_GUIDE_URL`` overrides the base, for a
preview deployment or a local copy of the site.
"""

from __future__ import annotations

import logging
import os
import re
from collections.abc import Callable

from fastapi import HTTPException
from pydantic import BaseModel, field_validator

log = logging.getLogger(__name__)

DEFAULT_GUIDE_URL = "https://growth-factory-landing.vercel.app/guide/"
# One entry per docs/guide/*.md file (README.md is the index, ""). tests/test_help_api.py keeps them equal.
PAGES = (
    "",
    "getting-started",
    "factory",
    "factory-map",
    "library",
    "studio",
    "results",
    "references",
    "brand-profile",
    "posting",
    "models",
    "settings-privacy",
    "plans",
)
ANCHOR = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


def guide_base() -> str:
    base = os.environ.get("GF_GUIDE_URL", "").strip() or DEFAULT_GUIDE_URL
    if not re.match(r"https?://", base):
        base = DEFAULT_GUIDE_URL
    return base if base.endswith("/") else base + "/"


def guide_url(page: str = "", anchor: str = "") -> str:
    if page not in PAGES:
        raise ValueError(f"Unknown guide page: {page}")
    if anchor and (len(anchor) > 80 or not ANCHOR.fullmatch(anchor)):
        raise ValueError("Unknown guide section.")
    return guide_base() + page + (f"#{anchor}" if anchor else "")


class HelpRequest(BaseModel):
    page: str = ""
    anchor: str = ""

    @field_validator("page")
    @classmethod
    def known_page(cls, value: str) -> str:
        if value not in PAGES:
            raise ValueError("Unknown guide page.")
        return value

    @field_validator("anchor")
    @classmethod
    def plain_anchor(cls, value: str) -> str:
        if value and (len(value) > 80 or not ANCHOR.fullmatch(value)):
            raise ValueError("Unknown guide section.")
        return value


def install(app, *, open_url: Callable[[str], bool]) -> None:
    @app.get("/api/help")
    def help_pages():
        return {"base_url": guide_base(), "pages": list(PAGES)}

    @app.post("/api/help/open")
    def open_help(body: HelpRequest):
        try:
            url = guide_url(body.page, body.anchor)
        except ValueError as error:  # validated already; kept for direct callers
            raise HTTPException(422, str(error)) from None
        opened = False
        try:
            opened = bool(open_url(url))
        except Exception:  # noqa: BLE001 - the link is returned so the page can offer it instead
            log.warning("Could not open the system browser for the guide.", exc_info=False)
        return {"url": url, "opened": opened}
