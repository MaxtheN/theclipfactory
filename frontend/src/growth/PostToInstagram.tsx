import { useEffect, useRef, useState } from "react";
import { AutoTextarea } from "../components/AutoTextarea";
import { Field, Pill } from "./parts";
import {
  DEFAULT_LIMITS,
  addLinkInBio,
  canResume,
  checkCaption,
  hasLinkInBio,
  hashtagsOf,
  inFlight,
  localInputValue,
  localTimezone,
  publishApi,
  scheduleSuggestions,
  stateLabel,
  toggleHashtag,
  withOffset,
  type PostLimits,
  type PostPackageView,
  type PostSchedule,
  type PostTargets,
  type PublishAttempt,
  type QualityReport,
} from "./publishApi";
import { postCopyApi, type PostCopy } from "./referencesApi";
import { CloudSignIn } from "./CloudSignIn";
import { PostPreview } from "./PostPreview";
import { clipMediaUrl } from "./productionApi";

export interface PostableClip {
  id: string;
  approved: boolean;
  sha256?: string | null;
  hook?: string | null;
  caption?: string | null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Retry.");
const rubricLabels: [keyof QualityReport["rubric"], string][] = [
  ["hook_clarity", "Hook"],
  ["standalone_context", "Context"],
  ["caption_legibility", "Captions"],
  ["technical", "Technical"],
];
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const localTime = (iso: string) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

function Counters({ text, limits, label }: { text: string; limits: PostLimits; label?: string }) {
  const check = checkCaption(text, limits);
  const item = (value: number, max: number, unit: string) =>
    <span className={value > max ? "over" : ""}>{value.toLocaleString()} / {max.toLocaleString()} {unit}</span>;
  return <div className="gf-caption-counters" aria-label={label || "Caption limits"} aria-live="polite">
    {item(check.chars, limits.caption_chars, "characters")}
    {item(check.hashtags, limits.hashtags, "hashtags")}
    {item(check.mentions, limits.mentions, "mentions")}
  </div>;
}

/**
 * Approve & post: one click approves this exact revision (when needed) and posts it, now or at a
 * scheduled time, to the chosen accounts. The package (caption, hashtags, CTA, cover, feed
 * sharing) is previewed on a phone first. Uncertain outcomes offer "Check status", never a blind retry.
 */
export function PostToInstagram({
  clip,
  disabled = false,
  approve,
  pollMs = 3000,
  now = () => new Date(),
}: {
  clip: PostableClip;
  disabled?: boolean;
  /** Records the human approval of this exact revision; returns the saved clip. */
  approve: () => Promise<PostableClip | false | undefined>;
  pollMs?: number;
  /** Injected clock for schedule suggestions (tests). */
  now?: () => Date;
}) {
  const [targets, setTargets] = useState<PostTargets>();
  const [report, setReport] = useState<QualityReport>();
  const [attempts, setAttempts] = useState<PublishAttempt[]>([]);
  const [schedules, setSchedules] = useState<PostSchedule[]>([]);
  const [pkg, setPkg] = useState<PostPackageView>();
  const [chosen, setChosen] = useState<string[]>([]);
  const [caption, setCaption] = useState("");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [coverMs, setCoverMs] = useState<number | null>(null);
  const [shareToFeed, setShareToFeed] = useState(true);
  const [mode, setMode] = useState<"now" | "schedule">("now");
  const [when, setWhen] = useState("");
  const [previewAccount, setPreviewAccount] = useState<string>();
  const [override, setOverride] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [copy, setCopy] = useState<PostCopy | null>();
  const [writing, setWriting] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  // Generated copy prefills the caption until the person edits it themselves.
  const edited = useRef(false), prefilled = useRef(false);
  const live = useRef(true);
  const limits = pkg?.limits ?? DEFAULT_LIMITS;

  function applyTargets(t: PostTargets) {
    setTargets(t); setAttempts(t.attempts); setSchedules(t.schedules ?? []);
  }
  const refresh = () => publishApi.targets(clip.id).then(t => { if (live.current) applyTargets(t); });

  useEffect(() => {
    live.current = true;
    setTargets(undefined); setReport(undefined); setAttempts([]); setSchedules([]); setChosen([]); setError("");
    setOverride(""); setOverrides({}); setCoverMs(null); setShareToFeed(true); setMode("now"); setNotice("");
    edited.current = false; prefilled.current = false; setCopy(undefined); setPkg(undefined);
    publishApi.targets(clip.id).then(t => {
      if (!live.current) return;
      applyTargets(t);
      if (!prefilled.current) setCaption(t.default_caption || clip.caption || clip.hook || "");
    }).catch(e => live.current && setError(message(e)));
    postCopyApi.get(clip.id).then(v => {
      if (!live.current || !v.post_copy) return;
      setCopy(v.post_copy);
      if (!edited.current) { prefilled.current = true; setCaption(v.post_copy.caption); }
    }).catch(() => undefined);
    Promise.resolve().then(() => publishApi.postPackage(clip.id))
      .then(v => { if (live.current && v) setPkg(v); }).catch(() => undefined);
    publishApi.quality(clip.id).then(r => live.current && setReport(r)).catch(e => live.current && setError(message(e)));
    return () => { live.current = false; };
  }, [clip.id, clip.sha256]);

  const running = attempts.some(inFlight);
  const waiting = schedules.some(s => s.status === "scheduled");
  useEffect(() => {
    if (!running && !waiting) return;
    const timer = setInterval(() => { void refresh().catch(() => undefined); }, running ? pollMs : Math.max(pollMs, 15000));
    return () => clearInterval(timer);
  }, [running, waiting, clip.id, pollMs]);

  const blocked = new Set(attempts.filter(a => a.state !== "failed" && a.state !== "cancelled").map(a => a.account_id));
  const held = report?.verdict === "hold";
  const signInRequired = !!targets && (!targets.cloud_configured || !targets.signed_in);
  const captionFor = (account: string) => overrides[account] ?? caption;
  const captionProblems = (chosen.length ? chosen.map(captionFor) : [caption])
    .flatMap(text => checkCaption(text, limits).problems);
  const scheduledAt = mode === "schedule" ? withOffset(when) : null;
  const scheduleProblem = mode !== "schedule" ? "" : !scheduledAt ? "Pick a date and time."
    : new Date(scheduledAt).getTime() <= now().getTime() + 60_000 ? "Pick a time at least a minute from now." : "";
  const ready = !!targets && !!report && !signInRequired && chosen.length > 0
    && chosen.every(a => captionFor(a).trim().length > 0) && captionProblems.length === 0 && !scheduleProblem
    && (!held || override.trim().length >= 10) && !busy && !disabled;
  const accountName = (id: string) => targets?.accounts.find(a => a.id === id)?.display_name || id;
  const shownAccount = previewAccount && chosen.includes(previewAccount) ? previewAccount : chosen[0];
  const coverUrl = coverMs === null ? pkg?.auto_cover.url : pkg?.candidates.find(c => c.time_ms === coverMs)?.url;
  const suggested = copy?.hashtags ?? [];
  const present = new Set(hashtagsOf(caption).map(t => t.toLowerCase()));
  const zone = localTimezone();

  async function approved(): Promise<PostableClip> {
    if (clip.approved) return clip;
    const saved = await approve();
    if (!saved || !saved.approved) throw new Error("Approval was not recorded; nothing was posted.");
    return saved;
  }

  async function submit() {
    if (!ready) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const current = await approved();
      if (!current.sha256) throw new Error("This revision has no recorded file hash; it cannot be posted.");
      const options = { share_to_feed: shareToFeed, cover_time_ms: coverMs, ...(held ? { override_reason: override.trim() } : {}) };
      if (mode === "schedule" && scheduledAt) {
        const row = await publishApi.schedule(current.id, {
          account_ids: chosen, captions: Object.fromEntries(chosen.map(a => [a, captionFor(a)])),
          sha256: current.sha256, publish_at: scheduledAt, timezone: zone, ...options,
        });
        if (live.current) {
          setSchedules(old => [...old.filter(s => s.id !== row.id), row]);
          setAttempts(old => [...row.attempts, ...old.filter(a => !row.attempts.some(m => m.id === a.id))]);
          setChosen([]); setNotice(`Scheduled for ${localTime(row.publish_at)}. The app must be open at that time.`);
        }
        return;
      }
      const made: PublishAttempt[] = [], failures: string[] = [];
      for (const account of chosen) {
        try {
          made.push(await publishApi.post(current.id, { account_id: account, caption: captionFor(account), sha256: current.sha256, ...options }));
        } catch (e) {
          failures.push(`${accountName(account)}: ${message(e)}`);
        }
      }
      if (live.current) {
        setAttempts(old => [...made, ...old.filter(a => !made.some(m => m.id === a.id))]);
        setChosen([]);
        if (failures.length) setError(failures.join(" "));
      }
    } catch (e) {
      if (live.current) setError(message(e));
    } finally {
      if (live.current) setBusy(false);
    }
  }

  /** Ask the local model for fresh copy; the template fallback is labelled when the model cannot run. */
  async function regenerate() {
    setWriting("Writing…"); setError("");
    try {
      let view = await postCopyApi.regenerate(clip.id, "model");
      for (let i = 0; view.job && ["queued", "running"].includes(view.job.status) && i < 600; i++) {
        await new Promise(done => setTimeout(done, pollMs));
        if (!live.current) return;
        view = await postCopyApi.get(clip.id);
        setWriting(view.job?.status === "queued" ? "Queued behind other local work…" : "Writing…");
      }
      if (!live.current) return;
      if (view.job?.status === "failed") throw new Error(view.job.error || "Post copy could not be written.");
      if (view.post_copy) { setCopy(view.post_copy); setCaption(view.post_copy.caption); edited.current = false; }
    } catch (e) {
      if (live.current) setError(message(e));
    } finally {
      if (live.current) setWriting("");
    }
  }

  async function act(attempt: PublishAttempt, kind: "reconcile" | "resume") {
    setBusy(true); setError("");
    try {
      const next = await publishApi[kind](attempt.id);
      if (live.current) setAttempts(old => old.map(a => (a.id === next.id ? next : a)));
    } catch (e) {
      if (live.current) setError(message(e));
    } finally {
      if (live.current) setBusy(false);
    }
  }

  async function decide(row: PostSchedule, action: "post_now" | "reschedule" | "cancel") {
    const at = action === "reschedule" ? withOffset(when) : undefined;
    if (action === "reschedule" && !at) { setError("Pick a new date and time under Schedule first."); setMode("schedule"); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const next = await publishApi.decide(row.id, action, at ?? undefined);
      if (!live.current) return;
      setSchedules(old => old.map(s => (s.id === next.id ? next : s)));
      setAttempts(old => [...next.attempts, ...old.filter(a => !next.attempts.some(m => m.id === a.id))]);
    } catch (e) {
      if (live.current) setError(message(e));
    } finally {
      if (live.current) setBusy(false);
    }
  }

  const editCaption = (value: string) => { edited.current = true; setCaption(value); };
  const pending = schedules.filter(s => s.status === "scheduled");
  const submitLabel = busy ? "Working…" : mode === "schedule"
    ? (clip.approved ? "Schedule post" : "Approve & schedule")
    : (clip.approved ? "Post to Instagram" : "Approve & post");

  return <section className="gf-form-fields gf-post-instagram" aria-label="Post to Instagram">
    <h3>Post to Instagram</h3>
    {signInRequired && <div className="gf-post-signin">
      <div>
        <p role="status"><strong>Sign in required.</strong> We host the approved video briefly so Instagram can fetch it.</p>
        {targets?.cloud_configured && !signingIn && <button type="button" className="gf-button compact" onClick={() => setSigningIn(true)}>Sign in</button>}
      </div>
      {!targets?.cloud_configured && <p>Accounts aren't set up on this Mac yet, so posting is off. Everything else still works.</p>}
      {signingIn && <CloudSignIn skipLabel="Cancel" onSkip={() => setSigningIn(false)} onDone={() => {
        setSigningIn(false);
        // Re-read targets so posting unlocks as soon as the session exists. The password is never kept here.
        void refresh().catch(e => live.current && setError(message(e)));
      }} />}
    </div>}
    {pending.length > 0 && <ul className="gf-schedule-list" aria-label="Scheduled posts">{pending.map(row => <li key={row.id}>
      {row.overdue_at
        ? <p role="status"><strong>Missed while the app was closed.</strong> Was set for {localTime(row.publish_at)} · {row.account_ids.map(accountName).join(", ")}. Nothing was posted.</p>
        : <p>Scheduled for <strong>{localTime(row.publish_at)}</strong> · {row.account_ids.map(accountName).join(", ")}. The app must be open at that time.</p>}
      <div className="gf-schedule-actions">
        {row.overdue_at && <button type="button" className="gf-button compact" disabled={busy} onClick={() => void decide(row, "post_now")}>Post now</button>}
        {row.overdue_at && <button type="button" className="gf-button secondary compact" disabled={busy} onClick={() => void decide(row, "reschedule")}>Reschedule</button>}
        <button type="button" className="gf-button ghost compact" disabled={busy} onClick={() => void decide(row, "cancel")}>Cancel</button>
      </div>
    </li>)}</ul>}
    <div className="gf-post-layout">
      <div className="gf-form-fields">
        {report ? <div aria-label="Quality gate">
          <Pill tone={held ? "quiet" : "mint"}>{held ? "Quality gate: hold" : "Quality gate: pass"}</Pill>
          <p className="gf-help">{rubricLabels.map(([key, label]) => `${label} ${report.rubric[key] ?? "–"}/5`).join(" · ")}</p>
          {report.reasons.length > 0 && <ul>{report.reasons.map(r => <li key={r}>{r}</li>)}</ul>}
        </div> : !error && <p className="gf-help">Checking quality…</p>}
        {held && <Field label="Override reason (required to post a held clip)">{id => <AutoTextarea id={id} rows={2} value={override} onChange={e => setOverride(e.target.value)} placeholder="Why is it fine to post anyway?" />}</Field>}
        {targets && (targets.accounts.length === 0
          ? <p className="gf-help">Connect an Instagram account for this brand first.</p>
          : <fieldset><legend>Accounts</legend>{targets.accounts.map(account => <label key={account.id}>
            <input type="checkbox" checked={chosen.includes(account.id)} disabled={blocked.has(account.id) || busy}
              onChange={e => setChosen(old => e.target.checked ? [...old, account.id] : old.filter(id => id !== account.id))} />
            {" "}{account.display_name || account.id}{blocked.has(account.id) ? " · already has a post attempt" : ""}
          </label>)}</fieldset>)}
        <Field label="Caption" hint={copy ? `${copy.label}${copy.fallback_reason ? ` · ${copy.fallback_reason}` : ""}` : undefined}>{id => <AutoTextarea id={id} rows={4} value={caption} onChange={e => editCaption(e.target.value)} />}</Field>
        <Counters text={caption} limits={limits} />
        <div className="gf-chip-row" aria-label="Caption extras">
          {suggested.map(tag => <button key={tag} type="button" className="gf-chip" aria-pressed={present.has(tag.toLowerCase())}
            onClick={() => editCaption(toggleHashtag(caption, tag))}>#{tag}</button>)}
          <button type="button" className="gf-chip" aria-pressed={hasLinkInBio(caption)} disabled={hasLinkInBio(caption)}
            onClick={() => editCaption(addLinkInBio(caption))}>{hasLinkInBio(caption) ? "“Link in bio” added" : "Add “Link in bio”"}</button>
        </div>
        <button type="button" className="gf-button ghost" disabled={!!writing || busy} onClick={() => void regenerate()}>{writing || "Regenerate caption"}</button>
        {chosen.length > 1 && <div aria-label="Per-account captions">
          {chosen.map(account => overrides[account] === undefined
            ? <button key={account} type="button" className="gf-chip" onClick={() => { setOverrides(old => ({ ...old, [account]: caption })); setPreviewAccount(account); }}>Own caption for {accountName(account)}</button>
            : <div key={account}>
              <Field label={`Caption for ${accountName(account)}`}>{id => <AutoTextarea id={id} rows={3} value={overrides[account]} onFocus={() => setPreviewAccount(account)} onChange={e => setOverrides(old => ({ ...old, [account]: e.target.value }))} />}</Field>
              <Counters text={overrides[account]} limits={limits} label={`Caption limits for ${accountName(account)}`} />
              <button type="button" className="gf-button ghost compact" onClick={() => setOverrides(old => { const next = { ...old }; delete next[account]; return next; })}>Use the shared caption</button>
            </div>)}
        </div>}
        <label><input type="checkbox" checked={shareToFeed} onChange={e => setShareToFeed(e.target.checked)} /> Also show in the main feed (not only Reels)</label>
        <p className="gf-help">{pkg?.collaborators_note ?? "Mention people with @ in the caption."} No location is added.</p>
        {pkg && pkg.candidates.length > 1 && <fieldset>
          <legend>Cover</legend>
          <div className="gf-cover-strip" role="group" aria-label="Cover frames">
            {pkg.candidates.map(c => {
              const selected = coverMs === null ? c.auto : coverMs === c.time_ms;
              return <button key={c.time_ms} type="button" aria-pressed={selected} aria-label={`Cover at ${seconds(c.time_ms)}${c.auto ? " (suggested)" : ""}`}
                onClick={() => setCoverMs(c.auto ? null : c.time_ms)}>
                <img src={c.url} alt="" loading="lazy" /><small>{c.auto ? "Suggested" : seconds(c.time_ms)}</small>
              </button>;
            })}
          </div>
        </fieldset>}
        <fieldset className="gf-post-when">
          <legend>When</legend>
          <div className="gf-post-when-modes">
            <label><input type="radio" name={`when-${clip.id}`} checked={mode === "now"} onChange={() => setMode("now")} /> Post now</label>
            <label><input type="radio" name={`when-${clip.id}`} checked={mode === "schedule"} onChange={() => { setMode("schedule"); if (!when) setWhen(localInputValue(scheduleSuggestions(now())[0].at)); }} /> Schedule</label>
          </div>
          {mode === "schedule" && <>
            <div className="gf-chip-row">{scheduleSuggestions(now()).map(s => <button key={s.label} type="button" className="gf-chip"
              aria-pressed={when === localInputValue(s.at)} onClick={() => setWhen(localInputValue(s.at))}>{s.label}</button>)}</div>
            <Field label="Date and time" hint={`Times are in ${zone}.`}>{id => <input id={id} type="datetime-local" value={when} min={localInputValue(now())} onChange={e => setWhen(e.target.value)} />}</Field>
            <p className="gf-help"><strong>The app must be open at that time.</strong> If it is closed then, you'll be asked to post, reschedule or cancel when you reopen it. Nothing posts late on its own.</p>
            {scheduleProblem && when && <p className="gf-help">{scheduleProblem}</p>}
          </>}
        </fieldset>
        {captionProblems.length > 0 && <div className="gf-inline-error" role="alert">{[...new Set(captionProblems)].join(" ")}</div>}
        <button className="gf-button full" disabled={!ready} onClick={() => void submit()}>{submitLabel}</button>
        {notice && <p role="status">{notice}</p>}
        {error && <div className="gf-inline-error" role="alert">{error}</div>}
        {attempts.length > 0 && <ul aria-label="Post attempts">{attempts.map(a => <li key={a.id}>
          <strong>{a.account_name || a.account_id}</strong> · <span>{stateLabel[a.state]}</span>
          {a.state === "scheduled" && a.scheduled_for && <> · {localTime(a.scheduled_for)}</>}
          {a.permalink && <> · <a href={a.permalink} target="_blank" rel="noreferrer noopener">Open reel</a></>}
          {a.error && <p className="gf-help">{a.error.message}</p>}
          {a.warnings.includes("caption_readback_mismatch") && <p className="gf-help">Instagram shows a different caption; check the post.</p>}
          {(a.warnings.includes("cover_upload_failed") || a.warnings.includes("cover_url_unavailable")) && <p className="gf-help">Custom cover couldn't be hosted; Instagram used the same frame from the video instead.</p>}
          {(a.state === "unknown" || (a.state === "container_created" && !a.active)) &&
            <button className="gf-button secondary" disabled={busy} onClick={() => void act(a, "reconcile")}>Check status</button>}
          {a.state !== "unknown" && canResume(a) &&
            <button className="gf-button ghost" disabled={busy} onClick={() => void act(a, "resume")}>Continue</button>}
        </li>)}</ul>}
      </div>
      <PostPreview
        videoUrl={clipMediaUrl(clip.id)}
        coverUrl={coverUrl}
        handle={shownAccount ? accountName(shownAccount) : targets?.accounts[0]?.display_name || "your_account"}
        caption={shownAccount ? captionFor(shownAccount) : caption}
        shareToFeed={shareToFeed}
        when={mode === "schedule" && scheduledAt ? `Posts ${localTime(scheduledAt)} (${zone})` : null}
      />
    </div>
  </section>;
}
