"""Help entry: allowlisted user-guide pages opened in the browser, and the guide's own links."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from clip_factory import autonomy_runtime, help_api
from clip_factory.app import create_app

GUIDE = Path(__file__).resolve().parents[1] / "docs" / "guide"
SESSION = "help-session-token"


def client(opened: list[str], result=True) -> TestClient:
    app = FastAPI()

    def open_url(url: str):
        opened.append(url)
        if isinstance(result, Exception):
            raise result
        return result

    help_api.install(app, open_url=open_url)
    return TestClient(app)


def test_pages_match_the_guide_files():
    files = {p.stem for p in GUIDE.glob("*.md") if p.name != "README.md"}
    assert set(help_api.PAGES) == files | {""}
    assert len(help_api.PAGES) == len(set(help_api.PAGES))


def test_frontend_guide_pages_and_url_match_the_engine():
    source = (GUIDE.parents[1] / "frontend" / "src" / "growth" / "guideLinks.ts").read_text()
    union = source.split("export type GuidePage =", 1)[1].split(";", 1)[0]
    assert re.findall(r'"([^"]*)"', union) == list(help_api.PAGES)
    assert f'GUIDE_URL = "{help_api.DEFAULT_GUIDE_URL}"' in source


def test_guide_url_uses_the_default_base_and_clean_urls(monkeypatch):
    monkeypatch.delenv("GF_GUIDE_URL", raising=False)
    assert help_api.guide_url() == "https://growth-factory-landing.vercel.app/guide/"
    assert help_api.guide_url("posting", "missed-schedules") == (
        "https://growth-factory-landing.vercel.app/guide/posting#missed-schedules")


@pytest.mark.parametrize("value, base", [
    ("http://localhost:4173/guide", "http://localhost:4173/guide/"),
    ("https://preview.example.com/guide/", "https://preview.example.com/guide/"),
    ("javascript:alert(1)", help_api.DEFAULT_GUIDE_URL),
    ("   ", help_api.DEFAULT_GUIDE_URL),
])
def test_guide_base_override(monkeypatch, value, base):
    monkeypatch.setenv("GF_GUIDE_URL", value)
    assert help_api.guide_base() == base


@pytest.mark.parametrize("page, anchor", [("../etc", ""), ("https://evil", ""), ("factory", "a b"),
                                          ("factory", "x" * 81), ("factory", "#top"), ("Factory", "")])
def test_guide_url_refuses_anything_outside_the_allowlist(page, anchor):
    with pytest.raises(ValueError):
        help_api.guide_url(page, anchor)


def test_open_route_opens_the_page_and_returns_the_link(monkeypatch):
    monkeypatch.delenv("GF_GUIDE_URL", raising=False)
    opened: list[str] = []
    api = client(opened)
    body = api.post("/api/help/open", json={"page": "results", "anchor": "what-results-can-and-cannot-prove"}).json()
    assert body == {"url": help_api.DEFAULT_GUIDE_URL + "results#what-results-can-and-cannot-prove", "opened": True}
    assert opened == [body["url"]]
    assert api.post("/api/help/open", json={}).json()["url"] == help_api.DEFAULT_GUIDE_URL
    assert api.get("/api/help").json() == {"base_url": help_api.DEFAULT_GUIDE_URL, "pages": list(help_api.PAGES)}


def test_open_route_refuses_unknown_pages_without_opening_anything():
    opened: list[str] = []
    api = client(opened)
    assert api.post("/api/help/open", json={"page": "../../secrets"}).status_code == 422
    assert api.post("/api/help/open", json={"page": "factory", "anchor": "<script>"}).status_code == 422
    assert opened == []


@pytest.mark.parametrize("result", [False, OSError("no browser")])
def test_a_browser_that_does_not_open_still_returns_the_link(result):
    body = client([], result).post("/api/help/open", json={"page": "models"}).json()
    assert body["opened"] is False and body["url"].endswith("/guide/models")


def test_the_app_serves_help_behind_the_session(tmp_path, monkeypatch):
    monkeypatch.delenv("GF_GUIDE_URL", raising=False)
    opened: list[str] = []
    monkeypatch.setattr(autonomy_runtime.webbrowser, "open", lambda url, new=0: opened.append(url) or True)
    with TestClient(create_app(tmp_path, token=SESSION), base_url="http://127.0.0.1",
                    headers={"X-Clip-Token": SESSION}) as api:
        assert api.post("/api/help/open", json={"page": "getting-started"}).json() == {
            "url": help_api.DEFAULT_GUIDE_URL + "getting-started", "opened": True}
    assert opened == [help_api.DEFAULT_GUIDE_URL + "getting-started"]
    with TestClient(create_app(tmp_path / "b", token=SESSION), base_url="http://127.0.0.1") as anonymous:
        assert anonymous.post("/api/help/open", json={}).status_code in (401, 403)


def slug(heading: str) -> str:
    """GitHub-style heading anchor (the website renderer uses the same rule)."""
    text = re.sub(r"[^\w\s-]", "", heading.strip().lower())
    return re.sub(r"\s", "-", text)


def anchors(path: Path) -> set[str]:
    return {slug(m.group(1)) for m in re.finditer(r"^#{1,6}\s+(.+)$", path.read_text(), re.MULTILINE)}


def test_every_link_inside_the_guide_resolves():
    broken = []
    for page in GUIDE.glob("*.md"):
        for target in re.findall(r"\]\(([^)\s]+)\)", page.read_text()):
            if re.match(r"(https?|mailto):", target):
                continue
            name, _, anchor = target.partition("#")
            linked = GUIDE / name if name else page
            if not linked.is_file() or (anchor and anchor not in anchors(linked)):
                broken.append(f"{page.name} -> {target}")
    assert broken == []


def test_the_guide_covers_the_promised_explanations():
    text = {p.stem: p.read_text() for p in GUIDE.glob("*.md")}
    assert "One heavy worker" in text["factory"] and "interrupted" in text["factory"]
    assert "never sent late on its own" in text["posting"] and "overdue" in text["posting"]
    assert "Raw video and audio are never sent" in text["models"]
    assert "Observational, not causal" in text["results"] and "matched baseline" in text["results"]
    assert "kept as notes only" in text["references"]
    assert "jamesbodebiyi@gmail.com" in text["README"]
