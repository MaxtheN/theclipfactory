import { useEffect, useRef, useState } from "react";
import { api, post, put } from "../api";
import type { FactoryState } from "../useFactory";
import type { Clip } from "../types";
import type { Workspace } from "./useCampaignWorkspace";
import { reviewPreview } from "./workspaceApi";
import "./automation.css";

type Row = Record<string, unknown> & { id: string };
type State = { policies: Row[]; publications: Row[]; snapshots: Row[]; work: Row[]; experiments: Row[] };
const empty: State = { policies: [], publications: [], snapshots: [], work: [], experiments: [] };
function rows(value: unknown): Row[] {
  if (!Array.isArray(value) || value.some(v => !v || typeof v !== "object" || typeof v.id !== "string"))
    throw new Error("Saved learning data was incomplete. Refresh before changing anything.");
  return value;
}
export function parseAutomationState(value: unknown): State {
  if (!value || typeof value !== "object") throw new Error("Learning state unavailable.");
  const obj = value as Record<string, unknown>;
  const result = { policies: rows(obj.policies), publications: rows(obj.publications), snapshots: rows(obj.snapshots),
    work: rows(obj.work), experiments: rows(obj.experiments) };
  for (const row of result.policies) {
    if (![row.campaign_id, row.profile_id, row.account_id].every(v => typeof v === "string" && !!v) ||
        ![3, 6].includes(Number(row.cadence_days)) || typeof row.enabled !== "boolean" || typeof row.auto_drafts !== "boolean")
      throw new Error("Saved learning policy is incomplete. Refresh before changing anything.");
  }
  for (const row of [...result.work, ...result.publications, ...result.snapshots, ...result.experiments])
    if (typeof row.policy_id !== "string" || !row.policy_id) throw new Error("Saved learning scope is incomplete.");
  return result;
}
const text = (value: unknown) => typeof value === "string" ? value : "";

export function AutomationPanel({ w, factory, visible, onReview }: { w: Workspace; factory: FactoryState; visible: boolean; onReview?: (clip: Clip) => void }) {
  const [state, setState] = useState<State>(empty), [accounts, setAccounts] = useState<Row[]>([]);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(false);
  const blocked = busy || !fresh;
  const [accountId, setAccountId] = useState(""), [cadence, setCadence] = useState<3 | 6>(3);
  const [authConfig, setAuthConfig] = useState(""), [key, setKey] = useState("");
  const [existingAccount, setExistingAccount] = useState("");
  const [configured, setConfigured] = useState(false);
  const [link, setLink] = useState(""), [intent, setIntent] = useState("");
  const [clipId, setClipId] = useState(""), [mediaId, setMediaId] = useState(""), [confirmedMapping, setConfirmedMapping] = useState(false);
  const lock = useRef(false), alive = useRef(true);
  const scoped = (row: Row) => row.campaign_id === w.campaign?.id && row.profile_id === w.profileId;
  const policies = state.policies.filter(scoped), selectedAccounts = accounts.filter(a => a.profile_id === w.profileId && a.status === "active");
  const policy = policies.find(p => p.account_id === accountId);
  const clips = factory.data.clips.filter(c => c.campaign_id === w.campaign?.id && c.profile_id === w.profileId && c.approved && !!c.sha256);
  const selectedClip = clips.find(c => c.id === clipId);
  const policyIds = new Set(policies.map(p => p.id));
  const work = state.work.filter(row => policyIds.has(text(row.policy_id))), experiments = state.experiments.filter(scoped);
  const publications = state.publications.filter(row => policyIds.has(text(row.policy_id)));
  const snapshots = state.snapshots.filter(row => policyIds.has(text(row.policy_id)));

  async function refresh() {
    if (alive.current) setFresh(false);
    const [next, linked, settings] = await Promise.all([api<unknown>("/api/automation/state"), api<unknown>("/api/automation/accounts"), api<Record<string, unknown>>("/api/automation/settings")]);
    const parsed = parseAutomationState(next), checked = rows(linked);
    if (alive.current) { setState(parsed); setAccounts(checked); setFresh(true); setConfigured(settings.configured === true); setAuthConfig(previous => previous || text(settings.auth_config_id)); }
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!visible || reviewPreview) return;
    let current = true;
    const load = () => { if (current) void refresh().catch(e => { if (current && alive.current) setError(e instanceof Error ? e.message : "Learning unavailable."); }); };
    load(); const timer = window.setInterval(load, 15000);
    return () => { current = false; window.clearInterval(timer); };
  }, [visible]);
  async function act(operation: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try { await operation(); await refresh(); }
    catch (e) { const known = !!e && typeof e === "object" && "status" in e && typeof e.status === "number" && e.status >= 400 && e.status < 500; if (alive.current) setError((e instanceof Error ? e.message : "Request could not be confirmed.") + (known ? "" : " Refresh saved state before repeating a change.")); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  if (reviewPreview) return <section className="gf-automation"><span className="gf-kicker">The learning loop</span><h2>Every result informs the next draft.</h2><p>Connect accounts and collect real performance in the Mac app. This hosted design preview contains illustrative data.</p></section>;
  return <section className="gf-automation" aria-labelledby="automation-title">
    <div className="gf-automation-heading"><div><span className="gf-kicker">The learning loop</span><h2 id="automation-title">A better next draft. With receipts.</h2><p>Real post metrics → one creative hypothesis → a new draft for your review.</p></div><span className="gf-automation-policy">Drafts run automatically · You approve publishing</span></div>
    <ol className="gf-automation-steps"><li><strong>Connect</strong><span>Choose the exact Instagram account.</span></li><li><strong>Observe</strong><span>Check a post after 3 or 6 days.</span></li><li><strong>Experiment</strong><span>Change one opening or duration.</span></li><li><strong>Review</strong><span>Your new draft stays unpublished.</span></li></ol>
    {error && <p role="alert" className="gf-automation-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="gf-automation-controls">
      <label>Instagram account<select value={accountId} onChange={e => setAccountId(e.target.value)} disabled={blocked}><option value="">Choose a connected account</option>{selectedAccounts.map(a => <option key={a.id} value={a.id}>{text(a.display_name) || a.id}</option>)}</select></label>
      <label>Review performance after<select value={cadence} onChange={e => setCadence(Number(e.target.value) as 3 | 6)} disabled={blocked}><option value={3}>3 days</option><option value={6}>6 days</option></select></label>
      <button disabled={blocked || !selectedAccounts.some(a => a.id === accountId) || !w.campaign} onClick={() => void act(async () => {
        const body = { campaign_id: w.campaign!.id, profile_id: w.profileId, account_id: accountId, cadence_days: cadence, enabled: true, auto_drafts: true, allowed_changes: ["hook", "duration"] };
        if (policy) await put(`/api/automation/policies/${encodeURIComponent(policy.id)}`, body); else await post("/api/automation/policies", body);
        setNotice("Learning saved. It runs while the Mac app is open and catches up when you reopen it.");
      })}>{policy?.enabled ? "Update learning" : "Start the loop"}</button>
      {policy?.enabled === true && <button disabled={blocked} onClick={() => void act(async () => { await put(`/api/automation/policies/${encodeURIComponent(policy.id)}`, { campaign_id: policy.campaign_id, profile_id: policy.profile_id, account_id: policy.account_id, cadence_days: policy.cadence_days, allowed_changes: policy.allowed_changes, auto_drafts: policy.auto_drafts, enabled: false }); setNotice("Learning paused. Your evidence and drafts are saved."); })}>Pause</button>}
    </div>
    {!accountId && <p className="gf-automation-help">{selectedAccounts.length ? "Choose your verified Instagram account to enable Start the loop." : "First save connection settings and verify an account below. Then Start the loop becomes available."}</p>}
    <details open={selectedAccounts.length === 0 || undefined}><summary>Connect an Instagram account</summary><p>This is a one-time developer setup for the demo. Your API key stays in macOS Keychain. Once saved, choose a new sign-in or verify an account you already connected.</p>
      <div className="gf-automation-controls"><label>Auth Config ID (starts with ac_)<input value={authConfig} onChange={e => setAuthConfig(e.target.value)} placeholder="ac_…" autoComplete="off" /></label><label>Composio project API key<input type="password" value={key} onChange={e => setKey(e.target.value)} autoComplete="off" /></label><button disabled={blocked || !authConfig.trim() || (!configured && !key.trim())} onClick={() => void act(async () => { await put("/api/automation/settings", { auth_config_id: authConfig.trim(), ...(key ? { api_key: key } : {}) }); setKey(""); setConfigured(true); setNotice("Settings saved. Now verify an existing account below, or connect a new one."); })}>Save connection settings</button>
      <button disabled={blocked || !configured || !w.profileId} onClick={() => void act(async () => { const result = await post<Record<string, unknown>>("/api/automation/connections", { profile_id: w.profileId }); const url = text(result.redirect_url); if (!url.startsWith("https://") || !text(result.connected_account_id)) throw new Error("Connection could not be verified."); setLink(url); setIntent(text(result.connected_account_id)); })}>Connect this workspace</button></div>
      {!configured && <p className="gf-automation-help">Save the Auth Config ID and project API key above before continuing.</p>}
      <details><summary>Already connected in Composio?</summary><p>Paste the connected account ID (starts with ca_). We find the owner and verify the actual Instagram identity for you.</p><div className="gf-automation-controls"><label>Connected account ID<input value={existingAccount} onChange={e => setExistingAccount(e.target.value)} placeholder="ca_…" /></label><button disabled={blocked || !configured || !existingAccount.trim()} onClick={() => void act(async () => { const result = await post<Record<string, unknown>>("/api/automation/accounts/import", { profile_id: w.profileId, connected_account_id: existingAccount.trim() }); if (result.id !== existingAccount.trim()) throw new Error("Account confirmation did not match your selection."); setAccountId(text(result.id)); setNotice("Instagram account verified. Choose your review cadence and start the loop."); })}>Verify this Instagram account</button></div></details>
      {link && <p><a href={link} target="_blank" rel="noreferrer">Open secure Instagram sign-in ↗</a> <button disabled={blocked} onClick={() => void act(async () => { await post(`/api/automation/connections/${encodeURIComponent(intent)}/verify`); setLink(""); setIntent(""); setNotice("Account identity verified and connected to this workspace."); })}>I've signed in · Verify account</button></p>}
    </details>
    <details><summary>Track an existing published clip</summary><p>Choose an approved clip and its actual Instagram media ID. The collector verifies ownership and publication time. You confirm the clip mapping. This does not publish anything.</p><div className="gf-automation-controls">
      <label>Approved clip<select value={clipId} onChange={e => { setClipId(e.target.value); setConfirmedMapping(false); }}><option value="">Choose a reviewed clip</option>{clips.map(c => <option key={c.id} value={c.id}>{c.hook || c.name}</option>)}</select></label><label>Instagram media ID<input inputMode="numeric" value={mediaId} onChange={e => { setMediaId(e.target.value); setConfirmedMapping(false); }} /></label><label className="gf-automation-confirm"><input type="checkbox" checked={confirmedMapping} onChange={e => setConfirmedMapping(e.target.checked)} />This post uses this exact clip</label>
      <button disabled={blocked || !policy || !selectedClip || !/^\d+$/.test(mediaId) || !confirmedMapping} onClick={() => void act(async () => { await post("/api/automation/publications", { policy_id: policy!.id, clip_id: selectedClip!.id, account_id: accountId, media_id: mediaId, confirmed_clip_mapping: true, sha256: selectedClip!.sha256 }); setNotice("Post tracked. Its measurement window starts at the provider's publication time."); })}>Track this post</button>
    </div></details>
    <div className="gf-automation-ledger"><div><h3>Upcoming checks</h3>{!publications.length && <p>No published posts tracked for this workspace yet.</p>}{publications.slice(0, 6).map(row => <article key={row.id}><strong>Post {text(row.media_id)}</strong><span>Next check: {new Date(text(row.next_due_at)).toLocaleString()}</span></article>)}{work.slice(0, 6).map(row => <article key={row.id}><strong>{text(row.status).replaceAll("_", " ")}</strong><span>{text(row.due_at) ? new Date(text(row.due_at)).toLocaleString() : text(row.message) || "Saved measurement work"}</span><small>{text(row.detail) || text(row.error)}</small></article>)}</div><div><h3>What the factory is testing</h3>{!experiments.length && <p>No experiment yet. A quality score alone cannot establish audience growth.</p>}{experiments.slice(0, 6).map(row => <article key={row.id}><strong>{text(row.variable) || "Creative experiment"} · {text(row.status).replaceAll("_", " ")}</strong><p>{text(row.rationale)}</p><small>{text(row.limitations)}</small><details><summary>Evidence & execution receipt</summary><pre>{JSON.stringify(row, null, 2)}</pre></details></article>)}</div></div>
    {!!snapshots.length && <details><summary>Observed metrics · {snapshots.length} saved snapshots</summary>{snapshots.slice(0, 6).map(row => <article key={row.id}><strong>{text(row.source)}</strong><p>Collected {new Date(text(row.collected_at)).toLocaleString()} · cumulative counts, never summed</p><dl className="gf-automation-metrics">{row.metrics && typeof row.metrics === "object" && !Array.isArray(row.metrics) ? Object.entries(row.metrics).map(([metric, value]) => <div key={metric}><dt>{metric.replaceAll("_", " ")}</dt><dd>{typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "Unavailable"}</dd></div>) : <p>Metric detail unavailable.</p>}</dl></article>)}</details>}
    {onReview && experiments.some(row => typeof row.clip_id === "string") && <div className="gf-automation-drafts">{experiments.map(row => { const clip = factory.data.clips.find(c => c.id === row.clip_id && c.campaign_id === w.campaign?.id && c.profile_id === w.profileId); return clip ? <button key={row.id} onClick={() => onReview(clip)}>Review draft · {clip.hook || clip.name}</button> : null; })}</div>}
    <div className="gf-automation-footer"><p>Observational evidence guides a test; it does not prove lift. Paid spending is off.</p><button disabled={busy} onClick={() => void act(async () => { await refresh(); setNotice("Saved state refreshed."); })}>Refresh</button><button disabled={blocked} onClick={() => void act(async () => { await post("/api/automation/check"); setNotice("Checking work that is due. Future windows stay scheduled."); })}>Check due work</button></div>
  </section>;
}
