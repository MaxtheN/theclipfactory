# ruff: noqa: F811
"""Editing craft: plans (cuts, hook-first, emphasis), filter graphs, provenance, variants, real renders."""

import itertools
import json
import re
import shutil
import subprocess
from pathlib import Path
from unittest.mock import Mock

import pytest
from pydantic import ValidationError
from test_app import client, upload_mock, wait_job  # noqa: F401
from test_versions import direct, fake_media, rendered

from clip_factory import craft, media
from clip_factory.app import Render
from clip_factory.jobs import Jobs, WorkError
from clip_factory.store import Store

HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))

# A talky synthetic source: setup, a filler, a payoff sentence and a closer, with real pauses.
WORDS = [
    ("So", 0.5, 0.8), ("here", 0.85, 1.1), ("is", 1.15, 1.4), ("the", 1.45, 1.7), ("setup.", 1.75, 2.2),
    ("um", 3.5, 3.8), ("this", 3.9, 4.2), ("matters", 4.25, 4.7), ("because", 4.75, 5.3),
    ("We", 6.4, 6.7), ("grew", 6.75, 7.0), ("revenue", 7.05, 7.6), ("300%", 7.65, 8.1), ("in", 8.15, 8.3),
    ("Chicago.", 8.35, 9.0),
    ("That", 10.2, 10.5), ("changed", 10.55, 11.0), ("everything.", 11.05, 11.7),
]


def words(items=WORDS):
    return [{"text": w, "start": a, "end": b} for w, a, b in items]


def transcript(items=WORDS):
    groups = [items[0:5], items[5:9], items[9:15], items[15:]]
    return {
        "segments": [
            {
                "start": g[0][1],
                "end": g[-1][2],
                "text": " ".join(w for w, _, _ in g),
                "words": [{"word": w, "start": a, "end": b} for w, a, b in g],
            }
            for g in groups
        ]
    }


def inside_word(t, items=WORDS, slack=0.0):
    return any(a + slack < t < b - slack for _, a, b in items)


# ----------------------------------------------------------------- jump cuts


def test_silence_cuts_tighten_pauses_and_never_cut_inside_a_word():
    plan = craft.plan_jump_cuts(words(), 0.3, 12.0, "silences")
    assert plan["removed"] and plan["fillers_removed"] == []
    for removal in plan["removed"]:
        assert not inside_word(removal["start"]) and not inside_word(removal["end"])
        assert removal["end"] - removal["start"] >= 0.2
    for a, b in plan["keeps"]:
        assert b - a >= craft.MIN_SEGMENT
    assert plan["removed_share"] <= craft.MAX_REMOVED_SHARE
    # The 1.3 s pause after "setup." keeps a breath on each side.
    first = plan["removed"][0]
    assert first["start"] == pytest.approx(2.2 + craft.CUT_PAD) and first["end"] == pytest.approx(3.5 - craft.CUT_PAD)


def test_filler_cuts_only_in_filler_mode_and_soft_fillers_need_commas():
    assert craft.plan_jump_cuts(words(), 0.3, 12.0, "silences_and_fillers")["fillers_removed"] == ["um"]
    talk = words([("I", 0.0, 0.2), ("like", 0.25, 0.5), ("pizza,", 0.55, 0.9), ("so,", 1.0, 1.2),
                  ("like,", 1.25, 1.5), ("it", 1.55, 1.7), ("works", 1.75, 2.0), ("every", 2.05, 2.3),
                  ("single", 2.35, 2.6), ("time.", 2.65, 3.0)])
    plan = craft.plan_jump_cuts(talk, 0.0, 3.0, "silences_and_fillers")
    assert plan["fillers_removed"] == ["like,"]  # "I like pizza" keeps its verb
    assert all(not (r["start"] < 1.2 or r["end"] > 1.55) for r in plan["removed"])
    assert craft.plan_jump_cuts(talk, 0.0, 3.0, "silences")["removed"] == []
    # A filler cut that would leave a sub-second piece is restored instead.
    short = craft.plan_jump_cuts(talk[:7], 0.0, 2.0, "silences_and_fillers")
    assert short["removed"] == [] and short["keeps"] == [(0.0, 2.0)]


def test_cut_guards_cap_removal_skip_sparse_speech_and_need_word_timings():
    # One long pause: removing it all would exceed the cap, so nothing larger than the cap goes.
    talk = [(f"w{i}", i * 0.3, i * 0.3 + 0.25) for i in range(7)]
    long_pause = words(talk + [(f"v{i}", 6.0 + i * 0.3, 6.25 + i * 0.3) for i in range(7)])
    capped = craft.plan_jump_cuts(long_pause, 0.0, 8.1, "silences")
    assert capped["removed_share"] == pytest.approx(craft.MAX_REMOVED_SHARE, abs=0.01)
    (removal,) = capped["removed"]
    assert 1.8 + craft.CUT_PAD <= removal["start"] and removal["end"] <= 6.0 - craft.CUT_PAD
    sparse = words([("Goal!", 3.0, 3.5), ("Yes!", 9.0, 9.4)])
    assert "sparse" in craft.plan_jump_cuts(sparse, 0.0, 12.0, "silences")["reason"]
    assert craft.plan_jump_cuts([], 0.0, 5.0, "silences")["keeps"] == [(0.0, 5.0)]
    assert craft.plan_jump_cuts(words(), 0.3, 12.0, "off")["keeps"] == [(0.3, 12.0)]
    # A tiny island between two cuts is restored rather than left as a sub-second flash.
    island = words([("A", 0.0, 0.3), ("b.", 0.35, 0.6), ("C", 2.0, 2.2), ("D", 3.6, 3.9), ("e", 3.95, 4.3),
                    ("f.", 4.35, 4.9)])
    plan = craft.plan_jump_cuts(island, 0.0, 4.9, "silences")
    assert all(b - a >= craft.MIN_SEGMENT for a, b in plan["keeps"])


def test_captions_are_retimed_onto_the_cut_timeline():
    plan = craft.plan_jump_cuts(words(), 0.3, 12.0, "silences")
    keeps = craft.snap(plan["keeps"], 0.3)
    segments = [{"start": 0.3 + a, "end": 0.3 + b} for a, b in keeps]
    entries = media.caption_entries(transcript(), segments)
    removed_before = lambda t: sum(r["end"] - r["start"] for r in plan["removed"] if r["end"] <= t)
    timed = [w for e in entries for w in e["timed"]]
    assert [w["text"] for w in timed] == [w for w, _, _ in WORDS]
    for word, (_, start, _) in zip(timed, WORDS, strict=True):
        # Output time = source time - range start - everything removed before it (± one frame).
        assert word["start"] == pytest.approx(start - 0.3 - removed_before(start), abs=1 / 30 + 1e-6)
    total = sum(b - a for a, b in keeps)
    assert entries[-1]["end"] <= total + 1e-6
    assert all(b["start"] >= a["end"] - 1e-6 for a, b in itertools.pairwise(entries))


def test_snap_puts_cuts_on_the_frame_grid():
    snapped = craft.snap([(0.31, 2.37), (3.1, 5.0)], 0.3)
    for a, b in snapped:
        assert round(a * 30, 6).is_integer() and round(b * 30, 6).is_integer()


# ----------------------------------------------------------------- hook-first structure


def plan(**overrides):
    args = {"requested": "auto", "payoff": None, "moment": None, "key_phrase": "", "planner": [], "cold_open": False}
    return craft.plan_structure(words(), 0.3, 12.0, **{**args, **overrides})


def test_hook_first_teases_a_word_aligned_payoff_of_real_words():
    result = plan(key_phrase="Revenue grew 300% in Chicago")
    assert result["resolved"] == "hook_first"
    payoff, teaser = result["payoff"], result["teaser"]
    assert payoff["text"] == "We grew revenue 300% in Chicago." and payoff["source"] == "deterministic"
    assert teaser["end"] - teaser["start"] <= craft.TEASER_MAX
    assert not inside_word(teaser["start"]) and not inside_word(teaser["end"])
    said = " ".join(w for w, _, _ in WORDS)
    assert teaser["text"] in said  # no fabricated teaser words
    assert payoff["start"] >= 0.3 + craft.SETUP_MIN


def test_storyboard_signals_and_planner_spans_steer_the_payoff():
    loud_closer = {"interval": 1.0, "loudness": [0.1] * 10 + [1.0, 1.0], "scenes": [{"start": 10, "end": 12, "highlight": 10}]}
    assert plan(moment=loud_closer)["payoff"]["text"] == "That changed everything."
    planned = plan(payoff=(10.2, 11.7))
    assert planned["payoff"]["source"] == "planner" and planned["teaser"]["text"] == "That changed everything."


@pytest.mark.parametrize(
    "overrides,reason",
    [
        ({"requested": "linear"}, "Linear"),
        ({"cold_open": True}, "cold open"),
        ({"payoff": (0.5, 2.2)}, "stutter"),
        ({"payoff": (20.0, 25.0)}, "not inside"),
    ],
)
def test_hook_first_falls_back_to_linear_with_a_reason(overrides, reason):
    result = plan(**overrides)
    assert result["resolved"] == "linear" and reason.lower() in result["reason"].lower()


# ----------------------------------------------------------------- emphasis, punch-ins, cards


def entries_for(items=WORDS, start=0.3, end=12.0):
    return media.caption_entries(transcript(items), [{"start": start, "end": end}])


def test_emphasis_picks_numbers_and_names_once_per_cue_or_the_planner_words():
    entries = entries_for()
    heuristic = craft.choose_emphasis(entries, [], "Revenue grew 300% in Chicago")
    assert heuristic["source"] == "heuristic" and "300%" in heuristic["words"]
    per_cue = [e for e, _ in heuristic["marks"]]
    assert len(per_cue) == len(set(per_cue))
    planner = craft.choose_emphasis(entries, ["changed everything", "unicorn"], "")
    assert planner["source"] == "planner" and planner["words"] == ["changed"] and planner["ignored"] == ["unicorn"]
    # Sentence-initial capitals are not proper nouns; "I" never is.
    assert craft.emphasis_rank("So", None, set()) == 0
    assert craft.emphasis_rank("Chicago.", "in", set()) == 2
    assert craft.emphasis_rank("I", "and", set()) == 0


def test_caption_ass_restyles_only_emphasised_words_with_verbatim_text():
    entries = entries_for()
    marks = craft.choose_emphasis(entries, [], "")["marks"]
    ass = craft.caption_ass(entries, "standard", marks, font="Arial", accent="#FFD400")
    assert "\\c&H0000D4FF&\\b1\\fscx115" in ass
    plain = re.sub(r"\{[^}]*\}", "", ass)
    for word, _, _ in WORDS:
        assert word in plain
    pop = craft.caption_ass(entries, "pop", marks, font="Arial", accent=craft.POP_EMPHASIS)
    assert pop.count("Dialogue:") == len(WORDS) and "\\fscx112" in pop


def test_punch_ins_are_spaced_capped_and_skip_the_opening():
    entries = [{"start": 0, "end": 20, "text": "x", "timed": [{"text": "w", "start": t, "end": t + 0.3} for t in range(20)]}]
    marks = {(0, i) for i in range(20)}
    times = craft.punch_times(entries, marks, 20.0, after=2.0)
    assert len(times) == craft.PUNCH_MAX and times[0] >= 2.0
    assert all(b - a >= craft.PUNCH_GAP + craft.PUNCH_HOLD for a, b in itertools.pairwise(times))
    expression = craft.zoom_expression(times, 2.5)
    assert expression.startswith("1+") and expression.count("clip(") == 2 * len(times) + 1
    assert craft.zoom_expression([], None) is None


def test_title_card_flash_and_end_card_scripts():
    script = craft.overlay_ass(hook="Revenue grew 300%", hook_format="title_card", hook_seconds=2.0, font="Inter",
                               primary="#112233", accent="#FFD400", flash_at=2.5, end_card=(9.0, 10.6, "Follow for more"))
    assert "Style: Card,Inter,96" in script and "&H00332211" in script
    # Visible from the very first frame (covers and frame-0 previews show the hook).
    assert "\\fad(0,180)" in script
    assert "Dialogue: 3,0:00:02.50,0:00:02.65,Flash" in script
    assert "Follow for more" in script and "Dialogue: 4,0:00:09.00,0:00:10.60,Dim" in script
    overlay = craft.overlay_ass(hook="Plain", hook_format="overlay", hook_seconds=3.0, font="Arial",
                                primary="#000000", accent="#FFFFFF", flash_at=None, end_card=None)
    assert "Dialogue: 1,0:00:00.00,0:00:03.00,Hook,,0,0,0,,Plain" in overlay


def test_hook_grounding_lists_numbers_the_source_never_says():
    grounding = craft.hook_grounding("Revenue grew 900% in Chicago", "We grew revenue 300% in Chicago.")
    assert grounding["unsupported_numbers"] == ["900%"] and grounding["found_in_source"] == 3


# ----------------------------------------------------------------- validation and provenance


def test_edit_plan_options_are_validated_with_defaults():
    body = Render(start=0, end=5)
    assert Render(start=0, end=5, emphasis_words=["{\\b1}Chicago"]).emphasis_words == ["b1 Chicago"]
    assert (body.loudness, body.jump_cuts, body.structure, body.hook_format, body.cover) == (
        "normalize", "silences", "auto", "title_card", "best_frame")
    for bad in (
        {"end_card": "cta"},
        {"payoff_start": 1.0},
        {"payoff_start": 1.0, "payoff_end": 40.0},
        {"structure": "linear", "payoff_start": 1.0, "payoff_end": 2.0},
        {"punch_in": "emphasis", "motion": "push_in"},
        {"jump_cuts": "everything"},
        {"emphasis_words": ["{}"]},
        {"variants": {"variable": "caption_style", "values": ["pop", "pop"]}},
        {"variants": {"variable": "caption_style", "values": ["pop", "neon"]}},
        {"variants": {"variable": "opening_treatment", "values": ["cold_open", "none"]}},
        {"brand_kit": {"font_file": "/fonts/brand.ttf"}},
        {"brand_kit": {"logo_file": "logo.jpg"}},
        {"brand_kit": {"accent_color": "yellow"}},
    ):
        with pytest.raises(ValidationError):
            Render(start=0, end=5, **bad)


def test_brand_assets_are_checked_by_magic_bytes(tmp_path):
    logo = tmp_path / "logo.png"
    logo.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 10)
    assert craft.checked_file(str(logo), "logo") == logo
    fake = tmp_path / "fake.png"
    fake.write_bytes(b"GIF89a....")
    with pytest.raises(ValueError, match="not a PNG"):
        craft.checked_file(str(fake), "logo")
    with pytest.raises(ValueError, match="could not be read"):
        craft.checked_file(str(tmp_path / "missing.ttf"), "font")


def test_legacy_plans_read_as_rendered_and_revisions_inherit_craft():
    legacy = craft.with_legacy({"start": 0, "end": 5, "loudness": "normalize"})
    assert legacy["jump_cuts"] == "off" and legacy["loudness"] == "normalize" and legacy["structure"] == "linear"
    body = Render(start=0, end=5, hook="New hook")
    craft.inherit(body, {"start": 0, "end": 5})
    assert (body.loudness, body.jump_cuts, body.hook_format) == ("off", "off", "overlay")
    explicit = Render(start=0, end=5, jump_cuts="silences_and_fillers")
    craft.inherit(explicit, {})
    assert explicit.jump_cuts == "silences_and_fillers" and explicit.loudness == "off"


@pytest.mark.parametrize(
    "variable,values",
    [("hook", ["Hook A", "Hook B", "Hook C"]), ("caption_style", ["standard", "pop"]),
     ("opening_treatment", ["text_overlay", "none"]), ("structure", ["linear", "hook_first"])],
)
def test_variants_differ_in_exactly_one_variable(variable, values):
    base = Render(start=0, end=5, hook="Base hook", hook_overlay=True, variants={"variable": variable, "values": values})
    copies = craft.expand_variants(base)
    assert len(copies) == len(values)
    plans = [c.model_dump(exclude={"changed_variable", "hook_overlay"}) for c in copies]
    for one, other in itertools.pairwise(plans):
        assert {k for k in one if one[k] != other[k]} == {variable}
    groups = {craft.variant_of(c)["variant_group"] for c in copies}
    assert len(groups) == 1 and [craft.variant_of(c)["variant_value"] for c in copies] == values
    assert all(c.changed_variable == variable and c.variants is None for c in copies)


# ----------------------------------------------------------------- filter graph (mocked FFmpeg)


def crafted_commands(tmp_path, monkeypatch, **edit):
    commands = []
    monkeypatch.setattr(media, "probe", lambda _: {"duration": 12.0, "width": 1280, "height": 720, "has_audio": True})
    monkeypatch.setattr(media, "filters", lambda: " subtitles ")
    monkeypatch.setattr(media, "ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(media, "ffmpeg_version", lambda: "ffmpeg version test")
    monkeypatch.setattr(media, "verify", lambda *a, **k: {"playback_format_passed": True, "integrated_loudness": -14.1,
                                                          "playback_format": [], "captions": []})
    measured = '{"input_i" : "-30.94", "input_tp" : "-29.00", "input_lra" : "0.10", "input_thresh" : "-40.9", "target_offset" : "0.02"}'

    def process(job, command, **kwargs):
        commands.append(command)
        if command[-1] != "-" and "-filter_complex" in command:
            Path(command[-1]).write_bytes(b"mp4")
        return f"[Parsed_loudnorm_0] \n{measured}\n" if command[-1] == "-" else ""

    jobs = Mock()
    jobs.process.side_effect = process
    options = craft.CraftOptions(**edit).model_dump(exclude={"variants"})
    result = media.render(jobs, "job", tmp_path / "s.mp4", tmp_path / "out" / "c.mp4", start=0.3, end=12.0,
                          transcript=transcript(), hook="Revenue grew 300% in Chicago", framing="blur", edit=options)
    return commands, result


def graph_of(command):
    return command[command.index("-filter_complex") + 1]


def test_crafted_graph_teaser_jump_cuts_and_two_pass_loudness(tmp_path, monkeypatch):
    commands, result = crafted_commands(tmp_path, monkeypatch, punch_in="emphasis", jump_cuts="silences_and_fillers")
    measure, render = commands
    assert "print_format=json" in graph_of(measure) and "[0:v:0]" not in graph_of(measure)
    graph = graph_of(render)
    # Teaser window first, then the main range with frame-exact selects (one decoder per window).
    assert render.count("-i") == 2
    assert graph.count("select='") == 2 and "setpts=N/30/TB" in graph
    assert "measured_I=-30.94" in graph and "linear=true" in graph
    assert "concat=n=2:v=1:a=0[joined]" in graph and "afade=t=out" in graph
    assert "subtitles=c.captions.ass" in graph and "subtitles=c.hook.ass" in graph
    assert "eval=frame" in graph  # punch-ins and the teaser-cut settle zoom
    segments = result["source_segments"]
    assert segments[0]["role"] == "teaser" and all(s["role"] == "main" for s in segments[1:])
    record = result["craft"]
    assert result["structure"] == "hook_first" and record["structure"]["teaser"]["text"].startswith("We grew")
    assert record["jump_cuts"]["fillers_removed"] == ["um"]
    assert record["loudness"]["method"] == "two_pass" and record["loudness"]["output_lufs"] == -14.1
    assert record["hook"]["format"] == "title_card" and record["punch_in"]["times"]
    assert record["caption_emphasis"]["words"]


def test_crafted_graph_respects_off_switches_and_duration_limit(tmp_path, monkeypatch):
    commands, result = crafted_commands(
        tmp_path, monkeypatch, loudness="off", jump_cuts="off", structure="linear", caption_emphasis="off",
        hook_format="overlay",
    )
    assert len(commands) == 1
    graph = graph_of(commands[0])
    assert "loudnorm" not in graph and "eval=frame" not in graph
    assert "force_style" in graph  # plain SRT captions when nothing needs per-word styling
    assert result["source_segments"] == [{"role": "main", "start": 0.3, "end": 12.0}]
    assert result["craft"]["structure"]["resolved"] == "linear"


def test_explicit_hook_first_without_a_payoff_fails_before_rendering(tmp_path, monkeypatch):
    with pytest.raises(WorkError, match="Hook-first"):
        crafted_commands(tmp_path, monkeypatch, structure="hook_first", payoff_start=0.5, payoff_end=2.2)


# ----------------------------------------------------------------- API: provenance, variants, revisions


def test_api_records_craft_and_renders_variants_as_linked_versions(client, monkeypatch):
    calls = []
    fake_media(monkeypatch, client, calls)
    video = upload_mock(client, monkeypatch)
    first = rendered(client, direct(client, video["id"], hook="First", hook_overlay=True, jump_cuts="off"))
    assert first["edit_plan"]["jump_cuts"] == "off" and calls[-1]["edit"]["loudness"] == "normalize"
    assert "variants" not in first["edit_plan"]
    response = direct(client, video["id"], hook="Base", hook_overlay=True,
                      variants={"variable": "hook", "values": ["Hook A", "Hook B"]})
    job = wait_job(client, response.json()["id"], timeout=60)
    assert job["status"] == "completed", job
    clips = [client.app.state.store.get("clips", i) for i in job["result"]["clip_ids"]]
    assert [c["hook"] for c in clips] == ["Hook A", "Hook B"]
    assert len({c["variant_group"] for c in clips}) == 1 and job["result"]["variant_variable"] == "hook"
    assert all(c["changed_variable"] == "hook" for c in clips)
    one, other = (c["edit_plan"] for c in clips)
    assert {k for k in one if one[k] != other[k]} == {"hook"}
    # A revision of a pre-craft clip keeps what that clip was rendered with, except what it changes.
    store = client.app.state.store
    legacy = dict(first, id="legacy", edit_plan={k: v for k, v in first["edit_plan"].items() if k not in craft.CRAFT_FIELDS})
    store.put("clips", legacy)
    revision = rendered(client, direct(client, video["id"], hook="Revised", hook_overlay=True,
                                       parent_clip_id="legacy", change_reason="Sharper hook"))
    assert revision["edit_plan"]["loudness"] == "off" and revision["edit_plan"]["jump_cuts"] == "off"
    assert [c["field"] for c in revision["plan_changes"]] == ["hook"]


# ----------------------------------------------------------------- real renders (tiny synthetic sources)


def talky_source(tmp_path):
    path = tmp_path / "talk.mp4"
    voice = "+".join(f"between(t,{a},{b})" for _, a, b in WORDS)
    subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=12",
         "-f", "lavfi", "-i", f"aevalsrc='0.05*sin(2*PI*300*t)*({voice})':s=48000:d=12",
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path)],
        check=True, capture_output=True, timeout=60,
    )
    return path


def run_render(tmp_path, source, **edit):
    store = Store(tmp_path / "store")
    jobs = Jobs(store)
    output = tmp_path / "clips" / "abc123.mp4"
    options = craft.CraftOptions(**edit).model_dump(exclude={"variants"})
    try:
        job = jobs.submit("render", lambda identifier: media.render(
            jobs, identifier, source, output, start=0.3, end=12.0, transcript=transcript(),
            hook="Revenue grew 300% in Chicago", framing="blur", edit=options))
        final = wait_job_store(store, job["id"])
    finally:
        jobs.close()
    return output, final


def wait_job_store(store, identifier, timeout=120):
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = store.get("jobs", identifier)
        if job["status"] in {"completed", "failed", "cancelled"}:
            return job
        time.sleep(0.05)
    pytest.fail("render did not finish")


@pytest.mark.skipif(not HAS_FFMPEG, reason="FFmpeg is not installed")
def test_real_crafted_render_is_vertical_loudness_normalised_and_tighter(tmp_path):
    if " subtitles " not in media.filters() or " loudnorm " not in media.filters():
        pytest.skip("FFmpeg lacks libass or loudnorm")
    source = talky_source(tmp_path)
    output, final = run_render(tmp_path, source, punch_in="emphasis", end_card="cta", cta_text="Follow for part 2",
                               jump_cuts="silences_and_fillers")
    assert final["status"] == "completed", final
    result = final["result"]
    actual = media.probe(output)
    assert (actual["width"], actual["height"]) == (1080, 1920) and actual["has_audio"]
    checks = {c["id"]: c for c in result["technical_checks"]["playback_format"]}
    assert all(c["status"] == "pass" for c in checks.values()), checks
    lufs = media.integrated_loudness(Mock(process=lambda job, cmd, **k: subprocess.run(
        cmd, capture_output=True, text=True, check=True).stderr), "job", output)
    assert lufs == pytest.approx(-14.0, abs=1.0)
    record = result["craft"]
    teaser = record["structure"]["teaser"]
    # Shorter than the 11.7 s range plus its teaser: pauses and the filler are gone.
    assert actual["duration"] < 11.7 + (teaser["end"] - teaser["start"]) - 2.0
    assert actual["duration"] == pytest.approx(record["output_seconds"], abs=0.1)
    assert result["structure"] == "hook_first"
    cover = tmp_path / "cover.jpg"
    chosen = media.write_cover(Mock(process=lambda job, cmd, **k: subprocess.run(cmd, check=True)), "job", output,
                               cover, mode="best_frame", avoid=[(record["end_card"]["start"], 99)])
    assert cover.exists() and chosen["mode"] == "best_frame" and chosen["time"] < record["end_card"]["start"]
    assert json.loads(json.dumps(record))  # provenance is plain JSON
