"""Synthetic rehearsal must use production decisions without touching live state."""
import json
from copy import deepcopy

import pytest
from fastapi.testclient import TestClient

from clip_factory import ranking
from clip_factory.app import create_app
from clip_factory.demo_loop import rubric, simulate_loop
from clip_factory.demo_loop_api import install
from clip_factory.growth_loop import compare_observations


def pairs(body):
    return [pair for loop in body['loops'] for pair in loop['pairs']]


def test_replay_is_seeded_and_contains_no_real_render_or_approval():
    profile = {'id': 'real-profile', 'name': 'Example', 'active_strategy_id': 'real-version'}
    before = deepcopy(profile)
    body = simulate_loop(profile, seed=17, rounds=2)
    assert body == simulate_loop(profile, seed=17, rounds=2)
    assert profile == before
    assert body['simulated'] is True and body['ephemeral'] is True
    assert body['model']['status'] == 'not_used'
    assert body['model']['cost_usd'] == 0
    assert len(body['loops']) == 2 and len(pairs(body)) == 6
    assert 'no real posts' in body['banner'].lower()
    for pair in pairs(body):
        assert pair['simulated'] is True
        assert pair['render'] == {'status': 'not_rendered', 'artifact': None, 'job_id': None}
        assert pair['simulated_reviewer']['real_approval'] is False
        assert pair['after']['approved'] is False
    json.dumps(body, allow_nan=False)


def test_quality_reuses_production_weights_and_only_one_plan_field_changes():
    body = simulate_loop({'name': 'Demo'}, rounds=1)
    assert rubric()['version'] == ranking.RANK_VERSION
    assert {d['key']: d['weight'] for d in rubric()['dimensions']} == ranking.WEIGHTS
    board = {'scenes': [{'index': i, 'score': 0.6 + i * 0.05} for i in range(3)]}
    for pair in pairs(body):
        a, b = pair['before']['plan'], pair['after']['plan']
        assert [key for key in a if a[key] != b[key]] == ['hook']
        assert pair['proposal']['source_quote'] in pair['before']['synthetic_transcript']
        expected, _ = ranking.score(pair['after'], board, {'key_messages': ['A practical decision']}, speech_source=True)
        assert pair['quality_after']['score'] == expected
        assert sum(d['points'] for d in pair['quality_after']['dimensions']) == pytest.approx(expected, abs=0.6)


def test_metrics_use_shared_production_comparison_and_keep_denominators():
    body = simulate_loop({}, rounds=1, metric='engagement_rate')
    for pair in pairs(body):
        a, b = pair['observations']
        assert pair['evaluation'] == compare_observations(a, b, metric='engagement_rate', min_views=100,
                                                        window_complete=True)
        assert pair['proposal']['evidence_ids'] == [a['id'], b['id']]
        assert pair['proposal']['parent_clip_id'] == pair['before']['id']
        assert pair['proposal']['variant_clip_id'] == pair['after']['id']
        for snapshot in (a, b):
            counts = snapshot['metrics']
            assert 0 <= counts['completions'] <= counts['views']
            assert snapshot['source'] == 'synthetic_instagram'


def test_higher_quality_can_have_worse_audience_outcome():
    body = simulate_loop({}, seed=7, rounds=1, scenario='decline')
    assert any(p['quality_difference'] > 0 and p['evaluation']['status'] == 'favors_parent' for p in pairs(body))
    assert any(p['next_action'] == 'keep_parent' for p in pairs(body))


def test_pending_window_abstains_and_does_not_impute_zero():
    body = simulate_loop({}, rounds=2, scenario='sparse')
    for pair in pairs(body):
        assert pair['evaluation']['status'] == 'insufficient_evidence'
        assert pair['evaluation']['after_value'] is None
        assert pair['next_action'] == 'wait'
        assert pair['observations'][1]['metrics']['views'] is None
        assert pair['next_plan'] == pair['before']['plan']


def test_equal_evidence_never_selects_a_winner():
    body = simulate_loop({}, rounds=2, scenario='no_signal')
    assert all(p['evaluation']['status'] == 'no_clear_difference' for p in pairs(body))
    assert all(p['next_action'] == 'keep_parent' for p in pairs(body))


@pytest.mark.parametrize('values', [{'seed': True}, {'rounds': 99}, {'rounds': 0}, {'scenario': 'winner'},
                                   {'metric': 'made_up'}, {'seed': -1}])
def test_direct_call_rejects_invalid_controls(values):
    with pytest.raises(ValueError):
        simulate_loop({}, **values)


def test_api_is_authenticated_scoped_and_writes_no_simulation_data(tmp_path):
    app = create_app(tmp_path, token='test-token')
    install(app)
    store = app.state.store
    store.put('profiles', {'id': 'p', 'name': 'Brand'})
    store.put('campaigns', {'id': 'c', 'profile_ids': ['p'], 'video_ids': [], 'archived_at': None})
    with store.connect() as db:
        before = db.execute('SELECT kind,id,data FROM records ORDER BY kind,id').fetchall()
    with TestClient(app, base_url='http://127.0.0.1') as client:
        assert client.post('/api/demo-loop/p/simulate', json={}).status_code == 401
        assert client.get('/api/demo-loop/viewer').status_code == 401
        assert client.get('/api/demo-loop/assets/app.js').status_code == 401
        headers = {'X-Clip-Token': 'test-token'}
        viewer = client.get('/api/demo-loop/viewer?profile_id=p', headers=headers)
        assert viewer.status_code == 200
        assert '/api/demo-loop/assets/app.js' in viewer.text
        assert client.get('/api/demo-loop/assets/app.js', headers=headers).status_code == 200
        assert client.get('/api/demo-loop/assets/styles.css', headers=headers).status_code == 200
        assert client.get('/api/demo-loop/assets/index.html', headers=headers).status_code == 404
        response = client.post('/api/demo-loop/p/simulate', json={'rounds': 1}, headers=headers)
        assert response.status_code == 200 and response.json()['simulated'] is True
        assert client.post('/api/demo-loop/missing/simulate', json={}, headers=headers).status_code == 404
        assert client.post('/api/demo-loop/p/simulate', json={'seed': True}, headers=headers).status_code == 422
        assert client.get('/api/demo-loop/rubric', headers=headers).status_code == 200
        with store.connect() as db:
            after = db.execute('SELECT kind,id,data FROM records ORDER BY kind,id').fetchall()
        assert after == before
        store.patch('profiles', 'p', archived_at='2026-11-14T00:00:00+00:00')
        assert client.post('/api/demo-loop/p/simulate', json={}, headers=headers).status_code == 409
