import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, localMediaUrl, post } from "../api";
import type { Clip } from "../types";
import type { FactoryState } from "../useFactory";
import { type FactoryMapModel, type StationId } from "./flowEvents";
import { activeRulesId, type Workspace } from "./useCampaignWorkspace";
import { reviewPreview } from "./workspaceApi";
import "./loop-rehearsal.css";

type Scenario = "mixed" | "decline" | "sparse";
type Dimension = { id: string; label: string; weight: number; value: number | null; ranking_value: number; contribution_points: number };
type Assessment = { id: string; current: boolean; sha256?: string; status: string; message?: string; assessment?: Record<string, unknown> };
export type LoopScorecard = { integrity?: { status: string; message?: string }; ranking: { clip_id?: string; sha256?: string; score: number; hold_reason?: string | null; dimensions: Dimension[]; limitations?: string }; assessments: Assessment[] };
type Observation = { id: string; simulated: boolean; metrics: Record<string, number | null> };
type Comparison = { status: string; before_value: number | null; after_value: number | null; metric?: string; reasons: string[]; decision: string; caveat?: string };
type Proposal = { status: string; reason: string; before?: string | null; after?: string | null; weak_dimension?: string | null; source_quote?: string; evidence_source?: string; assessment_id?: string | null };
type Preview = { source_clip_id: string; source_sha256: string; simulated_evidence: boolean; scenario: Scenario; proposal: Proposal; comparison: Comparison; synthetic_observations: Observation[] };
type Slot = { id: string; parent_clip_id: string; parent_sha256?: string; campaign_id: string; status: string; job_id?: string | null; clip_id?: string | null; sha256?: string; error?: string };
type Receipt = { id: string; number: number; profile_id: string; source_clip_id?: string; source_sha256?: string; status: string; kind: string; simulated_evidence?: boolean; proposal?: Proposal; comparison?: Comparison; slots: Slot[] };
type PlanPair = { id: string; before: { id: string; topic: string; hook: string; synthetic_transcript: string }; after: { hook: string }; quality_before: { score: number }; quality_after: { score: number }; proposal: { source_quote: string; reason: string }; evaluation: Comparison; observations: Observation[] };
type SyntheticReplay = { simulated: true; loops: { number: number; pairs: PlanPair[] }[] };
type RequestBody = { request_id: string; clip_id: string; expected_sha256: string; expected_strategy_version_id: string; scenario: Scenario };
const PHASES = ["critic", "post", "measure", "strategist", "editor", "critic"] as const;
const TITLES = ["Inspect the rubric", "Post to Instagram · simulated", "Measure the evidence", "Propose one change", "Render the next draft", "Compare the versions"];
const human = (v: string) => v.replaceAll("_", " ");
const errorText = (e: unknown) => e instanceof Error ? e.message : "The rehearsal could not be loaded.";
const row = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function scorecard(value: unknown, clip: Clip): LoopScorecard {
  if (!row(value) || !row(value.ranking) || value.ranking.clip_id !== clip.id || value.ranking.sha256 !== clip.sha256 || typeof value.ranking.score !== "number" || !Number.isFinite(value.ranking.score) || !Array.isArray(value.ranking.dimensions) || !Array.isArray(value.assessments)) throw new Error("The scorecard does not match the selected clip revision.");
  return value as unknown as LoopScorecard;
}
function preview(value: unknown, clip: Clip, scenario: Scenario): Preview {
  if (!row(value) || value.source_clip_id !== clip.id || value.source_sha256 !== clip.sha256 || value.simulated_evidence !== true || value.scenario !== scenario || !row(value.proposal) || !row(value.comparison) || !Array.isArray(value.synthetic_observations)) throw new Error("The rehearsal preview does not match this clip, scenario and revision.");
  return value as unknown as Preview;
}
function receipt(value: unknown, profile: string, clip: Clip): Receipt {
  if (!row(value) || value.profile_id !== profile || value.source_clip_id !== clip.id || value.source_sha256 !== clip.sha256 || value.simulated_evidence !== true || typeof value.id !== "string" || !Array.isArray(value.slots) || value.slots.some(s => !row(s) || s.parent_clip_id !== clip.id || s.campaign_id !== clip.campaign_id)) throw new Error("The render receipt does not match the selected clip and brand.");
  return value as unknown as Receipt;
}
function requestId() { return globalThis.crypto?.randomUUID?.() ?? `rehearsal-${Date.now()}-${Math.random().toString(36).slice(2)}`; }

export function useLoopRehearsal(w: Workspace, factory: FactoryState, enabled: boolean) {
  const clips = useMemo(() => factory.data.clips.filter(c => c.profile_id === w.profileId && c.campaign_id === w.campaign?.id && (w.campaign?.video_ids ?? []).includes(c.video_id) && /^[a-f0-9]{64}$/i.test(c.sha256 || "") && !c.rank?.below_bar && !c.made_without_speech), [factory.data.clips, w.profileId, w.campaign]);
  const [chosen, setChosen] = useState("");
  const clip = clips.find(c => c.id === chosen) ?? clips[0];
  const rules = activeRulesId(w);
  const scopeKey = `${w.profileId}:${w.campaign?.id}:${clip?.id}:${clip?.sha256}:${rules}`;
  const currentScope = useRef(scopeKey); currentScope.current = scopeKey;
  const [phase, setPhase] = useState(0), [playing, setPlaying] = useState(false), [scenario, setScenario] = useState<Scenario>("mixed");
  const [score, setScore] = useState<LoopScorecard | null>(null), [afterScore, setAfterScore] = useState<LoopScorecard | null>(null);
  const [draft, setDraft] = useState<Preview | null>(null), [result, setResult] = useState<Receipt | null>(null);
  const [synthetic, setSynthetic] = useState<SyntheticReplay | null>(null), [error, setError] = useState("");
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [pending, setPending] = useState<RequestBody | null>(null);
  const runIntent = useRef<string | null>(null);
  const serial = useRef(0), mounted = useRef(true), submitLock = useRef<string | null>(null), priorPhase = useRef<StationId | null>(null);
  const [transition, setTransition] = useState<{ from: StationId; to: StationId; key: number } | null>(null);
  const storageKey = `gf-rehearsal:${scopeKey}`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; serial.current++; }; }, []);
  useEffect(() => {
    serial.current++; setScore(null); setAfterScore(null); setDraft(null); setResult(null); setSynthetic(null); setError(""); setPhase(0); setPlaying(false); setPending(null); setBusy(false); submitLock.current = null; runIntent.current = null; priorPhase.current = null;
    try { const v: unknown = JSON.parse(sessionStorage.getItem(storageKey) || "null"); if (row(v) && v.clip_id === clip?.id && v.expected_sha256 === clip?.sha256 && v.expected_strategy_version_id === rules) setPending(v as unknown as RequestBody); } catch { /* Mounted request still has an exact id. */ }
  }, [scopeKey]);
  useEffect(() => { if (!enabled) setPlaying(false); }, [enabled]);
  const load = useCallback(async () => {
    if (!enabled) return;
    const ticket = ++serial.current, scope = scopeKey;
    setLoading(true); setError("");
    try {
      if (reviewPreview) throw new Error("This visual preview does not execute real clip or rehearsal APIs. Open the authenticated Mac app to rehearse.");
      if (!clip) {
        const value = await post<SyntheticReplay>(`/api/demo-loop/${encodeURIComponent(w.profileId)}/simulate`, { seed: 7, rounds: 2, scenario });
        if (!value.simulated || !Array.isArray(value.loops) || !value.loops[0]?.pairs?.length) throw new Error("The service returned incomplete synthetic plans.");
        if (mounted.current && ticket === serial.current && currentScope.current === scope) setSynthetic(value);
      } else {
        const value = scorecard(await api(`/api/clips/${encodeURIComponent(clip.id)}/scorecard`), clip);
        if (!mounted.current || ticket !== serial.current || currentScope.current !== scope) return;
        const proposal = rules ? preview(await post(`/api/growth/profiles/${encodeURIComponent(w.profileId)}/rehearse-preview`, { request_id: `preview-${clip.id}`, clip_id: clip.id, expected_sha256: clip.sha256, expected_strategy_version_id: rules, scenario }), clip, scenario) : null;
        if (mounted.current && ticket === serial.current && currentScope.current === scope) { setScore(value); setDraft(proposal); }
      }
    } catch (e) { if (mounted.current && ticket === serial.current && currentScope.current === scope) setError(errorText(e)); }
    finally { if (mounted.current && ticket === serial.current) setLoading(false); }
  }, [enabled, scopeKey, clip, rules, scenario, w.profileId]);
  useEffect(() => { void load(); return () => { serial.current++; }; }, [load]);
  useEffect(() => {
    if (!playing || !enabled) return;
    if (phase >= 3) {
      setPlaying(false);
      if (runIntent.current === scopeKey) {
        runIntent.current = null;
        if (clip && draft?.proposal.status === "supported_rubric_edit" && draft.comparison.decision === "test" && score?.integrity?.status === "verified") void renderDraft();
      }
      return;
    }
    const timer = window.setTimeout(() => setPhase(p => Math.min(3, p + 1)), 1900);
    return () => window.clearTimeout(timer);
  }, [playing, enabled, phase, scopeKey, clip?.id, draft, score]);
  useEffect(() => {
    const next = PHASES[phase], previous = priorPhase.current;
    if (previous && previous !== next) setTransition({ from: previous, to: next, key: Date.now() });
    priorPhase.current = next;
    const timer = window.setTimeout(() => setTransition(null), 850);
    return () => window.clearTimeout(timer);
  }, [phase]);
  const activeSlot = result?.slots[0];
  const output = factory.data.clips.find(c => c.id === activeSlot?.clip_id && c.sha256 === activeSlot.sha256 && c.profile_id === w.profileId && c.campaign_id === w.campaign?.id);
  const refreshReceipt = useCallback(async () => {
    if (!result || !clip) return;
    const scope = scopeKey;
    try {
      const value = await api<{ profile_id: string; loops: unknown[] }>(`/api/growth/profiles/${encodeURIComponent(w.profileId)}`);
      if (value.profile_id !== w.profileId || !Array.isArray(value.loops)) throw new Error("The loop readback has a different brand.");
      const match = value.loops.find(v => row(v) && v.id === result.id);
      if (!match) throw new Error("The render receipt is not available yet. Refresh before retrying.");
      const next = receipt(match, w.profileId, clip);
      if (mounted.current && currentScope.current === scope) { setResult(next); if (next.status === "completed") { setPhase(5); void factory.refresh?.(["clips", "jobs"]); } }
    } catch (e) { if (mounted.current && currentScope.current === scope) setError(errorText(e)); }
  }, [result?.id, clip, scopeKey, w.profileId, factory.refresh]);
  useEffect(() => {
    if (!enabled || !result || !["running", "submitting"].includes(result.status)) return;
    const timer = window.setInterval(() => void refreshReceipt(), 2200);
    return () => window.clearInterval(timer);
  }, [enabled, result?.status, refreshReceipt]);
  useEffect(() => {
    if (!enabled || !output) return;
    let live = true;
    void api(`/api/clips/${encodeURIComponent(output.id)}/scorecard`).then(value => { if (live) setAfterScore(scorecard(value, output)); }).catch(e => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [enabled, output?.id, output?.sha256]);
  async function renderDraft() {
    if (!clip || !rules || !draft || submitLock.current === scopeKey || reviewPreview) return;
    if (!pending && (draft.proposal.status !== "supported_rubric_edit" || draft.comparison.decision !== "test" || score?.integrity?.status !== "verified")) return;
    const scope = scopeKey;
    const body = pending ?? { request_id: requestId(), clip_id: clip.id, expected_sha256: clip.sha256!, expected_strategy_version_id: rules, scenario };
    submitLock.current = scope; setBusy(true); setError(""); setPlaying(false); setPending(body);
    try { sessionStorage.setItem(storageKey, JSON.stringify(body)); } catch { /* In-memory identity retained. */ }
    try {
      const next = receipt(await post(`/api/growth/profiles/${encodeURIComponent(w.profileId)}/rehearse`, body), w.profileId, clip);
      if (mounted.current && currentScope.current === scope) { setResult(next); setPending(null); sessionStorage.removeItem(storageKey); setPhase(next.status === "no_draft" ? 3 : next.status === "completed" ? 5 : 4); void factory.refresh?.(["clips", "jobs"]); }
    } catch (e) {
      if (mounted.current && currentScope.current === scope) {
        setError(errorText(e));
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) { setPending(null); try { sessionStorage.removeItem(storageKey); } catch { /* Already rejected. */ } }
      }
    } finally { if (submitLock.current === scope) submitLock.current = null; if (mounted.current && currentScope.current === scope) setBusy(false); }
  }
  async function assess() {
    if (!clip || busy || reviewPreview) return;
    const scope = scopeKey; setBusy(true); setError("");
    try { await post(`/api/clips/${encodeURIComponent(clip.id)}/assess`, { expected_sha256: clip.sha256 }); if (currentScope.current === scope) await load(); }
    catch (e) { if (currentScope.current === scope) setError(errorText(e)); }
    finally { if (currentScope.current === scope) setBusy(false); }
  }
  const assessmentPending = score?.assessments.some(a => a.current && ["queued", "running"].includes(a.status));
  useEffect(() => { if (!enabled || !assessmentPending) return; const timer = window.setInterval(() => void load(), 2200); return () => window.clearInterval(timer); }, [enabled, assessmentPending, load]);
  const syntheticPair = synthetic?.loops[0]?.pairs[0];
  const proposal = draft?.proposal ?? (syntheticPair ? { status: "synthetic_plan", reason: syntheticPair.proposal.reason, before: syntheticPair.before.hook, after: syntheticPair.after.hook, source_quote: syntheticPair.proposal.source_quote } : undefined);
  const comparison = draft?.comparison ?? syntheticPair?.evaluation;
  const observations = draft?.synthetic_observations ?? syntheticPair?.observations;
  return { clips, clip, output, score, afterScore, proposal, comparison, observations, syntheticPair, phase, playing, scenario, error, loading, busy, pending, result, transition, station: PHASES[phase] as StationId, title: TITLES[phase],
    setClip: (id: string) => { if (!busy && !pending && !result?.slots.some(s => ["queued", "running", "prepared", "submitting", "unknown"].includes(s.status))) setChosen(id); },
    setScenario: (value: Scenario) => { if (!busy && !pending && !result) { setScenario(value); setPhase(0); setPlaying(false); setDraft(null); } },
    play: () => { runIntent.current = null; if (phase >= 3) setPhase(0); setPlaying(v => !v); },
    runExperiment: () => {
      if (!clip || !draft || !score || busy || pending || result || reviewPreview) return;
      runIntent.current = scopeKey;
      setPhase(0); setPlaying(true); setError("");
    },
    next: () => { setPlaying(false); setPhase(p => Math.min(clip ? 3 : 5, p + 1)); },
    reset: () => { setPlaying(false); setPhase(0); if (result && ["completed", "no_draft"].includes(result.status)) { setResult(null); setAfterScore(null); } }, pause: useCallback(() => { runIntent.current = null; setPlaying(false); }, []), load, renderDraft, assess, refreshReceipt,
  };
}
export type LoopRehearsalState = ReturnType<typeof useLoopRehearsal>;

export function rehearsalModel(real: FactoryMapModel, state: LoopRehearsalState): FactoryMapModel {
  const used = new Set(PHASES.slice(0, state.phase));
  return { ...real, live: false, edges: real.edges.map(e => ({ ...e, flowing: false })),
    returnArc: { lit: !!state.result && state.result.status === "completed", label: state.result?.status === "completed" ? "Rehearsal revision saved · real audience outcome unknown" : "Style / strategy → next factory iteration" },
    stations: real.stations.map(s => ({ ...s, state: s.id === state.station ? state.phase === 3 ? "idle" : state.phase === 4 && state.result?.status === "held" ? "failed" : "active" : used.has(s.id as typeof PHASES[number]) ? "done" : "idle",
      status: s.id === state.station ? state.title : used.has(s.id as typeof PHASES[number]) ? "Rehearsal step inspected" : "Not active in this rehearsal",
      counts: [], last: "", sheet: [], dim: false })) };
}

export function LoopRehearsalControls({ state }: { state: LoopRehearsalState }) {
  const blocked = state.busy || !!state.pending || !!state.result;
  return <div className="gf-loop-rehearsal-controls">
    <div className="gf-loop-rehearsal-label"><strong>Simulated Instagram data</strong><span>{state.clip ? "Real clip → synthetic measurement → real next draft" : "Generate a real clip first. Plan-only preview is available below."}</span></div>
    <div className="gf-loop-rehearsal-inputs"><label>Original clip<select aria-label="Rehearsal clip" value={state.clip?.id ?? ""} onChange={e => state.setClip(e.target.value)} disabled={blocked || !state.clips.length}>{!state.clips.length && <option value="">No eligible real clip</option>}{state.clips.map(c => <option key={c.id} value={c.id}>{c.hook || c.name}</option>)}</select></label><label>Evidence scenario<select aria-label="Rehearsal scenario" value={state.scenario} disabled={blocked} onChange={e => state.setScenario(e.target.value as Scenario)}><option value="mixed">Supported change</option><option value="decline">Underperforming variant</option><option value="sparse">Pending evidence</option></select></label>
      <div className="gf-loop-rehearsal-playback"><button type="button" className="gf-loop-rehearsal-primary" onClick={state.runExperiment} disabled={!state.clip || !state.proposal || state.loading || state.busy || !!state.pending || !!state.result || state.playing}>Run demo experiment — creates one draft</button>{state.pending && <button type="button" onClick={() => void state.renderDraft()} disabled={state.busy}>Retry same draft request</button>}{state.playing && <button type="button" onClick={state.pause}>Pause</button>}<button type="button" onClick={state.reset} disabled={state.busy}>{state.result && ["completed", "no_draft"].includes(state.result.status) ? "New experiment" : "Reset view"}</button></div>
    </div>
    <p role="status" aria-live="polite">{state.loading ? "Reading the exact clip, rubric and source-backed proposal…" : state.result ? `Loop #${state.result.number} · ${human(state.result.status)}` : state.phase === 3 && !state.playing ? state.comparison?.decision !== "test" ? `Stopped: ${human(state.comparison?.status || "insufficient evidence")}. ${state.comparison?.reasons.join(" ") || "The original stays unchanged."}` : state.proposal?.status !== "supported_rubric_edit" ? "Stopped: the rubric has no safely supported edit. Assess the clip or choose another." : "The proposed edit is ready for the next factory iteration." : state.title}</p>
    {!state.clip && <button type="button" onClick={state.play} disabled={state.loading || state.playing}>Preview plan-only sequence</button>}
    {state.error && <p className="gf-loop-rehearsal-error" role="alert">{state.error} <button type="button" onClick={() => void state.load()} disabled={state.busy}>Refresh evidence</button></p>}
  </div>;
}
function Score({ data, label }: { data: LoopScorecard | null; label: string }) {
  return <section className="gf-loop-score"><h4>{label}</h4>{data ? <><strong>{data.ranking.score}<small> / 100 quality proxy</small></strong>{data.integrity?.status !== "verified" && <p>Exact-file assessment is not verified.</p>}{data.ranking.hold_reason && <p>Held: {data.ranking.hold_reason}</p>}<details><summary>Eight weighted dimensions</summary><dl>{data.ranking.dimensions.map(d => <div key={d.id}><dt>{d.label} · {Math.round(d.weight * 100)}%</dt><dd>{d.value === null ? "Unknown / proxy" : `${Math.round(d.value * 100)} / 100`} · {d.contribution_points.toFixed(1)} pts</dd></div>)}</dl></details></> : <p>Score not available yet. A missing assessment is not a passing result.</p>}</section>;
}
export function LoopRehearsalInspector({ state }: { state: LoopRehearsalState }) {
  const beforeMedia = state.clip && !reviewPreview ? localMediaUrl(`/api/clips/${encodeURIComponent(state.clip.id)}/media`) : undefined;
  const afterMedia = state.output && !reviewPreview ? localMediaUrl(`/api/clips/${encodeURIComponent(state.output.id)}/media`) : undefined;
  const assessment = state.score?.assessments.find(a => a.current && a.status === "assessed");
  const observations = state.observations;
  const percent = (value: number | null | undefined) => value == null ? "Unknown" : `${(value * 100).toFixed(0)}%`;
  return <div className="gf-loop-rehearsal-inspector gf-loop-inline-workbench">
    <header className="gf-loop-workbench-head"><div><span className="gf-loop-eyebrow">One experiment · one editorial change</span><h3>{state.clip ? "From this reel to the next draft" : "Plan-only example"}</h3></div><span className="gf-loop-evidence-badge">Simulated Instagram data</span></header>
    <p className="gf-loop-rehearsal-banner">{state.clip ? "The original and any completed revision are real files. The audience counts below are hypothetical; nothing is posted." : "Synthetic plans only. No media was rendered and the real-draft action is disabled."}</p>
    <div className="gf-loop-media-pair">
      <section className="gf-loop-version"><div className="gf-loop-version-label"><h4>Original content</h4><span>{state.clip ? "Actual clip" : "Synthetic plan"}</span></div>{beforeMedia ? <video key={state.clip!.id} controls playsInline preload="metadata" src={beforeMedia} aria-label="Original clip video" /> : <div className="gf-loop-plan-placeholder"><p>{state.syntheticPair?.before.hook || "Generate a fresh batch in Factory to choose an original."}</p></div>}<p className="gf-loop-version-hook">{state.clip?.hook}</p>{state.clip ? <Score data={state.score} label="Original rubric" /> : <p>Quality proxy {state.syntheticPair?.quality_before.score ?? "unknown"} · synthetic metadata.</p>}<small>{state.clip?.sha256 ? `Exact revision ${state.clip.sha256.slice(0, 12)}` : "No real file attached"}</small></section>
      <section className="gf-loop-version"><div className="gf-loop-version-label"><h4>Next factory iteration</h4><span>{state.output ? "Actual new draft" : state.result?.status === "running" ? "Rendering" : "Proposed edit"}</span></div>{afterMedia ? <video key={state.output!.id} controls playsInline preload="metadata" src={afterMedia} aria-label="Revised clip video" /> : <div className={`gf-loop-plan-placeholder${state.phase === 4 ? " is-working" : ""}`}><span>{state.result?.slots[0]?.job_id ? "Editor job recorded" : "One source-backed hook change"}</span><p>{state.proposal?.after || "No supported edit yet"}</p><small>{state.result?.status === "running" ? "The real renderer is working. The next clip appears only after its receipt is complete." : "The demo runs the measurement and strategy steps, then renders one draft when the evidence and rubric support it."}</small></div>}<p className="gf-loop-version-hook">{state.output?.hook}</p>{state.output ? <Score data={state.afterScore} label="Revised rubric" /> : <p className="gf-loop-rehearsal-note">No revised score is claimed before a real output and its assessment exist.</p>}<small>{state.output ? "Revision · actual unapproved draft. Real audience outcome unknown." : "No output video has been fabricated."}</small></section>
    </div>
    <div className="gf-loop-evidence-row">
      <section><span className="gf-loop-eyebrow">Measure</span><h4>Completion rate</h4><p className="gf-loop-rate">{percent(state.comparison?.before_value)} <span>→</span> {percent(state.comparison?.after_value)}</p><p>{observations?.map(o => `${o.metrics.completions == null ? "Unknown" : o.metrics.completions} completions / ${o.metrics.views == null ? "unknown" : o.metrics.views} views`).join(" · ") || "No measurement available."}</p><small>Synthetic 3-day comparison. This is not the new draft’s measured performance.</small><details><summary>All synthetic counts</summary><table><thead><tr><th>Metric</th><th>Original</th><th>Hypothetical variant</th></tr></thead><tbody>{["views", "completions", "likes", "comments", "shares", "saves", "link_clicks"].map(key => <tr key={key}><th scope="row">{human(key)}</th>{observations?.slice(0, 2).map(o => <td key={o.id}>{o.metrics[key] == null ? "Unknown" : o.metrics[key]!.toLocaleString()}</td>)}</tr>)}</tbody></table></details></section>
      <section><span className="gf-loop-eyebrow">Strategy / style upgrade</span><h4>{state.proposal?.weak_dimension ? human(state.proposal.weak_dimension) : "One supported creative change"}</h4><p>{state.proposal?.reason || "The rubric must identify a safe edit before the factory makes a revision."}</p>{state.proposal?.source_quote && <blockquote>“{state.proposal.source_quote}”<cite>Source speech · {state.proposal.evidence_source || "synthetic excerpt"}</cite></blockquote>}<small>{state.comparison?.reasons.join(" ") || "The proposed rule stays separate from approved strategy. No model weights are trained."}</small></section>
      <section><span className="gf-loop-eyebrow">Next production</span><h4>{state.result?.status === "completed" ? "A new draft is saved" : state.comparison?.decision === "test" && state.proposal?.status === "supported_rubric_edit" ? "The editor has a concrete next step" : "Wait or keep the original"}</h4><p>{state.result?.slots[0]?.error || state.result ? state.result?.slots[0]?.error || `Loop #${state.result!.number} · ${human(state.result!.status)}. Follow its recorded output.` : "The next edit changes only the hook. Source, duration, framing and captions stay fixed."}</p><small>Factory builder is used only for a recorded capability gap. Rendering this hook repair does not imply a code upgrade.</small>{state.result && <button type="button" className="gf-loop-rehearsal-secondary" onClick={() => void state.refreshReceipt()}>Refresh render receipt</button>}</section>
    </div>
    {state.clip && <details className="gf-loop-technical"><summary>Rubric evidence and assessment controls</summary>{state.score?.integrity?.status !== "verified" && <p className="gf-loop-rehearsal-error">{state.score?.integrity?.message || "Exact-file integrity is not verified. Real rendering is held."}</p>}<button type="button" className="gf-loop-rehearsal-secondary" onClick={() => void state.assess()} disabled={state.busy || !state.clip.sha256}>Run configured AI assessment</button><p className="gf-loop-rehearsal-note">Uses the configured provider and records its cost. A quality score is not an engagement probability or publication permission.</p>{assessment && <pre>{JSON.stringify(assessment.assessment, null, 2)}</pre>}{state.result && <pre>{JSON.stringify({ receipt: state.result.id, slots: state.result.slots }, null, 2)}</pre>}</details>}
    {!state.clip && <p className="gf-loop-rehearsal-note">Generate a real clip before rendering. This fallback only demonstrates plans and synthetic outcomes.</p>}
  </div>;
}
