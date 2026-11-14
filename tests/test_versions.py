# ruff: noqa: F811
"""Clip versions: technical checks, opening variants, revisions, retries, transcripts and exports."""

import hashlib
import json
import shutil
import subprocess
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from test_app import client, seed_clip, upload_mock, wait_job  # noqa: F401
from test_campaign_api import setup_campaign

from clip_factory import media
from clip_factory.jobs import Jobs, WorkError
from clip_factory.store import Store

HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def libass() -> bool:
    filters = subprocess.run(
        ["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True, timeout=10, check=False
    )
    return " subtitles " in filters.stdout


def wait(store, identifier, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = store.get("jobs", identifier)
        if job["status"] in {"completed", "failed", "cancelled"}:
            return job
        time.sleep(0.02)
    pytest.fail(f"Job did not terminate: {job}")


def fake_media(monkeypatch, client, calls=None, fail=None):
    """Fast stand-in for FFmpeg: each distinct plan writes distinct bytes."""

    def render(jobs, job, source, output, **kwargs):
        if calls is not None:
            calls.append(kwargs)
        if fail and fail():
            raise WorkError("Rendered file failed playback/format checks, so no clip was saved.")
        output.write_bytes(json.dumps(kwargs, sort_keys=True, default=str).encode())
        return {
            "subtitles_burned": False,
            "hook_rendered": bool(kwargs.get("hook")),
            "duration": kwargs["end"] - kwargs["start"],
        }

    monkeypatch.setattr("clip_factory.media.render", render)
    monkeypatch.setattr("clip_factory.media.ffmpeg", lambda: "mock-ffmpeg")
    monkeypatch.setattr(client.app.state.jobs, "process", lambda *a, **k: "")


def direct(client, video_id, **body):
    return client.post(
        f"/api/videos/{video_id}/render", json={"start": 0, "end": 2, "subtitles": False, **body}
    )


def rendered(client, response):
    assert response.status_code == 202, response.text
    job = wait_job(client, response.json()["id"], timeout=60)
    assert job["status"] == "completed", job
    return client.app.state.store.get("clips", job["result"]["clip_id"])


def file_hash(client, clip):
    return hashlib.sha256((client.app.state.root / clip["path"]).read_bytes()).hexdigest()


# Media units


def test_word_captions_follow_each_segment_on_the_output_timeline():
    transcript = {
        "segments": [
            {
                "start": 0.0,
                "end": 2.0,
                "text": "ignored when word timings exist",
                "words": [
                    {"word": " One", "start": 0.0, "end": 0.2},
                    {"word": " two.", "start": 0.3, "end": 0.5},
                    {"word": " Three", "start": 1.6, "end": 1.9},
                ],
            },
            {"start": 4.0, "end": 6.0, "text": " Main {\\b1}point"},
        ]
    }
    entries = media.caption_entries(transcript, [{"start": 1.5, "end": 2.0}, {"start": 4.0, "end": 5.0}])
    assert [e["text"] for e in entries] == ["Three", "Main (/b1)point"]
    # The short word cue is held for readability but never past its own segment.
    assert entries[0]["start"] == pytest.approx(0.1) and entries[0]["end"] == pytest.approx(0.5)
    assert entries[1]["start"] == pytest.approx(0.5) and entries[1]["end"] == pytest.approx(1.5)
    words = [{"word": f" w{i}", "start": i * 0.2, "end": i * 0.2 + 0.15} for i in range(10)]
    chunks = media.caption_entries(
        {"segments": [{"start": 0, "end": 2, "text": "x", "words": words}]}, [{"start": 0, "end": 2}]
    )
    assert [len(e["text"].split()) for e in chunks] == [media.CAPTION_MAX_WORDS, 3]
    malformed = {"segments": [{"start": 0, "end": 1, "text": "Segment text", "words": [{"word": "x"}]}]}
    assert [e["text"] for e in media.caption_entries(malformed, [{"start": 0, "end": 1}])] == ["Segment text"]


def test_imported_transcripts_are_validated_against_the_source():
    srt = "1\n00:00:00,500 --> 00:00:01,250\nHello <i>there</i>\nfriend\n\n2\n00:00:02,000 --> 00:00:03,000\nSecond\n"
    assert media.parse_transcript("srt", srt, 4)["segments"] == [
        {"start": 0.5, "end": 1.25, "text": "Hello there friend"},
        {"start": 2.0, "end": 3.0, "text": "Second"},
    ]
    vtt = "WEBVTT\n\nNOTE made elsewhere\n\ncue-1\n00:01.000 --> 00:02.000 align:start\nVTT words\n"
    assert media.parse_transcript("vtt", vtt, 4)["segments"] == [
        {"start": 1.0, "end": 2.0, "text": "VTT words"}
    ]
    data = json.dumps(
        {
            "language": "en",
            "segments": [
                {"start": 0, "end": 1, "text": "Json", "words": [{"word": "Json", "start": 0.1, "end": 0.6}]}
            ],
        }
    )
    parsed = media.parse_transcript("json", data, 4)
    assert parsed["language"] == "en"
    assert parsed["segments"][0]["words"] == [{"word": "Json", "start": 0.1, "end": 0.6}]
    for kind, content, message in [
        ("srt", "1\n00:00:02,000 --> 00:00:01,000\nBackwards\n", "start time before"),
        ("srt", "1\n00:00:09,000 --> 00:00:10,000\nLate\n", "within the source"),
        ("srt", "no cues here", "no timed text"),
        ("srt", "1\n00:00:aa --> 00:00:01,000\nBad\n", "Unreadable"),
        ("json", "{", "not valid JSON"),
        ("json", json.dumps({"segments": "x"}), "list of segments"),
    ]:
        with pytest.raises(WorkError, match=message):
            media.parse_transcript(kind, content, 4)


def test_faststart_layout_is_read_from_top_level_boxes(tmp_path):
    def box(kind, payload=b""):
        return (8 + len(payload)).to_bytes(4, "big") + kind + payload

    good, bad = tmp_path / "good.mp4", tmp_path / "bad.mp4"
    good.write_bytes(box(b"ftyp", b"isom") + box(b"moov", b"meta") + box(b"mdat", b"data"))
    bad.write_bytes(box(b"ftyp", b"isom") + box(b"mdat", b"data") + box(b"moov"))
    assert media.moov_before_mdat(good) is True
    assert media.moov_before_mdat(bad) is False
    assert media.moov_before_mdat(tmp_path / "missing.mp4") is None


def test_failed_playback_checks_discard_the_render(tmp_path, monkeypatch):
    output = tmp_path / "clips" / "abc.mp4"
    jobs = Mock()
    monkeypatch.setattr(media, "ffmpeg", lambda: "/mock/ffmpeg")
    monkeypatch.setattr(media.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout=" subtitles "))

    def encode(*args, **kwargs):
        output.with_name("abc.partial.mp4").write_bytes(b"encoded")
        return ""

    jobs.process.side_effect = encode
    monkeypatch.setattr(
        media, "probe", lambda _: {"duration": 1, "width": 720, "height": 1280, "has_audio": False}
    )
    failing = [
        {"id": "dimensions", "label": "1080 × 1920 vertical", "status": "fail", "detail": "720 × 1280"}
    ]
    monkeypatch.setattr(
        media,
        "verify",
        lambda *a, **k: {"playback_format_passed": False, "playback_format": failing, "captions": []},
    )
    with pytest.raises(WorkError, match="no clip was saved.*720 × 1280"):
        media.render(
            jobs,
            "job",
            tmp_path / "source.mp4",
            output,
            start=0,
            end=1,
            transcript={"segments": [{"start": 0, "end": 1, "text": "Words"}]},
            hook="Hook",
        )
    assert not list(output.parent.iterdir())  # no clip, partial, captions or hook file left behind


@pytest.mark.skipif(not HAS_FFMPEG, reason="FFmpeg required")
@pytest.mark.parametrize("audio", [True, False])
def test_real_cold_open_joins_segments_and_passes_checks(tmp_path, audio):
    if not libass():
        pytest.skip("libass required")
    source = tmp_path / "source.mp4"
    command = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=3"]
    if audio:
        command += ["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "aac", "-shortest"]
    command += ["-c:v", "libx264", "-pix_fmt", "yuv420p", str(source)]
    subprocess.run(command, check=True, capture_output=True, timeout=30)
    store, output = Store(tmp_path), tmp_path / "clips" / "abc123.mp4"
    jobs = Jobs(store)
    transcript = (
        {
            "segments": [
                {"start": 0.5, "end": 1.0, "text": "Cold words"},
                {"start": 2.0, "end": 2.8, "text": "Main words"},
            ]
        }
        if audio
        else None
    )
    try:
        job = jobs.submit(
            "render",
            lambda identifier: media.render(
                jobs,
                identifier,
                source,
                output,
                start=2.0,
                end=3.0,
                transcript=transcript,
                framing="fill",
                focus_x=0.25,
                hook="" if audio else "Hook text",
                cold_open=(0.5, 1.0),
                has_audio=audio,
            ),
        )
        final = wait(store, job["id"])
        assert final["status"] == "completed", final
        result = final["result"]
        checks = result["technical_checks"]
        assert checks["playback_format_passed"], checks
        statuses = {c["id"]: c["status"] for c in checks["playback_format"]}
        assert statuses["duration"] == statuses["faststart"] == statuses["dimensions"] == "pass"
        assert result["source_segments"] == [
            {"role": "cold_open", "start": 0.5, "end": 1.0},
            {"role": "main", "start": 2.0, "end": 3.0},
        ]
        assert result["duration"] == pytest.approx(1.5, abs=0.07)
        assert media.probe(output)["has_audio"] is audio
        if audio:
            text = output.with_suffix(".srt").read_text()
            assert "00:00:00,000 --> 00:00:00,500\nCold words" in text
            assert "00:00:00,500 --> 00:00:01,300\nMain words" in text
            assert statuses["audio_stream"] == "pass"
            assert {c["id"]: c["status"] for c in checks["captions"]}["timing"] == "pass"
        else:
            assert result["hook_rendered"] and statuses["audio_stream"] == "not_applicable"
    finally:
        jobs.close()


def test_jobs_record_start_and_finish_times(tmp_path):
    store = Store(tmp_path)
    jobs = Jobs(store)
    try:
        final = wait(store, jobs.submit("render", lambda _: {"ok": True})["id"])
        assert final["created_at"] <= final["started_at"] <= final["finished_at"]
    finally:
        jobs.close()


# API rules (fast, FFmpeg stubbed)


def test_revisions_link_to_parent_and_need_fresh_review(client, monkeypatch):
    fake_media(monkeypatch, client)
    store = client.app.state.store
    video = upload_mock(client, monkeypatch)
    first = rendered(client, direct(client, video["id"], hook="First", hook_overlay=True))
    assert first["revision_number"] == 1 and first["parent_clip_id"] is None
    assert first["opening_treatment"] == "text_overlay"
    assert first["sha256"] == file_hash(client, first)
    assert (client.app.state.root / first["path"]).stat().st_mode & 0o222 == 0
    receipt = first["render_receipt"]
    assert receipt["attempt"] == 1 and receipt["cost"] == {
        "status": "known",
        "amount": 0.0,
        "currency": "USD",
        "basis": "Rendered locally with FFmpeg; no paid or external service was called.",
        "excluded": ["hardware", "electricity", "human time"],
    }
    assert client.put(f"/api/clips/{first['id']}", json={"approved": True}).status_code == 200

    def revise(**body):
        return direct(client, video["id"], hook_overlay=True, parent_clip_id=first["id"], **body)

    unchanged = revise(hook="First", change_reason="Try again")
    assert unchanged.status_code == 422 and "changes no edit decision" in unchanged.json()["detail"]
    assert revise(hook="Second").status_code == 422  # a revision explains the requested change
    assert direct(client, video["id"], change_reason="No parent").status_code == 422
    second = rendered(client, revise(hook="Sharper hook", change_reason="Creator asked for a sharper hook"))
    assert second["parent_clip_id"] == second["root_clip_id"] == first["id"]
    assert second["revision_number"] == 2 and not second["approved"]
    assert second["change_reason"] == "Creator asked for a sharper hook"
    assert second["plan_changes"] == [{"field": "hook", "before": "First", "after": "Sharper hook"}]
    parent = store.get("clips", first["id"])
    assert parent["approved"] and parent["sha256"] == first["sha256"] == file_hash(client, parent)
    third = rendered(
        client,
        direct(
            client,
            video["id"],
            end=1.5,
            hook="Sharper hook",
            hook_overlay=True,
            parent_clip_id=second["id"],
            change_reason="Shorter",
        ),
    )
    assert third["root_clip_id"] == first["id"] and third["revision_number"] == 3
    assert third["plan_changes"] == [{"field": "end", "before": 2.0, "after": 1.5}]
    assert client.delete(f"/api/clips/{first['id']}").status_code == 409
    assert client.delete(f"/api/clips/{second['id']}").status_code == 409
    assert client.delete(f"/api/clips/{third['id']}").status_code == 200
    other = upload_mock(client, monkeypatch)
    wrong_source = direct(
        client, other["id"], hook="Other", hook_overlay=True, parent_clip_id=first["id"], change_reason="x"
    )
    assert wrong_source.status_code == 422


def test_failed_render_retry_is_explicit_and_bounded(client, monkeypatch):
    state = {"fail": True}
    fake_media(monkeypatch, client, fail=lambda: state["fail"])
    video = upload_mock(client, monkeypatch)

    def retry(job_id):
        return direct(client, video["id"], retry_of_job_id=job_id)

    first = wait_job(client, direct(client, video["id"]).json()["id"])
    assert first["status"] == "failed" and "no clip was saved" in first["error"]
    assert first["started_at"] <= first["finished_at"]
    assert client.get("/api/clips").json() == []
    second = wait_job(client, retry(first["id"]).json()["id"])
    assert second["context"]["attempt"] == 2 and second["context"]["retry_of_job_id"] == first["id"]
    assert retry(first["id"]).status_code == 409  # one linear chain of attempts
    third = wait_job(client, retry(second["id"]).json()["id"])
    assert third["context"]["attempt"] == 3
    blocked = retry(third["id"])
    assert blocked.status_code == 409 and "failed 3 times" in blocked.json()["detail"]
    fresh = wait_job(client, direct(client, video["id"]).json()["id"])
    state["fail"] = False
    recovered = wait_job(client, retry(fresh["id"]).json()["id"])
    assert recovered["status"] == "completed", recovered
    clip = client.app.state.store.get("clips", recovered["result"]["clip_id"])
    assert clip["render_receipt"]["attempt"] == 2 and clip["render_receipt"]["retry_of_job_id"] == fresh["id"]
    assert retry(recovered["id"]).status_code == 409
    other = upload_mock(client, monkeypatch)
    assert direct(client, other["id"], retry_of_job_id=fresh["id"]).status_code == 422


def test_captioned_speech_needs_transcript_and_imports_record_origin(client, monkeypatch):
    calls = []
    fake_media(monkeypatch, client, calls)
    video = upload_mock(client, monkeypatch, has_audio=True)
    blocked = client.post(f"/api/videos/{video['id']}/render", json={"start": 0, "end": 2})
    assert blocked.status_code == 409 and "transcript" in blocked.json()["detail"]
    uncaptioned = rendered(client, direct(client, video["id"]))
    assert uncaptioned["transcript_origin"] is None
    late = "1\n00:00:09,000 --> 00:00:10,000\nLate\n"
    assert (
        client.put(
            f"/api/videos/{video['id']}/transcript", json={"format": "srt", "content": late}
        ).status_code
        == 422
    )
    srt = "1\n00:00:00,000 --> 00:00:01,500\nReal words\n"
    imported = client.put(
        f"/api/videos/{video['id']}/transcript", json={"format": "srt", "content": srt, "language": "en"}
    )
    assert imported.status_code == 200, imported.text
    body = imported.json()
    assert body["transcript_origin"] == "imported" and body["transcript"]["language"] == "en"
    assert body["transcript"]["segments"] == [{"start": 0.0, "end": 1.5, "text": "Real words"}]
    assert "path" not in body
    clip = rendered(client, client.post(f"/api/videos/{video['id']}/render", json={"start": 0, "end": 2}))
    assert clip["transcript_origin"] == "imported"
    assert calls[-1]["transcript"]["segments"][0]["text"] == "Real words"
    missing = client.put("/api/videos/missing/transcript", json={"format": "srt", "content": srt})
    assert missing.status_code == 404


def test_opening_treatments_are_validated(client, monkeypatch):
    calls = []
    fake_media(monkeypatch, client, calls)
    video = upload_mock(client, monkeypatch)

    def post(**body):
        return direct(client, video["id"], start=2, end=4, **body)

    assert post(opening_treatment="cold_open").status_code == 422
    assert post(opening_treatment="cold_open", cold_open_start=1, cold_open_end=1.2).status_code == 422
    assert post(opening_treatment="cold_open", cold_open_start=4, cold_open_end=6).status_code == 422
    assert post(cold_open_start=0, cold_open_end=1).status_code == 422
    assert post(opening_treatment="text_overlay").status_code == 422
    clip = rendered(
        client,
        post(
            opening_treatment="cold_open",
            cold_open_start=0.5,
            cold_open_end=1.5,
            hook="Post hook",
            hook_overlay=True,
            changed_variable="opening_treatment",
        ),
    )
    assert calls[-1]["cold_open"] == (0.5, 1.5) and calls[-1]["has_audio"] is False
    assert not calls[-1].get("hook")  # a cold open replaces the text overlay
    assert clip["opening_treatment"] == "cold_open" and clip["changed_variable"] == "opening_treatment"
    assert clip["edit_plan"]["cold_open_start"] == 0.5 and not clip["edit_plan"]["hook_overlay"]
    assert clip["hook"] == "Post hook"


def test_campaign_revisions_stay_in_campaign_and_profile(client, monkeypatch):
    calls = []
    fake_media(monkeypatch, client, calls)
    video = upload_mock(client, monkeypatch)
    profiles, _, version, path = setup_campaign(client, [video])

    def post(profile, **body):
        return client.post(
            path + "/render",
            json={"video_id": video["id"], "profile_id": profile["id"], "subtitles": False, **body},
        )

    first = rendered(client, post(profiles[0]))
    assert first["opening_treatment"] == "text_overlay" and calls[-1]["hook"] == "Original hook"
    cold = rendered(
        client,
        post(
            profiles[0],
            opening_treatment="cold_open",
            cold_open_start=2,
            cold_open_end=3,
            changed_variable="opening_treatment",
        ),
    )
    assert cold["opening_treatment"] == "cold_open" and not cold["hook_rendered"]
    assert calls[-1]["cold_open"] == (2, 3) and cold["strategy_version_id"] == version["id"]
    assert post(profiles[1], parent_clip_id=first["id"], change_reason="x", hook="New").status_code == 422
    outside = client.post(
        f"/api/videos/{video['id']}/render",
        json={"start": 0, "end": 1, "hook": "New", "parent_clip_id": first["id"], "change_reason": "x"},
    )
    assert outside.status_code == 422
    revision = rendered(
        client, post(profiles[0], parent_clip_id=first["id"], change_reason="Sharper", hook="Sharper hook")
    )
    assert revision["parent_clip_id"] == first["id"] and revision["revision_number"] == 2
    assert revision["plan_changes"] == [{"field": "hook", "before": "Original hook", "after": "Sharper hook"}]
    assert revision["campaign_id"] == first["campaign_id"] and revision["profile_id"] == profiles[0]["id"]


def test_export_copies_the_approved_version_with_a_manifest(client, monkeypatch):
    fake_media(monkeypatch, client)
    store = client.app.state.store
    video = upload_mock(client, monkeypatch)
    clip = rendered(client, direct(client, video["id"], hook="Export me", hook_overlay=True))
    assert client.post(f"/api/clips/{clip['id']}/export").status_code == 409
    assert client.put(f"/api/clips/{clip['id']}", json={"approved": True}).status_code == 200
    clip = store.get("clips", clip["id"])
    response = client.post(f"/api/clips/{clip['id']}/export")
    assert response.status_code == 201, response.text
    export = response.json()
    manifest = export["manifest"]
    assert export["sha256"] == manifest["video"]["sha256"] == clip["sha256"]
    assert manifest["schema"] == "clip-factory/export-manifest@1"
    assert manifest["review"] == {"state": "approved", "approved_at": clip["approved_at"]}
    assert manifest["edit_plan"] == clip["edit_plan"] and manifest["opening_treatment"] == "text_overlay"
    assert manifest["clip"]["revision_number"] == 1 and manifest["clip"]["checksum_recorded_at_render"]
    assert manifest["render_receipt"] == clip["render_receipt"]
    folder = Path(export["location"])
    assert folder.parent == client.app.state.root / "exports"
    exported = folder / export["file"]
    assert hashlib.sha256(exported.read_bytes()).hexdigest() == clip["sha256"]
    assert export["file"].startswith("export-me-r1-")
    assert json.loads((folder / "manifest.json").read_text()) == manifest
    assert client.get(f"/api/exports/{export['id']}/manifest").json() == manifest
    assert client.get(f"/api/exports/{export['id']}/download").content == exported.read_bytes()
    assert [e["id"] for e in client.get("/api/exports", params={"clip_id": clip["id"]}).json()] == [
        export["id"]
    ]
    assert client.delete(f"/api/clips/{clip['id']}").status_code == 409
    # A file changed after render is not exported as the reviewed version.
    path = client.app.state.root / clip["path"]
    path.chmod(0o644)
    path.write_bytes(b"changed")
    tampered = client.post(f"/api/clips/{clip['id']}/export")
    assert tampered.status_code == 409 and "changed after it was rendered" in tampered.json()["detail"]
    # Changing post copy withdraws approval, so the next export needs review again.
    assert client.put(f"/api/clips/{clip['id']}", json={"caption": "New copy"}).json()["approved_at"] is None


def test_legacy_clip_without_checksum_exports_with_flag(client):
    seed_clip(client, approved=True)
    response = client.post("/api/clips/testclip/export")
    assert response.status_code == 201, response.text
    assert not response.json()["manifest"]["clip"]["checksum_recorded_at_render"]
    assert response.json()["sha256"] == hashlib.sha256(b"local-media").hexdigest()


# Real end-to-end proof


@pytest.mark.skipif(not HAS_FFMPEG, reason="FFmpeg required")
def test_real_hook_variants_revision_and_verified_export(client, tmp_path):
    if not libass():
        pytest.skip("libass required")
    file = tmp_path / "speech.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=320x180:r=30:d=4",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=4",
            "-shortest",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            str(file),
        ],
        check=True,
        capture_output=True,
        timeout=30,
    )
    with file.open("rb") as source:
        response = client.post("/api/videos", files={"file": (file.name, source, "video/mp4")})
    assert response.status_code == 201, response.text
    video = response.json()
    assert video["has_audio"]
    profiles, _campaign, version, path = setup_campaign(client, [video], duration=1.5)
    store = client.app.state.store

    def render(**body):
        return client.post(
            path + "/render",
            json={"video_id": video["id"], "profile_id": profiles[0]["id"], "start": 2, **body},
        )

    assert render().status_code == 409  # speech without a transcript is not captioned with invented text
    srt = "1\n00:00:00,200 --> 00:00:01,000\nCold open line\n\n2\n00:00:02,000 --> 00:00:03,400\nMain point line\n"
    imported = client.put(f"/api/videos/{video['id']}/transcript", json={"format": "srt", "content": srt})
    assert imported.status_code == 200, imported.text

    text = rendered(
        client,
        render(opening_treatment="text_overlay", hook="Text hook", changed_variable="opening_treatment"),
    )
    cold = rendered(
        client,
        render(
            opening_treatment="cold_open",
            cold_open_start=0.2,
            cold_open_end=1.0,
            changed_variable="opening_treatment",
        ),
    )
    assert text["opening_treatment"] == "text_overlay" and text["hook_rendered"]
    assert cold["opening_treatment"] == "cold_open" and not cold["hook_rendered"]
    assert cold["source_segments"] == [
        {"role": "cold_open", "start": 0.2, "end": 1.0},
        {"role": "main", "start": 2.0, "end": 3.5},
    ]
    assert text["duration"] == pytest.approx(1.5, abs=0.07)
    assert cold["duration"] == pytest.approx(2.3, abs=0.07)
    for clip in (text, cold):
        assert clip["technical_checks"]["playback_format_passed"], clip["technical_checks"]
        assert clip["transcript_origin"] == "imported" and clip["sha256"] == file_hash(client, clip)
        assert media.probe(client.app.state.root / clip["path"])["has_audio"]
    assert "Cold open line" in (client.app.state.root / cold["path"]).with_suffix(".srt").read_text()

    def first_frame(clip):
        raw = subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-i",
                str(client.app.state.root / clip["path"]),
                "-frames:v",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "pipe:1",
            ],
            capture_output=True,
            check=True,
        ).stdout
        return hashlib.sha256(raw).hexdigest()

    assert first_frame(text) != first_frame(cold)  # the two openings differ in the rendered video

    assert client.put(f"/api/clips/{text['id']}", json={"approved": True}).status_code == 200
    revision = rendered(
        client,
        render(
            opening_treatment="text_overlay",
            hook="Sharper text hook",
            parent_clip_id=text["id"],
            change_reason="Creator asked for a sharper opening line",
        ),
    )
    assert revision["parent_clip_id"] == text["id"] and revision["revision_number"] == 2
    assert not revision["approved"]
    assert revision["plan_changes"] == [
        {"field": "hook", "before": "Text hook", "after": "Sharper text hook"}
    ]
    assert first_frame(revision) != first_frame(text)
    earlier = store.get("clips", text["id"])
    assert earlier["approved"] and file_hash(client, earlier) == text["sha256"]

    assert client.post(f"/api/clips/{revision['id']}/export").status_code == 409
    assert client.put(f"/api/clips/{revision['id']}", json={"approved": True}).status_code == 200
    response = client.post(f"/api/clips/{revision['id']}/export")
    assert response.status_code == 201, response.text
    export = response.json()
    folder = Path(export["location"])
    exported = folder / export["file"]
    assert hashlib.sha256(exported.read_bytes()).hexdigest() == revision["sha256"] == export["sha256"]
    assert media.probe(exported) == {
        "duration": pytest.approx(1.5, abs=0.07),
        "width": 1080,
        "height": 1920,
        "has_audio": True,
        "hdr": False,
    }
    manifest = json.loads((folder / "manifest.json").read_text())
    assert manifest["clip"]["parent_clip_id"] == text["id"]
    assert manifest["strategy"]["strategy_version_id"] == version["id"]
    assert manifest["source"]["transcript_origin"] == "imported"
    assert manifest["technical_checks"]["playback_format_passed"]
    assert "Main point line" in (folder / "captions.srt").read_text()
    assert client.delete(f"/api/clips/{text['id']}").status_code == 409
    assert client.delete(f"/api/clips/{revision['id']}").status_code == 409
    assert (
        hashlib.sha256(client.get(f"/api/clips/{text['id']}/download").content).hexdigest() == text["sha256"]
    )
