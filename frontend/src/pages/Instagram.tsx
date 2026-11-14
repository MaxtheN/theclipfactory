import { useState } from 'react';
import { endpoint, post, remove } from '../api';
import type { Clip, InstagramStatus, Settings } from '../types';
import type { FactoryState } from '../useFactory';
import { Badge, Empty, Field, Section, ReadOnlyValue } from '../components/ui';
export function publishingGate(clip: Clip | undefined, settings: Settings | null, status: InstagramStatus | null, stale = false): string[] {
  const reasons: string[] = [];
  if (stale) reasons.push('Refresh connection, clips, and settings before publishing.');
  if (!clip) reasons.push('Select a clip.'); else if (clip.approved !== true) reasons.push('Approve this clip in Factory.');
  if (settings?.publishing_enabled !== true) reasons.push('Enable publishing explicitly in Settings.');
  if (status?.connected !== true) reasons.push('Connect a verified Instagram account.');
  if (status?.publishing_available !== true) reasons.push('Publishing capability is unavailable or unknown.');
  return reasons;
}
export function isPublicHttps(value: string): boolean {
  try { const url = new URL(value); const host = url.hostname.toLowerCase(); return url.protocol === 'https:' && !url.username && !url.password && !!host && host.includes('.') && !host.endsWith('.local') && !host.endsWith('.localhost') && host !== 'localhost' && host !== '0.0.0.0' && !/^127\./.test(host) && !/^10\./.test(host) && !/^192\.168\./.test(host) && !/^172\.(1[6-9]|2\d|3[01])\./.test(host) && !host.startsWith('['); } catch { return false; }
}
export function Instagram({state}: {state: FactoryState}) {
  const [token,setToken] = useState(''); const [account,setAccount] = useState('');
  const [clipId,setClipId] = useState(''); const [url,setUrl] = useState(''); const [urlError,setUrlError] = useState('');
  const status = state.data.instagram;
  const selected = state.data.clips.find(c => c.id === clipId);
  const gate = publishingGate(selected,state.data.settings,status,!!(state.errors.instagram || state.errors.settings || state.errors.clips));
  async function connect(event: React.FormEvent) {
    event.preventDefault(); const access_token = token.trim(); setToken('');
    await state.run(() => post('/api/instagram/connect',{access_token,...(account.trim() ? {account_id:account.trim()} : {})}), 'Connection inspected by Meta. See the verified account status below.');
  }
  async function publish(event: React.FormEvent) {
    event.preventDefault(); setUrlError('');
    if (!isPublicHttps(url)) { setUrlError('Provide a publicly reachable HTTPS video URL, not a localhost or private-network address.'); return; }
    if (gate.length || !selected) return;
    await state.run(() => post(endpoint('clips',selected.id,'publish'),{public_video_url:url.trim()}), 'Publishing job queued. A queued job is not proof of a successful Instagram post.');
  }
  return <><div className="two-col"><Section title="Account connection" detail="Credentials are never persisted in the browser"><div className="row"><Badge tone={status?.connected === true ? 'success' : ''}>{state.errors.instagram ? 'Unknown connection' : status?.connected === true ? 'Connected' : status?.connected === false ? 'Not connected' : 'Unknown connection'}</Badge></div><form autoComplete="off" onSubmit={event => void connect(event)}><Field label="Meta access token" hint="Held only in component memory; cleared when submitted or when you leave this screen. The backend handles secure storage."><input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} required spellCheck={false}/></Field><Field label="Instagram account ID (optional)"><input value={account} onChange={e => setAccount(e.target.value)} autoComplete="off"/></Field><div className="actions"><button disabled={state.busy || !token.trim()}>Inspect & connect</button>{status?.connected === true && <button type="button" className="danger-button" disabled={state.busy} onClick={() => { if (window.confirm('Disconnect this Instagram account?')) void state.run(() => remove('/api/instagram/connect'), 'Instagram disconnected.'); }}>Disconnect</button>}{status?.oauth_configured === true && <button type="button" className="secondary" disabled={state.busy || !!state.errors.instagram} onClick={() => void state.run(async () => { const result = await post<{url:string}>('/api/instagram/oauth/start'); const target = new URL(result.url); if (target.protocol !== 'https:') throw new Error('OAuth returned an unsafe URL.'); window.location.assign(target.href); }, 'Opening Meta authorization.')}>Connect with OAuth</button>}</div></form></Section>
    <Section title="Capability preflight" detail="Hardware and settings do not imply an available integration"><dl className="info-list"><div><dt>Verified account</dt><dd><ReadOnlyValue value={state.errors.instagram ? null : status?.account}/></dd></div><div><dt>Publishing</dt><dd><ReadOnlyValue value={state.errors.instagram ? null : status?.publishing_available}/></dd></div><div><dt>Ads integration</dt><dd><ReadOnlyValue value={state.errors.instagram ? null : status?.ads_available}/></dd></div><div><dt>OAuth configured</dt><dd><ReadOnlyValue value={state.errors.instagram ? null : status?.oauth_configured}/></dd></div></dl><h3>Requirements</h3>{Array.isArray(status?.requirements) && status.requirements.length ? <ul className="requirements">{status.requirements.map((r,i) => <li key={i}><ReadOnlyValue value={r}/></li>)}</ul> : <p className="muted">No requirements reported. This does not imply publishing is ready.</p>}<p className="muted">No unattended ad launches or simulated campaigns. Ads settings are opt-ins only.</p></Section></div>
    <Section title="Publish an approved clip" detail="Public HTTPS hosting is required · local media URLs cannot be sent to Meta">{!state.data.clips.length ? <Empty title="Create and review a clip first">Rendered clips from Factory can be published only after explicit approval.</Empty> : <form onSubmit={event => void publish(event)}><Field label="Clip to publish"><select value={clipId} onChange={e => setClipId(e.target.value)}><option value="">Select a rendered clip</option>{state.data.clips.map(c => <option key={c.id} value={c.id}>{c.name} · {c.approved ? 'approved' : 'needs review'}{c.published_at ? ' · already published' : ''}</option>)}</select></Field><Field label="Public HTTPS video URL" hint="Host the approved clip on a publicly accessible HTTPS endpoint. This app does not provide asset hosting."><input type="url" required value={url} onChange={e => setUrl(e.target.value)} placeholder="https://your-host.example/approved-clip.mp4"/></Field>{urlError && <p role="alert" className="error-text">{urlError}</p>}{gate.length > 0 && <ul className="gate-list">{gate.map(reason => <li key={reason}>{reason}</li>)}</ul>}<button disabled={state.busy || gate.length > 0 || !url.trim()}>Queue Instagram publish</button></form>}</Section>
    <Section title="Import real insights" detail="Only available Meta metrics are imported; unknown values remain unknown"><button disabled={state.busy || status?.connected !== true || !!state.errors.instagram} onClick={() => void state.run(() => post('/api/instagram/sync'), 'Insights sync queued. Check Results after the job completes.')}>Sync Instagram insights</button><p className="muted">Paid insights require an actual configured Meta ad account. Manual events are separate observations, not attributed conversions.</p></Section>
  </>;
}
