"""Display timing regressions from actual Groq clips; source measurements stay intact."""
import itertools
import json
import shutil
import subprocess
import time
from pathlib import Path

import pytest

from clip_factory import craft, media
from clip_factory.jobs import Jobs
from clip_factory.store import Store


def ass_seconds(value):
    hours, minutes, seconds = value.split(':')
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def assert_intervals(rows, limit):
    assert all(0 <= e['start'] < e['end'] <= limit for e in rows)
    assert all(a['end'] <= b['start'] + 1e-7 for a, b in itertools.pairwise(rows))


def test_actual_groq_clip_timelines_preserve_every_selected_word_and_share_ass_srt_grid():
    fixture = json.loads((Path(__file__).parent / 'fixtures/groq-actual-caption-timelines.json').read_text())
    for clip in fixture['clips']:
        segments = clip['source_segments']
        expected = []
        for segment in segments:
            for row in media.foreground(fixture['transcript']):
                expected.extend(media.clean_caption(w['text']) for w in media.usable_words(row.get('words'))
                                if segment['start'] <= (w['start'] + w['end']) / 2 < segment['end'])
        entries = media.caption_entries(fixture['transcript'], segments)
        limit = sum(s['end'] - s['start'] for s in segments)
        assert_intervals(entries, limit)
        assert ' '.join(e['text'] for e in entries) == ' '.join(expected)
        assert all(0 <= w['start'] < w['end'] <= e['end'] for e in entries for w in e.get('timed', []))
        srt = media.srt_text(entries)
        assert srt.count('-->') == len(entries)
        script = craft.caption_ass(entries, 'pop', set(), font='Arial', accent='#ff7700')
        events = [line.split(',') for line in script.splitlines() if line.startswith('Dialogue:')]
        intervals = [{'start': ass_seconds(e[1]), 'end': ass_seconds(e[2])} for e in events]
        assert_intervals(intervals, limit)
        assert intervals[0]['start'] == entries[0]['start']
        assert intervals[-1]['end'] == entries[-1]['end']
        # Stored speech measurements remain available independently of display intervals.
        assert all(w['measured_words'] for e in entries for w in e.get('timed', []))


def test_regressing_highlights_merge_display_groups_without_losing_negation():
    raw = [{'start': 0, 'end': .8, 'text': "We don't know.", 'timed': [
        {'text': 'We', 'start': .2, 'end': .3},
        {'text': "don't", 'start': .1, 'end': .4},
        {'text': 'know.', 'start': .4, 'end': .8}]}]
    entries = media.normalize_caption_entries(raw, 1)
    assert entries[0]['text'] == "We don't know."
    assert [w['text'] for w in entries[0]['timed']] == ["We don't", 'know.']
    assert entries[0]['timed'][0]['measured_words'][1]['start'] == .1
    assert_intervals(entries[0]['timed'], 1)
    assert raw[0]['timed'][0]['start'] == .2


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='FFmpeg required')
def test_real_cut_render_has_frame_aligned_duration_and_clean_srt_ass_intervals(tmp_path):
    source = tmp_path / 'source.mp4'
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
        'testsrc2=s=320x180:r=30:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', str(source)], check=True, timeout=30)
    transcript = {'provider': 'groq', 'segments': [
        {'start': 0, 'end': 1.8, 'text': "We don't know.", 'words': [
            {'word': 'We', 'start': .2, 'end': .4}, {'word': "don't", 'start': .1, 'end': .5},
            {'word': 'know.', 'start': 1.2, 'end': 1.8}]},
        {'start': 1.7, 'end': 3.9, 'text': 'New York Times.', 'words': [
            {'word': 'New', 'start': 1.7, 'end': 2.1}, {'word': 'York', 'start': 2.1, 'end': 2.4},
            {'word': 'Times.', 'start': 1.9, 'end': 3.9}]}]}
    store = Store(tmp_path / 'store')
    jobs = Jobs(store)
    output = tmp_path / 'clip.mp4'
    options = craft.CraftOptions(jump_cuts='silences', loudness='off', crop_focus='fixed',
                                 caption_emphasis='keywords').model_dump(exclude={'variants'})
    try:
        job = jobs.submit('render', lambda identifier: media.render(jobs, identifier, source, output,
            start=.073, end=3.917, transcript=transcript, caption_style='pop', framing='fit', edit=options))
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            final = store.get('jobs', job['id'])
            if final['status'] in {'completed', 'failed', 'cancelled'}:
                break
            time.sleep(.03)
        assert final['status'] == 'completed', final
        result = final['result']
        assert result['technical_checks']['playback_format_passed']
        assert 'timing' not in result['technical_checks']['caption_issues']
        entries = media.caption_entries(transcript, result['source_segments'])
        assert_intervals(entries, result['duration'])
        assert output.with_suffix('.srt').read_text() == media.srt_text(entries)
        frames = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-count_frames',
            '-show_entries', 'stream=nb_read_frames,duration', '-of', 'json', str(output)],
            capture_output=True, text=True, check=True, timeout=10)
        stream = json.loads(frames.stdout)['streams'][0]
        planned = sum(s['end'] - s['start'] for s in result['source_segments'])
        assert int(stream['nb_read_frames']) == round(planned * 30)
        assert abs(float(stream['duration']) - round(planned * 30) / 30) < .001
        assert "We don't know." in " ".join(e['text'] for e in entries)
    finally:
        jobs.close()
