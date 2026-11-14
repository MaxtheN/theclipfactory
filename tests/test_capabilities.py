import pytest

from clip_factory import capabilities as caps
from clip_factory.store import Store


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path)


def requests(store, supported=()):
    return caps.CapabilityRequests(store, supported_fn=lambda: set(supported))


def test_catalog_is_derived_from_craft_options():
    supported = {item["capability"]: item for item in caps.supported(reg=None)}
    assert supported["jump_cuts"]["values"] == ["off", "silences", "silences_and_fillers"]
    assert supported["hook_format"]["default"] == "title_card"
    assert "progress_bar" not in supported
    unsupported = {item["capability"] for item in caps.catalog()["unsupported"]}
    assert {"progress_bar", "background_music_bed", "split_screen_two_speakers"} <= unsupported


def test_keyword_detection_quotes_text_and_respects_negation():
    hits = caps.classify_text("Top reels all show a progress bar at the bottom. Hooks are short.")
    assert hits == [{"capability": "progress_bar", "quote": "Top reels all show a progress bar at the bottom."}]
    assert caps.classify_text("Please keep it clean, no progress bar.") == []
    found = {h["capability"] for h in caps.classify_text("Add a lower third with the guest's name and some sfx")}
    assert found == {"speaker_name_lower_third", "sound_effect_on_hook"}


def seed(store):
    store.put("reference_research", {
        "id": "rr_1", "references": [{"id": "ref1", "observations": [
            {"id": "o1", "statement": "A thin progress bar fills along the top edge throughout."}]}],
        "observations": [], "pattern": {"pattern": "Speakers are stacked in a split-screen layout.", "hypothesis": ""},
    })
    store.put("clips", {"id": "clip1", "team_findings": [
        {"message": "Cuts feel jarring; a zoom transition on cut would hide them."}],
        "change_reason": "Add a progress bar please"})
    store.put("feedback", {"id": "fb1", "clip_id": "clip1", "notes": "Needs a progress bar like the references."})
    store.put("beliefs", {"id": "b1", "statement": "Clips with a lower third naming the speaker hold attention",
                          "rationale": ""})


def test_scan_dedupes_by_capability_and_counts_distinct_evidence(store):
    seed(store)
    reqs = requests(store)
    reqs.scan()
    rows = {r["capability"]: r for r in reqs.all()}
    assert set(rows) == {"progress_bar", "split_screen_two_speakers", "zoom_transition_on_cut",
                         "speaker_name_lower_third"}
    bar = rows["progress_bar"]
    assert bar["id"] == "cap_progress_bar" and bar["status"] == "detected"
    assert bar["demand_count"] == 3
    assert {e["source"] for e in bar["evidence"]} == {"reference_observation", "change_request", "feedback"}
    assert rows["split_screen_two_speakers"]["buildable"] is False
    # A second scan of the same records adds nothing.
    reqs.scan()
    assert reqs.get("cap_progress_bar")["demand_count"] == 3
    assert reqs.all()[0]["capability"] == "progress_bar"  # most demanded first


def test_already_supported_capability_is_not_requested_and_open_requests_merge(store):
    reqs = requests(store, supported={"progress_bar"})
    assert reqs.add_evidence("progress_bar", [{"source": "feedback", "id": "x", "quote": "progress bar"}]) is None
    other = requests(store)
    other.add_evidence("progress_bar", [{"source": "feedback", "id": "x", "quote": "progress bar"}])
    assert reqs.mark_merged() == ["cap_progress_bar"]
    assert reqs.get("cap_progress_bar")["status"] == "merged"


def test_demo_request_is_labelled_until_real_evidence_arrives(store):
    reqs = requests(store)
    demo = reqs.demo()
    assert demo["demo"] is True and demo["evidence"][0]["source"] == "demo"
    assert reqs.demo()["demand_count"] == 1  # idempotent
    reqs.record_text("change_request", "clip9", "Can we get a progress bar on this one?")
    record = reqs.get("cap_progress_bar")
    assert record["demo"] is False and record["demand_count"] == 2


def test_status_transitions_are_enforced(store):
    reqs = requests(store)
    reqs.demo()
    with pytest.raises(ValueError):
        reqs.transition("cap_progress_bar", "merged")
    reqs.transition("cap_progress_bar", "work_order")
    reqs.transition("cap_progress_bar", "building")
    reqs.transition("cap_progress_bar", "ready_for_review")
    assert [h["status"] for h in reqs.get("cap_progress_bar")["history"]] == [
        "detected", "work_order", "building", "ready_for_review"]
    with pytest.raises(KeyError):
        reqs.transition("cap_nope", "work_order")


def test_model_classification_must_quote_the_text(store):
    store.put("feedback", {"id": "f1", "clip_id": "c", "notes": "It would be nice to see time remaining somehow."})
    store.put("feedback", {"id": "f2", "clip_id": "c", "notes": "Show how much is left of the video."})

    def complete(system, user, schema):
        assert "progress_bar" in user and "Text:" in user
        if "time remaining" in user:
            return {"matches": [{"capability": "progress_bar", "quote": "see time remaining somehow"}]}
        return {"matches": [{"capability": "progress_bar", "quote": "invented words not in the text"}]}

    reqs = requests(store)
    reqs.scan(classify=caps.model_classifier(complete))
    record = reqs.get("cap_progress_bar")
    assert record["demand_count"] == 1
    assert record["evidence"][0]["id"] == "f1" and record["evidence"][0]["by"] == "model"
