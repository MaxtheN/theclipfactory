"""Local agents off the Mac: Ollama routing, the hardware check, blockers, pulls and receipts."""

import json
import subprocess
import time
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from fastapi.testclient import TestClient

from clip_factory import llm_provider, local_agents
from clip_factory.app import create_app
from clip_factory.jobs import JobCancelled, WorkError
from clip_factory.local_agents import nvidia_memory_gb as real_nvidia_memory
from clip_factory.local_agents import ollama_binary as real_ollama_binary
from clip_factory.models import Models
from clip_factory.ollama import Ollama, OllamaError

SESSION = "local-agents-session"
KEY = "sk-or-" + "a" * 40
FOUR, TWO = local_agents.CATALOGUE[0], local_agents.CATALOGUE[1]


def server(models=(), *, pull=None, chat=None, seen=None):
    """A fake Ollama: /api/tags lists ``models`` (vision-capable); /api/pull streams ``pull`` events."""
    listed = list(models)

    def handler(request: httpx.Request):
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [
                {"name": name, "size": 3_300_000_000, "digest": name, "details": {}} for name in listed]})
        if request.url.path == "/api/show":
            return httpx.Response(200, json={"capabilities": ["completion", "vision"]})
        if request.url.path == "/api/pull":
            body = json.loads(request.content)
            if seen is not None:
                seen.append(body)
            events = pull if pull is not None else [
                {"status": "pulling manifest"},
                {"status": "pulling a", "digest": "a", "total": 3_000, "completed": 1_500},
                {"status": "pulling a", "digest": "a", "total": 3_000, "completed": 3_000},
                {"status": "success"},
            ]
            if any(event.get("status") == "success" for event in events):
                listed.append(body["model"])
            return httpx.Response(200, content="\n".join(json.dumps(e) for e in events).encode())
        if request.url.path == "/api/chat":
            lines = chat or [{"message": {"content": "hi"}},
                             {"message": {"content": "!"}, "done": True, "prompt_eval_count": 120, "eval_count": 7}]
            return httpx.Response(200, content="\n".join(json.dumps(x) for x in lines).encode())
        return httpx.Response(404)

    return Ollama("http://ollama.test", transport=httpx.MockTransport(handler), cache_seconds=0)


def stopped():
    def refused(request):
        raise httpx.ConnectError("refused", request=request)

    return Ollama("http://ollama.test", transport=httpx.MockTransport(refused), cache_seconds=0)


@pytest.fixture
def ram(monkeypatch):
    def use(gb: float, *, gpu: str | None = None, vram: float | None = None):
        monkeypatch.setattr(local_agents.psutil, "virtual_memory",
                            lambda: SimpleNamespace(total=int(gb * 1e9), available=int(gb * 0.6e9)))
        monkeypatch.setattr(local_agents.speech_backend, "nvidia_gpu", lambda: gpu)
        monkeypatch.setattr(local_agents, "nvidia_memory_gb", lambda: vram)

    return use


# ------------------------------------------------------------------------------- engine and hardware


@pytest.mark.parametrize(("system", "machine", "expected"), [
    ("Darwin", "arm64", "mlx"), ("Windows", "AMD64", "ollama"), ("Linux", "x86_64", "ollama"),
    ("Darwin", "x86_64", "ollama"), ("Linux", "aarch64", "ollama"),
])
def test_agents_run_on_mlx_only_on_apple_silicon(speech_host, system, machine, expected):
    speech_host(system, machine)
    assert local_agents.engine() == expected


@pytest.mark.parametrize(("gb", "vram", "expected", "device"), [
    (32, None, FOUR, "cpu"),
    (16, None, FOUR, "cpu"),
    (11.5, None, FOUR, "cpu"),    # a 12 GB computer reports a little under 12
    (11.3, None, TWO, "cpu"),
    (7.5, None, TWO, "cpu"),      # an 8 GB computer
    (7.3, None, None, None),
    (8, 6, FOUR, "cuda"),         # the 4B model fits on the GPU
    (8, 4, TWO, "cuda"),
    (7.3, 12, None, None),        # below the RAM floor, a big GPU does not help
    (4, None, None, None),
])
def test_model_choice_at_each_memory_boundary(ram, gb, vram, expected, device):
    ram(gb, gpu="RTX" if vram else None, vram=vram)
    hw = local_agents.hardware()
    assert hw["ram_gb"] == round(gb, 1) and hw["vram_gb"] == vram
    assert local_agents.recommend(hw) is expected
    state = local_agents.status(stopped())
    chosen = [item for item in state["catalogue"] if item["recommended"]]
    assert [item["id"] for item in chosen] == ([expected["id"]] if expected else [])
    if expected:
        assert chosen[0]["device"] == device
        assert state["recommended"] == {"text": expected["id"], "vision": expected["id"]}
    else:
        assert state["recommended"] is None


def test_vram_is_read_only_when_an_nvidia_gpu_is_present(ram, monkeypatch):
    ram(16)
    probe = Mock(return_value=12.0)
    monkeypatch.setattr(local_agents, "nvidia_memory_gb", probe)
    assert local_agents.hardware()["gpu"] is None and local_agents.hardware()["vram_gb"] is None
    probe.assert_not_called()


def test_nvidia_memory_is_the_largest_gpu_and_never_raises(monkeypatch):
    real_nvidia_memory.cache_clear()
    monkeypatch.setattr(local_agents.shutil, "which", lambda name: "/usr/bin/nvidia-smi")
    monkeypatch.setattr(local_agents.subprocess, "run",
                        lambda *a, **k: SimpleNamespace(stdout="8192\n12288\nN/A\n"))
    assert real_nvidia_memory() == pytest.approx(12288 * 1024**2 / 1e9)
    real_nvidia_memory.cache_clear()

    def broken(*a, **k):
        raise subprocess.CalledProcessError(9, "nvidia-smi")

    monkeypatch.setattr(local_agents.subprocess, "run", broken)
    assert real_nvidia_memory() is None
    real_nvidia_memory.cache_clear()
    monkeypatch.setattr(local_agents.shutil, "which", lambda name: None)
    assert real_nvidia_memory() is None
    real_nvidia_memory.cache_clear()


def test_ollama_is_found_on_path_or_at_the_windows_install_location(monkeypatch, tmp_path, speech_host):
    monkeypatch.setattr(local_agents.shutil, "which", lambda name: None)
    speech_host("Windows", "AMD64")
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    assert real_ollama_binary() is None
    exe = tmp_path / "Programs" / "Ollama" / "ollama.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"MZ")
    assert real_ollama_binary() == str(exe)
    monkeypatch.setattr(local_agents.shutil, "which", lambda name: "/opt/bin/ollama")
    assert real_ollama_binary() == "/opt/bin/ollama"


# ------------------------------------------------------------------------------------------ blockers


def blocker_for(ollama, installed=()):
    return local_agents.blocker(local_agents.status(ollama), [{"id": f"ollama:{n}"} for n in installed])


def test_too_small_comes_first_and_names_the_alternatives(ram, speech_host, monkeypatch):
    speech_host("Windows", "AMD64")
    ram(6)
    found = blocker_for(stopped())
    assert found["code"] == "agents_hardware" and found["action"] is None and found["scope"] == "agents"
    assert "6 GB" in found["message"] and "OpenRouter key" in found["message"] and "by hand" in found["message"]
    assert found["alternatives"] == ["openrouter_key", "manual"]


def test_missing_then_stopped_then_no_model_then_ready(ram, speech_host, monkeypatch):
    speech_host("Linux", "x86_64")
    ram(16)
    missing = blocker_for(stopped())
    assert missing["code"] == "ollama_missing" and missing["action"] == "check"
    assert missing["install_url"] == "https://ollama.com/download"
    monkeypatch.setattr(local_agents, "ollama_binary", lambda: "/usr/local/bin/ollama")
    assert blocker_for(stopped())["code"] == "ollama_stopped"
    empty = blocker_for(server())
    assert empty["code"] == "agent_model_missing" and empty["action"] == "pull"
    assert empty["model_id"] == FOUR["id"] and empty["download_gb"] == 3.3 and "3.3 GB" in empty["message"]
    assert blocker_for(server([FOUR["tag"]]), [FOUR["tag"]]) is None


def test_a_running_server_counts_as_installed_without_a_binary(ram, speech_host):
    speech_host("Windows", "AMD64")
    ram(16)
    state = local_agents.status(server())
    assert state["ollama"] == {"installed": True, "running": True, "install_url": local_agents.INSTALL_URL}


def test_the_mac_has_no_ollama_blocker(ram, mac_host):
    ram(4)
    assert blocker_for(stopped()) is None


# ------------------------------------------------------------------------------------- cloud routing


def gateway(tmp_path, *, key):
    from clip_factory.store import Store

    gate = llm_provider.LlmGateway(Store(tmp_path))
    if key:
        gate.secrets.set(KEY)
    return gate


def test_agents_never_route_to_cloud_without_a_saved_key_and_the_role_enabled(tmp_path):
    no_key = gateway(tmp_path / "a", key=False)
    no_key.update_settings({"cloud_agents": True})
    assert no_key.route("agents")["provider"] == "local"
    key_only = gateway(tmp_path / "b", key=True)
    assert key_only.route("agents")["provider"] == "local"
    both = gateway(tmp_path / "c", key=True)
    both.update_settings({"cloud_agents": True})
    assert both.route("agents")["provider"] == "openrouter"
    both.update_settings({"provider": "local"})
    assert both.route("agents")["provider"] == "local"


# ----------------------------------------------------------------------------------------- pulls


def test_pull_reports_progress_and_clears_the_listing():
    seen, updates = [], []
    ollama = server(seen=seen)
    assert ollama.model(FOUR["tag"]) is None
    ollama.pull(FOUR["tag"], progress=lambda pct, msg: updates.append((pct, msg)))
    assert seen == [{"model": FOUR["tag"], "stream": True}]
    assert [pct for pct, _ in updates] == [0, 48, 95]
    assert updates[0][1] == "Ollama: pulling manifest"
    assert updates[-1][1] == "Downloading through Ollama (0.0 of 0.0 GB)"
    assert ollama.model(FOUR["tag"]) is not None


@pytest.mark.parametrize(("events", "message"), [
    ([{"error": "pull model manifest: file does not exist"}], "could not download this model"),
    ([{"status": "pulling a", "digest": "a", "total": 10, "completed": 2}], "ended before it finished"),
    ([[1, 2]], "invalid response"),
])
def test_a_failed_pull_is_an_error_not_a_success(events, message):
    with pytest.raises(OllamaError, match=message):
        server(pull=events).pull(FOUR["tag"], progress=lambda *a: None)


def test_pull_is_cancellable_and_refuses_bad_names():
    def cancel():
        raise JobCancelled()

    with pytest.raises(JobCancelled):
        server().pull(FOUR["tag"], progress=lambda *a: None, check=cancel)
    with pytest.raises(OllamaError, match="Invalid"):
        server().pull("../x", progress=lambda *a: None)
    with pytest.raises(OllamaError, match="not running"):
        stopped().pull(FOUR["tag"], progress=lambda *a: None)


def test_pull_job_verifies_the_model_is_listed_after():
    jobs = Mock()
    assert local_agents.pull(server(), jobs, "job", FOUR) == {"model_id": FOUR["id"], "installed": True}
    assert jobs.update.call_args_list[-1].kwargs == {"progress": 100, "message": f"{FOUR['name']} is ready"}
    with pytest.raises(WorkError, match="does not list"):
        never_listed = server(pull=[{"status": "success"}])
        never_listed.pull = lambda *a, **k: None
        local_agents.pull(never_listed, jobs, "job", TWO)
    with pytest.raises(WorkError, match="could not download"):
        local_agents.pull(server(pull=[{"error": "boom"}]), jobs, "job", TWO)


# -------------------------------------------------------------------------------------- receipts


def test_ollama_calls_carry_provider_model_and_tokens(tmp_path):
    models = Models(tmp_path, Mock())
    models.ollama = server([FOUR["tag"]])
    result = models.run("job", FOUR["id"], "generate", prompt="hook")
    assert result["output"] == "hi!"
    receipt = result["llm"]
    assert receipt["provider"] == "ollama" and receipt["model"] == FOUR["id"]
    assert (receipt["prompt_tokens"], receipt["completion_tokens"]) == (120, 7)
    assert receipt["cost_usd"] == 0.0 and receipt["cost_basis"] == "local"
    batch = models.run_batch("job", FOUR["id"], [{"prompt": "a"}, {"prompt": "b"}])
    assert [item["llm"]["provider"] for item in batch] == ["ollama", "ollama"]


def test_the_gateway_names_ollama_on_local_completions(tmp_path):
    gate = gateway(tmp_path, key=False)
    receipt = {"provider": "ollama", "model": FOUR["id"], "prompt_tokens": 5, "completion_tokens": 2,
               "latency_seconds": 1.5}
    done = gate.complete_json("agents", "", "u", local=lambda: {"output": "{}", "llm": receipt})
    assert (done.provider, done.model, done.prompt_tokens, done.completion_tokens) == ("ollama", FOUR["id"], 5, 2)
    assert done.provenance()["cost_usd"] == 0
    assert gate.complete_json("agents", "", "u", local=lambda: {"output": "x"}).provider == "local"
    assert gate.spend()["calls"] == 0  # local calls never count as cloud spend


# ------------------------------------------------------------------------------------------ the app


@pytest.fixture
def client(tmp_path, monkeypatch, ram, speech_host):
    speech_host("Windows", "AMD64")
    ram(16)
    app = create_app(tmp_path, token=SESSION)
    monkeypatch.setattr("clip_factory.models.Models.download", lambda *a, **k: pytest.fail("no downloads"))
    with TestClient(app, base_url="http://127.0.0.1", headers={"X-Clip-Token": SESSION}) as active:
        yield active


def wait_job(client, identifier, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = next((j for j in client.get("/api/jobs").json() if j["id"] == identifier), None)
        if job and job["status"] in {"completed", "failed", "cancelled"}:
            return job
        time.sleep(0.02)
    pytest.fail("Job did not finish")


def test_system_and_factory_report_the_ollama_blocker_before_production(client):
    client.app.state.models.ollama = stopped()
    agents = client.get("/api/system").json()["agents"]
    assert agents["engine"] == "ollama" and agents["cloud"] is False
    assert agents["hardware"]["ram_gb"] == 16 and agents["blocker"]["code"] == "ollama_missing"
    line = client.get("/api/factory").json()
    assert line["ready"] is False and line["model_id"] is None
    assert [b["code"] for b in line["blockers"] if b.get("scope") == "agents"] == ["ollama_missing"]
    assert not any(b["code"] == "model" for b in line["blockers"])  # no Apple Silicon message off the Mac


def test_production_uses_the_installed_ollama_model_and_never_the_mlx_shelf(client, monkeypatch):
    client.app.state.models.ollama = server([TWO["tag"]])
    real_item = client.app.state.models.item
    monkeypatch.setattr(client.app.state.models, "item", lambda i: {**real_item(i), "installed": True}
                        if i == "qwen-small" else real_item(i))
    line = client.get("/api/factory").json()
    assert not any(b.get("scope") == "agents" for b in line["blockers"])
    assert line["model_id"] == TWO["id"]


def test_check_again_finds_ollama_once_it_is_running(client):
    client.app.state.models.ollama = stopped()
    assert client.post("/api/agents/check").json()["blocker"]["code"] == "ollama_missing"
    client.app.state.models.ollama = server()
    assert client.post("/api/agents/check").json()["blocker"]["code"] == "agent_model_missing"


def test_cloud_agents_with_a_saved_key_skip_the_local_check(client):
    client.app.state.models.ollama = stopped()
    llm = client.app.state.llm
    llm.secrets.set(KEY)
    llm._forget_key_state()
    llm.update_settings({"cloud_agents": True})
    agents = client.get("/api/system").json()["agents"]
    assert agents["cloud"] is True and agents["blocker"] is None


def test_pull_endpoint_validates_then_runs_a_download_job(client, monkeypatch):
    client.app.state.models.ollama = stopped()
    assert client.post("/api/agents/ollama/pull", json={"model_id": "ollama:llama3", "accept_license": True}).status_code == 422
    assert client.post("/api/agents/ollama/pull", json={"model_id": FOUR["id"]}).status_code == 422
    assert client.post("/api/agents/ollama/pull", json={"model_id": FOUR["id"], "accept_license": True}).status_code == 409
    client.app.state.models.ollama = server()
    monkeypatch.setattr(local_agents, "ollama_store", lambda: client.app.state.root)
    response = client.post("/api/agents/ollama/pull", json={"model_id": FOUR["id"], "accept_license": True})
    assert response.status_code == 202
    job = response.json()
    assert job["kind"] == "download" and job["context"]["download_gb"] == 3.3
    done = wait_job(client, job["id"])
    assert done["status"] == "completed" and done["result"] == {"model_id": FOUR["id"], "installed": True}
    again = client.post("/api/agents/ollama/pull", json={"model_id": FOUR["id"], "accept_license": True})
    assert again.status_code == 409
    assert client.get("/api/system").json()["agents"]["blocker"] is None


def test_pull_refuses_without_disk_space(client, monkeypatch):
    client.app.state.models.ollama = server()
    monkeypatch.setattr(local_agents, "ollama_store", lambda: client.app.state.root)
    monkeypatch.setattr("clip_factory.app.shutil.disk_usage", lambda path: SimpleNamespace(free=1e9))
    response = client.post("/api/agents/ollama/pull", json={"model_id": TWO["id"], "accept_license": True})
    assert response.status_code == 400 and "disk space" in response.json()["detail"]
