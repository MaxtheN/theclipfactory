import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { Icon } from "./Icon";
import { PrimaryAction } from "./parts";
import {
  busy,
  referencesApi,
  seconds,
  type Plan,
  type ReferenceItem,
  type ReferenceObservation,
  type Research,
} from "./referencesApi";
import "./references.css";

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Retry.");

const STATUS: Record<ReferenceItem["status"], [string, string]> = {
  stored: ["Ready to analyze", "quiet"],
  linked: ["MP4 link · fetched on analyze", "quiet"],
  not_inspected: ["Not inspected", "warn"],
  missing: ["Missing material", "warn"],
  failed: ["Could not analyze", "warn"],
  analyzed: ["Inspected", "good"],
};

/**
 * Research what works: 1–3 example reels → measured observations (evidence) → one pattern
 * (inference, with limits) → two plans on OUR footage that differ in one variable → "Use this direction".
 */
export function ReferenceResearch({
  campaignId,
  profileId,
  entry = "rules",
  preferredClipId,
  onClose,
  onUsed,
  pollMs = 1500,
}: {
  campaignId: string;
  profileId: string;
  entry?: "rules" | "studio";
  preferredClipId?: string;
  onClose?: () => void;
  /** Called after "Use this direction" queued the versions and the proposal. */
  onUsed?: () => void;
  pollMs?: number;
}) {
  const [research, setResearch] = useState<Research>();
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const [clipId, setClipId] = useState(preferredClipId || "");
  const [dragging, setDragging] = useState(false);
  const live = useRef(true);
  const players = useRef<Record<string, HTMLVideoElement | null>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await referencesApi.list(campaignId);
      const current = rows[0] ?? (await referencesApi.start(campaignId, profileId));
      if (!live.current) return;
      setResearch(current);
      setClipId(old => old || current.target_clip_id || current.candidate_clips[0]?.id || "");
      setError("");
    } catch (e) {
      if (live.current) setError(message(e));
    } finally {
      if (live.current) setLoading(false);
    }
  }, [campaignId, profileId]);

  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
    };
  }, [load]);

  const running = busy(research);
  useEffect(() => {
    if (!running || !research) return;
    const timer = setInterval(() => {
      void referencesApi.get(research.id).then(r => live.current && setResearch(r)).catch(() => undefined);
    }, pollMs);
    return () => clearInterval(timer);
  }, [running, research?.id, pollMs]);

  async function act(label: string, task: () => Promise<Research>) {
    setWorking(label);
    setError("");
    try {
      const next = await task();
      if (live.current) setResearch(next);
      return true;
    } catch (e) {
      if (live.current) setError(message(e));
      return false;
    } finally {
      if (live.current) setWorking("");
    }
  }

  if (loading && !research) return <section className="gf-refs" aria-busy="true"><p className="gf-refs-quiet">Loading examples…</p></section>;
  if (!research)
    return <section className="gf-refs"><div className="gf-inline-error" role="alert">{error || "Could not open reference research."}</div>
      <button className="gf-button secondary" onClick={() => void load()}>Retry</button></section>;

  const r = research;
  const full = r.references.length >= 3;
  const locked = running || !!working;
  const inspectable = r.references.some(x => x.kind === "upload" || x.status === "linked");
  const chosen = r.candidate_clips.find(c => c.id === clipId);
  const hookNeedsTarget = r.pattern?.variable === "hook" && clipId !== r.target_clip_id;
  const canUse = r.status === "ready" && !!r.pattern && !!clipId && !r.direction && !hookNeedsTarget && !locked;

  function files(list: FileList | null) {
    const file = list?.[0];
    if (file) void act("Uploading…", () => referencesApi.upload(r.id, file));
  }
  function drop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (!full && !locked) files(e.dataTransfer.files);
  }
  function seek(refId: string, at: number) {
    const player = players.current[refId];
    if (!player) return;
    player.currentTime = at;
    void player.play?.()?.catch?.(() => undefined);
    const calm = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    player.scrollIntoView?.({ block: "nearest", behavior: calm ? "auto" : "smooth" });
  }

  return <section className="gf-refs" aria-label="Research what works">
    <header className="gf-refs-head">
      <div>
        <span className="gf-refs-kicker">{entry === "studio" ? "Test a pattern from examples" : "Learn from examples"}</span>
        <h2>Research what works</h2>
        <p>Add 1–3 reels you admire. We measure them, note what they do, and turn one pattern into an A/B test on your own footage. Nothing is approved for you.</p>
      </div>
      {onClose && <button className="gf-refs-close" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>}
    </header>

    <ol className="gf-refs-steps">
      <li className="gf-refs-step">
        <h3><span>1</span>References</h3>
        <div className={`gf-refs-drop${dragging ? " is-over" : ""}${full ? " is-full" : ""}`}
          onDragOver={e => { e.preventDefault(); if (!full) setDragging(true); }}
          onDragLeave={() => setDragging(false)} onDrop={drop}>
          <Icon name="upload" size={20} />
          <label>
            <span>{full ? "Three references added" : "Drop a reel or short here, or choose a file"}</span>
            <small>MP4, MOV, M4V or WebM · up to 3 minutes · 200 MB</small>
            <input type="file" accept="video/mp4,video/quicktime,video/webm,.m4v" disabled={full || locked}
              aria-label="Upload a reference video" onChange={e => { files(e.target.files); e.target.value = ""; }} />
          </label>
        </div>
        <form className="gf-refs-link" onSubmit={e => {
          e.preventDefault();
          if (url.trim()) void act("Adding link…", () => referencesApi.link(r.id, url.trim())).then(ok => ok && setUrl(""));
        }}>
          <input type="url" value={url} placeholder="…or paste a link (recorded; only direct .mp4 files can be inspected)"
            aria-label="Reference link" disabled={full || locked} onChange={e => setUrl(e.target.value)} />
          <button className="gf-button secondary" disabled={full || locked || !url.trim()}>Add link</button>
        </form>
        {r.references.length === 0
          ? <p className="gf-refs-quiet">No references yet. Uploaded videos are analyzed; links to Instagram, TikTok or YouTube are kept as notes only.</p>
          : <ul className="gf-refs-cards">{r.references.map(ref => <ReferenceCard key={ref.id} research={r} item={ref}
            disabled={locked} onNote={note => void act("Saving note…", () => referencesApi.note(r.id, ref.id, note))}
            onRemove={() => void act("Removing…", () => referencesApi.remove(r.id, ref.id))}
            bind={el => { players.current[ref.id] = el; }} />)}</ul>}
        <div className="gf-refs-run">
          <label>
            <span>Test it on</span>
            <select value={clipId} disabled={locked} onChange={e => setClipId(e.target.value)} aria-label="Clip to test on">
              {r.candidate_clips.length === 0 && <option value="">No clips in this campaign yet</option>}
              {r.candidate_clips.map(c => <option key={c.id} value={c.id}>{c.hook || c.name || c.id} · {seconds(c.start)}–{seconds(c.end)}</option>)}
            </select>
          </label>
          <button className="gf-button secondary" disabled={locked || !inspectable}
            onClick={() => void act("Starting analysis…", () => referencesApi.analyze(r.id, clipId || null))}>
            {r.status === "draft" ? "Analyze examples" : "Analyze again"}
          </button>
        </div>
        {!inspectable && r.references.length > 0 && <p className="gf-refs-quiet">Upload at least one video: links alone are not inspected.</p>}
      </li>

      {running && <li className="gf-refs-progress" role="status" aria-live="polite">
        <div className="gf-refs-bar"><i style={{ width: `${Math.max(4, r.job?.progress ?? 2)}%` }} /></div>
        <span>{r.job?.message || "Queued behind other local work"} · {r.job?.progress ?? 0}%</span>
      </li>}

      {r.status === "failed" && <li><div className="gf-inline-error" role="alert">Analysis stopped: {r.error || r.job?.error || "unknown error"}. Your references are kept; try again.</div></li>}

      {(r.observations.length > 0 || r.status === "ready" || r.status === "abstained") && <li className="gf-refs-step">
        <h3><span>2</span>Observations <em className="gf-refs-tag evidence">evidence</em></h3>
        {r.observations.length === 0
          ? <p className="gf-refs-quiet">No inspectable material produced observations. Missing links are listed above, never analyzed.</p>
          : <ObservationList research={r} onSeek={seek} />}
      </li>}

      {(r.status === "ready" || r.status === "abstained") && <li className="gf-refs-step">
        <h3><span>3</span>Pattern <em className="gf-refs-tag inference">inference</em></h3>
        {r.pattern ? <div className="gf-refs-pattern">
          <p className="gf-refs-statement">{r.pattern.pattern}</p>
          <p className="gf-refs-cites">Rests on {r.pattern.supported_by.map(id => <a key={id} href={`#obs-${r.id}-${id}`} className="gf-refs-cite">{id}</a>)}</p>
        </div> : <p className="gf-refs-abstain" role="status"><strong>No pattern named.</strong> {r.abstained?.reason} The observations are still facts you can use.</p>}
        {r.limits.length > 0 && <div className="gf-refs-limits"><strong>Limits</strong><ul>{r.limits.map(l => <li key={l}>{l}</li>)}</ul></div>}
        {r.holds.length > 0 && <p className="gf-refs-quiet">Model held: {r.holds.join(" ")}</p>}
      </li>}

      {r.pattern && <li className="gf-refs-step">
        <h3><span>4</span>Hypothesis for your audience</h3>
        <p className="gf-refs-hypothesis">{r.pattern.hypothesis}</p>
        <div className="gf-refs-plans" aria-label="Two plans that differ in one variable">
          {r.plans.map(plan => <PlanCard key={plan.label} plan={plan} />)}
        </div>
        <p className="gf-refs-quiet">Only <strong>{r.plans[0]?.variable_label.toLowerCase()}</strong> changes; every other edit decision is shared. Both versions start unapproved.</p>
        {hookNeedsTarget && <p className="gf-refs-quiet">This hook was written from another clip's words. Analyze again on the selected clip.</p>}
        {r.direction ? <div className="gf-refs-done" role="status">
          <Icon name="check" size={16} />
          <div>
            <strong>Two versions are rendering</strong> for {chosen?.hook || r.direction.clip_id}. They record this research, so the Strategist can judge the pattern on real results.
            {r.direction.proposal_id
              ? <> A <strong>proposed</strong> Style rules note is waiting for your review; nothing was approved.</>
              : <> The Style rules note was not saved: {r.direction.proposal_error}</>}
          </div>
        </div> : <PrimaryAction label={working === "Using…" ? "Queuing both versions…" : "Use this direction"} intent="direction"
          disabled={!canUse} onClick={() => void act("Using…", () => referencesApi.use(r.id, clipId || null)).then(ok => ok && onUsed?.())} />}
      </li>}
    </ol>
    {working && working !== "Using…" && <p className="gf-refs-quiet" role="status">{working}</p>}
    {error && <div className="gf-inline-error" role="alert">{error}</div>}
  </section>;
}

function ReferenceCard({ research, item, disabled, onNote, onRemove, bind }: {
  research: Research;
  item: ReferenceItem;
  disabled: boolean;
  onNote: (note: string) => void;
  onRemove: () => void;
  bind: (el: HTMLVideoElement | null) => void;
}) {
  const [note, setNote] = useState(item.note);
  const [label, tone] = STATUS[item.status];
  const thumb = item.frames?.find(f => f.time >= 0.5) ?? item.frames?.[0];
  const playable = item.file && item.status !== "missing";
  return <li className="gf-refs-card" data-status={item.status}>
    <div className="gf-refs-thumb">
      {playable
        ? <video ref={bind} src={referencesApi.mediaUrl(research.id, item.id)} preload="metadata" muted playsInline controls
          poster={thumb ? referencesApi.frameUrl(research.id, thumb.file) : undefined} aria-label={`Reference ${item.name}`} />
        : <span className="gf-refs-placeholder"><Icon name="link" size={22} /></span>}
    </div>
    <div className="gf-refs-card-body">
      <div className="gf-refs-card-top">
        <strong title={item.name}>{item.kind === "url" ? item.url : item.name}</strong>
        <span className={`gf-refs-status ${tone}`}>{label}</span>
      </div>
      <small>{item.status_reason}{item.duration ? ` · ${seconds(item.duration)}` : ""}</small>
      {item.vision_note && <small>{item.vision_note}</small>}
      {item.transcript_note && <small>{item.transcript_note}</small>}
      <input className="gf-refs-note" value={note} maxLength={300} disabled={disabled} aria-label="Why I like this"
        placeholder="Why I like this (optional)" onChange={e => setNote(e.target.value)}
        onBlur={() => note !== item.note && onNote(note)} />
    </div>
    <button className="gf-refs-remove" disabled={disabled} aria-label={`Remove ${item.name}`} onClick={onRemove}><Icon name="close" size={14} /></button>
  </li>;
}

function ObservationList({ research, onSeek }: { research: Research; onSeek: (refId: string, at: number) => void }) {
  const cited = new Set(research.pattern?.supported_by ?? []);
  const byRef = research.references.filter(ref => research.observations.some(o => o.reference_id === ref.id));
  return <div className="gf-refs-observations">{byRef.map(ref => <div key={ref.id}>
    <h4>{ref.kind === "url" ? ref.url : ref.name}</h4>
    <ul>{research.observations.filter(o => o.reference_id === ref.id).map(o => <ObservationRow key={o.id} o={o}
      cited={cited.has(o.id)} anchor={`obs-${research.id}-${o.id}`} onSeek={at => onSeek(ref.id, at)} />)}</ul>
  </div>)}</div>;
}

function ObservationRow({ o, cited, anchor, onSeek }: { o: ReferenceObservation; cited: boolean; anchor: string; onSeek: (at: number) => void }) {
  const at = o.evidence.frame_time ?? o.evidence.start;
  const span = o.evidence.end > o.evidence.start ? `${seconds(o.evidence.start)}–${seconds(o.evidence.end)}` : seconds(at);
  return <li id={anchor} className={cited ? "is-cited" : undefined}>
    <span className="gf-refs-oid">{o.id}</span>
    <div>
      <p>{o.statement}</p>
      <small>
        <button className="gf-refs-chip" onClick={() => onSeek(at)} aria-label={`Play from ${seconds(at)}`}>
          <Icon name="play" size={11} /> {span}
        </button>
        {o.evidence.quote && o.evidence.kind === "quote" && <q>{o.evidence.quote}</q>}
        <span className="gf-refs-basis">{o.basis}</span>
      </small>
    </div>
  </li>;
}

function PlanCard({ plan }: { plan: Plan }) {
  return <article className={`gf-refs-plan ${plan.role}`}>
    <header><span className="gf-refs-plan-label">{plan.label}</span>{plan.role === "control" ? "Your current style" : "The pattern"}</header>
    <dl>
      <div className="is-changed"><dt>{plan.variable_label}</dt><dd>{plan.summary}</dd></div>
      {plan.variable !== "hook" && <div><dt>Hook</dt><dd>{plan.hook || "—"}</dd></div>}
      {plan.source && <div><dt>From your footage</dt><dd>{seconds(plan.source.start)}–{seconds(plan.source.end)}{plan.source.opening && <> · opens on <q>{plan.source.opening}</q></>}</dd></div>}
    </dl>
  </article>;
}

/** A quiet entry point ("Learn from examples" / "Test a pattern from examples") that opens the panel. */
export function ReferenceResearchLauncher(props: {
  campaignId?: string;
  profileId?: string;
  entry: "rules" | "studio";
  preferredClipId?: string;
  onUsed?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { campaignId, profileId, ...rest } = props;
  if (!campaignId || !profileId) return null;
  const label = props.entry === "studio" ? "Test a pattern from examples" : "Learn from examples";
  return open
    ? <ReferenceResearch campaignId={campaignId} profileId={profileId} {...rest} onClose={() => setOpen(false)} />
    : <button type="button" className="gf-button ghost gf-refs-launch" onClick={() => setOpen(true)}>
      <Icon name="spark" size={15} /> {label}
    </button>;
}
