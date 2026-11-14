"""Bounded offline speech-provider contracts. No Keychain or provider network access."""
import asyncio
import json
import time
import wave
from copy import deepcopy
from types import SimpleNamespace

import httpx
import pytest

from clip_factory import cloud_speech as speech
from clip_factory.jobs import JobCancelled, WorkError
from clip_factory.media import clean_transcript

KEY = "gsk_" + "private-test-only-" * 4


class Jobs:
    def __init__(self, cancel_after=None):
        self.checks, self.updates, self.cancel_after = 0, [], cancel_after

    def check(self, _):
        self.checks += 1
        if self.cancel_after is not None and self.checks >= self.cancel_after:
            raise JobCancelled("Cancelled")

    def update(self, _, **values):
        self.updates.append(values)


def wav(path, seconds=5, *, rate=16000, width=2, channels=1):
    with wave.open(str(path), "wb") as output:
        output.setparams((channels, width, rate, 0, "NONE", "not compressed"))
        output.writeframes(b"\0" * int(seconds * rate * width * channels))
    return path


def reply():
    return {"text": "Hello there.", "language": "en", "segments": [{"start": 0.0, "end": 1.0,
        "text": "Hello there.", "avg_logprob": -0.1, "no_speech_prob": 0.01, "compression_ratio": 1.1}],
        "words": [{"word": "Hello", "start": 0.0, "end": 0.4},
                  {"word": "there.", "start": 0.4, "end": 0.8}]}


def service(handler, **options):
    return speech.GroqSpeech(secrets=SimpleNamespace(get=lambda: KEY), transport=httpx.MockTransport(handler), **options)


def test_keychain_namespace_presence_and_sanitized_failure(monkeypatch):
    calls = []
    monkeypatch.setattr(speech.GroqSpeechSecrets, "_backend", lambda _: SimpleNamespace(
        get_password=lambda service, account: calls.append((service, account)) or KEY))
    assert speech.groq_configured() is True
    assert speech.GroqSpeechSecrets().get() == KEY
    assert calls[0] == ("growth-factory-groq", "api-key")

    def broken(_):
        raise RuntimeError(KEY)

    monkeypatch.setattr(speech.GroqSpeechSecrets, "_backend", broken)
    assert speech.groq_configured() is False
    with pytest.raises(WorkError) as failure:
        speech.GroqSpeechSecrets().get()
    assert KEY not in str(failure.value)


def test_chunking_has_absolute_word_offsets_and_never_uploads_source_name(tmp_path, monkeypatch):
    monkeypatch.setattr(speech, "CHUNK_SECONDS", 2)
    requests = []

    def handle(request):
        requests.append(request)
        assert request.url == speech.ENDPOINT
        assert request.headers["authorization"] == f"Bearer {KEY}"
        body = request.read()
        assert b'filename="speech.wav"' in body and b"private-source-name" not in body
        assert body.count(b'name="timestamp_granularities[]"') == 2
        assert b"verbose_json" in body and b"whisper-large-v3-turbo" in body
        payload = reply()
        payload["text"] = payload["segments"][0]["text"] = f"Hello friend{len(requests)}."
        payload["words"][1]["word"] = f"friend{len(requests)}."
        return httpx.Response(200, json=payload)

    jobs = Jobs()
    result = service(handle).transcribe(jobs, "job", wav(tmp_path / "private-source-name.wav"), "en", 5)
    assert len(requests) == 3
    assert [s["start"] for s in result["segments"]] == [0, 2, 4]
    assert [s["words"][0]["start"] for s in result["segments"]] == [0, 2, 4]
    assert result["segments"][-1]["words"][-1]["end"] == 4.8
    assert clean_transcript(result)["segments"] == result["segments"]
    assert result["cloud_receipt"]["actual_cost_usd"] is None
    assert result["cloud_receipt"]["audio_seconds"] == 5
    assert "Estimate" in result["cloud_receipt"]["cost_basis"]
    assert KEY not in json.dumps(result)
    assert not list(tmp_path.glob("groq-speech-*"))


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), -1, True, "0.1", 8])
def test_nonfinite_or_out_of_chunk_timestamps_fail_without_inventing_times(bad):
    payload = reply()
    payload["words"][0]["start"] = bad
    with pytest.raises(speech.CloudSpeechError) as error:
        speech.normalize_chunk(payload, duration=1, offset=0)
    assert error.value.kind == "invalid"


def test_missing_words_and_cross_segment_or_unordered_words_refuse():
    for mutate in (lambda p: p.pop("words"), lambda p: p.update(words=[]),
                   lambda p: p["words"].reverse(), lambda p: p["segments"][0].update(start=0.9)):
        payload = reply()
        mutate(payload)
        with pytest.raises(speech.CloudSpeechError):
            speech.normalize_chunk(payload, duration=1, offset=0)


@pytest.mark.parametrize("status,kind", [(401, "auth"), (403, "auth"), (429, "rate"), (500, "provider"), (302, "provider")])
def test_provider_errors_do_not_echo_credentials_or_body_and_do_not_retry(tmp_path, status, kind):
    calls = []

    def handle(_):
        calls.append(True)
        return httpx.Response(status, json={"error": KEY})

    with pytest.raises(speech.CloudSpeechError) as failure:
        service(handle).transcribe(Jobs(), "job", wav(tmp_path / "speech.wav", 1), "en", 1)
    assert failure.value.kind == kind and KEY not in str(failure.value)
    assert len(calls) == 1


def test_network_failure_is_sanitized(tmp_path):
    def handle(_):
        raise httpx.ReadTimeout(KEY)

    with pytest.raises(speech.CloudSpeechError) as failure:
        service(handle).transcribe(Jobs(), "job", wav(tmp_path / "speech.wav", 1), "en", 1)
    assert failure.value.kind == "network" and KEY not in str(failure.value)


def test_total_timeout_and_active_request_cancellation(tmp_path):
    async def slow(_):
        await asyncio.sleep(5)
        return httpx.Response(200, json=reply())

    audio = wav(tmp_path / "speech.wav", 1)
    started = time.monotonic()
    with pytest.raises(speech.CloudSpeechError) as failure:
        service(slow, request_timeout=0.05).transcribe(Jobs(), "job", audio, "en", 1)
    assert failure.value.kind == "network" and time.monotonic() - started < 1
    started = time.monotonic()
    with pytest.raises(JobCancelled):
        service(slow).transcribe(Jobs(cancel_after=5), "job", audio, "en", 1)
    assert time.monotonic() - started < 1
    assert not list(tmp_path.glob("groq-speech-*"))


def test_bad_wav_and_missing_key_fail_before_upload(tmp_path):
    calls = []
    cloud = service(lambda _: calls.append(True))
    with pytest.raises(speech.CloudSpeechError):
        cloud.transcribe(Jobs(), "job", wav(tmp_path / "stereo.wav", 1, channels=2), "en", 1)
    cloud.secrets = SimpleNamespace(get=lambda: None)
    with pytest.raises(speech.CloudSpeechError):
        cloud.transcribe(Jobs(), "job", wav(tmp_path / "mono.wav", 1), "en", 1)
    assert not calls


def test_silent_response_remains_empty_and_unknown_language():
    payload = {"text": "", "segments": [], "words": []}
    assert speech.normalize_chunk(payload, duration=1, offset=0) == {"text": "", "segments": [], "language": None}
    changed = deepcopy(payload)
    changed["text"] = "Unsupported text without timings"
    with pytest.raises(speech.CloudSpeechError):
        speech.normalize_chunk(changed, duration=1, offset=0)


def test_actual_provider_overlap_keeps_lexical_order_and_excludes_boundary_fragment():
    from pathlib import Path

    payload = json.loads((Path(__file__).parent / 'fixtures/groq-overlapping-words.json').read_text())
    result = speech.normalize_chunk(payload, duration=20, offset=40)
    assert len(result['segments']) == 5
    assert result['segments'][1]['text'] == 'Times.'
    assert result['segments'][1]['words'] == [{'word': 'Times.', 'start': 45.32, 'end': 46.1}]
    assert result['segments'][4]['text'] == 'for it.'
    assert [w['word'] for s in result['segments'] for w in s['words']] == [w['word'] for w in payload['words'][:44]]
    assert 'current presidents' not in result['text']
    assert len(result['dropped_boundary_segments']) == 1
    assert result['dropped_boundary_segments'][0]['start'] == 55.8
    assert result['dropped_boundary_segments'][0]['end'] == 60
    assert 'entire boundary segment excluded' in result['dropped_boundary_segments'][0]['reason']


def test_segment_text_omission_preserves_measured_negation_and_other_word_insertions():
    payload = {'text': 'We don know.', 'segments': [{'start': 0, 'end': 1, 'text': 'We don know.'}],
               'words': [{'word': 'We', 'start': 0, 'end': .2},
                         {'word': "don't", 'start': .2, 'end': .4},
                         {'word': 'know.', 'start': .4, 'end': .8}]}
    result = speech.normalize_chunk(payload, duration=1, offset=0)
    assert result['text'] == "We don't know."
    assert result['segments'][0]['words'] == payload['words']
    # A missing/replaced timed word is not permission to fabricate one.
    payload['words'][1]['word'] = 'do'
    with pytest.raises(speech.CloudSpeechError):
        speech.normalize_chunk(payload, duration=1, offset=0)


def test_only_tiny_boundary_rounding_is_clamped_and_large_resets_refuse():
    payload = reply()
    payload['words'][0]['start'] = -.01
    payload['words'][1]['end'] = 1.01
    result = speech.normalize_chunk(payload, duration=1, offset=0)
    assert result['segments'][0]['words'][0]['start'] == 0
    assert result['segments'][0]['words'][1]['end'] == 1
    assert 'dropped_boundary_segments' not in result
    payload = reply()
    payload['segments'][0]['end'] = 5
    payload['words'][0].update(start=3, end=3.4)
    payload['words'][1].update(start=0, end=.4)
    with pytest.raises(speech.CloudSpeechError, match='reset'):
        speech.normalize_chunk(payload, duration=5, offset=0)


def test_dropped_boundary_segment_is_excluded_from_text_and_persistable_receipt(tmp_path):
    payload = reply()
    payload['words'][1]['end'] = 1.4
    result = service(lambda _: httpx.Response(200, json=payload)).transcribe(
        Jobs(), 'job', wav(tmp_path / 'speech.wav', 1), 'en', 1)
    assert result['segments'] == [] and result['text'] == ''
    assert result['cloud_receipt']['dropped_boundary_segments']
    assert speech.CHUNK_SECONDS * speech.SAMPLE_RATE * speech.SAMPLE_WIDTH + 44 < speech.MAX_FILE_BYTES


def test_groq_word_order_survives_craft_swarm_sentences_and_caption_filters(monkeypatch):
    from pathlib import Path

    from clip_factory import craft, media, moments
    from clip_factory.team import TeamEngine

    payload = json.loads((Path(__file__).parent / 'fixtures/groq-overlapping-words.json').read_text())
    transcript = speech.normalize_chunk(payload, duration=20, offset=0)
    transcript['provider'] = 'groq'
    expected = [w['word'] for s in transcript['segments'] for w in s['words']]
    selected = craft.range_words(transcript, 0, 20, media.foreground, media.usable_words)
    assert [w['text'] for w in selected] == expected
    assert 'New York Times.' in ' '.join(w['text'] for w in selected)
    assert [w['text'] for w in TeamEngine.spoken_words(transcript, 0, 20)] == expected
    # Provider overlap must not change the existing midpoint eligibility rule.
    subset = craft.range_words(transcript, 5.5, 6.2, media.foreground, media.usable_words)
    assert [w['text'] for w in subset] == ['New', 'York', 'Times.']
    entries = media.caption_entries(transcript, [{'start': 0, 'end': 20}])
    assert 'New York Times.' in ' '.join(e['text'] for e in entries)
    captured, original = [], moments.sentence_units

    def capture(words):
        captured.extend(w['text'] for w in words)
        return original(words)

    monkeypatch.setattr(moments, 'sentence_units', capture)
    moments.shape_range(0, 15.5, selected, target=15, low=10, high=20, preserve_word_order=True)
    assert captured == expected
    # Legacy imported/local transcripts keep their existing chronological sorting.
    local = {**transcript, 'provider': 'local'}
    legacy = craft.range_words(local, 0, 20, media.foreground, media.usable_words)
    assert [w['start'] for w in legacy] == sorted(w['start'] for w in selected)

    negative = {'provider': 'groq', 'segments': [{'start': 0, 'end': 1, 'text': "We don't know.",
        'words': [{'word': 'We', 'start': .2, 'end': .3},
                  {'word': "don't", 'start': .1, 'end': .4},
                  {'word': 'know.', 'start': .4, 'end': .8}]}]}
    assert [w['text'] for w in craft.range_words(negative, 0, 1, media.foreground, media.usable_words)] == ['We', "don't", 'know.']
    assert media.caption_entries(negative, [{'start': 0, 'end': 1}])[0]['text'] == "We don't know."
