# ruff: noqa: F811
"""Reference research: material honesty, measurements, cited observations, one validated pattern,
and "Use this direction" → exactly-one-variable A/B render + a PROPOSED (never approved) rules note."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from test_app import client, wait_job  # noqa: F401
from test_campaign_api import approve_rules
from test_versions import fake_media

from clip_factory import media
from clip_factory import references as refs
from clip_factory.campaigns import Direction
from clip_factory.jobs import WorkError

HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
needs_ffmpeg = pytest.mark.skipif(not HAS_FFMPEG, reason="FFmpeg is not installed")

# A hook-first reference: the opening line comes back at the end.
REF_WORDS = [
    ("Stop", 0.3, 0.6), ("scrolling,", 0.65, 1.1), ("this", 1.15, 1.4), ("one", 1.45, 1.7), ("habit", 1.75, 2.1),
    ("changed", 2.15, 2.5), ("everything.", 2.55, 2.9), ("Here", 3.1, 3.3), ("is", 3.35, 3.5), ("why.", 3.55, 3.9),
    ("One", 5.0, 5.2), ("habit", 5.25, 5.5), ("changed", 5.55, 5.8), ("everything.", 5.85, 5.95),
]
OWN_WORDS = [
    ("Most", 2.2, 2.5), ("founders", 2.55, 3.0), ("hire", 3.05, 3.3), ("too", 3.35, 3.5), ("early.", 3.55, 4.0),
    ("We", 5.0, 5.2), ("waited", 5.25, 5.6), ("a", 5.65, 5.7), ("year", 5.75, 6.0), ("and", 6.05, 6.2),
    ("kept", 6.25, 6.5), ("control.", 6.55, 7.0),
]


def transcript(words):
    return {"language": "en", "segments": [{"start": words[0][1], "end": words[-1][2],
                                             "text": " ".join(w for w, _, _ in words),
                                             "words": [{"word": w, "start": a, "end": b, "probability": 0.95}
                                                       for w, a, b in words]}]}


def synthetic_reference(path: Path, *, seconds=6) -> Path:
    """Three solid-colour shots (two hard cuts at 2 s and 4 s) over a tone."""
    part = seconds / 3
    subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y",
         "-f", "lavfi", "-i", f"color=c=red:s=180x320:r=15:d={part}",
         "-f", "lavfi", "-i", f"color=c=blue:s=180x320:r=15:d={part}",
         "-f", "lavfi", "-i", f"color=c=green:s=180x320:r=15:d={part}",
         "-f", "lavfi", "-i", f"sine=f=440:d={seconds}",
         "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-map", "3:a",
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path)],
        check=True, capture_output=True, timeout=60,
    )
    return path


class LocalJobs:
    """Enough of Jobs for the analyzer's FFmpeg steps."""

    def process(self, job, command, *, timeout=60, cwd=None, failure="failed", **_):
        result = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=False)
        if result.returncode:
            raise WorkError(failure)
        return (result.stdout or "") + (result.stderr or "")

    def check(self, job):
        return None

    def update(self, job, **_):
        return None


# ----------------------------------------------------------------- material honesty


@pytest.mark.parametrize("url", [
    "https://www.instagram.com/reel/abc/", "https://instagram.com/p/x.mp4", "https://www.tiktok.com/@a/video/1",
    "https://youtu.be/xyz", "https://www.youtube.com/shorts/abc", "https://example.com/page",
    "https://cdn.example.com/video.mov",
])
def test_platform_pages_and_non_mp4_links_are_never_fetched(url):
    status = refs.url_status(url)
    assert status["fetchable"] is False and "upload" in status["reason"].lower() or "scraped" in status["reason"]


def test_direct_public_mp4_is_the_only_fetchable_link():
    assert refs.url_status("https://cdn.example.com/clips/ref.mp4")["fetchable"] is True
    with pytest.raises(WorkError):
        refs.fetch_mp4("https://www.instagram.com/reel/abc.mp4", Path("/tmp/never-written.mp4"))


def test_private_network_links_are_refused(monkeypatch, tmp_path):
    monkeypatch.setattr(refs.socket, "getaddrinfo", lambda *a, **k: [(0, 0, 0, "", ("127.0.0.1", 0))])
    with pytest.raises(WorkError, match="private or local"):
        refs.fetch_mp4("http://cdn.example.com/a.mp4", tmp_path / "a.mp4")
    assert not (tmp_path / "a.mp4").exists()


# ----------------------------------------------------------------- deterministic measurements


def test_frame_plan_is_dense_first_then_every_three_seconds():
    assert refs.frame_plan(10) == [0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 6.0, 9.0]
    assert refs.frame_plan(1.2) == [0.0, 0.5, 1.0]
    assert len(refs.frame_plan(180)) <= refs.MAX_FRAMES
    windows = refs.vision_windows(refs.frame_plan(20), 20)
    assert windows[0][2] == [0.0, 0.5, 1.0, 1.5] and windows[1][2] == [2.0, 3.0]


def test_measure_reads_speech_timing_and_hook_first_structure():
    m = refs.measure(duration=6.0, transcript=transcript(REF_WORDS), cuts=[2.0, 4.0], lufs=-14.2)
    assert m["time_to_first_word"] == 0.3 and m["word_count"] == len(REF_WORDS)
    assert m["words_per_second"] == round(len(REF_WORDS) / (5.95 - 0.3), 2)
    assert m["cuts_per_minute"] == 20.0 and m["first_cut"] == 2.0 and m["integrated_lufs"] == -14.2
    assert m["structure"]["guess"] == "hook_first" and m["structure"]["later"]["start"] == 5.0


def test_linear_reference_is_not_called_hook_first():
    words = REF_WORDS[:10] + [("Totally", 5.0, 5.4), ("different", 5.45, 5.9), ("ending.", 5.9, 5.95)]
    assert refs.measure(duration=6, transcript=transcript(words), cuts=[], lufs=None)["structure"]["guess"] == "linear"


def test_loudness_parser_reads_the_ebur128_summary():
    output = "[Parsed_ebur128_0] Summary:\n\n  Integrated loudness:\n    I:         -16.3 LUFS\n    Threshold: -26.5 LUFS"
    assert refs.parse_loudness(output) == -16.3 and refs.parse_loudness("silence I: -70.0 LUFS") is None


@needs_ffmpeg
def test_real_ffmpeg_measures_cuts_and_loudness_on_a_synthetic_reference(tmp_path):
    source = synthetic_reference(tmp_path / "ref.mp4")
    analyzer = refs.Analyzer(jobs=LocalJobs(), models=None, admit=list, vision_model=None,
                             whisper_ready=lambda: False)
    cuts = analyzer.cuts("job", source, tmp_path / "work", 6.0)
    assert cuts == pytest.approx([2.0, 4.0], abs=0.15)
    lufs = analyzer.loudness("job", source, True)
    assert lufs is not None and -40 < lufs < 0


# ----------------------------------------------------------------- observations


def analyzed_ref(**extra):
    words = [{"text": w, "start": a, "end": b} for w, a, b in REF_WORDS]
    ref = {"id": "ref_a", "duration": 6.0, "status": "analyzed", "note": "", "name": "a.mp4",
           "measurements": refs.measure(duration=6.0, transcript=transcript(REF_WORDS), cuts=[2.0, 4.0], lufs=-14.0),
           "frames": [{"time": t, "file": f"f{t}.jpg", "described": True, "visual": "A man talks to camera.",
                       "on_screen_text": ["STOP SCROLLING"] if t < 2 else []} for t in refs.frame_plan(6)],
           "transcript_text": " ".join(w for w, _, _ in REF_WORDS), "_words": words, **extra}
    ref["captions"] = refs.captions_detected(ref["frames"], words)
    return ref


def test_every_observation_is_a_fact_with_exact_valid_evidence():
    ref = analyzed_ref()
    found = refs.observations_for(ref)
    statements = " | ".join(o["statement"] for o in found)
    assert "first word is spoken at 0.3s" in statements
    assert "2 picture cuts" in statements and "STOP SCROLLING" in statements and "returns later" in statements
    assert all(not refs.validate_observation(o, ref) for o in found)
    assert all({"start", "end", "kind"} <= set(o["evidence"]) for o in found)


def test_invented_quotes_frames_and_times_are_rejected():
    ref = analyzed_ref()
    bad_quote = {"statement": "x", "evidence": {"kind": "quote", "start": 0, "end": 1, "quote": "guaranteed millions"}}
    bad_time = {"statement": "x", "evidence": {"kind": "measurement", "start": 0, "end": 60}}
    bad_frame = {"statement": "x", "evidence": {"kind": "frame", "start": 1.25, "end": 1.25, "frame_time": 1.25}}
    assert "not in this reference's transcript" in " ".join(refs.validate_observation(bad_quote, ref))
    assert refs.validate_observation(bad_time, ref) and refs.validate_observation(bad_frame, ref)


# ----------------------------------------------------------------- pattern validation / abstain

OBS = [{"id": "O1", "reference_id": "ref_a", "statement": "Opening line returns later."},
       {"id": "O2", "reference_id": "ref_b", "statement": "On-screen text in the first 2 s."}]
CONTROL = {"hook": "Own hook", "opening_treatment": "text_overlay", "caption_style": "standard",
           "hook_format": "title_card", "structure": "linear"}
GOOD = {"pattern": "Both references open on the payoff line and return to it.", "supported_by": ["O1"],
        "hypothesis": "Our audience may stay past 3 s if the payoff is teased first.", "variable": "structure",
        "value_b": "hook_first", "extra_limit": ""}


def check(raw, own=None, brief=None):
    return refs.validate_pattern(raw, OBS, variables=refs.allowed_variables(own), control=CONTROL, own=own, brief=brief)


def test_valid_pattern_keeps_control_from_our_style_rules():
    pattern, errors = check(GOOD)
    assert not errors and pattern["value_a"] == "linear" and pattern["value_b"] == "hook_first"
    assert pattern["reference_ids"] == ["ref_a"]


@pytest.mark.parametrize("change, message", [
    ({"supported_by": ["O9"]}, "do not exist"),
    ({"variable": "framing"}, "variable"),
    ({"variable": "hook", "value_b": "Most founders hire too early"}, "Variable must be one of"),
    ({"value_b": "linear"}, "nothing to test"),
    ({"variable": "caption_style", "value_b": "neon"}, "must be one of"),
    ({"hypothesis": "This is proven to make it go viral with 300% more views."}, "proof"),
])
def test_invalid_patterns_are_refused(change, message):
    pattern, errors = check({**GOOD, **change})
    assert pattern is None and message in " ".join(errors)


def test_hook_pattern_must_be_grounded_in_our_own_words_and_brief():
    own = {"text": "Most founders hire too early. We waited a year and kept control."}
    ok, errors = check({**GOOD, "variable": "hook", "value_b": "Most founders hire too early"}, own=own)
    assert ok and not errors
    _, errors = check({**GOOD, "variable": "hook", "value_b": "Billionaires reveal secret wealth trick"}, own=own)
    assert "actually says" in " ".join(errors)
    _, errors = check({**GOOD, "variable": "hook", "value_b": "Founders hire too early"}, own=own,
                      brief={"must_avoid": ["founders hire"]})
    assert "must-avoid" in " ".join(errors)


def test_pattern_gets_one_repair_then_abstains_and_holds_never_infer():
    replies = iter([json.dumps({**GOOD, "supported_by": ["O7"]}), json.dumps(GOOD)])
    analyzer = refs.Analyzer(jobs=LocalJobs(), models=None, admit=list, vision_model="m", whisper_ready=lambda: False)
    outcome = analyzer.pattern("job", [], OBS, brief_text="", brief=None, own=None, control=CONTROL,
                               generate=lambda prompt: next(replies))
    assert outcome["status"] == "ready" and outcome["attempts"] == 2
    bad = refs.Analyzer(jobs=LocalJobs(), models=None, admit=list, vision_model="m", whisper_ready=lambda: False)
    outcome = bad.pattern("job", [], OBS, brief_text="", brief=None, own=None, control=CONTROL,
                          generate=lambda prompt: "not json")
    assert outcome["status"] == "abstained" and "twice" in outcome["reason"]
    held = refs.Analyzer(jobs=LocalJobs(), models=None, admit=lambda: ["memory low"], vision_model="m",
                         whisper_ready=lambda: False)

    def never(prompt):
        raise AssertionError("A held model must never be asked to infer.")

    outcome = held.pattern("job", [], OBS, brief_text="", brief=None, own=None, control=CONTROL, generate=never)
    assert outcome["status"] == "held" and "memory low" in outcome["reason"]


# ----------------------------------------------------------------- API: upload, links, analysis, use


class FakeModels:
    """Stands in for Whisper and qwen3-vl:4b; records every call."""

    def __init__(self, patterns):
        self.patterns, self.calls = list(patterns), []

    def require(self, identifier, kind):
        return None

    def vision(self, identifier):
        return True

    def run(self, job_id, identifier, action, **payload):
        self.calls.append((identifier, action, bool(payload.get("images"))))
        if action == "transcribe":
            return transcript(REF_WORDS)
        if payload.get("images"):
            return {"output": json.dumps({"visual": "A person talks to camera on a plain background.", "action": "low",
                                          "on_screen_text": ["STOP SCROLLING"], "usable": True, "said": "A habit.",
                                          "highlight": 6, "highlight_reason": "Direct address."})}
        return {"output": self.patterns.pop(0)}


def workspace(client):
    store, root = client.app.state.store, client.app.state.root
    (root / "videos" / "own.mp4").write_bytes(b"own-source")
    store.put("videos", {"id": "own", "name": "own.mp4", "duration": 20.0, "width": 1080, "height": 1920,
                         "has_audio": True, "hdr": False, "path": "videos/own.mp4", "status": "transcribed",
                         "transcript": transcript(OWN_WORDS), "transcript_origin": "generated", "created_at": "x"})
    profile = client.post("/api/profiles", json={"name": "Brand", "audience": "Founders"}).json()
    campaign = client.post("/api/campaigns", json={"name": "Launch", "profile_ids": [profile["id"]],
                                                   "video_ids": ["own"]}).json()
    rules = approve_rules(client, profile["id"], Direction(hooks=["Own hook"], duration_seconds=10))
    store.put("clips", {"id": "ownclip", "video_id": "own", "campaign_id": campaign["id"], "profile_id": profile["id"],
                        "start": 2.0, "end": 8.0, "hook": "Most founders hire too early", "caption": "",
                        "structure": "linear", "approved": False, "created_at": "2026-11-14T00:00:00+00:00",
                        "edit_plan": {"start": 2.0, "end": 8.0, "hook_format": "title_card", "structure": "linear",
                                      "caption_style": "standard", "framing": "fit"}})
    return profile, campaign, rules


def start_research(client, campaign, profile):
    response = client.post(f"/api/campaigns/{campaign['id']}/reference-research", json={"profile_id": profile["id"]})
    assert response.status_code == 201, response.text
    return response.json()


@needs_ffmpeg
def test_reference_upload_is_kind_reference_and_never_a_production_source(client, tmp_path):
    profile, campaign, _ = workspace(client)
    research = start_research(client, campaign, profile)
    source = synthetic_reference(tmp_path / "ref.mp4")
    response = client.post(f"/api/reference-research/{research['id']}/references",
                           files={"file": ("../ref.mp4", source.read_bytes(), "video/mp4")}, data={"note": "Love the open"})
    assert response.status_code == 201, response.text
    ref = response.json()["references"][0]
    assert ref["media_kind"] == "reference" and ref["kind"] == "upload" and ref["note"] == "Love the open"
    assert [v["id"] for v in client.get("/api/videos").json()] == ["own"]
    stored = client.app.state.root / "references" / research["id"] / ref["file"]
    assert stored.is_file() and not any((client.app.state.root / "videos").glob("ref_*"))
    assert client.get(f"/api/reference-research/{research['id']}/references/{ref['id']}/media").status_code == 200
    assert client.get(f"/api/reference-research/{research['id']}/frames/..%2Ffactory.sqlite3").status_code == 404


def test_reference_limits_duration_count_and_type(client, monkeypatch):
    profile, campaign, _ = workspace(client)
    research = start_research(client, campaign, profile)
    path = f"/api/reference-research/{research['id']}"
    assert client.post(path + "/references", files={"file": ("a.txt", b"x", "text/plain")}).status_code == 422
    monkeypatch.setattr(media, "probe", lambda _: {"duration": 240.0, "width": 1, "height": 1, "has_audio": False})
    long = client.post(path + "/references", files={"file": ("long.mp4", b"x", "video/mp4")})
    assert long.status_code == 422 and "3 minutes" in long.json()["detail"]
    assert not list((client.app.state.root / "references" / research["id"]).iterdir())
    for n in range(3):
        assert client.post(path + "/links", json={"url": f"https://www.instagram.com/reel/{n}/"}).status_code == 201
    assert client.post(path + "/links", json={"url": "https://example.com/4.mp4"}).status_code == 422


def test_links_are_recorded_not_inspected_and_never_analyzed(client, monkeypatch):
    profile, campaign, _ = workspace(client)
    research = start_research(client, campaign, profile)
    path = f"/api/reference-research/{research['id']}"
    body = client.post(path + "/links", json={"url": "https://www.instagram.com/reel/abc/", "note": "Great pace"}).json()
    ref = body["references"][0]
    assert ref["status"] == "not_inspected" and "upload the video" in ref["status_reason"].lower()
    client.post(path + "/links", json={"url": "https://cdn.example.com/dead.mp4"})

    def unreachable(url, target, **_):
        raise WorkError("The link could not be fetched (unreachable, private or refused).")

    monkeypatch.setattr(refs.Analyzer, "__init__", _with_fetch(refs.Analyzer.__init__, unreachable))
    job = client.post(path + "/analyze", json={}).json()["job_id"]
    assert wait_job(client, job)["status"] == "completed"
    done = client.get(path).json()
    statuses = {r["url"]: (r["status"], r["status_reason"]) for r in done["references"]}
    assert statuses["https://www.instagram.com/reel/abc/"][0] == "not_inspected"
    assert statuses["https://cdn.example.com/dead.mp4"][0] == "missing"
    assert "Missing material" in statuses["https://cdn.example.com/dead.mp4"][1]
    assert done["observations"] == [] and done["pattern"] is None and done["status"] == "abstained"
    assert all("measurements" not in r for r in done["references"])


def _with_fetch(original, fetch):
    def init(self, **kwargs):
        original(self, **{**kwargs, "fetch": fetch})
    return init


@needs_ffmpeg
def test_analysis_then_use_this_direction_renders_one_variable_and_only_proposes(client, tmp_path, monkeypatch):
    profile, campaign, rules = workspace(client)
    app = client.app
    bad = json.dumps({**GOOD, "supported_by": ["O99"]})
    models = FakeModels([bad, json.dumps({**GOOD, "supported_by": ["O1"]})])
    monkeypatch.setattr(app.state, "models", models)
    app.state.autonomy_runtime.resource_check = lambda *_: None
    research = start_research(client, campaign, profile)
    path = f"/api/reference-research/{research['id']}"
    source = synthetic_reference(tmp_path / "ref.mp4")
    client.post(path + "/references", files={"file": ("ref.mp4", source.read_bytes(), "video/mp4")})
    client.post(path + "/links", json={"url": "https://www.tiktok.com/@a/video/1"})
    queued = client.post(path + "/analyze", json={"target_clip_id": "ownclip"})
    assert queued.status_code == 202, queued.text
    job = wait_job(client, queued.json()["job_id"], timeout=90)
    assert job["status"] == "completed", job
    done = client.get(path).json()
    assert done["status"] == "ready", done.get("abstained")
    ref = next(r for r in done["references"] if r["kind"] == "upload")
    assert ref["status"] == "analyzed" and ref["measurements"]["cuts"] == pytest.approx([2.0, 4.0], abs=0.15)
    assert ref["measurements"]["structure"]["guess"] == "hook_first"
    assert all(o["evidence"] and o["reference_id"] == ref["id"] for o in done["observations"])
    # Evidence (observations) and inference (pattern) are stored apart; the pattern cites real ids.
    pattern = done["pattern"]
    assert pattern["supported_by"] == ["O1"] and {"O1"} <= {o["id"] for o in done["observations"]}
    assert pattern["variable"] == "structure" and (pattern["value_a"], pattern["value_b"]) == ("linear", "hook_first")
    assert any("No performance data" in limit for limit in done["limits"]) and "Sample of 1 reference" in done["limits"][0]
    assert [p["value"] for p in done["plans"]] == ["linear", "hook_first"]
    assert done["plans"][0]["source"]["clip_id"] == "ownclip" and "founders" in done["own_span"]["text"]
    # Admission guard ran before inference; frames were described with images; Whisper transcribed.
    actions = [c[1] for c in models.calls]
    assert actions.count("transcribe") == 1 and sum(1 for c in models.calls if c[2]) >= 2

    fake_media(monkeypatch, client)
    used = client.post(path + "/use", json={})
    assert used.status_code == 202, used.text
    direction = used.json()["direction"]
    assert direction["variant_request"]["variants"] == {"variable": "structure", "values": ["linear", "hook_first"]}
    render = wait_job(client, direction["job_id"], timeout=60)
    assert render["status"] == "completed", render
    clips = [app.state.store.get("clips", i) for i in render["result"]["clip_ids"]]
    assert len(clips) == 2 and len({c["variant_group"] for c in clips}) == 1
    assert all(c["reference_research_id"] == research["id"] and c["changed_variable"] == "structure" for c in clips)
    one, other = (c["edit_plan"] for c in clips)
    assert {k for k in one if one[k] != other[k]} == {"structure"}
    proposal = app.state.store.get("strategy_versions", direction["proposal_id"])
    assert proposal["status"] == "proposed" and proposal["reference_research_id"] == research["id"]
    assert proposal["approved_at"] is None and proposal["reference_research"]["inference"] is True
    assert app.state.store.get("profiles", profile["id"])["active_strategy_id"] == rules["id"]
    assert client.post(path + "/use", json={}).status_code == 409


def test_use_requires_a_validated_pattern_and_a_campaign_clip(client):
    profile, campaign, _ = workspace(client)
    research = start_research(client, campaign, profile)
    path = f"/api/reference-research/{research['id']}"
    assert client.post(path + "/use", json={"clip_id": "ownclip"}).status_code == 409
    store = client.app.state.store
    store.patch(refs.STORE, research["id"], status="ready", target_clip_id="ownclip",
                pattern={**GOOD, "value_a": "linear", "reference_ids": ["ref_a"]})
    assert client.post(path + "/use", json={"clip_id": "elsewhere"}).status_code == 422
    assert client.post(path + "/analyze", json={}).status_code == 422  # no references


def test_variant_request_changes_exactly_one_variable_and_hook_needs_a_control():
    research = {"id": "rr_1", "profile_id": "p", "pattern": {**GOOD, "variable": "caption_style", "value_a": "standard",
                                                             "value_b": "pop", "reference_ids": ["r"]}}
    clip = {"id": "c", "video_id": "v", "start": 1, "end": 9, "hook": "Hi", "edit_plan": {"caption_style": "standard",
                                                                                           "structure": "auto"}}
    request = refs.variant_request(research, clip)
    assert request["variants"] == {"variable": "caption_style", "values": ["standard", "pop"]}
    assert request["changed_variable"] == "caption_style" and "caption_style" not in {k for k in request if k != "variants"} - {"changed_variable"}
    research["pattern"].update(variable="hook", value_a="", value_b="New")
    with pytest.raises(WorkError):
        refs.variant_request(research, clip)
