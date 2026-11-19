import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { BeliefLedger, type LedgerBelief } from "./BeliefLedger";
import {
  strategistApi,
  type Portfolio,
  type Simulation,
  type StrategistRun,
  type StrategistView,
} from "./strategistApi";
import { experimentLines } from "./resultsModel";
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

function PortfolioStrip({
  portfolio,
  metric,
}: {
  portfolio: Portfolio | null;
  metric: string | null;
}) {
  if (!portfolio?.slots.length)
    return (
      <p className="gf-strategist-empty">
        Nothing queued yet. The first experiments appear once posts are
        measured.
      </p>
    );
  const lines = experimentLines(portfolio.slots, metric);
  const modes = [
    ...new Map(
      portfolio.slots.map((s) => [
        `${s.mode}|${s.variable}|${s.value}|${s.direction}`,
        s.mode,
      ]),
    ).values(),
  ];
  return (
    <ol className="gf-strategist-queue" aria-label="Next experiment batch">
      {lines.map((line, i) => (
        <li key={i} className={`is-${modes[i]}`}>
          <strong>{modes[i] === "exploit" ? "Keep" : "Test"}</strong>
          <span>{line.replace(/^Test: (.)/, (_, c: string) => c.toUpperCase())}</span>
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
  if (run.status === "completed" && !run.measured_posts)
    return "No real measured posts yet — nothing to learn from. Try the learning loop demo.";
  if (run.status === "completed")
    return `Reviewed ${run.measured_posts} measured post${run.measured_posts === 1 ? "" : "s"}${run.proposals?.length ? ` · ${run.proposals.length} new suggestion${run.proposals.length === 1 ? "" : "s"}` : " · nothing new"}.`;
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
  onView,
  extraWaiting,
  extraWaitingCount = 0,
  learnedExtra,
  onDemo,
}: {
  profileId: string;
  onOpenStyleRules?: () => void;
  /** Reports each fresh real view (never the simulation) to the Results header. */
  onView?: (view: StrategistView) => void;
  /** More items for "Waiting for you" (drafts, rules from measured tests). */
  extraWaiting?: ReactNode;
  extraWaitingCount?: number;
  /** Shown under the lanes, e.g. measured tests and the account's typical numbers. */
  learnedExtra?: ReactNode;
  /** Opens the learning-loop demo (shown when there is no real data to learn from). */
  onDemo?: () => void;
}) {
  const [view, setView] = useState<StrategistView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [simulation, setSimulation] = useState<Simulation | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const reduced = useMemo(prefersReducedMotion, []);
  const alive = useRef(true);
  const panel = useRef<HTMLElement>(null);
  const onViewRef = useRef(onView);
  onViewRef.current = onView;

  const load = useCallback(async () => {
    try {
      const next = await strategistApi.view(profileId);
      if (alive.current) {
        setView(next);
        setError("");
        onViewRef.current?.(next);
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
      panel.current?.scrollIntoView?.({
        behavior: reduced ? "auto" : "smooth",
        block: "start",
      });
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

  const waitingCount =
    (pending?.style_rules.length ?? 0) +
    (pending?.campaign.length ?? 0) +
    extraWaitingCount;
  const baselineValue =
    view?.baseline.metrics && view.target_metric
      ? view.baseline.metrics[view.target_metric]
      : null;

  return (
    <section
      ref={panel}
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
          <span className="gf-results-step">02</span>
          <h2 id="gf-strategist-title">What we've learned</h2>
          <p>
            The Strategist compares each measured post with your typical{" "}
            {(view?.target_metric ?? "result").replace(/_/g, " ")}
            {baselineValue != null && view
              ? ` (${baselineValue.toLocaleString()} across ${view.baseline.posts} posts)`
              : ""}
            . Every change it suggests waits for you.
          </p>
        </div>
        <div className="gf-strategist-actions">
          <button
            type="button"
            onClick={() => void run()}
            disabled={busy || active || !!simulation}
          >
            {busy || active ? "Strategist running…" : "Run strategist"}
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
          {latest?.status === "completed" && !latest.measured_posts && onDemo && (
            <>
              {" "}
              <button type="button" className="gf-strategist-link" onClick={onDemo}>
                Run the learning loop
              </button>
            </>
          )}
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
            Simulated post {current.step} of {simulation.steps.length}:{" "}
            {current.post.views.toLocaleString()} views vs typical{" "}
            {current.baseline_views?.toLocaleString() ?? "unknown"}
            {current.layers_run.length
              ? ` · reviewed ${current.layers_run.join(", ").replace("campaign", "posting plan")}`
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
      {!simulation && learnedExtra}
      <p className="gf-strategist-footnote">
        Observational, not proof. Guides the next test.
      </p>
      <section className="gf-strategist-section" aria-labelledby="gf-next-experiment">
        <span className="gf-results-step">03</span>
        <h3 id="gf-next-experiment">Next experiment</h3>
        <p className="gf-strategist-note">
          Mostly proven patterns; about 1 in 4 explores.
        </p>
        <PortfolioStrip
          portfolio={portfolio}
          metric={view?.target_metric ?? null}
        />
      </section>
      {!simulation && (
        <section className="gf-strategist-section" aria-labelledby="gf-waiting-for-you">
          <span className="gf-results-step">04</span>
          <h3 id="gf-waiting-for-you">
            Waiting for you{waitingCount ? ` (${waitingCount})` : ""}
          </h3>
          {!waitingCount && (
            <p className="gf-strategist-empty">
              Nothing needs you right now.
            </p>
          )}
          {pending?.style_rules.map((rule) => (
            <article key={rule.id} className="gf-strategist-proposal">
              <span>
                New {rule.layer === "selection" ? "clip-picking" : "editing"}{" "}
                rule · Style rules version {rule.version}
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
              <summary>Review a posting-time suggestion</summary>
              <p>{proposal.summary}</p>
              <small>{proposal.caveat}</small>
              <div className="gf-strategist-actions">
                <button
                  type="button"
                  onClick={() => void decide(proposal.id, true)}
                >
                  Approve
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
          {extraWaiting}
        </section>
      )}
      <p className="gf-strategist-caveat">
        {simulation?.caveat ?? view?.caveat}
      </p>
    </section>
  );
}
