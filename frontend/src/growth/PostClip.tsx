import { useEffect, useRef, useState, type ReactNode } from "react";
import { AutoTextarea } from "../components/AutoTextarea";
import { UnsavedNote, useUnsavedDraft } from "./unsavedDrafts";
import { Field, Pill } from "./parts";
import {
  TIKTOK_TOGGLES,
  addLinkInBio,
  canResume,
  checkCaption,
  hasLinkInBio,
  hashtagsOf,
  inFlight,
  limitsFor,
  localInputValue,
  localTimezone,
  platformLabel,
  publishApi,
  scheduleSuggestions,
  stateLabel,
  toggleHashtag,
  withOffset,
  type PackageFields,
  type PostPackageView,
  type PostSchedule,
  type PostTargets,
  type PublishAttempt,
  type QualityReport,
  type TikTokCreatorInfo,
  type TikTokSettings,
  type TikTokToggle,
  type YoutubeVisibility,
} from "./publishApi";
import { postCopyApi, type PostCopy } from "./referencesApi";
import { CloudSignIn } from "./CloudSignIn";
import { PostPreview } from "./PostPreview";
import { PanelDialog } from "./PanelDialog";
import { Icon } from "./Icon";
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
/** Uncertain outcomes are checked against the platform, never retried blindly. */
const needsCheck = (a: PublishAttempt) =>
  a.state === "unknown" || ((a.state === "container_created" || a.state === "submitted") && !a.active);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const localTime = (iso: string) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

function Counters({ text, platform, label, named }: { text: string; platform: string; label?: string; named?: boolean }) {
  const check = checkCaption(text, platform), limits = limitsFor(platform);
  const item = (value: number, max: number, unit: string) =>
    <span className={value > max ? "over" : ""}>{value.toLocaleString()} / {max.toLocaleString()} {unit}</span>;
  return <div className="gf-caption-counters" aria-label={label || "Caption limits"} aria-live="polite">
    {item(check.chars, limits.caption_chars, named ? `characters (${platformLabel(platform)})` : "characters")}
    {limits.hashtags !== null && item(check.hashtags, limits.hashtags, "hashtags")}
    {limits.mentions !== null && item(check.mentions, limits.mentions, "mentions")}
  </div>;
}

const NO_TIKTOK: TikTokSettings = {
  privacy_level: "", allow_comment: false, allow_duet: false, allow_stitch: false,
  content_preview_confirmed: false, express_consent_given: false,
};
const TOGGLE_LABELS: Record<TikTokToggle, string> = { allow_comment: "Comments", allow_duet: "Duets", allow_stitch: "Stitches" };
const MUSIC_TERMS = "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en";
const COLLABORATOR = /^[A-Za-z0-9._]{1,30}$/;
export const collaboratorsOf = (value: string) =>
  [...new Set(value.split(/[\s,]+/).map(v => v.trim().replace(/^@/, "")).filter(Boolean))];
type CreatorInfo = TikTokCreatorInfo | { error: string };

/**
 * Posts an already-approved revision, now or at a scheduled time, to the chosen accounts. Approval is
 * a separate decision made in review (REQ-CPR-019): posting never approves, and an unapproved
 * revision cannot be posted. The package (caption, hashtags, CTA, cover, feed
 * sharing) is previewed on a phone first. Uncertain outcomes offer "Check status", never a blind retry.
 */
function PostEditorSurface({ compact, open, onClose, children }: { compact: boolean; open: boolean; onClose: () => void; children: ReactNode }) {
  return compact
    ? <PanelDialog open={open} onClose={onClose} title="Prepare your post" description="Preview, pick accounts and platforms, then post or schedule." size="wide">{children}</PanelDialog>
    : <>{children}</>;
}

export function PostClip({
  clip,
  disabled = false,
  compact = false,
  activeSurface = true,
  pollMs = 3000,
  now = () => new Date(),
}: {
  clip: PostableClip;
  disabled?: boolean;
  /** Keeps review focused; the full editor stays mounted in a deliberate sheet. */
  compact?: boolean;
  activeSurface?: boolean;
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
  // The creator's own caption edits are an Unsaved Draft until they post, schedule or regenerate.
  const [captionDirty, setCaptionDirty] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [coverMs, setCoverMs] = useState<number | null>(null);
  const [shareToFeed, setShareToFeed] = useState(true);
  const [collaborators, setCollaborators] = useState("");
  const [youtubeTitle, setYoutubeTitle] = useState("");
  const [youtubeVisibility, setYoutubeVisibility] = useState<YoutubeVisibility>("public");
  // TikTok has no defaults: the creator picks privacy and interactions and confirms every post.
  const [tiktok, setTiktok] = useState<TikTokSettings>(NO_TIKTOK);
  const [creatorInfo, setCreatorInfo] = useState<Record<string, CreatorInfo>>({});
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
  const [editorOpen, setEditorOpen] = useState(false);
  useEffect(() => setEditorOpen(false), [clip.id, clip.sha256, clip.approved]);
  useEffect(() => { if (!activeSurface) setEditorOpen(false); }, [activeSurface]);
  // Generated copy prefills the caption until the person edits it themselves.
  const edited = useRef(false), prefilled = useRef(false);
  const live = useRef(true);

  function applyTargets(t: PostTargets) {
    setTargets(t); setAttempts(t.attempts); setSchedules(t.schedules ?? []);
  }
  const refresh = () => publishApi.targets(clip.id).then(t => { if (live.current) applyTargets(t); });

  useEffect(() => {
    live.current = true;
    setTargets(undefined); setReport(undefined); setAttempts([]); setSchedules([]); setChosen([]); setError("");
    setOverride(""); setOverrides({}); setCoverMs(null); setShareToFeed(true); setMode("now"); setNotice("");
    setCollaborators(""); setYoutubeTitle(""); setYoutubeVisibility("public"); setTiktok(NO_TIKTOK); setCreatorInfo({});
    edited.current = false; prefilled.current = false; setCopy(undefined); setPkg(undefined); setCaptionDirty(false);
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
  const postingOff = !!targets && !targets.publishing_enabled;
  const target = (id: string) => targets?.accounts.find(a => a.id === id);
  const platformOf = (id: string) => target(id)?.platform || "instagram";
  const captionFor = (account: string) => overrides[account] ?? caption;
  const captionProblems = chosen.flatMap(a => checkCaption(captionFor(a), platformOf(a)).problems);
  // The shared caption is measured against the strictest platform still using it.
  const sharing = chosen.filter(a => overrides[a] === undefined).map(platformOf);
  const sharedPlatform = sharing.sort((a, b) => limitsFor(a).caption_chars - limitsFor(b).caption_chars)[0]
    ?? targets?.accounts[0]?.platform ?? "instagram";
  const platforms = new Set(chosen.map(platformOf));
  const hasInstagram = platforms.has("instagram"), hasYoutube = platforms.has("youtube");
  const collaboratorList = hasInstagram ? collaboratorsOf(collaborators) : [];
  const collaboratorProblem = collaboratorList.length > (pkg?.limits.collaborators ?? 3)
    ? `Invite at most ${pkg?.limits.collaborators ?? 3} collaborators.`
    : collaboratorList.some(u => !COLLABORATOR.test(u)) ? "Collaborators are Instagram usernames: letters, numbers, dots and underscores." : "";
  const youtubeProblem = hasYoutube && youtubeTitle.length > 100 ? "YouTube titles are limited to 100 characters." : "";
  const tiktokAccounts = chosen.filter(a => platformOf(a) === "tiktok");
  const tiktokInfos = tiktokAccounts.map(a => creatorInfo[a]);
  const tiktokLoaded = tiktokInfos.every((i): i is TikTokCreatorInfo => !!i && !("error" in i));
  const tiktokError = tiktokInfos.find((i): i is { error: string } => !!i && "error" in i)?.error;
  const loaded = tiktokLoaded ? tiktokInfos as TikTokCreatorInfo[] : [];
  // Several TikTok accounts share one choice, so only options every one of them allows are offered.
  const privacyOptions = (loaded[0]?.privacyLevels ?? []).filter(o => loaded.every(i => i.privacyLevels?.some(p => p.value === o.value)));
  const toggleAllowed = (name: TikTokToggle) => loaded.every(i => i.postingLimits?.interactionSettings?.[name]?.enabled !== false);
  const nicknames = loaded.map(i => i.creator?.nickname).filter(Boolean);
  const maxSeconds = Math.min(...loaded.map(i => i.postingLimits?.maxVideoDurationSec ?? Infinity));
  const tiktokBlocker = !tiktokAccounts.length ? ""
    : tiktokError ? tiktokError
    : !tiktokLoaded ? "Checking the TikTok account…"
    : loaded.some(i => i.creator?.canPostMore === false) ? "TikTok says this account cannot post more right now. Try again later."
    : pkg?.duration && Number.isFinite(maxSeconds) && pkg.duration > maxSeconds ? `TikTok allows videos up to ${maxSeconds} seconds for this account.`
    : !privacyOptions.length ? "TikTok returned no privacy options for this account." : "";
  const tiktokReady = !tiktokAccounts.length || (!tiktokBlocker && privacyOptions.some(o => o.value === tiktok.privacy_level)
    && tiktok.content_preview_confirmed && tiktok.express_consent_given);
  const tiktokKey = tiktokAccounts.join(",");
  useEffect(() => {
    for (const id of tiktokKey ? tiktokKey.split(",") : []) {
      if (creatorInfo[id] && !("error" in creatorInfo[id])) continue;
      publishApi.tiktokCreatorInfo(id)
        .then(info => { if (live.current) setCreatorInfo(old => ({ ...old, [id]: info })); })
        .catch(e => { if (live.current) setCreatorInfo(old => ({ ...old, [id]: { error: message(e) } })); });
    }
    // creatorInfo is read, not watched: each account is fetched once per selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiktokKey]);
  useEffect(() => {
    // A toggle the creator turned off in TikTok can never be sent on.
    if (!tiktokLoaded) return;
    setTiktok(old => {
      const next = { ...old };
      for (const name of TIKTOK_TOGGLES) if (!toggleAllowed(name)) next[name] = false;
      if (next.privacy_level && !privacyOptions.some(o => o.value === next.privacy_level)) next.privacy_level = "";
      return TIKTOK_TOGGLES.every(n => next[n] === old[n]) && next.privacy_level === old.privacy_level ? old : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiktokLoaded, tiktokKey, creatorInfo]);
  const scheduledAt = mode === "schedule" ? withOffset(when) : null;
  const scheduleProblem = mode !== "schedule" ? "" : !scheduledAt ? "Pick a date and time."
    : new Date(scheduledAt).getTime() <= now().getTime() + 60_000 ? "Pick a time at least a minute from now." : "";
  const needsApproval = !clip.approved;
  const ready = !needsApproval && !!targets && !!report && !signInRequired && !postingOff && chosen.length > 0
    && chosen.every(a => target(a)?.publishing_permitted === true)
    && chosen.every(a => captionFor(a).trim().length > 0) && captionProblems.length === 0 && !scheduleProblem
    && !collaboratorProblem && !youtubeProblem && tiktokReady
    && (!held || override.trim().length >= 10) && !busy && !disabled;
  const accountName = (id: string) => target(id)?.display_name || id;
  const accountLabel = (id: string) => target(id) ? `${accountName(id)} on ${target(id)?.platform_label || platformLabel(platformOf(id))}` : id;
  /** Only the fields each platform uses: the server refuses collaborators outside Instagram. */
  const packageFor = (group: Set<string>): PackageFields => ({
    share_to_feed: shareToFeed, cover_time_ms: coverMs,
    ...([...group].every(p => p === "instagram") ? { collaborators: collaboratorList } : {}),
    ...(group.has("youtube") ? { youtube_title: youtubeTitle.trim() || null, youtube_visibility: youtubeVisibility } : {}),
    ...(group.has("tiktok") ? { tiktok } : {}),
  });
  const shownAccount = previewAccount && chosen.includes(previewAccount) ? previewAccount : chosen[0];
  const coverUrl = coverMs === null ? pkg?.auto_cover.url : pkg?.candidates.find(c => c.time_ms === coverMs)?.url;
  const suggested = copy?.hashtags ?? [];
  const present = new Set(hashtagsOf(caption).map(t => t.toLowerCase()));
  const zone = localTimezone();

  async function submit() {
    if (!ready) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const current = clip;
      if (!current.approved) throw new Error("Approve this revision before posting it.");
      if (!current.sha256) throw new Error("This revision has no recorded file hash; it cannot be posted.");
      const reason = held ? { override_reason: override.trim() } : {};
      if (mode === "schedule" && scheduledAt) {
        // One schedule shares one package, so Instagram collaborators get their own schedule.
        const instagram = chosen.filter(a => platformOf(a) === "instagram"), rest = chosen.filter(a => platformOf(a) !== "instagram");
        const groups = collaboratorList.length && instagram.length && rest.length ? [instagram, rest] : [chosen];
        const rows: PostSchedule[] = [], failures: string[] = [];
        for (const group of groups) {
          try {
            rows.push(await publishApi.schedule(current.id, {
              account_ids: group, captions: Object.fromEntries(group.map(a => [a, captionFor(a)])),
              sha256: current.sha256, publish_at: scheduledAt, timezone: zone, ...reason,
              ...packageFor(new Set(group.map(platformOf))),
            }));
          } catch (e) {
            failures.push(groups.length > 1 ? `${group.map(accountLabel).join(", ")}: ${message(e)}` : message(e));
          }
        }
        if (live.current) {
          const made = rows.flatMap(r => r.attempts);
          setSchedules(old => [...old.filter(s => !rows.some(r => r.id === s.id)), ...rows]);
          setAttempts(old => [...made, ...old.filter(a => !made.some(m => m.id === a.id))]);
          if (rows.length) {
            const scheduled = new Set(rows.flatMap(r => r.account_ids));
            setChosen(old => old.filter(a => !scheduled.has(a))); setCaptionDirty(false);
            setNotice(`Scheduled for ${localTime(rows[0].publish_at)}. The app must be open at that time.`);
          }
          if (failures.length) setError(failures.join(" "));
        }
        return;
      }
      const made: PublishAttempt[] = [], failures: string[] = [];
      for (const account of chosen) {
        try {
          made.push(await publishApi.post(current.id, {
            account_id: account, caption: captionFor(account), sha256: current.sha256, ...reason,
            ...packageFor(new Set([platformOf(account)])),
          }));
        } catch (e) {
          failures.push(`${accountLabel(account)}: ${message(e)}`);
        }
      }
      if (live.current) {
        setAttempts(old => [...made, ...old.filter(a => !made.some(m => m.id === a.id))]);
        setChosen(old => old.filter(a => !made.some(m => m.account_id === a)));
        if (made.length) { setCaptionDirty(false); setTiktok(NO_TIKTOK); }
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
      if (view.post_copy) { setCopy(view.post_copy); setCaption(view.post_copy.caption); edited.current = false; setCaptionDirty(false); }
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

  const editCaption = (value: string) => { edited.current = true; setCaption(value); setCaptionDirty(true); };
  useUnsavedDraft(captionDirty, {
    id: "post-caption",
    screen: "studio",
    label: "Post caption",
    record: clip.id,
    discard: () => {
      edited.current = false;
      setCaption(copy?.caption || targets?.default_caption || clip.caption || clip.hook || "");
      setOverrides({});
      setCaptionDirty(false);
    },
  });
  const pending = schedules.filter(s => s.status === "scheduled");
  // Names where it goes: the chosen platforms, or every available one before anything is chosen.
  const destinations = [...new Set((chosen.length ? chosen : targets?.accounts.map(a => a.id) ?? []).map(platformOf))].map(platformLabel);
  const postLabel = destinations.length === 0 ? "Post" : destinations.length === 1 ? `Post to ${destinations[0]}`
    : destinations.length === 2 ? `Post to ${destinations[0]} and ${destinations[1]}` : `Post to ${destinations.length} platforms`;
  const submitLabel = busy ? "Working…" : mode === "schedule" ? "Schedule post" : postLabel;
  const approvalNote = "Approve this revision to post it. Approving never posts on its own.";

  const verdict = !report ? "" : held
    ? `Held: ${report.reasons[0] ? report.reasons[0].charAt(0).toLowerCase() + report.reasons[0].slice(1) : "check the details before posting"}`
    : "Passed: ready to post";
  const pickedCover = pkg?.candidates.find(c => (coverMs === null ? c.auto : coverMs === c.time_ms));

  return <div className="gf-post-instagram">
    <section className="gf-review-section gf-quality" aria-label="Quality gate">
      <div className="gf-review-section-head">
        <h3>Quality</h3>
        {report && <Pill tone={held ? "sand" : "mint"}>{held ? "Quality gate: hold" : "Quality gate: pass"}</Pill>}
      </div>
      {report ? <>
        <ul className="gf-score-pills" aria-label="Quality scores">
          {rubricLabels.map(([key, label]) => {
            const value = report.rubric[key];
            const tone = value === null || value === undefined ? "is-unknown" : value >= 4 ? "is-good" : value <= 2 ? "is-low" : "";
            return <li key={key} className={tone}><span>{label}</span><strong>{value ?? "–"}<small>/5</small></strong></li>;
          })}
        </ul>
        <p className={`gf-quality-verdict${held ? " is-held" : ""}`}>{verdict}</p>
        {report.reasons.length > 0 && <details className="gf-quality-details">
          <summary>Details</summary>
          <ul>{report.reasons.map(r => <li key={r}>{r}</li>)}</ul>
        </details>}
        {held && !compact && <Field label="Override reason (required to post a held clip)">{id => <AutoTextarea id={id} rows={2} value={override} onChange={e => setOverride(e.target.value)} placeholder="Why is it fine to post anyway?" />}</Field>}
      </> : !error && <p className="gf-help">Checking quality…</p>}
    </section>

    {compact && <section className="gf-review-section gf-post-launcher" aria-label="Posting tools">
      <button type="button" className="gf-button secondary full" disabled={needsApproval} onClick={() => setEditorOpen(true)}><Icon name="send" size={16} /> Prepare your post<Icon name="arrow" size={15} /></button>
      <p className="gf-post-note">{needsApproval ? approvalNote : "Preview, caption, accounts and timing."}</p>
      {captionDirty && <UnsavedNote>Caption not saved</UnsavedNote>}
      {attempts.length > 0 && <p className="gf-post-note" role="status" aria-label="Posting activity">{[...new Set(attempts.map(a => a.state))].map(state => `${stateLabel[state]}: ${attempts.filter(a => a.state === state).length}`).join(" · ")}</p>}
      {attempts.some(needsCheck) && <p className="gf-post-recovery-note" role="status">A post needs a status check. Open posting to check the exact attempt before trying again.</p>}
      {pending.some(row => row.overdue_at) && <p className="gf-post-recovery-note" role="status">A scheduled post was missed while the app was closed. Nothing was posted. Open posting to choose what happens next.</p>}
      {pending.some(row => !row.overdue_at) && <p className="gf-post-note">Scheduled posts are waiting. The app must be open at their scheduled time.</p>}
      {notice && <p className="gf-post-note" role="status">{notice}</p>}
      {error && <div className="gf-inline-error" role="alert">{error}</div>}
    </section>}
    <PostEditorSurface compact={compact} open={editorOpen && activeSurface} onClose={() => setEditorOpen(false)}>
    <section className={`gf-review-section gf-post-section${compact ? " gf-post-sheet" : ""}`} aria-label="Post">
      <div className="gf-review-section-head"><h3>Post</h3></div>
      {signInRequired && <div className="gf-post-signin">
        <div>
          <p role="status"><strong>Sign in required.</strong> Posting goes through Growth Factory cloud, which hosts the approved video briefly so each platform can fetch it.</p>
          {targets?.cloud_configured && !signingIn && <button type="button" className="gf-button compact" onClick={() => setSigningIn(true)}>Sign in</button>}
        </div>
        {!targets?.cloud_configured && <p>Posting is off until accounts are set up.</p>}
        {signingIn && <CloudSignIn skipLabel="Cancel" onSkip={() => setSigningIn(false)} onDone={() => {
          setSigningIn(false);
          // Re-read targets so posting unlocks as soon as the session exists. The password is never kept here.
          void refresh().catch(e => live.current && setError(message(e)));
        }} />}
      </div>}
      {pending.length > 0 && <ul className="gf-schedule-list" aria-label="Scheduled posts">{pending.map(row => <li key={row.id}>
        {row.overdue_at
          ? <p role="status"><strong>Missed while the app was closed.</strong> Was set for {localTime(row.publish_at)} · {row.account_ids.map(accountLabel).join(", ")}. Nothing was posted.</p>
          : <p>Scheduled for <strong>{localTime(row.publish_at)}</strong> · {row.account_ids.map(accountLabel).join(", ")}. The app must be open at that time.</p>}
        <div className="gf-schedule-actions">
          {row.overdue_at && <button type="button" className="gf-button compact" disabled={busy} onClick={() => void decide(row, "post_now")}>Post now</button>}
          {row.overdue_at && <button type="button" className="gf-button secondary compact" disabled={busy} onClick={() => void decide(row, "reschedule")}>Reschedule</button>}
          <button type="button" className="gf-button ghost compact" disabled={busy} onClick={() => void decide(row, "cancel")}>Cancel</button>
        </div>
      </li>)}</ul>}
      <div className="gf-post-composer"><div className="gf-post-composer-preview">
      {(!compact || (editorOpen && activeSurface)) && <PostPreview
        videoUrl={clipMediaUrl(clip.id)}
        coverUrl={coverUrl}
        handle={shownAccount ? accountName(shownAccount) : targets?.accounts[0]?.display_name || "your_account"}
        caption={shownAccount ? captionFor(shownAccount) : caption}
        shareToFeed={shareToFeed}
        when={mode === "schedule" && scheduledAt ? `Posts ${localTime(scheduledAt)} (${zone})` : null}
      />}
      </div><div className="gf-post-composer-fields">
      {postingOff && <p className="gf-post-recovery-note" role="status">Posting is off. Turn on <strong>Post from Growth Factory</strong> in Settings → Accounts and connections.</p>}
      {targets && (targets.accounts.length === 0
        ? <p className="gf-help">Connect an account for this brand in Settings → Accounts and connections first.</p>
        : <fieldset className="gf-post-group gf-post-accounts"><legend>Accounts</legend>{targets.accounts.map(account => {
          const allowed = account.publishing_permitted === true;
          const label = account.platform_label || platformLabel(account.platform);
          return <label key={account.id} className="gf-post-account">
            <input type="checkbox" checked={chosen.includes(account.id)} disabled={blocked.has(account.id) || !allowed || postingOff || busy}
              onChange={e => setChosen(old => e.target.checked ? [...old, account.id] : old.filter(id => id !== account.id))} />
            <span className="gf-post-account-avatar" aria-hidden="true">{(account.display_name || account.id).replace(/^@/, "").slice(0, 1).toUpperCase()}</span>
            <span className="gf-post-account-name">{account.display_name || account.id} <small>{label}</small>
              {blocked.has(account.id) ? " · already has a post attempt" : !allowed ? " · allow posting in Settings first" : ""}</span>
          </label>;
        })}</fieldset>)}
      <div className="gf-post-group">
        <Field label="Caption" hint={copy ? `${copy.label}${copy.fallback_reason ? ` · ${copy.fallback_reason}` : ""}` : undefined}>{id => <AutoTextarea id={id} rows={4} value={caption} onChange={e => editCaption(e.target.value)} />}</Field>
        <Counters text={caption} platform={sharedPlatform} named={platforms.size > 1} />
        {captionDirty && <UnsavedNote>Caption not saved</UnsavedNote>}
        <div className="gf-chip-row" aria-label="Caption extras">
          {suggested.map(tag => <button key={tag} type="button" className="gf-chip" aria-pressed={present.has(tag.toLowerCase())}
            onClick={() => editCaption(toggleHashtag(caption, tag))}>#{tag}</button>)}
          <button type="button" className="gf-text-button" aria-pressed={hasLinkInBio(caption)} disabled={hasLinkInBio(caption)}
            onClick={() => editCaption(addLinkInBio(caption))}>{hasLinkInBio(caption) ? "“Link in bio” added" : "Add “Link in bio”"}</button>
          <button type="button" className="gf-text-button" disabled={!!writing || busy} onClick={() => void regenerate()}>{writing || "Regenerate caption"}</button>
        </div>
        {chosen.length > 1 && <div className="gf-post-overrides" aria-label="Per-account captions">
          {chosen.map(account => overrides[account] === undefined
            ? <button key={account} type="button" className="gf-chip" onClick={() => { setOverrides(old => ({ ...old, [account]: caption })); setPreviewAccount(account); }}>Own caption for {accountLabel(account)}</button>
            : <div key={account} className="gf-post-group">
              <Field label={`Caption for ${accountLabel(account)}`}>{id => <AutoTextarea id={id} rows={3} value={overrides[account]} onFocus={() => setPreviewAccount(account)} onChange={e => setOverrides(old => ({ ...old, [account]: e.target.value }))} />}</Field>
              <Counters text={overrides[account]} platform={platformOf(account)} label={`Caption limits for ${accountLabel(account)}`} />
              <button type="button" className="gf-text-button" onClick={() => setOverrides(old => { const next = { ...old }; delete next[account]; return next; })}>Use the shared caption</button>
            </div>)}
        </div>}
      </div>
      {hasInstagram && <fieldset className="gf-post-group" aria-label="Instagram options">
        <legend>Instagram</legend>
        <label className="gf-toggle-row">
          <span>Also show in the main feed<small>Off posts to Reels only</small></span>
          <input type="checkbox" role="switch" checked={shareToFeed} onChange={e => setShareToFeed(e.target.checked)} />
        </label>
        <Field label="Collaborators" hint={pkg?.collaborators_note ?? "Up to 3 public Business or Creator usernames."}>{id =>
          <input id={id} value={collaborators} placeholder="@partner, @friend" autoComplete="off" onChange={e => setCollaborators(e.target.value)} />}</Field>
        {collaboratorProblem && <p className="gf-help" role="alert">{collaboratorProblem}</p>}
        <p className="gf-post-note">No location is added.</p>
      </fieldset>}
      {hasYoutube && <fieldset className="gf-post-group" aria-label="YouTube options">
        <legend>YouTube</legend>
        <Field label="YouTube title" hint={`Optional · ${youtubeTitle.length} / 100. The hook is used when empty.`}>{id =>
          <input id={id} value={youtubeTitle} maxLength={120} placeholder={clip.hook || ""} onChange={e => setYoutubeTitle(e.target.value)} />}</Field>
        {youtubeProblem && <p className="gf-help" role="alert">{youtubeProblem}</p>}
        <Field label="Visibility">{id => <select id={id} value={youtubeVisibility} onChange={e => setYoutubeVisibility(e.target.value as YoutubeVisibility)}>
          <option value="public">Public</option><option value="unlisted">Unlisted</option><option value="private">Private</option>
        </select>}</Field>
      </fieldset>}
      {tiktokAccounts.length > 0 && <fieldset className="gf-post-group gf-post-tiktok" aria-label="TikTok options">
        <legend>TikTok</legend>
        {nicknames.length > 0 && <p className="gf-post-note">Posting to {nicknames.join(", ")} on TikTok.</p>}
        {tiktokBlocker
          ? <p className={tiktokLoaded || tiktokError ? "gf-post-recovery-note" : "gf-help"} role="status">{tiktokBlocker}</p>
          : <>
            <Field label="Who can see this video">{id => <select id={id} value={tiktok.privacy_level} onChange={e => setTiktok(old => ({ ...old, privacy_level: e.target.value }))}>
              <option value="" disabled>Choose who can see it</option>
              {privacyOptions.map(o => <option key={o.value} value={o.value}>{o.label || o.value}</option>)}
            </select>}</Field>
            <div className="gf-post-tiktok-toggles" role="group" aria-label="Allow viewers to">
              {TIKTOK_TOGGLES.map(name => {
                const allowed = toggleAllowed(name);
                return <label key={name} className="gf-toggle-row">
                  <span>Allow {TOGGLE_LABELS[name].toLowerCase()}{!allowed && <small>Turned off in this TikTok account</small>}</span>
                  <input type="checkbox" role="switch" aria-label={`Allow ${TOGGLE_LABELS[name].toLowerCase()}`} checked={tiktok[name]} disabled={!allowed}
                    onChange={e => setTiktok(old => ({ ...old, [name]: e.target.checked }))} />
                </label>;
              })}
            </div>
            <label className="gf-post-consent">
              <input type="checkbox" checked={tiktok.content_preview_confirmed} onChange={e => setTiktok(old => ({ ...old, content_preview_confirmed: e.target.checked }))} />
              <span>I watched the preview and this is the video I want to post.</span>
            </label>
            <label className="gf-post-consent">
              <input type="checkbox" checked={tiktok.express_consent_given} onChange={e => setTiktok(old => ({ ...old, express_consent_given: e.target.checked }))} />
              <span>By posting, I agree to TikTok's <a href={MUSIC_TERMS} target="_blank" rel="noreferrer noopener">Music Usage Confirmation</a>.</span>
            </label>
            <p className="gf-post-note">It can take a few minutes for the video to appear on the TikTok profile.</p>
          </>}
      </fieldset>}
      {pkg && pkg.candidates.length > 1 && <fieldset className="gf-post-group">
        <legend>Cover</legend>
        <div className="gf-cover-strip" role="group" aria-label="Cover frames">
          {pkg.candidates.map(c => {
            const selected = coverMs === null ? c.auto : coverMs === c.time_ms;
            return <button key={c.time_ms} type="button" aria-pressed={selected} aria-label={`Cover at ${seconds(c.time_ms)}${c.auto ? " (suggested)" : ""}`}
              title={c.auto ? `Suggested · ${seconds(c.time_ms)}` : seconds(c.time_ms)} onClick={() => setCoverMs(c.auto ? null : c.time_ms)}>
              <img src={c.url} alt="" loading="lazy" />{c.auto && <span className="gf-cover-auto" aria-hidden="true" />}
            </button>;
          })}
        </div>
        {pickedCover && <small className="gf-cover-picked">{pickedCover.auto ? "Suggested frame" : "Your pick"} · {seconds(pickedCover.time_ms)}</small>}
      </fieldset>}
      <fieldset className="gf-post-group gf-post-when">
        <legend>When</legend>
        <div className="gf-segmented" role="radiogroup" aria-label="When to post">
          <label><input type="radio" name={`when-${clip.id}`} checked={mode === "now"} onChange={() => setMode("now")} /><span>Post now</span></label>
          <label><input type="radio" name={`when-${clip.id}`} checked={mode === "schedule"} onChange={() => { setMode("schedule"); if (!when) setWhen(localInputValue(scheduleSuggestions(now())[0].at)); }} /><span>Schedule</span></label>
        </div>
        {mode === "schedule" && <div className="gf-post-schedule">
          <div className="gf-chip-row">{scheduleSuggestions(now()).map(s => <button key={s.label} type="button" className="gf-chip"
            aria-pressed={when === localInputValue(s.at)} onClick={() => setWhen(localInputValue(s.at))}>{s.label}</button>)}</div>
          <Field label="Date and time" hint={`Times are in ${zone}.`}>{id => <input id={id} type="datetime-local" value={when} min={localInputValue(now())} onChange={e => setWhen(e.target.value)} />}</Field>
          <p className="gf-help"><strong>The app must be open at that time.</strong> If it is closed then, you'll be asked to post, reschedule or cancel when you reopen it. Nothing posts late on its own.</p>
          {scheduleProblem && when && <p className="gf-help">{scheduleProblem}</p>}
        </div>}
      </fieldset>
      {captionProblems.length > 0 && <div className="gf-inline-error" role="alert">{[...new Set(captionProblems)].join(" ")}</div>}
      {compact && held && <div className="gf-post-group"><p className="gf-post-recovery-note">{verdict}</p><Field label="Override reason (required to post a held clip)">{id => <AutoTextarea id={id} rows={2} value={override} onChange={e => setOverride(e.target.value)} placeholder="Why is it fine to post anyway?" />}</Field></div>}
      {needsApproval && !compact && <p className="gf-help" role="status">{approvalNote}</p>}
      <button className="gf-button full gf-post-submit" disabled={!ready} onClick={() => void submit()}>{submitLabel}</button>
      {notice && <p role="status">{notice}</p>}
      {error && <div className="gf-inline-error" role="alert">{error}</div>}
      {attempts.length > 0 && <ul className="gf-post-attempts" aria-label="Post attempts">{attempts.map(a => <li key={a.id}>
        <strong>{a.account_name || accountName(a.account_id)}</strong> · <span>{platformLabel(a.platform ?? target(a.account_id)?.platform)}</span> · <span>{stateLabel[a.state]}</span>
        {a.state === "scheduled" && a.scheduled_for && <> · {localTime(a.scheduled_for)}</>}
        {a.permalink && <> · <a href={a.permalink} target="_blank" rel="noreferrer noopener">Open post</a></>}
        {a.error && <p className="gf-help">{a.error.message}</p>}
        {a.warnings.includes("caption_readback_mismatch") && <p className="gf-help">Instagram shows a different caption; check the post.</p>}
        {(a.warnings.includes("cover_upload_failed") || a.warnings.includes("cover_url_unavailable")) && <p className="gf-help">Custom cover couldn't be hosted; Instagram used the same frame from the video instead.</p>}
        {needsCheck(a) &&
          <button className="gf-button secondary" disabled={busy} onClick={() => void act(a, "reconcile")}>Check status</button>}
        {a.state !== "unknown" && canResume(a) &&
          <button className="gf-button ghost" disabled={busy} onClick={() => void act(a, "resume")}>Continue</button>}
      </li>)}</ul>}
      </div></div>
    </section>
    </PostEditorSurface>
  </div>;
}
