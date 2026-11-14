import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BeliefLedger, type LedgerBelief } from "./BeliefLedger";
import {
  strategistApi,
  type Portfolio,
  type Simulation,
  type StrategistRun,
  type StrategistView,
} from "./strategistApi";
import "./strategist.css";

const STEP_MS = 1100;

export function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

function PortfolioStrip({ portfolio }: { portfolio: Portfolio | null }) {
  if (!portfolio?.slots.length)
    return (
      <p className="gf-strategist-empty">
        No experiment queue yet: beliefs need measured posts first.
      </p>
    );
  return (
    <ol className="gf-strategist-queue" aria-label="Next experiment batch">
      {portfolio.slots.map((slot) => (
        <li
          key={slot.slot}
          className={`is-${slot.mode}`}
          title={slot.rationale}
        >
          <strong>{slot.mode === "exploit" ? "Apply" : "Explore"}</strong>
          <span>
            {slot.direction === "decrease" && slot.mode === "exploit"
              ? "avoid "
              : ""}
            {slot.variable.replace(/_/g, " ")}: {slot.value.replace(/_/g, " ")}
          </span>
        </li>
      ))}
    </ol>
  );
}

function runLabel(run: StrategistRun | undefined): string | null {
  if (!run) return null;
  if (run.status === "queued") return "Waiting for the local worker…";
  if (run.status === "running") return `${run.message} (${run.progress}%)`;
  if (run.status === "failed") return `Last run failed: ${run.message}`;
  return null;
}

function modelNote(run: StrategistRun | undefined): string | null {
  const model = run?.model;
  if (!model) return null;
  if (model.status === "held")
    return `Model held: insufficient memory. ${model.reasons?.[0] ?? ""} Scoring and the queue still updated.`;
  if (model.status === "abstained")
    return "The local model abstained: its suggestions failed validation, so nothing was invented.";
  if (model.status === "proposed")
    return `The local model named ${model.count ?? 0} new candidate belief${model.count === 1 ? "" : "s"}; code scores them.`;
  if (model.status === "insufficient_evidence")
    return "The local model saw no pattern worth naming yet.";
  return null;
}

export function StrategistPanel({
  profileId,
  onOpenStyleRules,
}: {
  profileId: string;
  onOpenStyleRules?: () => void;
}) {
  const [view, setView] = useState<StrategistView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [simulation, setSimulation] = useState<Simulation | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const reduced = useMemo(prefersReducedMotion, []);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await strategistApi.view(profileId);
      if (alive.current) {
        setView(next);
        setError("");
      }
      return next;
    } catch (caught) {
      if (alive.current)
        setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    }
  }, [profileId]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const latest = view?.runs[0];
  const active = latest?.status === "queued" || latest?.status === "running";
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void load(), 1000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  useEffect(() => {
    if (!simulation || !playing) return;
    if (step >= simulation.steps.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setStep((s) => s + 1), STEP_MS);
    return () => window.clearTimeout(timer);
  }, [simulation, playing, step]);

  async function run() {
    setBusy(true);
    setError("");
    try {
      await strategistApi.run(profileId);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function retire(id: string) {
    try {
      await strategistApi.retire(id, "Retired from the strategist view.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function decide(id: string, approve: boolean) {
    try {
      await strategistApi.decide(id, approve);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function toggleSimulation() {
    if (simulation) {
      setSimulation(null);
      setPlaying(false);
      return;
    }
    setBusy(true);
    try {
      const result = await strategistApi.simulate(profileId);
      setSimulation(result);
      setStep(reduced ? result.steps.length - 1 : 0);
      setPlaying(!reduced);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const current = simulation?.steps[step];
  const beliefs: LedgerBelief[] = current
    ? current.beliefs
    : (view?.beliefs ?? []).map((b) => ({
        ...b,
        matching: b.counts.matching,
      }));
  const portfolio = current ? current.portfolio : (view?.portfolio ?? null);
  const progress = runLabel(latest);
  const note = simulation ? null : modelNote(latest);
  const pending = view?.pending_proposals;

  return (
    <section
      className={`gf-strategist${simulation ? " is-simulated" : ""}${reduced ? " is-reduced" : ""}`}
      aria-labelledby="gf-strategist-title"
    >
      {simulation && (
        <div className="gf-strategist-banner" role="status">
          {simulation.banner}
        </div>
      )}
      <header className="gf-strategist-head">
        <div>
          <h2 id="gf-strategist-title">Strategist</h2>
          <p>
            Learns from this account's own measured posts, compared with its
            median {view?.target_metric ?? "metric"}
            {view?.baseline.metrics && view.target_metric
              ? ` (${view.baseline.metrics[view.target_metric] ?? "unknown"} over ${view.baseline.posts} posts)`
              : ""}
            . Every change is a proposal you approve.
          </p>
        </div>
        <div className="gf-strategist-actions">
          <button
            type="button"
            onClick={() => void run()}
            disabled={busy || active || !!simulation}
          >
            {active ? "Strategist running…" : "Run strategist"}
          </button>
          <button
            type="button"
            aria-pressed={!!simulation}
            onClick={() => void toggleSimulation()}
            disabled={busy && !simulation}
          >
            {simulation ? "Back to real data" : "Play simulation"}
          </button>
        </div>
      </header>
      {error && (
        <p className="gf-strategist-error" role="alert">
          {error}
        </p>
      )}
      {!simulation && progress && (
        <p className="gf-strategist-progress" role="status">
          {progress}
        </p>
      )}
      {note && (
        <p
          className={`gf-strategist-model is-${latest?.model.status}`}
          role="status"
        >
          {note}
        </p>
      )}
      {simulation && current && (
        <div className="gf-strategist-sim-controls">
          <span>
            Synthetic post {current.step} of {simulation.steps.length}:{" "}
            {current.post.views.toLocaleString()} views vs median{" "}
            {current.baseline_views?.toLocaleString() ?? "unknown"}
            {current.layers_run.length
              ? ` · reviewed ${current.layers_run.join(", ")}`
              : ""}
          </span>
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
          >
            Previous
          </button>
          <button
            type="button"
            onClick={() =>
              setStep((s) => Math.min(simulation.steps.length - 1, s + 1))
            }
            disabled={step >= simulation.steps.length - 1}
          >
            Next
          </button>
          {!reduced && (
            <button type="button" onClick={() => setPlaying((p) => !p)}>
              {playing ? "Pause" : "Play"}
            </button>
          )}
        </div>
      )}
      <BeliefLedger
        beliefs={beliefs}
        onRetire={simulation ? undefined : (id) => void retire(id)}
      />
      <section className="gf-strategist-section">
        <h3>Next batch</h3>
        <p className="gf-strategist-note">
          About three in four slots apply supported beliefs; one tests the most
          uncertain, most important one.
        </p>
        <PortfolioStrip portfolio={portfolio} />
      </section>
      {!simulation && (
        <section className="gf-strategist-section">
          <h3>Waiting for your review</h3>
          {!pending?.style_rules.length && !pending?.campaign.length && (
            <p className="gf-strategist-empty">No pending proposals.</p>
          )}
          {pending?.style_rules.map((rule) => (
            <article key={rule.id} className="gf-strategist-proposal">
              <span>
                {rule.layer === "selection" ? "Selection" : "Craft"} change ·
                Style rules version {rule.version}
              </span>
              <button
                type="button"
                className="gf-strategist-link"
                onClick={onOpenStyleRules}
                disabled={!onOpenStyleRules}
              >
                Review in Style rules
              </button>
            </article>
          ))}
          {pending?.campaign.map((proposal) => (
            <details key={proposal.id} className="gf-strategist-proposal">
              <summary>Review posting-plan proposal</summary>
              <p>{proposal.summary}</p>
              <small>{proposal.caveat}</small>
              <div className="gf-strategist-actions">
                <button
                  type="button"
                  onClick={() => void decide(proposal.id, true)}
                >
                  Approve plan
                </button>
                <button
                  type="button"
                  onClick={() => void decide(proposal.id, false)}
                >
                  Reject
                </button>
              </div>
            </details>
          ))}
        </section>
      )}
      <p className="gf-strategist-caveat">
        {simulation?.caveat ?? view?.caveat}
      </p>
    </section>
  );
}
