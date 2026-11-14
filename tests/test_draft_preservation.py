"""Failed production must leave prior media and foreign-workspace output untouched."""
from copy import deepcopy

import pytest
from test_app import client as authenticated_client_fixture
from test_app import upload_mock, wait_job

from clip_factory.jobs import WorkError

client = authenticated_client_fixture


@pytest.mark.parametrize("replace_drafts", [True, False])
def test_failed_asr_keeps_exact_existing_drafts_sidecars_and_other_campaign(client, monkeypatch, replace_drafts):
    assert client.patch('/api/settings', json={'autonomy': 'review', 'replace_drafts': replace_drafts}).status_code == 200
    video = upload_mock(client, monkeypatch, has_audio=True, duration=600)
    root, store = client.app.state.root, client.app.state.store
    originals, media = {}, {}
    for name, campaign, profile in [('earlier', 'current', 'p'), ('foreign', 'other', 'p2')]:
        clip = {'id': name, 'video_id': video['id'], 'campaign_id': campaign, 'profile_id': profile,
                'path': f'clips/{name}.mp4', 'team_run_id': 'earlier-run', 'approved': False,
                'status': 'ready', 'name': name, 'hook': 'Original hook', 'caption': 'Original caption',
                'start': 0, 'end': 30, 'instagram_media_id': None}
        originals[name] = deepcopy(clip)
        store.put('clips', clip)
        for suffix in ['.mp4', '.jpg', '.srt', '.hook.ass', '.pop.ass']:
            path = root / 'clips' / f'{name}{suffix}'
            content = f'original {name}{suffix}'.encode()
            path.write_bytes(content)
            media[path] = content
    monkeypatch.setattr(client.app.state.models, 'require', lambda *_: None)

    def refuse_transcription(*_):
        raise WorkError('Not enough currently available memory for speech recognition.')

    monkeypatch.setattr(client.app.state.team, 'transcribe', refuse_transcription)
    response = client.post(f"/api/videos/{video['id']}/team", json={'model_id': 'qwen-small'})
    assert response.status_code == 202, response.text
    submitted = response.json()
    failed = wait_job(client, submitted['job']['id'])
    assert failed['status'] == 'failed' and 'memory' in failed['error']
    assert submitted['job']['context']['cleared_drafts'] == 0
    for identifier, original in originals.items():
        assert store.get('clips', identifier) == original
    assert all(path.read_bytes() == original for path, original in media.items())
    run = store.get('team_runs', submitted['run']['id'])
    assert run['status'] == 'failed'
    assert any(t['role'] == 'transcribe' and t['status'] == 'failed' for t in run['tasks'])
    # The fix does not remove the existing, explicitly invoked Remove capability.
    removed = client.delete('/api/clips/earlier')
    assert removed.status_code == 200, removed.text
    assert store.get('clips', 'earlier') is None
    assert not (root / 'clips/earlier.mp4').exists()
    assert store.get('clips', 'foreign') == originals['foreign']
    assert (root / 'clips/foreign.mp4').read_bytes() == media[root / 'clips/foreign.mp4']
