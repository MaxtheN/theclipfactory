import { useEffect, useRef, useState } from "react";
import { AutoTextarea } from "../components/AutoTextarea";
import { Field, Pill } from "./parts";
import {
  canResume,
  inFlight,
  publishApi,
  stateLabel,
  type PostTargets,
  type PublishAttempt,
  type QualityReport,
} from "./publishApi";

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

/**
 * Approve & post: one click approves this exact revision (when needed) and posts it
 * to the chosen accounts. Uncertain outcomes offer "Check status", never a blind retry.
 */
export function PostToInstagram({
  clip,
  disabled = false,
  approve,
  pollMs = 3000,
}: {
  clip: PostableClip;
  disabled?: boolean;
  /** Records the human approval of this exact revision; returns the saved clip. */
  approve: () => Promise<PostableClip | false | undefined>;
  pollMs?: number;
}) {
  const [targets, setTargets] = useState<PostTargets>();
  const [report, setReport] = useState<QualityReport>();
  const [attempts, setAttempts] = useState<PublishAttempt[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [caption, setCaption] = useState("");
  const [override, setOverride] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    setTargets(undefined); setReport(undefined); setAttempts([]); setChosen([]); setError(""); setOverride("");
    publishApi.targets(clip.id).then(t => {
      if (!live.current) return;
      setTargets(t); setAttempts(t.attempts);
      setCaption(t.default_caption || clip.caption || clip.hook || "");
    }).catch(e => live.current && setError(message(e)));
    publishApi.quality(clip.id).then(r => live.current && setReport(r)).catch(e => live.current && setError(message(e)));
    return () => { live.current = false; };
  }, [clip.id, clip.sha256]);

  const running = attempts.some(inFlight);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      void publishApi.targets(clip.id).then(t => live.current && setAttempts(t.attempts)).catch(() => undefined);
    }, pollMs);
    return () => clearInterval(timer);
  }, [running, clip.id, pollMs]);

  const blocked = new Set(attempts.filter(a => a.state !== "failed").map(a => a.account_id));
  const held = report?.verdict === "hold";
  const signInRequired = !!targets && (!targets.cloud_configured || !targets.signed_in);
  const ready = !!targets && !!report && !signInRequired && chosen.length > 0 && caption.trim().length > 0
    && (!held || override.trim().length >= 10) && !busy && !disabled;

  async function submit() {
    if (!ready) return;
    setBusy(true); setError("");
    try {
      let current: PostableClip = clip;
      if (!clip.approved) {
        const saved = await approve();
        if (!saved || !saved.approved) throw new Error("Approval was not recorded; nothing was posted.");
        current = saved;
      }
      if (!current.sha256) throw new Error("This revision has no recorded file hash; it cannot be posted.");
      const made: PublishAttempt[] = [], failures: string[] = [];
      for (const account of chosen) {
        try {
          made.push(await publishApi.post(current.id, {
            account_id: account, caption, sha256: current.sha256,
            ...(held ? { override_reason: override.trim() } : {}),
          }));
        } catch (e) {
          failures.push(`${targets?.accounts.find(a => a.id === account)?.display_name || account}: ${message(e)}`);
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

  return <section className="gf-form-fields gf-post-instagram" aria-label="Post to Instagram">
    <h3>Post to Instagram</h3>
    {signInRequired && <p className="gf-help" role="status"><strong>Sign in required.</strong> Sign in to Growth Factory cloud to host the video for Instagram.</p>}
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
    <Field label="Caption">{id => <AutoTextarea id={id} rows={3} maxLength={2200} value={caption} onChange={e => setCaption(e.target.value)} />}</Field>
    <button className="gf-button full" disabled={!ready} onClick={() => void submit()}>
      {busy ? "Working…" : clip.approved ? "Post to Instagram" : "Approve & post"}
    </button>
    {error && <div className="gf-inline-error" role="alert">{error}</div>}
    {attempts.length > 0 && <ul aria-label="Post attempts">{attempts.map(a => <li key={a.id}>
      <strong>{a.account_name || a.account_id}</strong> · <span>{stateLabel[a.state]}</span>
      {a.permalink && <> · <a href={a.permalink} target="_blank" rel="noreferrer noopener">Open reel</a></>}
      {a.error && <p className="gf-help">{a.error.message}</p>}
      {a.warnings.includes("caption_readback_mismatch") && <p className="gf-help">Instagram shows a different caption; check the post.</p>}
      {(a.state === "unknown" || (a.state === "container_created" && !a.active)) &&
        <button className="gf-button secondary" disabled={busy} onClick={() => void act(a, "reconcile")}>Check status</button>}
      {a.state !== "unknown" && canResume(a) &&
        <button className="gf-button ghost" disabled={busy} onClick={() => void act(a, "resume")}>Continue</button>}
    </li>)}</ul>}
  </section>;
}
