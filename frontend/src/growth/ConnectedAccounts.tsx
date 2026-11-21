import { useCallback, useEffect, useRef, useState } from "react";
import {
  PLATFORMS,
  platformLabel,
  postingApi,
  type PostingAccount,
} from "./publishApi";
import "./connected-accounts.css";

/**
 * Social accounts connected through Growth Factory cloud, for one brand. Connecting opens the
 * platform's own sign-in in the system browser and polls until the account shows up. Nothing
 * posts until both the app-wide switch and the account's own "Allow posting" are on.
 */

const message = (e: unknown, fallback: string) =>
  e instanceof Error && e.message ? e.message : fallback;
const nameOf = (a: PostingAccount) =>
  a.display_name || (a.username ? `@${a.username.replace(/^@/, "")}` : a.id);

type Phase =
  | { kind: "idle" }
  | { kind: "starting"; platform: string }
  | { kind: "waiting"; platform: string; requestId: string; url: string; opened: boolean };

export function ConnectedAccounts({
  profileId,
  publishing,
  pollMs = 3000,
  onConnected,
}: {
  profileId: string;
  /** The app-wide posting switch; shown only where Settings owns it. */
  publishing?: { enabled: boolean; saving?: boolean; onChange: (enabled: boolean) => void | Promise<void> };
  pollMs?: number;
  onConnected?: (account: PostingAccount) => void;
}) {
  const [accounts, setAccounts] = useState<PostingAccount[]>();
  const [loadError, setLoadError] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [confirming, setConfirming] = useState("");
  const alive = useRef(true);
  const connected = useRef(onConnected);
  connected.current = onConnected;
  // Set on every mount: React may mount, unmount and mount again (StrictMode does), and a
  // flag left false would drop every later answer and leave the list loading forever.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async (refresh: boolean) => {
    try {
      const rows = await postingApi.accounts(refresh);
      if (!alive.current) return;
      // Anything but a list is not an answer; say so instead of loading forever.
      if (!Array.isArray(rows)) throw new Error("Connected accounts are unavailable.");
      setAccounts(rows);
      setLoadError("");
    } catch (e) {
      if (alive.current) setLoadError(message(e, "Connected accounts are unavailable."));
    }
  }, []);
  useEffect(() => { void load(true); }, [load, profileId]);

  const waitingId = phase.kind === "waiting" ? phase.requestId : "";
  useEffect(() => {
    if (!waitingId) return;
    let stopped = false, timer = 0, misses = 0;
    const poll = async () => {
      try {
        const reply = await postingApi.progress(waitingId);
        if (stopped || !alive.current) return;
        misses = 0;
        const label = platformLabel(reply.platform);
        if (reply.status === "connected") {
          setPhase({ kind: "idle" });
          setNotice(reply.account
            ? `Connected ${nameOf(reply.account)} on ${label}. Turn on Allow posting to post to it from the app.`
            : `${label} connected.`);
          await load(false);
          if (reply.account) connected.current?.(reply.account);
          return;
        }
        if (reply.status === "ambiguous") {
          setPhase({ kind: "idle" });
          setNotice(`More than one new ${label} account appeared. Choose yours below with Use for this brand.`);
          await load(false);
          return;
        }
        if (reply.status === "expired") {
          setPhase({ kind: "idle" });
          setError(`The ${label} sign-in expired. Start again.`);
          return;
        }
      } catch (e) {
        if (stopped || !alive.current) return;
        // Brief network hiccups keep waiting; repeated ones stop.
        if (++misses >= 5) {
          setPhase({ kind: "idle" });
          setError(message(e, "Could not check the sign-in."));
          return;
        }
      }
      timer = window.setTimeout(() => void poll(), pollMs);
    };
    timer = window.setTimeout(() => void poll(), pollMs);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [waitingId, pollMs, load]);

  async function connect(platform: string) {
    setPhase({ kind: "starting", platform }); setError(""); setNotice("");
    try {
      const reply = await postingApi.connect(platform, profileId);
      if (alive.current)
        setPhase({ kind: "waiting", platform, requestId: reply.request_id, url: reply.auth_url, opened: reply.opened });
    } catch (e) {
      if (!alive.current) return;
      setPhase({ kind: "idle" });
      setError(message(e, `Could not start ${platformLabel(platform)} sign-in.`));
    }
  }

  async function change(account: PostingAccount, action: () => Promise<unknown>, done: string) {
    setBusy(account.id); setError(""); setNotice("");
    try {
      await action();
      if (!alive.current) return;
      setNotice(done);
      setConfirming("");
      await load(false);
    } catch (e) {
      if (alive.current) setError(message(e, "That change was not saved."));
    } finally {
      if (alive.current) setBusy("");
    }
  }

  // This brand's accounts, plus unlinked ones it can claim. Disconnected rows are history only.
  const rows = (accounts ?? []).filter(a =>
    a.status !== "disconnected" && (a.profile_id === profileId || (a.status === "unbound" && !a.profile_id)));
  const connecting = phase.kind !== "idle";
  const allowedCount = rows.filter(a => a.status === "active" && a.publishing_permitted).length;

  return <div className="gf-connected-accounts">
    {publishing && <label className="gf-connected-master">
      <span>
        <strong>Post from Growth Factory</strong>
        <small>{publishing.enabled
          ? allowedCount ? `On · ${allowedCount} account${allowedCount === 1 ? "" : "s"} allowed` : "On · allow posting on an account below"
          : "Off · nothing is posted, even to allowed accounts"}</small>
      </span>
      <input type="checkbox" role="switch" checked={publishing.enabled} disabled={publishing.saving}
        onChange={e => void publishing.onChange(e.target.checked)} />
    </label>}

    {loadError && <p className="gf-help" role="alert">{loadError}</p>}
    {!accounts && !loadError && <p className="gf-help">Loading connected accounts…</p>}
    {accounts && rows.length === 0 && <p className="gf-help">No accounts connected for this brand yet.</p>}
    {rows.length > 0 && <ul className="gf-connected-list" aria-label="Connected accounts">{rows.map(a => {
      const name = nameOf(a), label = a.platform_label || platformLabel(a.platform);
      const working = busy === a.id;
      return <li key={a.id} className="gf-connected-row">
        <span className="gf-connected-avatar" aria-hidden="true">{name.replace(/^@/, "").slice(0, 1).toUpperCase()}</span>
        <span className="gf-connected-name">
          <strong>{name}</strong>
          <small>{label} · {a.status === "active" ? "Connected" : a.status === "unbound" ? "Not linked to a brand" : "Needs reconnecting"}</small>
        </span>
        <span className="gf-connected-actions">
          {a.status === "active" && <label className="gf-connected-permit">
            <span>Allow posting</span>
            <input type="checkbox" role="switch" aria-label={`Allow posting to ${name} on ${label}`}
              checked={a.publishing_permitted === true} disabled={working}
              onChange={e => { const on = e.target.checked; void change(a, () => postingApi.permit(a.id, on),
                on ? `Posting to ${name} is allowed.` : `Posting to ${name} is off.`); }} />
          </label>}
          {a.status === "unbound" && <button type="button" className="gf-button compact" disabled={working}
            onClick={() => void change(a, () => postingApi.bind(a.id, profileId), `${name} is linked to this brand.`)}>Use for this brand</button>}
          {a.status === "needs_reconnect" && <button type="button" className="gf-button compact" disabled={connecting}
            onClick={() => void connect(a.platform)}>Reconnect</button>}
          {confirming === a.id
            ? <span className="gf-connected-confirm" role="group" aria-label={`Disconnect ${name}?`}>
              <button type="button" className="gf-button secondary compact gf-connected-danger" disabled={working}
                onClick={() => void change(a, () => postingApi.disconnect(a.id), `${name} is disconnected. Its past posts and results are kept.`)}>Disconnect</button>
              <button type="button" className="gf-button ghost compact" disabled={working} onClick={() => setConfirming("")}>Keep</button>
            </span>
            : <button type="button" className="gf-button ghost compact" disabled={working}
              aria-label={`Disconnect ${name} on ${label}`} onClick={() => setConfirming(a.id)}>Disconnect</button>}
        </span>
        {confirming === a.id && <p className="gf-help gf-connected-warning">Posting and result tracking stop for this account. Past posts and results are kept.</p>}
      </li>;
    })}</ul>}

    <div className="gf-connected-connect" role="group" aria-label="Connect an account">
      <span className="gf-connected-connect-label">Connect</span>
      {PLATFORMS.map(p => <button key={p.id} type="button" className="gf-connected-platform" disabled={connecting || !profileId}
        aria-label={`Connect ${p.label}`} onClick={() => void connect(p.id)}>{p.label}</button>)}
    </div>
    {phase.kind === "starting" && <p role="status">Opening {platformLabel(phase.platform)} sign-in…</p>}
    {phase.kind === "waiting" && <p role="status">
      {phase.opened ? `Finish signing in to ${platformLabel(phase.platform)} in your browser…` : `Open the ${platformLabel(phase.platform)} sign-in page to continue.`}{" "}
      <a href={phase.url} target="_blank" rel="noreferrer noopener">{phase.opened ? "Didn't open? Open sign-in page" : "Open sign-in page"}</a>{" "}
      <button type="button" className="gf-link-button" onClick={() => setPhase({ kind: "idle" })}>Cancel</button>
    </p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="gf-inline-error">{error}</p>}
    <p className="gf-help">Accounts connect through Growth Factory cloud, so you need to be signed in. Instagram needs a Business or Creator account.</p>
  </div>;
}
