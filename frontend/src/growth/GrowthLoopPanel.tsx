import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, post, put } from "../api";
import type { Clip } from "../types";
import { PanelDialog } from "./PanelDialog";
import { reviewPreview } from "./workspaceApi";
import "./growth-loop.css";

type Outcomes = { status: string; label: string; comparison?: { status: string; metric?: string; before_value?: number | null; after_value?: number | null; reasons?: string[]; caveat?: string } | null; evidence_ids?: string[]; caveat?: string };
type LoopSlot = { outcomes?: Outcomes; id: string; parent_clip_id: string; campaign_id: string; variable: string; reason: string; status: string; clip_id?: string | null; approved?: boolean };
type LoopReceipt = { proposal?: { status: string; weak_dimension?: string | null; before?: string | null; after?: string | null; reason: string; assessment_id?: string | null }; source_clip_id?: string; parent_loop_id?: string | null; simulated_evidence?: boolean; evidence_kind?: string; synthetic_observations?: unknown; comparison?: Outcomes["comparison"]; id: string; number: number; profile_id: string; kind: string; status: string; simulated: boolean; slots: LoopSlot[] };
type LoopView = { profile_id: string; policy: { auto_ab: boolean }; taste: { status: string; sample_size: number; minimum: number; positive: number; negative: number; caveat?: string }; loops: LoopReceipt[] };
type ScoreDimension = { id: string; label: string; weight: number; value: number | null; ranking_value: number; neutral_or_proxy: boolean; contribution_points: number };
type EditorialDimension = { score: number | null; reason: string; evidence: { source: string; quote: string }[] };
type Assessment = { id: string; current: boolean; status: string; model: string; message?: string | null; usage?: { calls?: number; cost_usd?: number } | null; assessment?: Record<string, unknown> | null };
type Scorecard = { integrity?: { status: string; message?: string | null }; ranking: { score: number; dimensions: ScoreDimension[]; hold_reason?: string | null; limitations: string }; ai_rubric: { version: string; dimensions: { id: string; label: string; weight: number }[] }; assessments: Assessment[]; judge_policy: { automatic_after_production: boolean; reason?: string | null; cost_basis?: string } };
type Action = "ab" | "recut" | "rehearse";
type Scenario = "mixed" | "decline" | "sparse";
type Pending = { kind: Action; storageKey: string; body: { request_id: string; clip_ids?: string[]; clip_id?: string; expected_sha256?: string; scenario?: Scenario; expected_strategy_version_id: string } };

const human = (value: string) => value.replace(/_/g, " ");
function tasteNote(clip: Clip): string | null {
  const rank = clip.rank as (NonNullable<Clip["rank"]> & { taste?: { index?: number | null; sample_size?: number } }) | null | undefined;
  const taste = rank?.taste;
  return typeof taste?.index === "number" && Number.isFinite(taste.index) ? `Taste alignment ${taste.index} / 100 · ${taste.sample_size ?? 0} reviews` : null;
}
const message = (error: unknown) => error instanceof Error ? error.message : "The local service could not complete the request.";
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function parseView(value: unknown, profileId: string): LoopView {
  if (!object(value) || value.profile_id !== profileId || !object(value.policy) || typeof value.policy.auto_ab !== "boolean" || !object(value.taste) || typeof value.taste.sample_size !== "number" || !Array.isArray(value.loops) || value.loops.some(r => !object(r) || r.profile_id !== profileId || typeof r.id !== "string" || typeof r.number !== "number" || !Array.isArray(r.slots))) throw new Error("The service returned an invalid growth-loop view. Refresh before continuing.");
  const taste = value.taste;
  if (["sample_size", "minimum", "positive", "negative"].some(key => typeof taste[key] !== "number" || !Number.isFinite(taste[key])) || value.loops.some(r => r.slots.some((slot: unknown) => !object(slot) || ["id", "campaign_id", "parent_clip_id", "variable", "reason", "status"].some(key => typeof slot[key] !== "string")))) throw new Error("The service returned incomplete loop evidence. Refresh before continuing.");
  return value as unknown as LoopView;
}
function parseScorecard(value: unknown): Scorecard {
  if (!object(value) || !object(value.ranking) || typeof value.ranking.score !== "number" || !Array.isArray(value.ranking.dimensions) || !object(value.ai_rubric) || !Array.isArray(value.ai_rubric.dimensions) || !Array.isArray(value.assessments) || !object(value.judge_policy)) throw new Error("The service returned an invalid scorecard. Refresh before continuing.");
  if (value.ranking.dimensions.some(d => !object(d) || typeof d.id !== "string" || typeof d.label !== "string" || ["weight", "ranking_value", "contribution_points"].some(key => typeof d[key] !== "number" || !Number.isFinite(d[key])) || !(d.value === null || typeof d.value === "number")) || value.ai_rubric.dimensions.some(d => !object(d) || typeof d.id !== "string" || typeof d.label !== "string") || value.assessments.some(a => !object(a) || typeof a.id !== "string" || typeof a.model !== "string" || typeof a.status !== "string" || typeof a.current !== "boolean")) throw new Error("The service returned incomplete score evidence. Refresh before continuing.");
  return value as unknown as Scorecard;
}
function newRequestId() { return globalThis.crypto?.randomUUID?.() ?? `growth-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function storageGet(key: string): Pending | null {
  try { const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null"); return object(value) && object(value.body) && typeof value.body.request_id === "string" && (Array.isArray(value.body.clip_ids) || typeof value.body.clip_id === "string") && typeof value.body.expected_strategy_version_id === "string" ? value as unknown as Pending : null; } catch { return null; }
}
function storageSet(pending: Pending) { try { sessionStorage.setItem(pending.storageKey, JSON.stringify(pending)); } catch { /* The mounted component still retains the exact request. */ } }
function storageClear(key: string) { try { sessionStorage.removeItem(key); } catch { /* no stored request */ } }

function ScorecardDialog({ clip, open, onClose }: { clip: Clip; open: boolean; onClose: () => void }) {
  const [data, setData] = useState<Scorecard | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const serial = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const path = `/api/clips/${encodeURIComponent(clip.id)}`;
  const load = useCallback(async () => {
    const ticket = ++serial.current;
    try { const value = parseScorecard(await api(`${path}/scorecard`)); if (mounted.current && ticket === serial.current) { setData(value); setError(""); } }
    catch (e) { if (mounted.current && ticket === serial.current) setError(message(e)); }
  }, [path]);
  useEffect(() => { if (!open || reviewPreview) return; void load(); return () => { serial.current++; }; }, [open, load]);
  const current = data?.assessments.filter(a => a.current) ?? [];
  const pending = current.some(a => a.status === "queued" || a.status === "running");
  useEffect(() => { if (!open || !pending || reviewPreview) return; const timer = window.setInterval(() => void load(), 1800); return () => window.clearInterval(timer); }, [open, pending, load]);
  async function assess() {
    if (!clip.sha256 || reviewPreview) return;
    setBusy(true); setError("");
    try { await post(`${path}/assess`, { expected_sha256: clip.sha256, retry_failed: current.some(a => a.status === "failed") }); if (mounted.current) await load(); }
    catch (e) { if (mounted.current) setError(message(e)); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <PanelDialog open={open} onClose={onClose} title="Clip quality scorecard" description={clip.hook || clip.name} size="wide">
    <div className="gf-growth-scorecard">
      {error && <p role="alert" className="gf-growth-error">{error}</p>}
      {!data && !error && <p role="status">Loading the exact clip’s scorecard…</p>}
      {data && <>
        <div className="gf-growth-score-heading"><strong>{data.ranking.score}<small> / 100</small></strong><div><h3>Production rubric</h3><p>Editorial readiness, separate from audience performance.</p></div></div>
        {data.integrity?.status !== "verified" && data.integrity?.message && <p className="gf-growth-error">{data.integrity.message}</p>}
        {data.ranking.hold_reason && <p className="gf-growth-error">Held: {data.ranking.hold_reason}</p>}
        <div className="gf-growth-table-wrap"><table><caption>Eight weighted production dimensions</caption><thead><tr><th>Dimension</th><th>Weight</th><th>Evidence</th><th>Points</th></tr></thead><tbody>{data.ranking.dimensions.map(d => <tr key={d.id}><th scope="row">{d.label}</th><td>{Math.round(d.weight * 100)}%</td><td>{d.value === null ? `Unknown · ranking proxy ${d.ranking_value.toFixed(2)}` : `${Math.round(d.value * 100)} / 100`}{d.neutral_or_proxy && d.value !== null && " · proxy"}</td><td>{d.contribution_points.toFixed(1)}</td></tr>)}</tbody></table></div>
        <section className="gf-growth-editorial" aria-label="AI editorial assessment"><h3>AI editorial assessment</h3><p>Reads supplied source text. It does not watch the video or predict engagement.</p>
          {!current.length && <p>No current assessment yet.</p>}
          {current.map(a => <article key={a.id}><p><strong>{human(a.status)}</strong> · {a.model}</p>{a.message && <p>{a.message}</p>}{a.assessment && <>
            {data.ai_rubric.dimensions.map(def => { const raw = a.assessment?.[def.id]; if (!object(raw)) return null; const d = raw as unknown as EditorialDimension; return <div className="gf-growth-editorial-dimension" key={def.id}><h4>{def.label}<span>{d.score === null ? "Unknown" : `${d.score} / 5`}</span></h4><p>{d.reason}</p>{d.evidence?.length > 0 && <details><summary>Source evidence</summary>{d.evidence.map((q, i) => <blockquote key={i}><p>“{q.quote}”</p><cite>{human(q.source)}</cite></blockquote>)}</details>}</div>; })}
            {typeof a.assessment.suggested_change === "string" && a.assessment.suggested_change && <p><strong>One proposed edit:</strong> {a.assessment.suggested_change}</p>}
            {a.assessment.editorial_hold === true && <p className="gf-growth-error">Editorial hold suggested: inspect source faithfulness before approval.</p>}
          </>}{a.usage && <p className="gf-growth-note">{a.usage.calls ?? 0} model calls · ${Number(a.usage.cost_usd ?? 0).toFixed(4)} assessment cost</p>}</article>)}
          <button type="button" className="gf-button secondary" disabled={!clip.sha256 || busy || pending || !data.judge_policy.automatic_after_production || (!!data.integrity && data.integrity.status !== "verified")} onClick={() => void assess()}>{busy || pending ? "Assessment queued…" : current.some(a => a.status === "failed") ? "Retry failed assessment" : "Assess this exact clip"}</button>
          {data.judge_policy.reason && <p className="gf-growth-note">{data.judge_policy.reason}</p>}
          <p className="gf-growth-note">{data.judge_policy.cost_basis}</p>
        </section>
        <p className="gf-growth-note">{data.ranking.limitations}</p>
      </>}
    </div>
  </PanelDialog>;
}

function rehearsalLabel(loop: LoopReceipt) {
  if (loop.slots.some(slot => slot.status === "completed" && slot.clip_id)) return "Real draft rendered · simulated engagement evidence. This is a rehearsal, not Instagram performance.";
  if (loop.status === "no_draft" || !loop.slots.length) return "No draft rendered · simulated engagement evidence. The rehearsal did not support a new edit.";
  return "Real render requested · simulated engagement evidence. A completed draft is not confirmed yet.";
}
function OutcomeReadout({ outcomes }: { outcomes: Outcomes }) {
  const comparison = outcomes.comparison;
  const metric = comparison?.metric;
  const format = (value: number | null | undefined) => value === null || value === undefined ? "unknown" : metric?.endsWith("_rate") ? `${(value * 100).toFixed(1)}%` : value.toLocaleString();
  return <div className="gf-growth-outcomes"><p><strong>{human(outcomes.status)}</strong> · {outcomes.label === "synthetic" ? "Simulated evidence" : outcomes.label === "demo_override" ? "Demo override · measured early" : outcomes.label === "real_observations" ? "Real account observations" : "Awaiting real measurements"}</p>{comparison && <>{metric && <p>{human(metric)}: {format(comparison.before_value)} → {format(comparison.after_value)}</p>}{comparison.reasons?.map((reason, index) => <p key={index}>{reason}</p>)}<p className="gf-growth-note">{comparison.caveat || outcomes.caveat}</p></>}{!!outcomes.evidence_ids?.length && <p className="gf-growth-note">Evidence: {outcomes.evidence_ids.join(" · ")}</p>}</div>;
}

type Props = { profileId: string; campaignId: string; strategyVersionId: string | null; clips: Clip[]; visible: boolean; onReview?: (clip: Clip) => void; onEditingRules?: () => void; onRehearse?: () => void };
/** Scope key discards local state and in-flight UI results on a workspace/campaign switch. */
export function GrowthLoopPanel(props: Props) { return <GrowthLoopBody key={`${props.profileId}:${props.campaignId}`} {...props} />; }
function GrowthLoopBody({ profileId, campaignId, strategyVersionId, clips, visible, onReview, onEditingRules, onRehearse }: Props) {
  const [view, setView] = useState<LoopView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [retry, setRetry] = useState<Pending | null>(null);
  const [scoreClip, setScoreClip] = useState<Clip | null>(null);
  const mounted = useRef(true);
  const request = useRef<Pending | null>(null);
  const path = `/api/growth/profiles/${encodeURIComponent(profileId)}`;
  const serial = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; serial.current++; }; }, []);
  const load = useCallback(async () => {
    const ticket = ++serial.current;
    try { const value = parseView(await api(path), profileId); if (mounted.current && ticket === serial.current) { setView(value); setError(""); } }
    catch (e) { if (mounted.current && ticket === serial.current) setError(message(e)); }
  }, [path, profileId]);
  useEffect(() => { if (!visible || reviewPreview) return; void load(); return () => { serial.current++; }; }, [visible, load]);
  const loops = (view?.loops ?? []).filter(r => r.simulated === false && (r.slots.some(s => s.campaign_id === campaignId) || clips.some(c => c.id === r.source_clip_id && c.profile_id === profileId && c.campaign_id === campaignId))).sort((a, b) => a.number - b.number);
  const running = loops.some(r => r.slots.some(s => ["prepared", "queued", "running", "submitting"].includes(s.status)));
  useEffect(() => { if (!visible || reviewPreview || !running) return; const timer = window.setInterval(() => void load(), 2000); return () => window.clearInterval(timer); }, [visible, running, load]);
  const scoped = useMemo(() => clips.filter(c => c.profile_id === profileId && c.campaign_id === campaignId), [clips, profileId, campaignId]);
  const eligible = scoped.filter(c => c.sha256 && c.edit_plan && !c.rank?.below_bar && !c.made_without_speech && c.rank?.position && (!c.status || c.status === "ready")).sort((a, b) => (a.rank?.position ?? Infinity) - (b.rank?.position ?? Infinity)).slice(0, 3);
  const storageKey = `growth-loop-request:${profileId}:${campaignId}`;
  useEffect(() => { const pending = storageGet(storageKey); if (pending) { request.current = pending; setRetry(pending); } }, [storageKey]);
  async function changePolicy(auto_ab: boolean) {
    setBusy("policy"); setError("");
    try { const policy = await put<LoopView["policy"]>(`${path}/policy`, { auto_ab }); if (!object(policy) || typeof policy.auto_ab !== "boolean") throw new Error("The policy save could not be confirmed. Refresh before changing it again."); if (mounted.current) setView(v => v ? { ...v, policy } : v); }
    catch (e) { if (mounted.current) setError(message(e)); }
    finally { if (mounted.current) setBusy(null); }
  }
  async function start(kind: "ab" | "recut") {
    if (reviewPreview || (!request.current && (!strategyVersionId || !eligible.length))) return;
    const pending = request.current ?? { kind, storageKey, body: { request_id: newRequestId(), clip_ids: eligible.map(c => c.id), expected_strategy_version_id: strategyVersionId! } };
    if (pending.kind !== kind) return;
    request.current = pending; storageSet(pending); setBusy(kind); setError("");
    try { await post(`${path}/${pending.kind}`, pending.body); storageClear(storageKey); request.current = null; if (mounted.current) { setRetry(null); await load(); } }
    catch (e) {
      const uncertain = !(e instanceof ApiError) || e.status < 400 || e.status >= 500;
      if (!uncertain) { storageClear(storageKey); request.current = null; }
      if (mounted.current) { setRetry(uncertain ? pending : null); setError(`${message(e)}${uncertain ? " The request may have reached the service. Retry uses the same batch and request ID." : ""}`); }
    } finally { if (mounted.current) setBusy(null); }
  }
  const canStart = !reviewPreview && !!view && ((!!strategyVersionId && !!eligible.length) || !!retry) && !busy;
  return <section className="gf-growth-loop" aria-label="Growth loop">
    <header><div><h2>Make the next round count.</h2><p>Inspect the rubric, learn your preferences, and render one-variable tests.</p></div><button className="gf-button secondary compact" type="button" onClick={onRehearse} disabled={!onRehearse}>Rehearse the loop</button></header>
    {reviewPreview ? <p className="gf-growth-note">Design preview. Real preference, assessment, and render controls are available in the Mac app. Open the Factory map to rehearse with clearly labeled synthetic data.</p> : <>
      {error && <p role="alert" className="gf-growth-error">{error}</p>}
      {!view && !error && visible && <p role="status">Loading growth-loop receipts…</p>}
      {view && <>
        <div className="gf-growth-preference"><strong>Your taste</strong><span>{view.taste.sample_size} reviewed revisions · {view.taste.positive} approvals · {view.taste.negative} change or reject decisions</span><p>{view.taste.status === "ready" ? "Preference alignment is available. It changes review order by at most five points; the quality rubric stays intact." : `Keep reviewing: at least ${view.taste.minimum} decisions, including approval and change/reject examples, are needed.`}</p><small>Preference alignment is an index, not a probability or Instagram result.</small></div>
        <label className="gf-growth-policy"><input type="checkbox" checked={view.policy.auto_ab} disabled={!!busy} onChange={e => void changePolicy(e.target.checked)} /><span>Automatically make a hook-format B variant for the top three picks.<small>New drafts only. Each publication still needs your approval.</small></span></label>
        {retry?.kind === "rehearse" && <p className="gf-growth-note">An earlier rehearsal request may still be running. Open the Factory map to inspect its receipt before starting another render.</p>}
        <div className="gf-growth-actions"><button type="button" className="gf-button secondary" disabled={!canStart || (!!retry && retry.kind !== "ab")} onClick={() => void start("ab")}>{retry?.kind === "ab" ? "Retry same A/B request" : "Make top-three A/B drafts"}</button><button type="button" className="gf-button secondary" disabled={!canStart || (!!retry && retry.kind !== "recut")} onClick={() => void start("recut")}>{retry?.kind === "recut" ? "Retry same re-cut request" : "Apply learning → re-cut"}</button><button type="button" className="gf-growth-link" onClick={() => void load()} disabled={!!busy}>Refresh receipts</button></div>
        <p className="gf-growth-note">{eligible.length ? `${eligible.length} eligible ranked clips in this campaign.` : "Generate and rank a fresh batch to prepare experiments."} Re-cut applies one changed, approved Style rule. {onEditingRules && <button type="button" className="gf-growth-link" onClick={onEditingRules}>Review Style rules</button>}</p>
        {scoped.length > 0 && <details className="gf-growth-clip-list"><summary>Inspect clip quality ({scoped.length})</summary>{scoped.map(c => <div key={c.id}><span>{c.hook || c.name}{tasteNote(c) && <small className="gf-growth-note">{tasteNote(c)}</small>}</span><span className="gf-growth-clip-actions"><button type="button" className="gf-growth-link" onClick={() => setScoreClip(c)}>Scorecard<span className="gf-growth-sr"> for {c.hook || c.name}</span></button></span></div>)}</details>}
        <div className="gf-growth-receipts"><h3>Production loop receipts</h3>{!loops.length && <p>No loop receipts yet. Rehearsal data is kept separate.</p>}{loops.map(loop => <article key={loop.id}><h4>{view.loops.find(parent => parent.id === loop.parent_loop_id) ? `Loop #${view.loops.find(parent => parent.id === loop.parent_loop_id)!.number} → Loop #${loop.number}` : `Loop #${loop.number}`}<span>{human(loop.kind)} · {human(loop.status)}</span></h4>{loop.simulated_evidence && <p className="gf-growth-synthetic">{rehearsalLabel(loop)}</p>}{loop.proposal && <div className="gf-growth-rubric-proposal"><p><strong>Rubric decision:</strong> {human(loop.proposal.status)}{loop.proposal.weak_dimension && ` · ${human(loop.proposal.weak_dimension)}`}</p><p>{loop.proposal.reason}</p><p><strong>Before:</strong> {loop.proposal.before || "No opening text"}</p><p><strong>Proposed:</strong> {loop.proposal.after || "No supported edit"}</p>{loop.proposal.assessment_id && <p className="gf-growth-note">Assessment: {loop.proposal.assessment_id}</p>}</div>}{loop.simulated_evidence && loop.comparison && <OutcomeReadout outcomes={{ status: loop.comparison.status, label: "synthetic", comparison: loop.comparison }} />}{loop.slots.filter(s => s.campaign_id === campaignId).map(slot => { const output = scoped.find(c => c.id === slot.clip_id); return <div className="gf-growth-slot" key={slot.id}><p><strong>{human(slot.variable)}</strong> · {human(slot.status)}</p><p>{slot.reason}</p>{slot.outcomes && <OutcomeReadout outcomes={slot.outcomes} />}{slot.status === "unknown" && <p className="gf-growth-error">Outcome unknown. Refresh to reconcile; do not start a duplicate render.</p>}{output && <button type="button" className="gf-growth-link" onClick={() => onReview?.(output)} disabled={!onReview}>Review {output.approved ? "version" : "draft"}: {output.hook || output.name}</button>}{slot.clip_id && !output && <p className="gf-growth-note">Draft saved. Refresh the Library to load this version.</p>}</div>; })}</article>)}</div>
      </>}
    </>}
    {scoreClip && <ScorecardDialog key={`${scoreClip.id}:${scoreClip.sha256}`} clip={scoreClip} open={visible && !!scoreClip} onClose={() => setScoreClip(null)} />}
  </section>;
}
