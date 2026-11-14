import { useCallback, useEffect, useRef, useState } from "react";
import { api, post } from "../api";
import { FactoryStage } from "./FactoryMap";
import { STATIONS, type Station, type StationId } from "./flowEvents";
import "./learning-loop-demo.css";

type DemoClip = {
  clip_id: string;
  hook: string;
  score: number | null;
  seconds: number;
  media_url: string;
  cover_url: string;
  outcome: "win" | "steady" | "loss";
  simulated: { metrics: { views: number; completion_rate: number } };
};
type Belief = {
  id: string;
  headline: string;
  confidence: number;
  status: string;
  counts: { matching: number; beats: number };
  evidence: { clip_id: string; value: number; baseline: number; outcome: string }[];
};
export type LearningDemoPlan = {
  profile_id: string;
  baseline: { metrics: { views: number; completion_rate: number } };
  clips: DemoClip[];
  clip_count: number;
  source_minutes: number | null;
  beliefs: Belief[];
  recut: { clip_id: string; target_main_seconds: number; before_seconds: number; rule: string };
  engine: string;
  honesty: string;
};
type LoopStatus = {
  id: string;
  number?: number;
  status: string;
  slot_status?: string;
  error?: string | null;
  progress?: number | null;
  output: null | { clip_id: string; seconds: number; approved: boolean; media_url: string };
};

type Card = "picks" | "posted" | "race" | "beliefs" | "recut";
type Beat = { caption: string; ms: number; active: StationId[]; flow: string[]; card?: Card };
const BEATS: Beat[] = [
  { caption: "Footage in", ms: 2500, active: ["footage"], flow: [] },
  { caption: "Listening and watching", ms: 3500, active: ["listen", "watch"], flow: ["footage>listen", "listen>watch"] },
  { caption: "Scout swarm finds moments", ms: 3500, active: ["scout"], flow: ["watch>scout"] },
  { caption: "Editor cuts every clip", ms: 3500, active: ["brief", "editor"], flow: ["scout>brief", "brief>editor"] },
  { caption: "Critic picks the best three", ms: 6000, active: ["critic"], flow: ["editor>critic"], card: "picks" },
  { caption: "Posted to Instagram", ms: 5000, active: ["approve", "post"], flow: ["critic>approve", "approve>post"], card: "posted" },
  { caption: "Three days later", ms: 8000, active: ["measure"], flow: ["post>measure"], card: "race" },
  { caption: "The Strategist learns", ms: 8500, active: ["strategist"], flow: ["measure>strategist"], card: "beliefs" },
  { caption: "New rule → next batch", ms: 4000, active: ["rules"], flow: ["strategist>rules", "return"] },
  { caption: "Editor re-cuts with it", ms: 0, active: ["editor"], flow: ["demo:strategist>editor", "return"], card: "recut" },
];
const RULES_BEAT = 8;

/** Scripted station states for one beat: earlier stations done, current ones working, one live number each. */
function stageStations(plan: LearningDemoPlan | null, step: number, loop: LoopStatus | null): Station[] {
  const touched = new Set(BEATS.slice(0, Math.max(0, step)).flatMap((b) => b.active));
  const now = new Set(step >= 0 ? BEATS[step].active : []);
  const win = plan?.clips.find((c) => c.outcome === "win");
  const lift = plan && win ? Math.round((win.simulated.metrics.completion_rate / plan.baseline.metrics.completion_rate - 1) * 100) : 0;
  const count = plan?.clip_count ?? 0;
  const numbers: Partial<Record<StationId, [string, string]>> = {
    footage: [plan?.source_minutes ? `${plan.source_minutes} min` : "1", "episode"],
    listen: ["✓", "transcript"],
    watch: ["✓", "scenes"],
    scout: [String(count), "ideas"],
    brief: ["✓", "on brief"],
    editor: step === BEATS.length - 1 ? (loop?.output ? ["1", "re-cut"] : ["…", "re-cutting"]) : [String(count), "clips"],
    critic: ["3", "top picks"],
    approve: ["3", "picked"],
    post: ["3", "posted"],
    measure: [`+${lift}%`, "retention"],
    strategist: [String(plan?.beliefs.length ?? 0), "learned"],
    rules: ["1", "proposal"],
  };
  return STATIONS.filter((s) => s.id !== "builder").map((s) => {
    const active = now.has(s.id) && !(s.id === "editor" && step === BEATS.length - 1 && loop?.output);
    const done = !active && (touched.has(s.id) || now.has(s.id));
    const number = numbers[s.id];
    return {
      ...s,
      state: active ? "active" : done ? "done" : "idle",
      status: active ? "Working" : done ? "Done" : "",
      counts: (active || done) && number ? [{ value: number[0], label: number[1] }] : [],
      last: "",
      sheet: [],
      lanes: 0,
    };
  });
}

const pct = (value: number) => `${Math.round(value * 100)}%`;
const secs = (value: number) => `${Math.round(value)}s`;
const reducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Animated count-up; instant under reduced motion. */
function CountUp({ to, format, delay = 0 }: { to: number; format: (n: number) => string; delay?: number }) {
  const [value, setValue] = useState(reducedMotion() ? to : 0);
  useEffect(() => {
    if (reducedMotion()) return setValue(to);
    let frame = 0;
    const start = performance.now() + delay;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / 900));
      setValue(to * (1 - Math.pow(1 - t, 3)));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [to, delay]);
  return <>{format(value)}</>;
}

function Info({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="gf-lld-info">
      <button type="button" aria-label="Details" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        ⓘ
      </button>
      {open && <span role="note">{text}</span>}
    </span>
  );
}

/** One entry point for the whole learning-loop story: real clips, simulated results, real learning, real re-edit. */
export function LearningLoopDemo({ profileId, open, onClose }: { profileId: string; open: boolean; onClose: () => void }) {
  const [plan, setPlan] = useState<LearningDemoPlan | null>(null);
  const [error, setError] = useState("");
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const [loop, setLoop] = useState<LoopStatus | null>(null);
  const [loopError, setLoopError] = useState("");
  const alive = useRef(true);

  const startRecut = useCallback(async (next: LearningDemoPlan, fresh = false) => {
    setLoopError("");
    const id = `learning-demo:${next.recut.clip_id}:${next.recut.target_main_seconds}${fresh ? `:${Date.now()}` : ""}`;
    try {
      let status = await post<LoopStatus>(`/api/demo-loop/${encodeURIComponent(profileId)}/learning-loop/recut`, {
        request_id: id,
        clip_id: next.recut.clip_id,
        target_seconds: next.recut.target_main_seconds,
        rule: next.recut.rule,
      });
      for (let i = 0; i < 120 && alive.current; i++) {
        status = await api<LoopStatus>(`/api/demo-loop/loops/${encodeURIComponent(status.id)}`);
        if (!alive.current) return;
        setLoop(status);
        if (status.output || ["held", "no_draft"].includes(status.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!status.output && !fresh) return startRecut(next, true);
      if (!status.output) setLoopError(status.error || "The re-edit could not render.");
    } catch (caught) {
      if (alive.current) setLoopError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [profileId]);

  const begin = useCallback(async () => {
    setPlan(null);
    setError("");
    setLoop(null);
    setStep(0);
    setPaused(false);
    try {
      const next = await post<LearningDemoPlan>(`/api/demo-loop/${encodeURIComponent(profileId)}/learning-loop`);
      if (!alive.current) return;
      setPlan(next);
      void startRecut(next); // a real render starts now, so it is ready by step 5
    } catch (caught) {
      if (alive.current) setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [profileId, startRecut]);

  useEffect(() => {
    alive.current = open;
    if (open) void begin();
    return () => {
      alive.current = false;
    };
  }, [open, begin]);

  useEffect(() => {
    if (!open || !plan || paused || step >= BEATS.length - 1) return;
    const timer = window.setTimeout(() => setStep((s) => s + 1), BEATS[step].ms);
    return () => window.clearTimeout(timer);
  }, [open, plan, paused, step]);

  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") setStep((s) => Math.min(BEATS.length - 1, s + 1));
      if (event.key === "ArrowLeft") setStep((s) => Math.max(0, s - 1));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, onClose]);

  if (!open) return null;
  const beat = BEATS[step];
  const parent = plan?.clips.find((c) => c.clip_id === plan.recut.clip_id);
  const base = plan?.baseline.metrics.completion_rate ?? 0;
  const stations = plan ? stageStations(plan, step, loop) : stageStations(null, -1, null);
  const total = BEATS.reduce((sum, b) => sum + b.ms, 0);
  const elapsed = BEATS.slice(0, step).reduce((sum, b) => sum + b.ms, 0);

  return (
    <section className="gf-lld" role="dialog" aria-label="Learning loop demo">
      <header className="gf-lld-top">
        <span className="gf-lld-pill">Simulated</span>
        <h2 className="gf-lld-caption" key={step} aria-live="polite">
          {error ? "Demo unavailable" : plan ? beat.caption : "Starting the factory…"}
        </h2>
        <span aria-hidden="true" />
      </header>
      <div className="gf-lld-progress" aria-hidden="true">
        <i style={{ width: `${Math.round((100 * (elapsed + (plan ? beat.ms : 0))) / total)}%` }} />
      </div>

      <main className={`gf-lld-stage${beat.card && plan ? " has-card" : ""}`}>
        <FactoryStage
          stations={stations}
          flowing={plan ? beat.flow : []}
          returnLit={!!plan && step >= RULES_BEAT}
          returnLabel={plan && step >= RULES_BEAT ? "New rule → next scouts" : "Rules guide the next scouts"}
          reduced={reducedMotion()}
        />
        {error && <p className="gf-lld-card-overlay gf-lld-label" role="alert">{error}</p>}
        {plan && beat.card && (
          <div className="gf-lld-card-overlay" key={beat.card}>
            {beat.card === "picks" && (
              <div className="gf-lld-row">
                {plan.clips.map((clip, i) => (
                  <figure key={clip.clip_id} className="gf-lld-card" style={{ animationDelay: `${i * 120}ms` }}>
                    <img src={clip.cover_url} alt="" />
                    {clip.score != null && <span className="gf-lld-score">{clip.score}</span>}
                    <figcaption>{clip.hook}</figcaption>
                  </figure>
                ))}
              </div>
            )}
            {beat.card === "posted" && (
              <div className="gf-lld-row">
                {plan.clips.map((clip, i) => (
                  <figure key={clip.clip_id} className="gf-lld-phone" style={{ animationDelay: `${i * 160}ms` }}>
                    <img src={clip.cover_url} alt="" />
                    <span className="gf-lld-posted" style={{ animationDelay: `${400 + i * 160}ms` }}>✓ Posted</span>
                  </figure>
                ))}
              </div>
            )}
            {beat.card === "race" && (
              <div className="gf-lld-race" aria-label="Viewers who watched to the end">
                <span className="gf-lld-label">Watched to the end · 3 days</span>
                {plan.clips.map((clip, i) => {
                  const rate = clip.simulated.metrics.completion_rate;
                  return (
                    <div key={clip.clip_id} className={`gf-lld-lane is-${clip.outcome}`}>
                      <img src={clip.cover_url} alt="" />
                      <div className="gf-lld-track">
                        <i className="gf-lld-bar" style={{ width: pct(rate / 0.75), animationDelay: `${i * 150}ms` }} />
                        <b className="gf-lld-base" style={{ left: pct(base / 0.75) }} />
                      </div>
                      <strong>
                        <CountUp to={rate * 100} format={(n) => `${Math.round(n)}%`} delay={i * 150} />
                        {clip.outcome === "win" ? " ▲" : clip.outcome === "loss" ? " ▼" : ""}
                      </strong>
                    </div>
                  );
                })}
                <span className="gf-lld-label">
                  ┆ your typical {pct(base)}
                  <Info text="Deterministic simulated Instagram numbers. Nothing was posted; no synthetic metric is stored." />
                </span>
              </div>
            )}
            {beat.card === "beliefs" && (
              <div className="gf-lld-beliefs">
                {plan.beliefs.map((belief, i) => (
                  <article key={belief.id} style={{ animationDelay: `${i * 200}ms` }}>
                    <h3>{belief.headline}</h3>
                    <div className="gf-lld-confidence">
                      <i style={{ width: pct(belief.confidence), animationDelay: `${300 + i * 200}ms` }} />
                    </div>
                    <span className="gf-lld-label">
                      <CountUp to={belief.confidence * 100} format={(n) => `${Math.round(n)}% sure`} delay={300 + i * 200} />
                      <Info text={`${belief.counts.beats} of ${belief.counts.matching} matching clips beat your typical. ${plan.engine}.`} />
                    </span>
                  </article>
                ))}
              </div>
            )}
            {beat.card === "recut" && (
              <div className="gf-lld-recut">
                <figure>
                  <span className="gf-lld-label">Before</span>
                  {parent && <video src={parent.media_url} poster={parent.cover_url} controls playsInline preload="metadata" />}
                </figure>
                <div className="gf-lld-diff">
                  <span className="gf-lld-chip">
                    {secs(plan.recut.before_seconds)} → {loop?.output ? secs(loop.output.seconds) : "…"}
                  </span>
                  <span className="gf-lld-label">{plan.recut.rule}</span>
                  {loop?.output && <span className="gf-lld-chip is-soft">Loop #2 ready</span>}
                  {loop?.output && (
                    <span className="gf-lld-label">
                      Draft · needs approval
                      <Info text="A real, unapproved MP4 changing one variable (length). Nothing posts. The next batch adopts the rule only after you approve it in Style rules." />
                    </span>
                  )}
                </div>
                <figure>
                  <span className="gf-lld-label">After · new render</span>
                  {loop?.output ? (
                    <video src={loop.output.media_url} controls autoPlay muted playsInline preload="auto" />
                  ) : loopError ? (
                    <div className="gf-lld-wait" role="alert">{loopError}</div>
                  ) : (
                    <div className="gf-lld-wait" role="status">
                      <span className="gf-lld-spinner" aria-hidden="true" />
                      Rendering{loop?.progress ? ` ${Math.round(loop.progress)}%` : "…"}
                    </div>
                  )}
                </figure>
              </div>
            )}
          </div>
        )}
      </main>

      <footer className="gf-lld-foot">
        {step < BEATS.length - 1 ? (
          <>
            <button type="button" className="gf-lld-next-btn" onClick={() => setPaused((p) => !p)} disabled={!plan}>
              {paused ? "▶ Play" : "❚❚ Pause"}
            </button>
            <button type="button" className="gf-lld-next-btn" onClick={() => setStep((s) => s + 1)} disabled={!plan}>
              Next →
            </button>
            <button type="button" className="gf-lld-next-btn is-quiet" onClick={() => setStep(BEATS.length - 1)} disabled={!plan}>
              Skip to re-edit
            </button>
          </>
        ) : (
          <button type="button" className="gf-lld-next-btn" onClick={() => void begin()}>
            ↺ Replay
          </button>
        )}
        <span className="gf-lld-foot-sep" aria-hidden="true" />
        <button type="button" className="gf-lld-next-btn is-quiet" onClick={onClose} aria-label="Close demo">
          Close<kbd>Esc</kbd>
        </button>
      </footer>
    </section>
  );
}

/** The single demo entry point used on Factory and Results. */
export function DemoLoopButton({ onClick, compact = false }: { onClick: () => void; compact?: boolean }) {
  return (
    <button type="button" className={`gf-lld-launch${compact ? " is-compact" : ""}`} onClick={onClick}>
      <span aria-hidden="true">▶</span> Run the learning loop
      <small>Simulated results · real agents · real re-edit</small>
    </button>
  );
}
