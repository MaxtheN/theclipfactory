import { useState } from "react";
import { Check } from "lucide-react";
import { post } from "../api";
import type { EngineStatus } from "../types";
import type { FactoryState } from "../useFactory";
import { Icon } from "./Icon";
import "./speech-setup.css";
import { platformWords } from "../platform";

/** Speech readiness as the local service reports it (the factory line is polled; system is not). */
export function engineOf(factory: FactoryState): EngineStatus | undefined {
  return factory.data.factory?.engine ?? factory.data.system?.engine ?? undefined;
}

/** True when footage with sound cannot be produced until speech is set up or repaired. */
export function speechBlocked(engine?: EngineStatus | null): boolean {
  return !!engine && !engine.ready && !!engine.blocker;
}

/**
 * Set up (or repair) speech recognition: one job that installs the runtime packages when needed
 * and downloads Whisper, with real progress from the local worker.
 *
 * - "inline": the actionable blocker shown where clips are found.
 * - "engine": the calm first-run "Setting up your engine" card with the one-time steps.
 */
export function SpeechSetup({
  factory,
  variant = "inline",
}: {
  factory: FactoryState;
  variant?: "inline" | "engine";
}) {
  const engine = engineOf(factory);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  if (!engine || !speechBlocked(engine) || !engine.blocker) return null;
  const blocker = engine.blocker;
  const job = engine.job;
  const damaged = blocker.code === "asr_damaged";
  const actionable = blocker.action === "speech_setup";
  const steps = engine.steps.length ? engine.steps : blocker.steps ?? [];
  const total = steps.reduce((sum, step) => sum + step.approx_gb, 0);
  const progress =
    job && typeof job.progress === "number" && Number.isFinite(job.progress)
      ? Math.max(0, Math.min(100, job.progress))
      : undefined;
  const failure = error || (!job ? engine.last_error : null);

  async function start() {
    setStarting(true);
    setError("");
    try {
      await post("/api/speech/setup", { accept_license: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Speech setup could not start.");
    } finally {
      setStarting(false);
      void factory.refresh(["factory", "jobs", "models", "system"]);
    }
  }

  const label = damaged ? "Repair speech model" : "Set up speech recognition";
  const button = actionable && !job && (
    <button
      type="button"
      className="gf-button primary compact"
      disabled={starting}
      onClick={() => void start()}
    >
      {starting ? "Starting…" : failure ? `Retry: ${label.toLowerCase()}` : label}
      {!starting && <Icon name="arrow" size={14} />}
    </button>
  );
  const status = job && (
    <div className="gf-speech-progress" role="status">
      <span>
        {job.step_index && job.step_count
          ? `Step ${job.step_index} of ${job.step_count} · `
          : ""}
        {job.status === "queued" ? "Waiting for the local worker" : job.message || "Working"}
      </span>
      <progress
        aria-label="Speech setup progress"
        max={100}
        value={progress}
      />
    </div>
  );

  if (variant === "inline")
    return (
      <div
        className="gf-speech-blocker"
        data-code={blocker.code}
        role="group"
        aria-label="Speech recognition"
      >
        <p>{blocker.message}</p>
        {failure && (
          <p className="gf-speech-error" role="alert">
            Setup stopped: {failure}
          </p>
        )}
        {status || button}
      </div>
    );

  const current = job?.step ?? null;
  const reached = job?.step_index ?? 0;
  return (
    <section
      className="gf-engine-setup"
      aria-labelledby="engine-setup-heading"
      data-code={blocker.code}
    >
      <header>
        <span className="gf-engine-symbol" aria-hidden="true">
          <Icon name={damaged ? "info" : "headphones"} size={20} />
        </span>
        <div>
          <h2 id="engine-setup-heading">
            {damaged ? "Your engine needs a repair" : "Setting up your engine"}
          </h2>
          <p>
            {damaged
              ? blocker.message
              : `So the factory can hear your episodes, ${platformWords().computer} needs a one-time download${
                  total ? ` (about ${total.toFixed(1)} GB)` : ""
                }. Everything runs locally.`}
          </p>
        </div>
      </header>
      {!!steps.length && (
        <ol className="gf-engine-steps">
          {steps.map((step, index) => {
            const done = !!job && index + 1 < reached;
            const active = !!job && step.id === current;
            return (
              <li
                key={step.id}
                className={done ? "is-complete" : active ? "is-current" : ""}
                aria-current={active ? "step" : undefined}
              >
                <span className="gf-engine-marker" aria-hidden="true">
                  {done ? <Check size={12} /> : index + 1}
                </span>
                <span>
                  {step.label}
                  {step.state === "damaged" ? " (repair)" : ""}
                </span>
                <small>about {step.approx_gb.toFixed(1)} GB</small>
              </li>
            );
          })}
        </ol>
      )}
      {failure && (
        <p className="gf-speech-error" role="alert">
          Setup stopped: {failure}
        </p>
      )}
      {status}
      {!actionable && <p>{blocker.message}</p>}
      {button && (
        <div className="gf-engine-actions">
          {button}
          <small>Whisper is MIT-licensed; starting accepts its license.</small>
        </div>
      )}
    </section>
  );
}

/** The chip shown on clips cut while their speech was never transcribed. */
export function SpeechlessChip() {
  return (
    <span
      className="gf-pill gf-status-speechless"
      title="Made while speech recognition was unavailable: no captions, and hooks only describe the picture. Ranked below the bar."
    >
      Made without speech
    </span>
  );
}
