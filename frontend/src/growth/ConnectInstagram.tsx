import { useEffect, useRef, useState } from "react";
import { api, post } from "../api";

/** Self-serve Instagram connection through a Composio Connect Link.
 *
 * The backend opens the sign-in page in the system browser; this component polls
 * until the backend has verified the real Instagram identity and bound it. */

export type ConnectStart = {
  request_id: string;
  redirect_url: string;
  opened: boolean;
};
export type ConnectStatus = {
  request_id: string;
  status: "pending" | "connected" | "failed" | "expired";
  message: string;
  account?: { id: string; display_name: string };
};

const ID = /^[A-Za-z0-9_-]{1,200}$/;
export const PERMISSION_MESSAGE =
  "Your Composio key needs connected-account management permission.";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Instagram connection reply was not understood.");
  return value as Record<string, unknown>;
}

export function parseConnectStart(value: unknown): ConnectStart {
  const v = record(value);
  if (
    typeof v.request_id !== "string" ||
    !ID.test(v.request_id) ||
    typeof v.redirect_url !== "string" ||
    !v.redirect_url.startsWith("https://")
  )
    throw new Error("Instagram connection reply was not understood.");
  return {
    request_id: v.request_id,
    redirect_url: v.redirect_url,
    opened: v.opened === true,
  };
}

export function parseConnectStatus(
  value: unknown,
  requestId: string,
): ConnectStatus {
  const v = record(value);
  const status = v.status;
  if (
    v.request_id !== requestId ||
    (status !== "pending" &&
      status !== "connected" &&
      status !== "failed" &&
      status !== "expired")
  )
    throw new Error("Instagram connection reply was not understood.");
  const result: ConnectStatus = {
    request_id: requestId,
    status,
    message: typeof v.message === "string" ? v.message : "",
  };
  if (status === "connected") {
    const account = record(v.account);
    if (typeof account.id !== "string" || account.id !== requestId)
      throw new Error("Connected account did not match this sign-in.");
    result.account = {
      id: account.id,
      display_name:
        typeof account.display_name === "string" ? account.display_name : "",
    };
  }
  return result;
}

export function isPermissionDenied(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    "status" in error &&
    error.status === 403 &&
    error instanceof Error &&
    error.message.includes("connected-account management")
  );
}

type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; requestId: string; url: string }
  | { kind: "connected"; handle: string }
  | { kind: "error"; message: string }
  | { kind: "no_permission" };

export function ConnectInstagram({
  profileId,
  ready,
  disabled,
  pollMs = 3000,
  onConnected,
  onNeedsDashboard,
}: {
  profileId: string;
  ready: boolean;
  disabled: boolean;
  pollMs?: number;
  onConnected: (accountId: string) => void;
  onNeedsDashboard?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const alive = useRef(true);
  const connected = useRef(onConnected);
  connected.current = onConnected;
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const waitingId = phase.kind === "waiting" ? phase.requestId : "";
  useEffect(() => {
    if (!waitingId) return;
    let stopped = false;
    let timer = 0;
    let misses = 0;
    const poll = async () => {
      try {
        const reply = parseConnectStatus(
          await api<unknown>(
            `/api/automation/connect/${encodeURIComponent(waitingId)}`,
          ),
          waitingId,
        );
        if (stopped || !alive.current) return;
        misses = 0;
        if (reply.status === "connected" && reply.account) {
          setPhase({
            kind: "connected",
            handle: reply.account.display_name || reply.account.id,
          });
          connected.current(reply.account.id);
          return;
        }
        if (reply.status === "failed" || reply.status === "expired") {
          setPhase({
            kind: "error",
            message:
              reply.message ||
              (reply.status === "expired"
                ? "The sign-in link expired. Start again."
                : "Instagram sign-in did not finish. Try again."),
          });
          return;
        }
      } catch (error) {
        if (stopped || !alive.current) return;
        // Brief network or provider hiccups keep waiting; repeated ones stop.
        if (++misses >= 5) {
          setPhase({
            kind: "error",
            message:
              error instanceof Error
                ? error.message
                : "Could not check the Instagram sign-in.",
          });
          return;
        }
      }
      timer = window.setTimeout(() => void poll(), pollMs);
    };
    timer = window.setTimeout(() => void poll(), pollMs);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [waitingId, pollMs]);

  async function start() {
    setPhase({ kind: "starting" });
    try {
      const reply = parseConnectStart(
        await post<unknown>("/api/automation/connect/instagram", {
          profile_id: profileId,
        }),
      );
      if (alive.current)
        setPhase({
          kind: "waiting",
          requestId: reply.request_id,
          url: reply.redirect_url,
        });
    } catch (error) {
      if (!alive.current) return;
      if (isPermissionDenied(error)) {
        setPhase({ kind: "no_permission" });
        onNeedsDashboard?.();
      } else
        setPhase({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not start Instagram sign-in.",
        });
    }
  }

  const busy = phase.kind === "starting" || phase.kind === "waiting";
  return (
    <div className="gf-connect-instagram">
      <button
        className="gf-connect-instagram-button"
        disabled={disabled || busy || !ready || !profileId}
        onClick={() => void start()}
      >
        {phase.kind === "connected"
          ? "Connect another account"
          : "Connect Instagram"}
      </button>
      {phase.kind === "starting" && <p role="status">Opening Instagram…</p>}
      {phase.kind === "waiting" && (
        <p role="status">
          Waiting for Instagram login in your browser…{" "}
          <a href={phase.url} target="_blank" rel="noreferrer noopener">
            Didn't open? Open login page
          </a>{" "}
          <button
            type="button"
            className="gf-link-button"
            onClick={() => setPhase({ kind: "idle" })}
          >
            Cancel
          </button>
        </p>
      )}
      {phase.kind === "connected" && (
        <p role="status">Connected @{phase.handle}</p>
      )}
      {phase.kind === "error" && (
        <p role="alert" className="gf-automation-error">
          {phase.message}
        </p>
      )}
      {phase.kind === "no_permission" && (
        <p role="alert" className="gf-automation-help">
          {PERMISSION_MESSAGE} For now, connect the account in the Composio
          dashboard, then use Import under Advanced.
        </p>
      )}
      {!ready && (
        <p className="gf-automation-help">
          Save your Composio settings under Advanced first.
        </p>
      )}
      <p className="gf-automation-help">
        Needs an Instagram Business or Creator account.
      </p>
    </div>
  );
}
