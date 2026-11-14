import { useEffect, useState, type FormEvent } from "react";
import { cloudApi, type CloudStatus } from "./cloudApi";
import { Field } from "./parts";
import { Icon } from "./Icon";

export type Mode = "sign-in" | "sign-up";
type Phase = "checking" | "form" | "signed-in";

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 72;

function message(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : "Something went wrong. Please retry.";
}

/** Shared account state: email + password go straight to the local backend
 * (which keeps the session in the Keychain); the password is never stored and
 * is cleared after every completed request. */
export function useCloudAccount(initialMode: Mode = "sign-in") {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const trimmed = email.trim();
  const validEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed);
  const validPassword =
    password.length >= MIN_PASSWORD && password.length <= MAX_PASSWORD;

  function switchMode(next: Mode) {
    if (submitting) return;
    setMode(next);
    setError("");
    setNotice("");
  }

  /** Resolves to the signed-in status, or null when the user must act. */
  async function submit(): Promise<CloudStatus | null> {
    if (submitting) return null;
    if (!validEmail) {
      setError("Enter a valid email address.");
      return null;
    }
    if (!validPassword) {
      setError(
        `Use a password between ${MIN_PASSWORD} and ${MAX_PASSWORD} characters.`,
      );
      return null;
    }
    setError("");
    setNotice("");
    setSubmitting(true);
    try {
      const body = { email: trimmed, password };
      const result =
        mode === "sign-up"
          ? await cloudApi.signUp(body)
          : await cloudApi.signIn(body);
      setPassword("");
      if (result.signed_in) return result;
      setNotice(
        result.message ||
          "Check your email to confirm your account, then sign in.",
      );
      setMode("sign-in");
      return null;
    } catch (err) {
      setError(message(err));
      return null;
    } finally {
      setSubmitting(false);
    }
  }

  return {
    mode,
    switchMode,
    email,
    setEmail,
    password,
    setPassword,
    error,
    setError,
    notice,
    submitting,
    validEmail,
    validPassword,
    submit,
  };
}
export type CloudAccount = ReturnType<typeof useCloudAccount>;

/** Tabs, email, password and messages. The caller owns the form and buttons. */
export function CloudAccountFields({
  account,
  disabled = false,
  order = ["sign-in", "sign-up"],
}: {
  account: CloudAccount;
  disabled?: boolean;
  order?: Mode[];
}) {
  const labels: Record<Mode, string> = {
    "sign-in": "Sign in",
    "sign-up": "Create account",
  };
  const off = disabled || account.submitting;
  return (
    <>
      <div className="gf-cloud-tabs" role="tablist" aria-label="Account options">
        {order.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={account.mode === id}
            className={`gf-cloud-tab${account.mode === id ? " is-selected" : ""}`}
            disabled={off}
            onClick={() => account.switchMode(id)}
          >
            {labels[id]}
          </button>
        ))}
      </div>
      <div className="gf-form-fields gf-cloud-fields" role="tabpanel">
        <Field label="Email">
          {(id) => (
            <input
              id={id}
              type="email"
              autoComplete="email"
              maxLength={254}
              required
              placeholder="you@example.com"
              value={account.email}
              disabled={off}
              onChange={(e) => account.setEmail(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Password"
          hint={
            account.mode === "sign-up"
              ? `At least ${MIN_PASSWORD} characters.`
              : undefined
          }
        >
          {(id) => (
            <input
              id={id}
              type="password"
              autoComplete={
                account.mode === "sign-up" ? "new-password" : "current-password"
              }
              minLength={MIN_PASSWORD}
              maxLength={MAX_PASSWORD}
              required
              value={account.password}
              disabled={off}
              onChange={(e) => account.setPassword(e.target.value)}
            />
          )}
        </Field>
      </div>
      {account.notice && (
        <p className="gf-flow-note" role="status">
          <Icon name="info" size={14} />
          {account.notice}
        </p>
      )}
      {account.error && (
        <div className="gf-onboarding-recovery" role="alert">
          <p>{account.error}</p>
        </div>
      )}
    </>
  );
}

/**
 * Optional Growth Factory account, used from Workspace settings. First-run
 * onboarding embeds the same fields as its final step instead.
 * "Continue offline" keeps the app fully local.
 */
export function CloudSignIn({
  onDone,
  onSkip,
  skipLabel = "Continue offline",
}: {
  onDone: (status: CloudStatus) => void;
  onSkip: () => void;
  skipLabel?: string;
}) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const account = useCloudAccount("sign-in");

  useEffect(() => {
    let live = true;
    cloudApi
      .status()
      .then((current) => {
        if (!live) return;
        setStatus(current);
        if (!current.configured) onSkip();
        else if (current.signed_in) {
          setPhase("signed-in");
          onDone(current);
        } else setPhase("form");
      })
      .catch((err: unknown) => {
        if (!live) return;
        account.setError(message(err));
        setPhase("form");
      });
    return () => {
      live = false;
    };
    // Status is checked once per mount; callbacks are not dependencies.
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await account.submit();
    if (!result) return;
    setStatus(result);
    setPhase("signed-in");
    onDone(result);
  }

  return (
    <section
      className="gf-cloud-sign-in"
      aria-label="Growth Factory account"
      aria-busy={phase === "checking" || account.submitting}
    >
      {phase === "checking" && (
        <div className="gf-loading" role="status">
          <span className="gf-spinner" />
          Checking your account…
        </div>
      )}

      {phase === "signed-in" && status?.signed_in && (
        <p className="gf-flow-note" role="status">
          <Icon name="check" size={14} />
          Signed in as {status.email}.
        </p>
      )}

      {phase === "form" && (
        <form className="gf-cloud-form" onSubmit={submit} noValidate>
          <h2>
            {account.mode === "sign-in"
              ? "Sign in to Growth Factory"
              : "Create your Growth Factory account"}
          </h2>
          <p>Your footage stays on this Mac. An account keeps this brand linked to you.</p>
          <CloudAccountFields account={account} />
          <footer className="gf-cloud-actions">
            <button
              type="button"
              className="gf-button ghost compact"
              disabled={account.submitting}
              onClick={onSkip}
            >
              {skipLabel}
            </button>
            <button
              type="submit"
              className="gf-button compact"
              disabled={
                account.submitting ||
                !account.validEmail ||
                !account.validPassword
              }
            >
              {account.submitting
                ? account.mode === "sign-in"
                  ? "Signing in…"
                  : "Creating account…"
                : account.mode === "sign-in"
                  ? "Sign in"
                  : "Create account"}
            </button>
          </footer>
        </form>
      )}
    </section>
  );
}

/** "Signed in as … / Sign out" row for Channel settings. Renders nothing when not configured. */
export function CloudAccountRow({ onSignIn }: { onSignIn?: () => void }) {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    let live = true;
    cloudApi
      .status()
      .then((current) => live && setStatus(current))
      .catch((err: unknown) => live && setError(message(err)));
    return () => {
      live = false;
    };
  }, []);

  if (!status?.configured && !error) return null;

  if (signingIn)
    return (
      <CloudSignIn
        onDone={() => {
          setSigningIn(false);
          void cloudApi
            .status()
            .then(setStatus, (err: unknown) => setError(message(err)));
        }}
        onSkip={() => setSigningIn(false)}
        skipLabel="Cancel"
      />
    );

  async function signOut() {
    setBusy(true);
    setError("");
    try {
      setStatus(await cloudApi.signOut());
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gf-cloud-account-row" aria-label="Growth Factory account">
      {status?.signed_in ? (
        <>
          <span>Signed in as {status.email}</span>
          <button
            type="button"
            className="gf-button ghost compact"
            disabled={busy}
            onClick={() => void signOut()}
          >
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </>
      ) : (
        status?.configured && (
          <>
            <span>Not signed in. Everything stays on this Mac.</span>
            {
              <button
                type="button"
                className="gf-button ghost compact"
                onClick={onSignIn ?? (() => setSigningIn(true))}
              >
                Sign in
              </button>
            }
          </>
        )
      )}
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
