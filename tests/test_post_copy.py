# ruff: noqa: F811
"""Per-clip post copy: grounded in the clip's words, brief-shaped, bounded, labelled fallback."""

import json

import pytest
from test_app import client, wait_job  # noqa: F401
from test_references import OWN_WORDS, transcript

from clip_factory import post_copy as pc
from clip_factory.jobs import WorkError

BRIEF = {"key_messages": ["Hire slowly and keep control"], "cta": "Get the hiring checklist",
         "cta_link": "https://example.com/checklist", "must_include": ["startup hiring"],
         "must_avoid": ["layoffs"], "tone": "Plain, direct"}


def ctx(**brief):
    clip = {"id": "c", "start": 2.0, "end": 8.0, "hook": "Most founders hire too early",
            "brief_serves": ["M1"], "brief_snapshot": {**BRIEF, **brief}}
    return pc.context_for(clip, {"transcript": transcript(OWN_WORDS)}, None)


def test_template_is_grounded_and_uses_link_in_bio_for_the_cta():
    made = pc.template(ctx())
    caption = made["caption"]
    assert caption.startswith("Most founders hire too early")
    assert "“Most founders hire too early. We waited a year and kept control.”" in caption
    assert "Hire slowly and keep control" in caption
    assert "Get the hiring checklist — link in bio." in caption and "https://" not in caption
    assert 1 <= len(made["hashtags"]) <= 5 and "startuphiring" in made["hashtags"]
    assert not pc.problems(caption, ctx())


def test_no_hashtags_when_the_brief_says_so():
    quiet = ctx(tone="Plain. No hashtags please.")
    assert quiet["hashtags_allowed"] is False
    made = pc.template(quiet)
    assert made["hashtags"] == [] and "#" not in made["caption"]
    assert "The brief asks for no hashtags." in pc.problems("Nice clip #founders", quiet)
    assert ctx(must_avoid=["hashtags"])["hashtags_allowed"] is False


def test_hashtags_are_capped_deduped_and_never_spammy():
    tags = pc.clean_tags(["#followforfollow", "#F4F", "#Startups", "#startups", "#founders", "#hiring",
                          "#control", "#growth", "#extra", "#layoffs"], ctx())
    assert tags == ["Startups", "founders", "hiring", "control", "growth"]
    assert "A banned or spammy hashtag was used." in pc.problems("Hi #like4like", ctx())
    assert "Use at most 5 hashtags." in pc.problems("Hi #a1b #b2c #c3d #d4e #e5f #f6g", ctx())


def test_checks_enforce_length_must_avoid_links_and_unspoken_numbers():
    c = ctx()
    assert "longer than 2,200" in " ".join(pc.problems("x" * 2201, c))
    assert "must-avoid" in " ".join(pc.problems("Our layoffs story", c))
    assert "link in bio" in " ".join(pc.problems("See https://example.com", c))
    assert "Numbers the clip never says: 10" in " ".join(pc.problems("We grew 10x after waiting", c))
    long = pc.compose("word " * 600, c, ["founders"])
    assert len(long) <= pc.MAX_CHARS and long.endswith("#founders")


def test_model_copy_is_validated_and_falls_back_to_a_labelled_template():
    c = ctx()
    good = json.dumps({"body": "Most founders hire too early. We waited a year and kept control.",
                       "hashtags": ["founders", "followforfollow", "hiring"]})
    made = pc.generate(c, admit=list, call=lambda prompt: good, model_id="ollama:qwen3-vl:4b-instruct")
    assert made["source"] == "model" and made["model_id"] and made["version"] == pc.VERSION
    assert "followforfollow" not in made["hashtags"] and "link in bio" in made["caption"] and not made["checks"]
    lying = json.dumps({"body": "This tripled revenue by 300% overnight, guaranteed.", "hashtags": []})
    fallback = pc.generate(c, admit=list, call=lambda prompt: lying, model_id="ollama:qwen3-vl:4b-instruct")
    assert fallback["source"] == "template" and "twice" in fallback["fallback_reason"]
    assert fallback["label"].startswith("Template") and "300" not in fallback["caption"]

    def never(prompt):
        raise AssertionError("held")

    held = pc.generate(c, admit=lambda: ["memory low"], call=never, model_id="ollama:qwen3-vl:4b-instruct")
    assert held["source"] == "template" and "memory low" in held["fallback_reason"]
    absent = pc.generate(c, admit=list, call=never, model_id=None)
    assert absent["source"] == "template" and "No qualified local model" in absent["fallback_reason"]

    def broken(prompt):
        raise WorkError("Ollama is not running.")

    failed = pc.generate(c, admit=list, call=broken, model_id="ollama:qwen3-vl:4b-instruct")
    assert failed["source"] == "template" and "Ollama is not running" in failed["fallback_reason"]


@pytest.fixture
def seeded(client):
    store = client.app.state.store
    store.put("videos", {"id": "own", "duration": 20.0, "transcript": transcript(OWN_WORDS)})
    store.put("clips", {"id": "c1", "video_id": "own", "start": 2.0, "end": 8.0, "hook": "Most founders hire too early",
                        "brief_serves": ["M1"], "brief_snapshot": BRIEF, "sha256": "abc"})
    return client


def test_api_get_prefills_a_stored_template_and_post_regenerates_with_provenance(seeded, monkeypatch):
    client = seeded
    first = client.get("/api/clips/c1/post-copy")
    assert first.status_code == 200
    copy = first.json()["post_copy"]
    assert copy["source"] == "template" and copy["clip_sha256"] == "abc"
    assert client.app.state.store.get("clips", "c1")["post_copy"]["caption"] == copy["caption"]
    assert client.get("/api/clips/missing/post-copy").status_code == 404

    app = client.app

    class Models:
        def require(self, *_):
            return None

        def run(self, job_id, model, action, **payload):
            assert payload["context_tokens"] == pc.CONTEXT_TOKENS
            return {"output": json.dumps({"body": "We waited a year and kept control.", "hashtags": ["founders"]})}

    monkeypatch.setattr(app.state, "models", Models())
    app.state.autonomy_runtime.resource_check = lambda *_: None
    queued = client.post("/api/clips/c1/post-copy", json={"mode": "model"})
    assert queued.status_code == 202, queued.text
    assert wait_job(client, queued.json()["job"]["id"])["status"] == "completed"
    done = client.get("/api/clips/c1/post-copy").json()
    assert done["post_copy"]["source"] == "model" and done["post_copy"]["model_id"].startswith("ollama:qwen3-vl:4b")
    assert done["post_copy"]["caption"].startswith("We waited a year and kept control.")
    template = client.post("/api/clips/c1/post-copy", json={"mode": "template"}).json()
    assert template["post_copy"]["source"] == "template" and template["job"] is None
    assert client.post("/api/clips/c1/post-copy", json={"mode": "magic"}).status_code == 422
