import { AutoTextarea } from "../components/AutoTextarea";
import { useEffect, useRef, useState } from "react";
import { activeJob, installedLlms } from "../productionPreflight";
import type { Job, TeamRun } from "../types";
import type { FactoryState } from "../useFactory";
import { activeRulesId, type Workspace } from "./useCampaignWorkspace";
import { reviewPreview, workspaceApi } from "./workspaceApi";
import { endpoint } from "../api";
import { Disclosure, Empty, Field, Pill, Poster, PrimaryAction, formatTime } from "./parts";
import { Icon } from "./Icon";
import { ClipEvidence } from "./ClipEvidence";
import { SourceTranscript } from "./SourceTranscript";
import { CraftControls, craftFromPlan, craftPlan, freshCraft } from "./CraftControls";
import { JourneyProgress } from "./JourneyProgress";
import { sourceLabel } from "./sourcePresentation";
import { clipMediaUrl, exportManifestUrl, exportMediaUrl, productionApi } from "./productionApi";
import { PostToInstagram } from "./PostToInstagram";
import { briefSummary } from "./briefModel";
import { rankOf, reviewOrder } from "./clipRanking";
import "./campaign-brief.css";
import { DIRECTION_MAX, parseProductionClip, type CampaignRenderRequest, type ExportRecord, type ProductionClip } from "./productionContracts";
import { changedEditFields, clipInScope, editErrors, jobInScope, object, readiness, retryBlocker, reviewBlocker } from "./productionState";

type Mode = "manual" | "agent";
const message = (e: unknown) => e instanceof Error ? e.message : "The operation was not confirmed. Refresh before retrying.";
export function Studio({ w, factory, preferredSource, preferredMode, preferredClip, onDirection, onEditBrief }: {
  w: Workspace; factory: FactoryState; /** Kept for callers; Results is one click away in the sidebar. */ next: () => void; preferredSource?: string; preferredMode?: Mode; preferredClip?: string;
  /** Opens the direction screen when production is blocked on approval. */
  onDirection?: () => void;
  /** Opens Workspace settings, where the campaign brief is edited. */
  onEditBrief?: () => void;
}) {
  const sources = factory.data.videos.filter(v => w.campaign?.video_ids.includes(v.id));
  const scope = { campaignId: w.campaign?.id || "", profileId: w.profileId, sourceIds: sources.map(v => v.id) };
  const scopeKey = `${scope.campaignId}/${scope.profileId}/${scope.sourceIds.join("|")}`;
  const [sourceId, setSourceId] = useState(preferredSource || sources[0]?.id || "");
  const [selectedId, setSelectedId] = useState(preferredClip || "");
  const [freshProduction, setFreshProduction] = useState(false);
  const [mode, setMode] = useState<Mode>(preferredMode || "agent");
  const [start, setStart] = useState("0"), [end, setEnd] = useState("30");
  const [hook, setHook] = useState("");
  const [opening, setOpening] = useState<"text_overlay" | "cold_open">("text_overlay");
  const [coldStart, setColdStart] = useState("0"), [coldEnd, setColdEnd] = useState("3");
  const [focusX, setFocusX] = useState(.5), [subtitles, setSubtitles] = useState(true);
  const [craft, setCraft] = useState(freshCraft);
  const [feedback, setFeedback] = useState(""), [revisionParent, setRevisionParent] = useState<ProductionClip>();
  const [modelId, setModelId] = useState(""), [budget, setBudget] = useState(1);
  // Many clips covering the whole episode, ranked best first; "Deep edit" is the slower team mode.
  const [strategy, setStrategy] = useState<"swarm" | "team">("swarm");
  // Optional per-run guidance for the agents ("what to look for"), sent with this run only.
  const [lookFor, setLookFor] = useState("");
  const [runs, setRuns] = useState<TeamRun[]>([]), [ledgerError, setLedgerError] = useState("");
  const [actionError, setActionError] = useState(""), [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState<{ id: string; scope: string; source: string }>();
  const [playbackError, setPlaybackError] = useState(""), [playbackReady, setPlaybackReady] = useState(false);
  const [exportsState, setExportsState] = useState<{ clipId: string; rows: ExportRecord[]; error: string }>({ clipId: "", rows: [], error: "" });
  const [uncertainExports, setUncertainExports] = useState<Set<string>>(new Set());
  const [cancelId, setCancelId] = useState("");
  const lock = useRef(false), video = useRef<HTMLVideoElement>(null);
  const active = w.versions.find(v => v.id === activeRulesId(w) && v.status === "approved");
  const direction = active?.directions[w.profileId];
  const source = sources.find(v => v.id === sourceId);
  const clipErrors: string[] = [];
  const clips = factory.data.clips.filter(c => clipInScope(c, scope)).flatMap(c => {
    try { return [parseProductionClip(c, c.id, { campaign_id: scope.campaignId, profile_id: scope.profileId, video_id: c.video_id })]; }
    catch (e) { clipErrors.push(`${c.id}: ${message(e)}`); return []; }
  });
  const ordered = reviewOrder(clips);
  const selected = freshProduction ? undefined : clips.find(c => c.id === selectedId) || ordered.above[0] || clips[0];
  const jobs = factory.data.jobs.filter(j => jobInScope(j, scope, runs));
  const models = installedLlms(factory.data.models, { needsVision: true });
  const stale = factory.loading || !!factory.errors.videos || !!factory.errors.jobs || !!factory.errors.clips || w.loading || !!w.error;
  const busy = w.busy || factory.busy || pending;
  const ready = readiness({ source, system: factory.errors.system ? null : factory.data.system, models: factory.errors.models ? [] : factory.data.models, jobs: factory.data.jobs, modelId, approved: !!direction, sourceAttached: !!source, subtitles, stale });
  const edits = editErrors({ start, end, hook, opening, coldStart, coldEnd, focusX }, source?.duration);
  const plan = { start: +start, end: +end, hook: hook.trim(), subtitles, opening_treatment: opening, hook_overlay: opening === "text_overlay", cold_open_start: opening === "cold_open" ? +coldStart : null, cold_open_end: opening === "cold_open" ? +coldEnd : null, focus_x: focusX, framing: direction?.framing, caption_style: direction?.caption_style, ...craftPlan(craft) };
  const delta = revisionParent ? changedEditFields(revisionParent.edit_plan, plan) : [];
  const revisionError = revisionParent && (!feedback.trim() ? "Describe why this version needs to change." : !delta.length ? "Change an actual edit setting; feedback alone does not change the render." : "");
  const reviewReason = selected ? reviewBlocker(selected, factory.data.jobs, stale) : "Select a clip first.";
  const reviewReady = !!selected && !reviewReason && !busy && !playbackError && (reviewPreview || playbackReady);
  const outputVersion = w.versions.find(v => v.id === selected?.strategy_version_id);
  const illustrativeSelected = reviewPreview || selected?.provenance_mode === "preview_fixture";
  // This is a presentation of scoped worker receipts, not a second production state machine.
  const submittedHere = submitted?.scope === scopeKey ? submitted : undefined;
  const visibleSourceId = selected?.video_id || sourceId;
  const sourceJobs = jobs.filter(j => object(j.context)?.video_id === visibleSourceId)
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  const journeyJob = jobs.find(j => j.id === submittedHere?.id)
    || sourceJobs.find(activeJob)
    || (freshProduction ? sourceJobs[0] : undefined);
  const journeyContext = object(journeyJob?.context);
  const journeyRun = runs.find(r => r.id === journeyContext?.team_run_id || r.job_id === journeyJob?.id);
  const journeySourceId = typeof journeyContext?.video_id === "string" ? journeyContext.video_id : submittedHere?.source || visibleSourceId;
  const currentTask = journeyRun?.tasks.find(task => task.status === "running");
  const jobResult = object(journeyJob?.result);
  const resultIds = [jobResult?.clip_id, ...(Array.isArray(jobResult?.clip_ids) ? jobResult.clip_ids : [])]
    .filter((id): id is string => typeof id === "string");
  const confirmedOutputs = clips.filter(clip => resultIds.includes(clip.id) && clip.video_id === journeySourceId);
  const journey = (journeyJob || submittedHere) && stale ? {
    state: "uncertain" as const, step: 1 as const, title: "Production status needs a refresh",
    message: "Queue or output data is unavailable. Refresh before starting another run.",
  } : journeyJob && ["failed", "cancelled"].includes(journeyJob.status) ? {
    state: "error" as const, step: 1 as const,
    title: journeyJob.status === "cancelled" ? "Production was cancelled" : "Production needs attention",
    message: journeyJob.error || journeyJob.message || journeyRun?.stop_reason || "Open the production log below for details.",
  } : journeyJob && activeJob(journeyJob) ? {
    state: "working" as const, step: 1 as const,
    title: journeyJob.status === "queued" ? "Your edit is in the queue" : currentTask?.label || (journeyJob.kind === "render" ? "Rendering your edit" : "Working on your footage"),
    message: journeyJob.message || (journeyJob.status === "queued" ? "The local worker has not started this job yet." : "Agents are working through the episode."),
  } : journeyJob?.status === "completed" ? confirmedOutputs.length ? {
    state: "review" as const, step: 2 as const,
    title: confirmedOutputs.length === 1 ? "Your edit is ready to review" : `${confirmedOutputs.length} edits are ready to review`,
    message: "Pick a clip below to review it.",
  } : {
    state: "uncertain" as const, step: 1 as const, title: "Production finished; the output is not available yet",
    message: "The worker reported completion, but its exact output is not here. Check the production log; no other clip was picked in its place.",
  } : journeyJob ? {
    state: "uncertain" as const, step: 1 as const, title: "Check the latest production status",
    message: journeyJob.error || journeyJob.message || `The worker reported ${journeyJob.status}. Check the production log before starting another run.`,
  } : submittedHere ? {
    state: "working" as const, step: 1 as const, title: "Your production request was received",
    message: "Waiting for this exact job to appear in the local queue.",
  } : undefined;

  useEffect(() => {
    let live = true;
    const load = async () => {
      try { const rows = await workspaceApi.teamRuns(); if (live) { setRuns(rows); setLedgerError(""); } }
      catch (e) { if (live) { setRuns([]); setLedgerError(message(e)); } }
    };
    void load(); const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 4000);
    return () => { live = false; window.clearInterval(timer); };
  }, [scopeKey]);
  useEffect(() => { if (!models.some(m => m.id === modelId)) setModelId(models[0]?.id || ""); }, [models.map(m => m.id).join("|"), modelId]);
  useEffect(() => { setPlaybackError(""); setPlaybackReady(false); }, [selected?.id]);
  useEffect(() => {
    if (preferredMode) setMode(preferredMode);
    if (preferredClip) { setSelectedId(preferredClip); setFreshProduction(false); setRevisionParent(undefined); }
  }, [preferredMode, preferredClip, scope.campaignId, scope.profileId]);
  useEffect(() => {
    const target = sources.find(s => s.id === preferredSource);
    if (!target || (preferredClip && clips.some(c => c.id === preferredClip))) return;
    setSourceId(target.id); setFreshProduction(true); setRevisionParent(undefined); setStart("0");
    setEnd(String(Math.min(direction?.duration_seconds || 30, target.duration || 30)));
    setHook(direction?.hooks[0] || "");
  }, [preferredSource, preferredClip, active?.id, scope.profileId]);
  useEffect(() => {
    if (!sources.some(s => s.id === sourceId)) { setSourceId(sources[0]?.id || ""); setEnd(String(Math.min(direction?.duration_seconds || 30, sources[0]?.duration || 30))); }
  }, [scopeKey, sourceId]);
  useEffect(() => {
    if (!hook && !revisionParent && !selected && direction) setHook(direction.hooks[0] || "");
  }, [active?.id, scope.profileId, freshProduction]);
  useEffect(() => {
    if (!submitted || submitted.scope !== scopeKey) return;
    const job = jobs.find(j => j.id === submitted.id);
    if (!job || activeJob(job)) return;
    if (job.status !== "completed") { setSubmitted(undefined); return; }
    const result = object(job.result);
    const ids = Array.isArray(result?.clip_ids) ? result.clip_ids : [];
    const id = result?.clip_id ?? (ids.length === 1 ? ids[0] : undefined);
    const output = typeof id === "string" ? clips.find(c => c.id === id && c.video_id === submitted.source) : undefined;
    if (output) { setSelectedId(output.id); setFreshProduction(false); setRevisionParent(undefined); setSubmitted(undefined); }
    else if (typeof id !== "string") { setActionError(ids.length > 1 ? "Agent production returned several versions. Choose a produced version below for review." : "This completed job has no exact clip result. Inspect its ledger; no other clip was selected."); setSubmitted(undefined); }
  }, [submitted, scopeKey, jobs, clips]);
  useEffect(() => {
    let live = true;
    setExportsState({ clipId: selected?.id || "", rows: [], error: "" });
    if (selected && !reviewPreview) void productionApi.listExports(selected).then(rows => { if (live) setExportsState({ clipId: selected.id, rows, error: "" }); }).catch(e => { if (live) setExportsState({ clipId: selected.id, rows: [], error: message(e) }); });
    return () => { live = false; };
  }, [selected?.id, selected?.approved]);

  async function perform(task: () => Promise<unknown>, success: string) {
    if (lock.current || busy) return false;
    lock.current = true; setPending(true); setActionError("");
    try { return await w.run(async () => { try { return await task(); } catch (e) { setActionError(message(e)); throw e; } }, success); }
    catch (e) { setActionError(message(e)); return false; }
    finally { lock.current = false; setPending(false); }
  }
  function newCut() { setFreshProduction(true); setRevisionParent(undefined); setFeedback(""); setMode("agent"); setStart("0"); setEnd(String(Math.min(direction?.duration_seconds || 30, source?.duration || 30))); setHook(direction?.hooks[0] || ""); setOpening("text_overlay"); setSubtitles(true); setFocusX(.5); }
  async function render() {
    if (!w.campaign || !active || !source || busy) return;
    if (mode === "agent") {
      if (!ready.canProduce || reviewPreview || ledgerError) return;
      await perform(async () => {
        const result = await productionApi.campaignProduce(w.campaign!.id, { expected_strategy_version_id: active.id, video_id: source.id, profile_id: w.profileId, model_id: modelId, strategy, ...(strategy === "team" ? { revision_budget: budget } : {}), ...(lookFor.trim() ? { direction: lookFor.trim() } : {}) });
        setRuns(old => [result.run, ...old.filter(r => r.id !== result.run.id)]);
        setSubmitted({ id: result.job.id, scope: scopeKey, source: source.id }); setFreshProduction(true);
      }, "Agent production queued. Follow the real tasks and inspect the resulting version before approval.");
      return;
    }
    if (!ready.canRender || edits.length || revisionError) return;
    const body: CampaignRenderRequest = { expected_strategy_version_id: active.id, video_id: source.id, profile_id: w.profileId, ...plan, caption: revisionParent?.caption || "", mode: "direct", instructions: revisionParent ? feedback.trim() : "Creator-selected moment within this campaign.", ...(revisionParent ? { parent_clip_id: revisionParent.id, change_reason: feedback.trim(), changed_variable: delta.join(", ") } : {}) };
    await perform(async () => { const job = await productionApi.campaignRender(w.campaign!.id, body); setSubmitted({ id: job.id, scope: scopeKey, source: source.id }); setFreshProduction(true); }, reviewPreview ? "Sample handoff queued. This illustrative preview does not render footage." : "Render queued. This exact job's output will appear for fresh review.");
  }
  function revise(clip: ProductionClip) {
    const p = clip.edit_plan;
    if (!p || typeof p.start !== "number" || typeof p.end !== "number" || typeof p.hook !== "string" || typeof p.subtitles !== "boolean" || typeof p.focus_x !== "number" || !["text_overlay", "cold_open"].includes(p.opening_treatment || "")) { setActionError("This legacy version has an incomplete saved edit plan. Create a new cut instead of guessing unknown settings."); return; }
    setMode("manual"); setRevisionParent(clip); setFeedback(""); setSourceId(clip.video_id);
    setStart(String(p.start ?? clip.start)); setEnd(String(p.end ?? clip.end)); setHook(p.hook ?? clip.hook);
    setOpening(p.opening_treatment === "cold_open" ? "cold_open" : "text_overlay");
    setColdStart(String(p.cold_open_start ?? 0)); setColdEnd(String(p.cold_open_end ?? 3));
    setFocusX(p.focus_x ?? .5); setSubtitles(p.subtitles ?? clip.subtitles_burned === true);
    setCraft(craftFromPlan(p as Record<string, unknown>));
  }
  function savedRetryBlocker(job: Job) {
    const context = object(job.context), p = object(context?.plan);
    if (context?.parent_clip_id) return "Reopen the parent version and supply a revision reason before rendering again.";
    const reason = retryBlocker(job, factory.data.jobs, scope, direction);
    if (reason) return reason;
    const retrySource = sources.find(v => v.id === context?.video_id);
    if (!retrySource || !p || typeof p.hook !== "string" || typeof p.subtitles !== "boolean" || typeof p.focus_x !== "number" || !["text_overlay", "cold_open"].includes(String(p.opening_treatment))) return "The saved edit plan is incomplete. Choose a new cut instead of guessing settings.";
    const state = readiness({ source: retrySource, system: factory.errors.system ? null : factory.data.system, models: factory.data.models, jobs: factory.data.jobs, modelId, approved: !!direction, sourceAttached: true, subtitles: p.subtitles, stale });
    if (state.manual.length) return state.manual[0];
    return editErrors({ start: String(p.start), end: String(p.end), hook: p.hook, opening: p.opening_treatment as "text_overlay" | "cold_open", coldStart: String(p.cold_open_start ?? 0), coldEnd: String(p.cold_open_end ?? 3), focusX: p.focus_x }, retrySource.duration)[0] || null;
  }
  async function retry(job: Job) {
    const context = object(job.context), p = object(context?.plan);
    if (!w.campaign || !active || !p || savedRetryBlocker(job)) return;
    const videoId = context?.video_id;
    const retrySource = sources.find(v => v.id === videoId);
    if (!retrySource || !direction) return;
    const draft = { start: String(p.start), end: String(p.end), opening: p.opening_treatment === "cold_open" ? "cold_open" as const : "text_overlay" as const, coldStart: String(p.cold_open_start ?? 0), coldEnd: String(p.cold_open_end ?? 3), hook: typeof p.hook === "string" ? p.hook : "", focusX: typeof p.focus_x === "number" ? p.focus_x : .5 };
    const blocked = readiness({ source: retrySource, system: factory.data.system, models: factory.data.models, jobs: factory.data.jobs, modelId, approved: true, sourceAttached: true, subtitles: p.subtitles === true, stale });
    if (!blocked.canRender || editErrors(draft, retrySource.duration).length) { setActionError("The saved retry plan is no longer ready. Reopen this source and check its transcript and edit range."); return; }
    await perform(async () => {
      const body: CampaignRenderRequest = { video_id: retrySource.id, profile_id: w.profileId, expected_strategy_version_id: active.id, start: +draft.start, end: +draft.end, hook: draft.hook, caption: typeof p.caption === "string" ? p.caption : "", subtitles: p.subtitles === true, mode: "direct", opening_treatment: draft.opening, cold_open_start: draft.opening === "cold_open" ? +draft.coldStart : null, cold_open_end: draft.opening === "cold_open" ? +draft.coldEnd : null, focus_x: draft.focusX, retry_of_job_id: job.id };
      const queued = await productionApi.campaignRender(w.campaign!.id, body);
      setSubmitted({ id: queued.id, scope: scopeKey, source: retrySource.id });
    }, "One retry queued with the saved edit plan. Approval is required on its resulting version.");
  }
  async function reconcile(clip: ProductionClip) {
    try { const rows = await productionApi.listExports(clip); setExportsState({ clipId: clip.id, rows, error: "" }); }
    catch (e) { setExportsState({ clipId: clip.id, rows: [], error: message(e) }); }
  }
  async function exportClip(clip: ProductionClip) {
    if (!reviewReady || !clip.approved || reviewPreview || uncertainExports.has(clip.id)) return;
    await perform(async () => {
      // The server has no idempotency key: claim before POST, including response-unknown outcomes.
      setUncertainExports(old => new Set(old).add(clip.id));
      const record = await productionApi.createVerifiedExport(clip);
      setExportsState(old => ({ clipId: clip.id, rows: [record, ...(old.clipId === clip.id ? old.rows.filter(r => r.id !== record.id) : [])], error: "" }));
    }, "Export ready: the MP4 and its record file.");
    await reconcile(clip);
  }
  if (!w.campaign) return <Empty title="Nothing set up yet" icon="studio">Set up your brand to start.</Empty>;
  const blockers = mode === "agent" ? [...ready.agent, ...(reviewPreview ? ["Agents run in the Mac app, not in this preview."] : []), ...(ledgerError ? ["Agent status is unavailable. Refresh before starting."] : [])] : [...ready.manual, ...edits, ...(revisionError ? [revisionError] : [])];
  const exportRows = exportsState.clipId === selected?.id ? exportsState.rows : [];
  const making = !selected || !!revisionParent;
  const visibleLabel = sourceLabel(visibleSourceId, w.campaign.video_ids);
  const clipButton = (c: ProductionClip, i: number) => {
    const rank = rankOf(c);
    const status = reviewPreview || c.provenance_mode === "preview_fixture" ? "Illustrative edit" : c.approved ? "Approved" : "Needs review";
    return <button className={selected?.id === c.id ? "selected" : ""} key={c.id} onClick={() => { setSelectedId(c.id); setRevisionParent(undefined); setFreshProduction(false); }}>
      <span>{String(i + 1).padStart(2, "0")}</span>
      <div><strong>{c.name}</strong><small title={rank?.why || undefined}>{rank?.why || status}</small>{rank?.why && <small>{rank.top_pick ? "Top pick · " : ""}{rank.below_bar && rank.reason ? `${rank.reason} · ` : ""}{status}</small>}</div>
      {rank && <span className={`gf-score-chip${rank.below_bar ? " is-low" : ""}`} title="Score out of 100" aria-label={`Score ${rank.score} out of 100`}>{rank.score}</span>}
      <Icon name={c.approved ? "check" : "play"} size={15} />
    </button>;
  };
  const fineTune = <Disclosure title="Fine-tune" icon="settings" open={!!revisionParent}>
    {!revisionParent && <Field label="Production mode">{id => <select id={id} value={mode} onChange={e => setMode(e.target.value as Mode)}><option value="agent">Let agents choose</option><option value="manual">Choose the moment myself</option></select>}</Field>}
    {mode === "manual" && <div className="gf-form-pair"><Field label="Start (seconds)">{id => <input id={id} type="number" min="0" step="0.1" value={start} onChange={e => setStart(e.target.value)} />}</Field><Field label="End (seconds)">{id => <input id={id} type="number" min="0" step="0.1" value={end} onChange={e => setEnd(e.target.value)} />}</Field></div>}
    {source && <SourceTranscript source={source} factory={factory} run={w.run} disabled={busy} />}
    {mode === "agent" ? <>
      <Field label="Installed vision model">{id => <select id={id} value={modelId} onChange={e => setModelId(e.target.value)}><option value="" disabled>Choose a model</option>{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select>}</Field>
      <Field label="How to find clips">{id => <select id={id} value={strategy} onChange={e => setStrategy(e.target.value as typeof strategy)}><option value="swarm">Whole episode, best first</option><option value="team">Deep edit (fewer clips, more review)</option></select>}</Field>
      {strategy === "team" && <Field label="Correction budget">{id => <select id={id} value={budget} onChange={e => setBudget(+e.target.value)}>{[0, 1, 2].map(n => <option value={n} key={n}>{n} corrections</option>)}</select>}</Field>}
    </> : <>
      <Field label="Opening treatment">{id => <select id={id} value={opening} onChange={e => setOpening(e.target.value as typeof opening)}><option value="text_overlay">Opening text overlay</option><option value="cold_open">Cold open from source</option></select>}</Field>
      <Field label={opening === "text_overlay" ? "Opening text" : "Post hook (not burned in)"}>{id => <AutoTextarea id={id} value={hook} onChange={e => setHook(e.target.value)} rows={2} />}</Field>
      {opening === "cold_open" && <div className="gf-form-pair"><Field label="Cold open start (seconds)">{id => <input id={id} type="number" min="0" step="0.1" value={coldStart} onChange={e => setColdStart(e.target.value)} />}</Field><Field label="Cold open end (seconds)">{id => <input id={id} type="number" min="0" step="0.1" value={coldEnd} onChange={e => setColdEnd(e.target.value)} />}</Field></div>}
      <Field label="Crop focus">{id => <input id={id} type="range" min="0" max="1" step="0.01" value={focusX} onChange={e => setFocusX(+e.target.value)} />}</Field>
      <Field label="Include captions">{id => <input id={id} type="checkbox" checked={subtitles} onChange={e => setSubtitles(e.target.checked)} />}</Field>
      <CraftControls value={craft} onChange={setCraft} />
      <div className="gf-spec-row"><span>FORMAT</span><strong>9:16 · {direction?.framing || "Unknown framing"}</strong><span>CAPTIONS</span><strong>{direction?.caption_style || "Unknown"}</strong></div>
    </>}
  </Disclosure>;
  return <div className="gf-studio-grid">
    <section className="gf-card gf-edit-surface">
      <div className="gf-card-header"><div><h2>{selected?.name || (source ? visibleLabel : "Choose an episode")}</h2>{selected && <p>{formatTime(selected.start)} — {formatTime(selected.end)} · {visibleLabel}</p>}</div>{selected && <Pill tone={selected.approved && !illustrativeSelected ? "mint" : "quiet"}>{illustrativeSelected ? "Illustrative edit" : selected.approved ? "Approved" : "Needs review"}</Pill>}</div>
      {journey && <JourneyProgress {...journey} source={sourceLabel(journeySourceId, w.campaign.video_ids)} progress={journeyJob?.progress} receipts={journey?.state === "working" && !ledgerError ? journeyRun?.tasks.filter(task => task.status === "completed").slice(-3).map(task => task.label) : []} label="Current production" />}
      <div className="gf-studio-media is-simple">
        {reviewPreview ? <div className="gf-preview-film"><Poster /><div className="gf-film-caption"><Pill>ILLUSTRATIVE</Pill><strong>{selected?.hook || "Sample episode"}</strong><small>Preview artwork · not rendered footage</small></div></div>
          : selected ? <video key={selected.id} ref={video} controls preload="metadata" src={clipMediaUrl(selected.id)} aria-label={`Review ${selected.name}`} onLoadedData={() => setPlaybackReady(true)} onError={() => { setPlaybackReady(false); setPlaybackError("This clip could not be played. Check the output file before approving."); }} />
          : source ? <video key={source.id} className="is-source" controls preload="metadata" src={endpoint("videos", source.id, "media")} aria-label={`Play ${visibleLabel}`} />
          : <div className="gf-empty-film"><Icon name="studio" size={38} /><h3>No episode yet</h3><p>Add an episode in Factory.</p></div>}
      </div>
      {(playbackError || actionError) && <div className="gf-inline-error" role="alert">{playbackError || actionError}</div>}
      {!!clipErrors.length && <div className="gf-inline-error" role="alert">Some versions could not be verified: {clipErrors.join(" ")}</div>}
      {clips.length > 0 && <>
        {ordered.above.some(c => rankOf(c)) && <p className="gf-clip-strip-title">Review {ordered.above.filter(c => !c.approved).length} clips · best first</p>}
        <div className="gf-clip-strip"><button onClick={newCut}><Icon name="plus" size={14} /><strong>Find more</strong></button>{ordered.above.map((c, i) => clipButton(c, i))}</div>
        {ordered.below.length > 0 && <details className="gf-disclosure gf-below-bar"><summary>Below the bar ({ordered.below.length})<Icon name="down" size={15} /></summary><p className="gf-help">Kept, not deleted. Lower scores or similar to a better clip.</p><div className="gf-clip-strip">{ordered.below.map((c, i) => clipButton(c, ordered.above.length + i))}</div></details>}
      </>}
      {ledgerError && <p className="gf-inline-error" role="alert">Agent status: {ledgerError}</p>}
      {jobs.length > 0 && <Disclosure title="Production log" icon="clock">
        {jobs.map(job => {
          const context = object(job.context), run = runs.find(r => r.id === context?.team_run_id || r.job_id === job.id);
          const retryReason = savedRetryBlocker(job);
          return <div key={job.id} className="gf-form-fields"><div className="gf-spec-row"><strong>{job.kind} · {job.status}</strong><span>{job.id}</span></div><p>{job.error || job.message || "No worker message recorded."}</p>{activeJob(job) && <progress aria-label={`Production progress ${job.id}`} max={100} value={typeof job.progress === "number" ? job.progress : undefined} />}
            {activeJob(job) && (cancelId === job.id ? <div><p>Cancel this job? Work in progress may still finish.</p><button className="gf-button secondary" disabled={busy} onClick={() => void perform(async () => { await productionApi.cancelJob(job.id); setCancelId(""); }, "Cancellation requested.")}>Confirm cancellation</button><button className="gf-button ghost" onClick={() => setCancelId("")}>Keep running</button></div> : <button className="gf-button ghost" disabled={busy} onClick={() => setCancelId(job.id)}>Cancel job</button>)}
            {["failed", "cancelled"].includes(job.status) && (job.kind === "render"
              ? <><button className="gf-button secondary" disabled={busy || !!retryReason} onClick={() => void retry(job)}>Retry saved render</button>{retryReason && <p className="gf-help">{retryReason}</p>}</>
              : <p className="gf-approval-note">To try again, fix the issue above, then use Let agents find clips.</p>)}
            {run && <Disclosure title={`Agent tasks · ${run.status}`}><p>Model: {run.model_id} · Corrections: {run.revision_count}/{run.revision_budget}</p><p>{run.stop_reason || "No stop reason recorded."}</p>{run.tasks.map(task => <div key={task.id}><strong>{task.label} · {task.status}</strong><p>{task.role} · Iteration {task.iteration}</p><small>Inputs: {task.input_refs.join(", ") || "Not recorded"}</small><pre>{task.output ? JSON.stringify(task.output, null, 2) : task.error || "No output recorded"}</pre></div>)}</Disclosure>}
          </div>;
        })}
      </Disclosure>}
    </section>
    <aside className="gf-card gf-review-inspector">
      <div className="gf-card-header"><div><h2>{!making ? "Review this clip" : revisionParent ? "Request a change" : "Find clips"}</h2></div></div>
      {making ? <div className="gf-form-fields">
        {!revisionParent && (() => { const summary = briefSummary(w.campaign!.brief, w.campaign!.objective, w.campaign!.primary_metric); return <p className="gf-brief-summary" aria-label="Goals and brief summary"><span title={summary}>{summary}</span>{onEditBrief && <button type="button" className="gf-button ghost compact" onClick={onEditBrief}>Edit brief</button>}</p>; })()}
        {sources.length > 1 && <Field label="Episode">{id => <select id={id} value={sourceId} disabled={!!revisionParent || busy} onChange={e => { setSourceId(e.target.value); setStart("0"); const s = sources.find(v => v.id === e.target.value); setEnd(String(Math.min(direction?.duration_seconds || 30, s?.duration || 30))); }}><option value="" disabled>Choose an episode</option>{sources.map(s => <option value={s.id} key={s.id}>{sourceLabel(s.id, w.campaign!.video_ids)}</option>)}</select>}</Field>}
        {revisionParent && <Field label="What would make it better?">{id => <AutoTextarea id={id} value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="What should change, and why?" rows={3} />}</Field>}
        {/* One reason at a time: the first thing to fix. */}
        {mode === "agent" && !revisionParent && <Field label="What should the agents look for? (optional)" hint="Used for this run only, within your style rules.">{id => <AutoTextarea id={id} rows={2} maxLength={DIRECTION_MAX} value={lookFor} disabled={busy} placeholder="e.g. the spiciest takes on AI policy, under 40s" onChange={e => setLookFor(e.target.value)} />}</Field>}
        {!direction && onDirection ? <button type="button" className="gf-button ghost full" onClick={onDirection}>Approve style rules first</button> : blockers[0] && <p className="gf-help">{blockers[0]}</p>}
        <PrimaryAction full label={busy ? "Queuing…" : mode === "agent" ? "Let agents find clips" : revisionParent ? "Render a new revision" : "Make this clip"} intent="produce" disabled={busy || blockers.length > 0} onClick={() => void render()} />
        {revisionParent && <button className="gf-button ghost full" onClick={() => setRevisionParent(undefined)}>Back to review</button>}
        {fineTune}
      </div> : <>
        <div className="gf-review-action-panel">
          {selected.warning && <p className="gf-help">{selected.warning}</p>}
          {reviewReason && <p className="gf-help">{reviewReason}</p>}
          {!reviewPreview && !playbackReady && !playbackError && <p className="gf-help">Play the clip before approving.</p>}
          <div className="gf-inspector-footer">
            {selected.approved ? <button className="gf-button full" disabled={!reviewReady || reviewPreview || uncertainExports.has(selected.id)} onClick={() => void exportClip(selected)}><Icon name="download" size={16} />{reviewPreview ? "Export · Mac app only" : "Export approved MP4"}</button> : <PrimaryAction full label="Approve this clip" intent="approve" disabled={!reviewReady} onClick={() => void perform(() => productionApi.review(selected, true), reviewPreview ? "Sample accepted; no real approval recorded." : "Approved. You can export it now.")} />}
            <button className="gf-button secondary full" disabled={busy} onClick={() => revise(selected)}>Request a change<Icon name="settings" size={15} /></button>
          </div>
          {!reviewPreview && !illustrativeSelected && <PostToInstagram clip={selected} disabled={!reviewReady} approve={async () => { const box: { clip?: ProductionClip } = {}; const ok = await perform(async () => { box.clip = await productionApi.review(selected, true); }, "Approved this exact revision."); return ok ? box.clip : false; }} />}
        </div>
        <div className="gf-review-details">
          <Disclosure title="Details" icon="info">
            <ClipEvidence clip={selected} />
            {selected.team_run_id && <button className="gf-button ghost full" disabled={busy || stale || factory.data.jobs.some(j => activeJob(j) && object(j.context)?.video_id === selected.video_id) || reviewPreview} onClick={() => void perform(async () => { const exact = selected.approved ? await productionApi.review(selected, false) : selected; await productionApi.recheck(exact); }, "Recheck queued. This version needs fresh approval afterwards.")}>Recheck technical critique</button>}
            <h3>Exports</h3>
            {reviewPreview ? <p>Exports run in the Mac app.</p> : <><button className="gf-button ghost" disabled={busy} onClick={() => void reconcile(selected)}>Refresh export history</button>{exportsState.error && <p role="alert">{exportsState.error}</p>}{uncertainExports.has(selected.id) && <p className="gf-help">An export was submitted for this version. Check history before exporting again; it won't be resent automatically.</p>}{!exportRows.length && <p>No exports yet.</p>}{exportRows.map(record => <div key={record.id}><strong>{record.created_at}</strong><p>{record.location}</p><a className="gf-button ghost" href={exportMediaUrl(record.id)} download>Download MP4</a><a className="gf-button ghost" href={exportManifestUrl(record.id)} download>Download manifest</a></div>)}</>}
          </Disclosure>
        </div>
      </>}
    </aside>
  </div>;
}
