import { useEffect, useState, type FormEvent } from "react";
import { cloudApi, type CloudStatus } from "./cloudApi";
import { Field } from "./parts";
import { Icon } from "./Icon";
import { BrandMark } from "./BrandMark";

type Mode = "sign-in" | "sign-up";
type Phase = "checking" | "form" | "submitting" | "signed-in" | "error";

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 72;

function message(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : "Something went wrong. Please retry.";
}

/**
 * Optional Growth Factory account. Shown before first-run onboarding when the
 * cloud is configured and nobody is signed in; "Continue offline" keeps the
 * app fully local.
 */
export function CloudSignIn({
  onDone,
  onSkip,
}: {
  onDone: (status: CloudStatus) => void;
  onSkip: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [status, setStatus] = useState<CloudStatus | null>(null);

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
        setError(message(err));
        setPhase("error");
      });
    return () => {
      live = false;
    };
    // Status is checked once per mount; callbacks are not dependencies.
  }, []);

  const trimmed = email.trim();
  const validEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed);
  const validPassword =
    password.length >= MIN_PASSWORD && password.length <= MAX_PASSWORD;
  const submitting = phase === "submitting";

  function switchMode(next: Mode) {
    if (submitting) return;
    setMode(next);
    setError("");
    setNotice("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    if (!validEmail) {
      setError("Enter a valid email address.");
      return;
    }
    if (!validPassword) {
      setError(
        `Use a password between ${MIN_PASSWORD} and ${MAX_PASSWORD} characters.`,
      );
      return;
    }
    setError("");
    setNotice("");
    setPhase("submitting");
    try {
      const body = { email: trimmed, password };
      const result =
        mode === "sign-up"
          ? await cloudApi.signUp(body)
          : await cloudApi.signIn(body);
      setStatus(result);
      if (result.signed_in) {
        setPassword("");
        setPhase("signed-in");
        onDone(result);
        return;
      }
      setPassword("");
      setNotice(
        result.message ||
          "Check your email to confirm your account, then sign in.",
      );
      setMode("sign-in");
      setPhase("form");
    } catch (err) {
      setError(message(err));
      setPhase("error");
    }
  }

  const tabs: { id: Mode; label: string }[] = [
    { id: "sign-in", label: "Sign in" },
    { id: "sign-up", label: "Create account" },
  ];

  return (
    <section
      className="gf-onboarding gf-onboarding-wizard gf-cloud-sign-in"
      aria-label="Growth Factory account"
      aria-busy={phase === "checking" || submitting}
    >
      <header className="gf-onboarding-header">
        <div className="gf-onboarding-brand">
          <BrandMark />
          <span>
            Growth
            <br />
            Factory.
          </span>
        </div>
      </header>

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

      {(phase === "form" || phase === "submitting" || phase === "error") && (
        <form className="gf-onboarding-form" onSubmit={submit} noValidate>
          <div className="gf-onboarding-scroll">
            <div className="gf-onboarding-step">
              <h1>
                {mode === "sign-in"
                  ? "Sign in to Growth Factory"
                  : "Create your Growth Factory account"}
              </h1>
              <p className="gf-onboarding-step-description">
                Your footage and workspace stay on this Mac. An account links
                this Mac to your Growth Factory workspace.
              </p>
              <div
                className="gf-cloud-tabs"
                role="tablist"
                aria-label="Account options"
              >
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={mode === tab.id}
                    className={`gf-button ${mode === tab.id ? "secondary" : "ghost"} compact`}
                    disabled={submitting}
                    onClick={() => switchMode(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <div className="gf-form-fields" role="tabpanel">
                <Field label="Email">
                  {(id) => (
                    <input
                      id={id}
                      type="email"
                      autoComplete="email"
                      maxLength={254}
                      required
                      value={email}
                      disabled={submitting}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  )}
                </Field>
                <Field
                  label="Password"
                  hint={
                    mode === "sign-up"
                      ? `At least ${MIN_PASSWORD} characters.`
                      : undefined
                  }
                >
                  {(id) => (
                    <input
                      id={id}
                      type="password"
                      autoComplete={
                        mode === "sign-up" ? "new-password" : "current-password"
                      }
                      minLength={MIN_PASSWORD}
                      maxLength={MAX_PASSWORD}
                      required
                      value={password}
                      disabled={submitting}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  )}
                </Field>
              </div>
            </div>
            {notice && (
              <p className="gf-flow-note" role="status">
                <Icon name="info" size={14} />
                {notice}
              </p>
            )}
            {error && (
              <div className="gf-onboarding-recovery" role="alert">
                <p>{error}</p>
              </div>
            )}
          </div>
          <footer className="gf-onboarding-actions">
            <button
              type="button"
              className="gf-button ghost"
              disabled={submitting}
              onClick={onSkip}
            >
              Continue offline
            </button>
            <button
              type="submit"
              className="gf-button gf-onboarding-cta"
              data-error={!!error}
              disabled={submitting || !validEmail || !validPassword}
            >
              <span className="gf-onboarding-cta-label">
                {submitting
                  ? mode === "sign-in"
                    ? "Signing in…"
                    : "Creating account…"
                  : mode === "sign-in"
                    ? "Sign in"
                    : "Create account"}
              </span>
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
            {onSignIn && (
              <button
                type="button"
                className="gf-button ghost compact"
                onClick={onSignIn}
              >
                Sign in
              </button>
            )}
          </>
        )
      )}
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
