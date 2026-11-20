"""Optional OpenRouter provider: routing, Keychain handling, errors, parity and accounting (all offline)."""

import contextlib
import json
import logging
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from clip_factory import brand_research as br
from clip_factory import llm_provider as lp
from clip_factory.jobs import WorkError
from clip_factory.store import Store

KEY = "sk-or-v1-" + "a1b2c3d4" * 8


def test_speech_is_a_separate_validated_opt_in(tmp_path, monkeypatch):
    monkeypatch.setattr("clip_factory.cloud_speech.groq_configured", lambda: True)
    gate = gateway(tmp_path)
    assert gate.settings()["speech_provider"] == "local"
    before = gate.settings()
    changed = gate.update_settings({"speech_provider": "groq"})
    assert changed["speech_provider"] == "groq"
    assert changed["model"] == before["model"] and changed["cloud_agents"] == before["cloud_agents"]
    assert gate.view()["groq_configured"] is True
    for bad in (True, "haiku", [], None):
        with pytest.raises(lp.HTTPException) as error:
            gate.update_settings({"speech_provider": bad})
        assert error.value.status_code == 422


class Server:
    """A scripted OpenRouter: each entry is a status code, an exception, or a JSON reply."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        if isinstance(reply, int):
            return httpx.Response(reply, json={"error": {"code": reply, "message": "nope"}})
        return httpx.Response(200, json=reply)

    def bodies(self):
        return [json.loads(r.content) for r in self.requests]


def ok(text, *, cost=0.00042, prompt=1200, completion=300):
    usage = {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion}
    if cost is not None:
        usage["cost"] = cost
    return {"choices": [{"message": {"content": text}, "finish_reason": "stop"}], "usage": usage}


def gateway(tmp_path, server=None, *, key=KEY, jobs=None, **settings):
    store = Store(tmp_path)
    class Own(lp.OpenRouterSecrets):  # each gateway gets its own fake keychain entry
        values: dict

        def _backend(self):
            return self

        def get_password(self, service, account):
            return self.values.get((service, account))

        def set_password(self, service, account, value):
            self.values[(service, account)] = value

        def delete_password(self, service, account):
            self.values.pop((service, account), None)

    secrets = Own()
    secrets.values = {}
    if key:
        secrets.set(key)
    sleeps = []
    client = lp.OpenRouterClient(transport=httpx.MockTransport(server or Server()), sleep=sleeps.append)
    gate = lp.LlmGateway(store, secrets=secrets, client=client, jobs=jobs)
    if settings:
        gate.update_settings(settings)
    gate.sleeps = sleeps
    return gate


# ------------------------------------------------------------------------------------- routing


def test_without_a_key_every_role_stays_local(tmp_path):
    gate = gateway(tmp_path, key=None)
    assert {gate.route(r)["provider"] for r in lp.ROLES} == {"local"}
    assert gate.view()["key"] == {"present": False, "error": None}


def test_with_a_key_light_roles_use_cloud_and_agents_stay_local_until_opted_in(tmp_path):
    gate = gateway(tmp_path)
    routes = {role: gate.route(role)["provider"] for role in lp.ROLES}
    assert routes == {"brand_research": "openrouter", "post_copy": "openrouter", "reference_pattern": "openrouter",
                      "strategist_hypothesis": "openrouter", "learning_analyst": "local", "agents": "local"}
    assert gate.route("brand_research")["model"] == "anthropic/claude-haiku-5.5"
    gate.update_settings({"cloud_agents": True, "model": "anthropic/claude-sonnet-5.5"})
    assert gate.route("agents") == {"provider": "openrouter", "model": "anthropic/claude-sonnet-5.5"}
    assert gate.route("learning_analyst")["provider"] == "openrouter"
    gate.update_settings({"provider": "local"})
    assert {gate.route(r)["provider"] for r in lp.ROLES} == {"local"}


def test_settings_are_validated_and_frames_need_the_agent_toggle(tmp_path):
    gate = gateway(tmp_path)
    for bad in ({"model": "openai/gpt-x"}, {"provider": "mars"}, {"cloud_agents": "yes"}, {"secret": 1}):
        with pytest.raises(Exception) as caught:
            gate.update_settings(bad)
        assert getattr(caught.value, "status_code", None) == 422
    assert gate.update_settings({"cloud_agent_frames": True})["cloud_agent_frames"] is False
    gate.update_settings({"cloud_agents": True, "cloud_agent_frames": True})
    assert gate.cloud_images_allowed()
    saved = gate.store.get(lp.SETTINGS_KIND, lp.SETTINGS_ID)
    assert KEY not in json.dumps(saved)


# ------------------------------------------------------------------------------- the cloud call


def test_cloud_call_sends_bearer_title_schema_and_records_cost_without_the_key(tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    server = Server(ok('```json\n{"a": 1}\n```'))
    gate = gateway(tmp_path, server)
    result = gate.complete_json("brand_research", "", "PROMPT", {"type": "object"}, max_tokens=50, job_id="j1")
    assert result.text == '{"a": 1}' and result.provider == "openrouter"
    assert result.provenance()["cost_usd"] == 0.00042 and result.cost_basis == "openrouter_reported"
    request = server.requests[0]
    assert str(request.url) == "https://openrouter.ai/api/v1/chat/completions"
    assert request.headers["authorization"] == f"Bearer {KEY}" and request.headers["x-title"] == "Growth Factory"
    body = server.bodies()[0]
    assert body["model"] == "anthropic/claude-haiku-5.5" and body["max_tokens"] == 50
    assert body["response_format"]["type"] == "json_schema" and body["messages"][1]["content"] == "PROMPT"
    assert KEY not in json.dumps(body)
    (row,) = gate.store.all(lp.LEDGER_KIND)
    assert row["role"] == "brand_research" and row["prompt_tokens"] == 1200 and row["cost_usd"] == 0.00042
    everything = json.dumps([gate.store.all(k) for k in (lp.LEDGER_KIND, lp.SETTINGS_KIND)])
    assert KEY not in everything and "PROMPT" not in everything
    assert KEY not in caplog.text
    assert gate.view()["spend"] == {"calls": 1, "cost_usd": 0.00042, "prompt_tokens": 1200, "completion_tokens": 300}


def test_cost_is_estimated_from_list_price_when_not_reported(tmp_path):
    gate = gateway(tmp_path, Server(ok("{}", cost=None, prompt=10_000, completion=1_000)))
    result = gate.complete_json("post_copy", "", "x", {"type": "object"})
    assert result.cost_basis == "estimated_from_list_price"
    assert result.cost_usd == pytest.approx((10_000 * 0.10 + 1_000 * 0.50) / 1e6)


@pytest.mark.parametrize("status,kind,phrase", [(401, "auth", "key was rejected"), (403, "auth", "key was rejected"),
                                                (402, "credit", "out of credit")])
def test_rejected_key_or_no_credit_is_plain_and_never_retried(tmp_path, status, kind, phrase):
    server = Server(status)
    gate = gateway(tmp_path, server)
    with pytest.raises(lp.CloudKeyError, match=phrase) as caught:
        gate.complete_json("brand_research", "", "x", None)
    assert caught.value.kind == kind and len(server.requests) == 1 and gate.sleeps == []
    assert KEY not in str(caught.value)


def test_other_4xx_is_never_retried(tmp_path):
    server = Server(429)
    gate = gateway(tmp_path, server)
    with pytest.raises(lp.CloudError, match="rate-limiting"):
        gate.complete_json("brand_research", "", "x", None)
    assert len(server.requests) == 1 and gate.sleeps == []


def test_network_errors_get_two_bounded_retries_with_backoff(tmp_path):
    server = Server(httpx.ConnectError("down"), httpx.ReadTimeout("slow"), httpx.ConnectError("down"))
    gate = gateway(tmp_path, server)
    with pytest.raises(lp.CloudError, match="Couldn't reach OpenRouter") as caught:
        gate.complete_json("brand_research", "", "x", None)
    assert caught.value.kind == "network" and len(server.requests) == 3 and gate.sleeps == [1.5, 3.0]
    assert gate.store.all(lp.LEDGER_KIND)[0]["status"] == "error"


def test_server_error_then_success_recovers(tmp_path):
    server = Server(503, ok("{}"))
    gate = gateway(tmp_path, server)
    assert gate.complete_json("brand_research", "", "x", {"type": "object"}).text == "{}"
    assert len(server.requests) == 2


def test_a_refused_schema_falls_back_to_instructions_once(tmp_path):
    server = Server(400, ok('{"ok": true}'))
    gate = gateway(tmp_path, server)
    assert gate.complete_json("brand_research", "", "x", {"type": "object", "title": "T"}).text == '{"ok": true}'
    first, second = server.bodies()
    assert "response_format" in first and "response_format" not in second
    assert '"title": "T"' in second["messages"][0]["content"]


def test_key_errors_fall_back_to_local_only_when_opted_in(tmp_path):
    calls = []
    local = lambda: calls.append("local") or {"output": "{}"}
    gate = gateway(tmp_path, Server(401, 401))
    with pytest.raises(lp.CloudKeyError):
        gate.complete_json("brand_research", "", "x", None, local=local, admit=list)
    assert calls == []
    gate.update_settings({"fallback_to_local": True})
    held = gateway(tmp_path / "held", Server(401), fallback_to_local=True)
    with pytest.raises(lp.LocalHeld, match="6.0 GiB"):  # the fallback still passes the admission guard
        held.complete_json("brand_research", "", "x", None, local=local, admit=lambda: ["6.0 GiB required"])
    result = gate.complete_json("brand_research", "", "x", None, local=local, admit=list)
    assert result.provider == "local" and calls == ["local"]


def test_local_route_runs_admission_then_the_unchanged_local_path(tmp_path):
    gate = gateway(tmp_path, key=None)
    order = []
    result = gate.complete_json("brand_research", "", "x", None, admit=lambda: order.append("admit") or [],
                                local=lambda: order.append("local") or {"output": "text"})
    assert result.text == "text" and order == ["admit", "local"]
    with pytest.raises(lp.LocalHeld):
        gate.complete_json("brand_research", "", "x", None, admit=lambda: ["held"], local=lambda: pytest.fail())


def test_usage_is_added_to_the_job_ledger(tmp_path):
    from clip_factory.jobs import Jobs

    store = Store(tmp_path)
    jobs = Jobs(store)
    try:
        store.put("jobs", {"id": "job1", "status": "running"})
        gate = gateway(tmp_path, Server(ok("{}"), ok("{}", cost=0.001)), jobs=lambda: jobs)
        gate.store = store
        gate.complete_json("brand_research", "", "x", {"type": "object"}, job_id="job1")
        gate.complete_json("brand_research", "", "x", {"type": "object"}, job_id="job1")
        usage = store.get("jobs", "job1")["llm_usage"]
        assert usage["calls"] == 2 and usage["cost_usd"] == pytest.approx(0.00142)
        assert usage["provider"] == "openrouter" and usage["model"] == "anthropic/claude-haiku-5.5"
    finally:
        jobs.close()


# ----------------------------------------------------------------------- brand research parity


def site():
    from tests.test_brand_research import site as signal_site

    return signal_site()


def good():
    from tests.test_brand_research import good_reply

    return good_reply()


def test_cloud_brand_model_skips_admission_and_keeps_repair_and_abstain(tmp_path):
    from clip_factory.brand_research_api import CloudBrandModel

    gate = gateway(tmp_path, Server(ok("not json"), ok(good())))
    model = CloudBrandModel(gate, "job1")
    assert model.admit() == []
    draft = br.draft_brief(site(), admit=model.admit, generate=model.generate)
    assert draft["brand_name"] == "Signal Hour"
    assert model.usage["calls"] == 2 and model.usage["provider"] == "openrouter"

    gate = gateway(tmp_path / "b", Server(ok("nope"), ok("still nope")))
    model = CloudBrandModel(gate, "job2")
    with pytest.raises(br.Abstain):
        br.draft_brief(site(), admit=model.admit, generate=model.generate)
    unsupported = json.dumps({"brand_name": "Fake Co", "evidence": [
        {"field": "brand_name", "quote": "a sentence that is not on the page", "page_url": ""}]})
    gate = gateway(tmp_path / "c", Server(ok(unsupported), ok(unsupported)))
    model = CloudBrandModel(gate, "job3")
    with pytest.raises(br.Abstain):  # evidence quotes are still verified against the fetched text
        br.draft_brief(site(), admit=model.admit, generate=model.generate)


def test_brand_model_factory_picks_cloud_only_with_a_key(tmp_path):
    from clip_factory.brand_research_api import CloudBrandModel, LocalBrandModel, brand_model

    runtime = SimpleNamespace(store=SimpleNamespace(get=lambda *a: {}), resource_check=lambda *a: None)
    with_key = SimpleNamespace(state=SimpleNamespace(llm=gateway(tmp_path)))
    without = SimpleNamespace(state=SimpleNamespace(llm=gateway(tmp_path / "n", key=None)))
    assert isinstance(brand_model(with_key, runtime, "j"), CloudBrandModel)
    assert isinstance(brand_model(without, runtime, "j"), LocalBrandModel)


def test_brand_research_api_reports_key_errors_and_provenance(tmp_path):
    from clip_factory.brand_research_api import BrandResearchService, CloudBrandModel, install
    from clip_factory.jobs import Jobs
    from tests.test_brand_research import Web, poll

    jobs = Jobs(Store(tmp_path / "jobs"))
    gates = {}
    service = BrandResearchService(lambda: jobs, lambda job_id: CloudBrandModel(gates["now"], job_id),
                                   reader_factory=Web().reader)
    app = FastAPI()
    install(app, service)
    try:
        with TestClient(app) as client:
            gates["now"] = gateway(tmp_path / "a", Server(ok(good())))
            done = poll(client, client.post("/api/brand-research", json={"url": "signal.example.com"}).json()["id"])
            assert done["status"] == "done" and done["draft"]["brand_name"] == "Signal Hour"
            assert done["draft"]["provenance"]["provider"] == "openrouter"
            assert done["draft"]["provenance"]["usage"]["cost_usd"] == 0.00042
            gates["now"] = gateway(tmp_path / "b", Server(402))
            failed = poll(client, client.post("/api/brand-research", json={"url": "signal.example.com"}).json()["id"])
            assert failed["status"] == "failed" and failed["error_kind"] == "cloud_key"
            assert "out of credit" in failed["error"] and KEY not in json.dumps(failed)
    finally:
        jobs.close()


# --------------------------------------------------------------------- strategist and analyst


def test_strategist_model_skips_admission_when_cloud_and_records_usage(tmp_path):
    from clip_factory.strategist_api import LocalModel

    checks = []
    runtime = SimpleNamespace(store=SimpleNamespace(get=lambda *a: {}), resource_check=lambda *a: checks.append(a))
    gate = gateway(tmp_path, Server(ok('{"status": "insufficient_evidence"}')))
    model = LocalModel(SimpleNamespace(state=SimpleNamespace(llm=gate)), runtime, "job1")
    assert model.cloud and model.admit() == [] and checks == []
    assert model.generate("prompt") == '{"status": "insufficient_evidence"}'
    assert model.usage["calls"] == 1 and model.model_id == "openrouter:anthropic/claude-haiku-5.5"
    assert LocalModel(SimpleNamespace(state=SimpleNamespace(llm=gate)), runtime, None).admit()
    local = LocalModel(SimpleNamespace(state=SimpleNamespace(llm=gateway(tmp_path / "n", key=None))), runtime, "j")
    assert not local.cloud and local.admit() == [] and len(checks) == 1  # local path: the guard ran


def test_reference_vision_admission_stays_local_even_when_patterns_use_cloud(tmp_path):
    from clip_factory.strategist_api import LocalModel

    checks = []
    runtime = SimpleNamespace(store=SimpleNamespace(get=lambda *a: {}), resource_check=lambda *a: checks.append(a))
    app = SimpleNamespace(state=SimpleNamespace(llm=gateway(tmp_path)))
    guard = LocalModel(app, runtime, "job")
    assert guard.cloud and guard.admit_local() == [] and len(checks) == 1


# ------------------------------------------------------------------------------ clip agents


class FakeModels:
    def __init__(self):
        self.calls = []
        self.jobs = SimpleNamespace(check=lambda job_id: None)

    def run(self, job_id, identifier, action, **payload):
        self.calls.append(("run", identifier, payload))
        return {"output": '{"local": true}'}

    def run_batch(self, job_id, identifier, requests):
        self.calls.append(("batch", identifier, requests))
        return [{"output": "{}"} for _ in requests]

    def vision(self, identifier):
        return True

    def require(self, identifier, kind):
        raise WorkError("Download this model first.")


def test_agent_prompts_stay_local_until_the_toggle_is_on(tmp_path, monkeypatch):
    models = FakeModels()
    server = Server(ok('{"cloud": true}'), ok("{}"), ok("{}"), ok('{"seen": 1}'))
    gate = gateway(tmp_path, server)
    routed = lp.RoutedModels(models, gate, "agents")
    assert routed.run("j", "ollama:qwen3-vl:4b-instruct", "generate", prompt="p")["output"] == '{"local": true}'
    assert routed.vision("x") is True and server.requests == []
    with pytest.raises(WorkError):
        routed.require("ollama:x", "llm")

    gate.update_settings({"cloud_agents": True})
    frame = tmp_path / "f.jpg"
    frame.write_bytes(b"\xff\xd8jpeg")
    out = routed.run("j", "ollama:qwen3-vl:4b-instruct", "generate", prompt="AGENT PROMPT", schema={"type": "object"},
                     images=[str(frame)], image_labels=["Frame at 1.0s"], max_tokens=2200)
    assert out["output"] == '{"cloud": true}' and out["llm"]["provider"] == "openrouter"
    body = server.bodies()[0]
    assert body["messages"][1]["content"] == "AGENT PROMPT"  # frames off: text descriptions only
    assert routed.vision("x") is False and routed.require("ollama:x", "llm") is None
    assert [o["output"] for o in routed.run_batch("j", "m", [{"prompt": "a"}, {"prompt": "b"}])] == ["{}", "{}"]

    gate.update_settings({"cloud_agent_frames": True})
    routed.run("j", "m", "generate", prompt="look", images=[str(frame)], image_labels=["Frame at 1.0s"])
    parts = server.bodies()[-1]["messages"][1]["content"]
    assert parts[0]["text"].startswith("The attached images are in order")
    assert parts[-1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert len([c for c in models.calls if c[0] == "run"]) == 1  # only the first, pre-toggle call ran locally


def test_routed_transcription_never_leaves_the_mac(tmp_path):
    models = FakeModels()
    gate = gateway(tmp_path, cloud_agents=True)
    routed = lp.RoutedModels(models, gate, "agents")
    routed.run("j", "whisper-turbo", "transcribe", audio="/tmp/a.wav")
    assert models.calls[0][0] == "run" and models.calls[0][1] == "whisper-turbo"


def test_a_run_holds_a_local_model_loaded_and_nothing_for_the_cloud(tmp_path):
    held = []
    models = FakeModels()
    models.warm = lambda identifier: held.append(identifier) or contextlib.nullcontext()
    gate = gateway(tmp_path)
    routed = lp.RoutedModels(models, gate, "agents")
    with routed.warm("ollama:qwen3-vl:4b-instruct"):
        pass
    gate.update_settings({"cloud_agents": True})
    with routed.warm("ollama:qwen3-vl:4b-instruct"):
        pass
    assert held == ["ollama:qwen3-vl:4b-instruct"]


def test_team_counts_cloud_usage_on_the_run(tmp_path):
    from clip_factory.team import TeamEngine

    store = Store(tmp_path)
    store.put("team_runs", {"id": "r1"})
    engine = SimpleNamespace(store=store)
    item = {"provider": "openrouter", "model": lp.HAIKU, "prompt_tokens": 10, "completion_tokens": 5, "cost_usd": 0.01}
    TeamEngine._count_llm(engine, "r1", {"output": "{}", "llm": item}, {"output": "{}"}, {"output": "{}", "llm": item})
    usage = store.get("team_runs", "r1")["llm_usage"]
    assert usage["calls"] == 2 and usage["cost_usd"] == 0.02 and usage["prompt_tokens"] == 20


# ------------------------------------------------------------------------------------------ API


def test_api_saves_replaces_and_removes_the_key_without_echoing_it(tmp_path):
    from clip_factory.app import create_app

    app = create_app(tmp_path, token="local-test")
    checks = Server({"data": {"label": "x"}}, 401, {"data": {}})
    app.state.llm.client = lp.OpenRouterClient(transport=httpx.MockTransport(checks), sleep=lambda s: None)
    with TestClient(app, base_url="http://127.0.0.1", headers={"X-Clip-Token": "local-test"}) as session:
        assert session.get("/api/llm-provider", headers={"X-Clip-Token": "no"}).status_code == 401
        view = session.get("/api/llm-provider").json()
        assert view["key"]["present"] is False and set(view["routes"].values()) == {"local"}
        assert [m["id"] for m in view["models"]] == ["anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5"]

        bad = session.put("/api/llm-provider/key", json={"api_key": "hunter2-not-a-key"})
        assert bad.status_code == 422 and "hunter2" not in bad.text
        saved = session.put("/api/llm-provider/key", json={"api_key": KEY})
        assert saved.status_code == 200 and KEY not in saved.text
        assert saved.json()["key"]["present"] is True and saved.json()["routes"]["brand_research"] == "openrouter"
        assert checks.requests[0].url.path == "/api/v1/key"
        rejected = session.put("/api/llm-provider/key", json={"api_key": KEY.replace("a1", "zz")})
        assert rejected.status_code == 422 and "rejected" in rejected.text and KEY[:20] not in rejected.text
        assert app.state.llm.secrets.get() == KEY  # a rejected replacement keeps the working key

        changed = session.put("/api/llm-provider/settings", json={"cloud_agents": True, "model": lp.SONNET}).json()
        assert changed["routes"]["agents"] == "openrouter" and changed["settings"]["model"] == lp.SONNET
        assert session.put("/api/llm-provider/settings", json={"model": "x"}).status_code == 422

        removed = session.delete("/api/llm-provider/key").json()
        assert removed["key"]["present"] is False and set(removed["routes"].values()) == {"local"}
    assert KEY not in json.dumps([row for kind in ("llm_settings", "llm_calls", "jobs") for row in app.state.store.all(kind)])


def test_thinking_is_off_and_a_truncated_answer_is_billed_but_rejected(tmp_path):
    truncated = {"choices": [{"message": {"content": None}, "finish_reason": "length"}],
                 "usage": {"prompt_tokens": 5000, "completion_tokens": 1200, "cost": 0.0011}}
    server = Server(truncated)
    gate = gateway(tmp_path, server)
    with pytest.raises(lp.CloudError, match="ran out of output room"):
        gate.complete_json("brand_research", "", "x", {"type": "object"}, job_id="j")
    assert server.bodies()[0]["reasoning"] == {"enabled": False}
    (row,) = gate.store.all(lp.LEDGER_KIND)
    assert row["status"] == "error" and row["cost_usd"] == 0.0011
    assert gate.spend()["cost_usd"] == 0.0011
