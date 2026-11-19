import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from clip_factory import craft, extensions
from clip_factory import factory_builder as fb
from clip_factory.extensions import Registry, base, static_check
from clip_factory.factory_builder_api import install
from clip_factory.store import Store

PACKAGE = Path(extensions.__file__).resolve().parent
FFMPEG = shutil.which("ffmpeg")

GOOD_MODULE = '''\
"""A thin bar that fills across the frame over the clip."""

from __future__ import annotations

from clip_factory.extensions.base import Fragment, Geometry, Timing, ass_color, dialogue

CAPABILITY = "{cap}"
LABEL = "Progress bar"
DESCRIPTION = "A thin bar that fills left to right over the clip."
PARAMS = {{
    "color": {{"type": "color", "default": "#FFD400"}},
    "height": {{"type": "int", "default": 14, "min": 4, "max": 40}},
    "position": {{"type": "enum", "default": "bottom", "values": ["top", "bottom"]}},
}}
PROVENANCE = "factory_builder:test"


def build(geometry: Geometry, timing: Timing, params: dict) -> Fragment:
    height = params["height"]
    y = geometry.height - height - 24 if params["position"] == "bottom" else 24
    width = geometry.width
    end_ms = round(timing.duration * 1000)
    shape = f"m 0 0 l {{width}} 0 {{width}} {{height}} 0 {{height}}"
    tags = f"{{{{\\\\an7\\\\move(-{{width}},{{y}},0,{{y}},0,{{end_ms}})\\\\bord0\\\\shad0\\\\1c{{ass_color(params['color'])}}\\\\p1}}}}"
    return Fragment(ass_events=(dialogue(0, timing.duration, tags + shape),))
'''

GOOD_TEST = '''\
import pytest

from clip_factory.extensions.base import ExtensionError, Geometry, Timing, check_fragment, validate_params
from clip_factory.extensions.progress_bar import PARAMS, build


@pytest.mark.parametrize("duration", [15.0, 3.0])
def test_default_fragment_is_valid(duration):
    fragment = build(Geometry(), Timing(duration=duration), validate_params(PARAMS, {}))
    assert check_fragment(fragment) == []
    assert len(fragment.ass_events) == 1


def test_out_of_range_height_is_refused():
    with pytest.raises(ExtensionError):
        validate_params(PARAMS, {"height": 400})
'''


def module(cap="progress_bar"):
    return GOOD_MODULE.format(cap=cap)


# ------------------------------------------------------------------------------- static checks


def test_valid_module_passes_static_check():
    assert static_check(module()) == []
    assert static_check(GOOD_TEST, capability="progress_bar", test=True) == []


@pytest.mark.parametrize("snippet, needle", [
    ("import os", "import os"),
    ("import subprocess", "import subprocess"),
    ("from socket import socket", "socket"),
    ("X = open('/etc/passwd').read()", "open"),
    ("X = eval('1')", "eval"),
    ("X = __import__('os')", "__import__"),
    ("X = ().__class__.__mro__", "__class__"),
    ("X = getattr(int, 'real')", "getattr"),
    ("from math import *", "star"),
    ("def spin():\n    while True:\n        pass", "While"),
    ("X = exec", "exec"),
])
def test_static_check_rejects_dangerous_code(snippet, needle):
    problems = static_check(module() + "\n" + snippet + "\n")
    assert problems and any(needle in p for p in problems), problems


def test_static_check_requires_the_interface_and_limits_size():
    assert any("build" in p for p in static_check('CAPABILITY = "x"\n'))
    assert any("larger" in p for p in static_check(module() + "#" * 30_000))
    assert any("import pytest" in p for p in static_check("import pytest\n" + module()))  # tests only


def test_fragment_check_refuses_files_graphs_and_unknown_filters():
    ok = base.Fragment(video_filters=("drawbox=x=0:y=1900:w=iw/2:h=12:color=0xFFD400@1:t=fill",))
    assert base.check_fragment(ok) == []
    for bad in ("movie=evil.png", "subtitles=x.ass", "drawbox=x=0[out];[out]null", "curves=psfile=a.acv",
                "drawtext=textfile=/etc/passwd"):
        assert base.check_fragment(base.Fragment(video_filters=(bad,))), bad
    assert base.check_fragment(base.Fragment(ass_events=("Style: injected",)))
    assert base.check_fragment("not a fragment")


# ------------------------------------------------------------------------------------ registry


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True)


def init_repo(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    git(path, "init", "-q", "-b", "feature")
    git(path, "config", "user.email", "t@example.invalid")
    git(path, "config", "user.name", "t")
    return path


def test_registry_loads_only_committed_unmodified_modules(tmp_path):
    repo = init_repo(tmp_path / "repo")
    ext = repo / "ext"
    ext.mkdir()
    (ext / "zz_merged_bar.py").write_text(module("zz_merged_bar"))
    (ext / "zz_edited_bar.py").write_text(module("zz_edited_bar"))
    (ext / "zz_unsafe_bar.py").write_text(module("zz_unsafe_bar") + "import os\n")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "seed")
    (ext / "zz_edited_bar.py").write_text(module("zz_edited_bar") + "\n# local edit\n")
    (ext / "zz_branch_bar.py").write_text(module("zz_branch_bar"))  # e.g. copied from an unmerged branch
    try:
        reg = Registry(ext)
        assert set(reg.extensions) == {"zz_merged_bar"}
        assert "Not merged" in reg.skipped["zz_edited_bar"] and "Not merged" in reg.skipped["zz_branch_bar"]
        assert "Static check failed" in reg.errors["zz_unsafe_bar"]
        out = extensions.apply({"zz_merged_bar": {"height": 10}}, duration=8.0, reg=reg)
        assert out["applied"][0]["params"] == {"color": "#FFD400", "height": 10, "position": "bottom"}
        assert "[Events]" in out["ass"] and "\\move(-1080,1886,0,1886,0,8000)" in out["ass"]
        with pytest.raises(base.ExtensionError):
            extensions.validate_selection({"zz_branch_bar": {}}, reg)
        with pytest.raises(base.ExtensionError):
            extensions.validate_selection({"zz_merged_bar": {"height": 99}}, reg)
    finally:
        for name in [n for n in sys.modules if n.startswith("clip_factory.extensions.zz_")]:
            sys.modules.pop(name)


def test_app_registry_has_no_builder_code_and_craft_rejects_unmerged_names():
    reg = extensions.registry(reload=True)
    assert all(Path(e.path).parent == PACKAGE for e in reg.extensions.values())
    with pytest.raises(ValidationError):
        craft.CraftOptions(extensions={"progress_bar_from_some_branch": {}})
    assert craft.CraftOptions().extensions == {}
    assert craft.LEGACY_PLAN["extensions"] == {}


# ---------------------------------------------------------------------------- work order + git


@pytest.fixture
def repo(tmp_path):
    """A tiny checkout with the real extension contract, so builds run ruff/pytest/FFmpeg for real."""
    root = init_repo(tmp_path / "checkout")
    (root / "clip_factory" / "extensions").mkdir(parents=True)
    (root / "tests").mkdir()
    (root / "clip_factory" / "__init__.py").write_text('"""Test package."""\n')
    for name in ("__init__.py", "base.py"):
        shutil.copyfile(PACKAGE / name, root / "clip_factory" / "extensions" / name)
    (root / "pyproject.toml").write_text("[tool.ruff]\nline-length = 110\n")
    git(root, "add", ".")
    git(root, "commit", "-qm", "base")
    return root


@pytest.fixture
def builder(repo, tmp_path, monkeypatch):
    monkeypatch.setattr(fb, "gh_status", lambda runner: {"available": False, "authenticated": False,
                                                        "reason": "GitHub CLI (gh) is not installed."})
    store = Store(tmp_path / "data")
    return fb.FactoryBuilder(store, tmp_path / "data", repo=repo, ffmpeg=lambda: FFMPEG,
                             runner=lambda *a, **k: pytest.fail("no external command may run here"))


def test_work_order_has_interface_tests_and_constraints(builder):
    builder.requests.demo()
    record = builder.write_work_order("cap_progress_bar")
    order = record["work_order"]
    assert record["status"] == "work_order"
    assert order["title"].startswith("Renderer extension: progress bar")
    assert "def build(geometry: Geometry, timing: Timing, params: dict) -> Fragment" in order["interface"]
    assert any("FFmpeg render assertion" in t for t in order["acceptance_tests"])
    joined = " ".join(order["constraints"])
    for phrase in ("No network", "no new dependencies", "FFmpeg 4.4", "off by default", "factory_builder:cap_progress_bar",
                   "never main or master"):
        assert phrase in joined
    assert "**Demo request**" in order["markdown"] and "`demo`" in order["markdown"]


def test_worktree_create_and_discard(repo, tmp_path):
    trees = fb.Worktrees(repo, tmp_path / "data" / "work")
    tree = trees.create("progress_bar", "abc12345")
    assert tree["branch"] == "factory/upgrade-progress-bar-abc12345" and tree["base_branch"] == "feature"
    assert Path(tree["path"], "clip_factory", "extensions", "base.py").is_file()
    assert git(repo, "branch", "--list", tree["branch"]).stdout.strip()
    with pytest.raises(fb.BuilderError):
        trees.discard(str(repo), None)  # never outside work/factory
    assert trees.discard(tree["path"], tree["branch"]) == {"worktree": True, "branch": True}
    assert not Path(tree["path"]).exists()
    assert not git(repo, "branch", "--list", tree["branch"]).stdout.strip()


class FakeModel:
    provider, model = "openrouter", "anthropic/claude-sonnet-5.5"

    def __init__(self, replies):
        self.replies, self.prompts = list(replies), []

    def generate(self, system, user, schema):
        self.prompts.append(user)
        return self.replies.pop(0), {"provider": self.provider, "model": self.model, "prompt_tokens": 1000,
                                     "completion_tokens": 500, "cost_usd": 0.0125, "cost_basis": "openrouter_reported"}


def reply(module_source, test_source=GOOD_TEST):
    return json.dumps({"module_source": module_source, "test_source": test_source, "summary": "Adds a progress bar."})


def run_build(builder, model):
    builder.model_factory = lambda job_id: model
    builder.requests.demo()
    build = builder.start("cap_progress_bar", lambda work: {"id": "job1", "work": work})
    assert builder.requests.get("cap_progress_bar")["status"] == "building"
    return builder.run(build["id"], "job1")


@pytest.mark.skipif(not FFMPEG, reason="FFmpeg is needed for the sample render")
def test_builder_repairs_invalid_code_then_commits_a_reviewable_branch(builder, repo):
    model = FakeModel([reply(module() + "import os\n"), "not json at all", reply(module())])
    result = run_build(builder, model)
    assert result["status"] == "ready_for_review", result.get("attempts")
    assert [a["ok"] for a in result["attempts"]] == [False, False, True]
    assert "import os is not allowed" in model.prompts[1] and "PREVIOUS module_source" in model.prompts[1]
    assert result["usage"]["calls"] == 3 and result["usage"]["cost_usd"] == pytest.approx(0.0375)
    assert "+CAPABILITY = \"progress_bar\"" in result["diff"] and "tests/extensions/test_progress_bar.py" in result["diff"]
    assert Path(result["sample_path"]).is_file() and result["render_check"]["ok"] is True
    assert "3 passed" in result["test_log"]
    log = git(Path(result["worktree"]), "log", "-1", "--format=%B").stdout
    assert "Factory-Builder-Request: cap_progress_bar" in log
    # The receipt says how the checks were isolated, on the build and in the commit.
    assert result["isolation"] == fb.receipt(fb.isolation_mode())
    assert f"Check isolation: {result['isolation']['label']}." in log
    # The working checkout is untouched: the extension exists only on the factory branch.
    assert not (repo / "clip_factory" / "extensions" / "progress_bar.py").exists()
    assert builder.requests.get("cap_progress_bar")["status"] == "ready_for_review"
    builder.discard(result["id"])
    assert builder.requests.get("cap_progress_bar")["status"] == "work_order"
    assert not git(repo, "branch", "--list", result["branch"]).stdout.strip()


def test_builder_gives_up_after_two_repairs(builder):
    bad = reply(module() + "X = eval('1')\n")
    result = run_build(builder, FakeModel([bad, bad, bad]))
    assert result["status"] == "failed" and len(result["attempts"]) == 3
    assert "repair rounds" in result["error"]
    assert builder.requests.get("cap_progress_bar")["status"] == "work_order"
    assert not Path(result["worktree"], "clip_factory", "extensions", "progress_bar.py").exists()


def test_unbuildable_capability_is_refused(builder):
    builder.requests.add_evidence("background_music_bed", [{"source": "feedback", "id": "f", "quote": "add music"}])
    with pytest.raises(fb.BuilderError, match="audio"):
        builder.start("cap_background_music_bed", lambda work: {"id": "j"})


# ------------------------------------------------------------------------- push / PR / issue


def ready_build(builder, base_branch="feature"):
    builder.requests.demo()
    builder.write_work_order("cap_progress_bar")
    builder.requests.transition("cap_progress_bar", "building")
    builder.requests.transition("cap_progress_bar", "ready_for_review")
    record = {"id": "fb_1", "request_id": "cap_progress_bar", "capability": "progress_bar", "status": "ready_for_review",
              "branch": "factory/upgrade-progress-bar-1", "worktree": None, "base_branch": base_branch,
              "base_commit": "x", "commit": "abc"}
    return builder.store.put(fb.BUILDS, record)


def test_push_and_issue_never_run_without_explicit_confirmation(builder):
    ready_build(builder)
    with pytest.raises(fb.BuilderError, match="explicit"):
        builder.push_and_open_pr("fb_1", confirm=False)
    with pytest.raises(fb.BuilderError, match="explicit"):
        builder.file_issue("cap_progress_bar", confirm=False)
    with pytest.raises(fb.BuilderError):
        builder.push_and_open_pr("fb_1", confirm="yes")  # only the literal True counts


def test_pr_targets_the_build_base_branch_never_main(builder, monkeypatch):
    ready_build(builder, base_branch="main")
    plan = builder.pr_plan("fb_1")
    assert plan["blocked"] and "never target main" in plan["blocked"]
    builder.store.patch(fb.BUILDS, "fb_1", base_branch="kartik/backend-integration")
    calls, pushes = [], []
    builder.runner = lambda cmd, **kw: (calls.append((cmd, kw)), subprocess.CompletedProcess(
        cmd, 0, "https://github.com/o/r/pull/7\n", ""))[1]
    monkeypatch.setattr(fb, "gh_status", lambda runner: {"available": True, "authenticated": True, "reason": None})
    monkeypatch.setattr(builder, "info", lambda: {"push_remote": "origin", "push_repo": "o/r", "origin_repo": "o/r"})
    monkeypatch.setattr(fb, "git", lambda repo, *args, **kw: pushes.append(args))
    plan = builder.pr_plan("fb_1")
    assert plan["blocked"] is None and plan["commands"][0] == "git push origin factory/upgrade-progress-bar-1"
    result = builder.push_and_open_pr("fb_1", confirm=True)
    assert pushes == [("push", "origin", "factory/upgrade-progress-bar-1:factory/upgrade-progress-bar-1")]
    cmd = calls[0][0]
    assert cmd[1:4] == ["pr", "create", "--draft"]
    assert cmd[cmd.index("--base") + 1] == "kartik/backend-integration"
    assert "Renderer extension: progress bar" in calls[0][1]["input"]
    assert result["pr_url"] == "https://github.com/o/r/pull/7"


def test_issue_without_gh_returns_copyable_markdown(builder, monkeypatch):
    ready_build(builder)
    monkeypatch.setattr(fb, "gh_status", lambda runner: {"available": False, "authenticated": False,
                                                        "reason": "GitHub CLI (gh) is not installed."})
    result = builder.file_issue("cap_progress_bar", confirm=True)
    assert result["filed"] is False and result["markdown"].startswith("# Renderer extension")


# ------------------------------------------------------------------------------------------ API


def test_api_requires_explicit_clicks(builder):
    app = FastAPI()
    install(app, builder)
    client = TestClient(app)
    assert client.get("/api/factory-builder").json()["summary"]["total"] == 0
    assert client.post("/api/factory-builder/demo").status_code == 201
    view = client.get("/api/factory-builder").json()
    assert view["requests"][0]["demo"] is True and view["summary"]["ideas"] == 1
    assert client.post("/api/factory-builder/requests/cap_progress_bar/build", json={}).status_code == 409
    assert client.post("/api/factory-builder/requests/cap_progress_bar/work-order").status_code == 200
    markdown = client.get("/api/factory-builder/requests/cap_progress_bar/work-order.md")
    assert markdown.status_code == 200 and "## Acceptance tests" in markdown.text
    assert client.post("/api/factory-builder/requests/cap_progress_bar/issue", json={}).status_code == 409
    assert client.post("/api/factory-builder/requests/cap_nope/work-order").status_code == 404
    found = client.post("/api/factory-builder/text", json={"id": "clip1", "text": "Give it a split screen"}).json()
    assert found == {"requests": ["cap_split_screen_two_speakers"]}


# ------------------------------------------------------------------------- renderer integration


def test_merged_extension_is_drawn_last_and_recorded_on_the_render(tmp_path, monkeypatch):
    from test_craft import crafted_commands, graph_of

    repo = init_repo(tmp_path / "merged")
    (repo / "zz_render_bar.py").write_text(module("zz_render_bar"))
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "merge")
    try:
        reg = Registry(repo)
        monkeypatch.setattr(extensions, "registry", lambda **_: reg)
        commands, result = crafted_commands(tmp_path, monkeypatch, loudness="off",
                                            extensions={"zz_render_bar": {"height": 8, "position": "top"}})
        graph = graph_of(commands[-1])
        assert graph.index("subtitles=c.hook.ass") < graph.index("subtitles=c.ext.ass")
        applied = result["craft"]["extensions"]
        assert applied == [{"capability": "zz_render_bar", "params": {"color": "#FFD400", "height": 8, "position": "top"},
                            "provenance": "factory_builder:test", "filters": 0, "ass_events": 1}]
        ass = (tmp_path / "out" / "c.ext.ass").read_text()
        assert "\\move(-1080,24,0,24,0," in ass
        # Off by default: the same render without the field draws nothing extra.
        commands, result = crafted_commands(tmp_path, monkeypatch, loudness="off")
        assert "c.ext.ass" not in graph_of(commands[-1]) and "extensions" not in result["craft"]
    finally:
        for name in [n for n in sys.modules if n.startswith("clip_factory.extensions.zz_")]:
            sys.modules.pop(name)


def test_merged_extensions_are_strategist_variables(monkeypatch):
    from clip_factory import strategist

    monkeypatch.setattr(strategist, "EXTENSIONS", ("progress_bar",))
    plan = {"start": 0, "end": 20, "extensions": {"progress_bar": {}}}
    assert strategist.tag_clip({"edit_plan": plan})["ext_progress_bar"] == "on"
    assert strategist.tag_clip({"edit_plan": {"start": 0, "end": 20}})["ext_progress_bar"] == "off"


def test_gateway_builder_model_uses_keychain_client_and_ledger_with_reasoning_on():
    from clip_factory import llm_provider

    sent, ledger = {}, []

    class Client:
        def chat(self, key, body, timeout):
            sent.update(key=key, body=body)
            return {"choices": [{"message": {"content": '{"module_source": "x"}'}}],
                    "usage": {"prompt_tokens": 100, "completion_tokens": 20, "cost": 0.0004}}

    class Gateway:
        secrets = type("S", (), {"get": staticmethod(lambda: "sk-or-test")})()
        client = Client()

        def _record(self, role, model, completion, job_id, latency, error=None):
            ledger.append((role, model, completion.cost_usd if completion else None, error))

    model = fb.GatewayBuilderModel(Gateway(), llm_provider.SONNET, "job1")
    text, usage = model.generate("sys", "user", fb.SCHEMA)
    assert text == '{"module_source": "x"}' and usage["cost_usd"] == 0.0004
    body = sent["body"]
    assert body["model"] == "anthropic/claude-sonnet-5.5" and body["reasoning"] == {"effort": "low"}
    assert body["response_format"]["json_schema"]["schema"] == fb.SCHEMA
    assert ledger == [("factory_builder", "anthropic/claude-sonnet-5.5", 0.0004, None)]


@pytest.mark.parametrize(
    ("platform_name", "bwrap", "works", "mode", "denied"),
    [
        ("linux", "/usr/bin/bwrap", True, "bubblewrap", True),
        ("linux", "/usr/bin/bwrap", False, "environment", False),
        ("linux", None, False, "environment", False),
        ("win32", None, False, "environment", False),
    ],
)
def test_isolation_mode_per_platform(monkeypatch, platform_name, bwrap, works, mode, denied):
    monkeypatch.setattr(fb.shutil, "which", lambda name: bwrap if name == "bwrap" else None)
    monkeypatch.setattr(fb, "_bwrap_works", lambda _: works)
    isolation = fb.isolation_mode(platform_name)
    assert (isolation["mode"], isolation["network_denied"]) == (mode, denied)
    if mode == "bubblewrap":
        assert isolation["prefix"][0] == bwrap and "--unshare-net" in isolation["prefix"]
    else:
        assert isolation["prefix"] == [] and "reduced isolation" in isolation["label"]
    if platform_name == "win32":
        assert "Windows" in isolation["label"]
    elif not works:
        assert ("user namespaces" if bwrap else "install bubblewrap") in isolation["label"]
    assert set(fb.receipt(isolation)) == {"mode", "network_denied", "label"}


def test_sandbox_environment_is_stripped_and_starts_python_on_this_os(tmp_path):
    env = fb.sandbox_env(tmp_path, None)
    path = env["PATH"].split(fb.os.pathsep)
    assert str(Path(sys.executable).parent) in path
    assert env["HTTPS_PROXY"] == "http://127.0.0.1:9" and "OPENROUTER_API_KEY" not in env
    if sys.platform == "win32":
        assert env["SYSTEMROOT"] and env["USERPROFILE"] == str(tmp_path)
    step = fb.run_step([sys.executable, "-c", "import os, random; print(os.environ['HOME'])"], tmp_path, env, 60)
    assert step["ok"], step["output"]
    assert step["sandbox"] == fb.isolation_mode()["label"]


@pytest.mark.skipif(fb.isolation_mode()["mode"] != "bubblewrap", reason="needs a working bwrap (Linux)")
def test_linux_sandbox_denies_network_access(tmp_path):
    probe = ("import socket\n"
             "try:\n    socket.create_connection(('1.1.1.1', 80), timeout=3)\nexcept OSError as e:\n"
             "    print('blocked', e.errno); raise SystemExit(3)\nprint('connected')")
    step = fb.run_step([sys.executable, "-c", probe], tmp_path, fb.sandbox_env(tmp_path, None), 60)
    assert step["code"] == 3 and "blocked" in step["output"], step["output"]
    assert step["sandbox"] == "Bubblewrap (network denied)"
