import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { ArrowRight, Check } from "lucide-react";

export type LaunchPhase = "profile" | "workspace" | "opening" | "ready";
export const LAUNCH_SWEEP_MS = 1500;
export const LAUNCH_FADE_MS = 280;
export const LAUNCH_FALLBACK_PADDING_MS = 80;
const messages: Record<LaunchPhase, string> = {
  profile: "Saving your audience and creative voice…",
  workspace: "Your profile is saved. Creating your workspace…",
  opening: "Your workspace is saved. Opening Factory…",
  ready: "Your choices are saved. Let’s make something worth watching.",
};
const progress: Record<LaunchPhase, string> = {
  profile: "8%",
  workspace: "42%",
  opening: "76%",
  ready: "100%",
};

export function LaunchTransition({
  phase,
  name,
  onComplete,
}: {
  phase: LaunchPhase;
  name: string;
  onComplete: () => void;
}) {
  const ready = phase === "ready";
  const [exiting, setExiting] = useState(false);
  const title = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const completed = useRef(false);
  const callback = useRef(onComplete);
  callback.current = onComplete;

  function finish() {
    if (!ready || completed.current) return;
    completed.current = true;
    callback.current();
  }
  function beginExit() {
    if (ready && !completed.current) setExiting(true);
  }
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    if (!ready) {
      setExiting(false);
      return;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      finish();
      return;
    }
    // A bounded fallback also handles hidden windows or missing animation events.
    const timer = window.setTimeout(
      beginExit,
      LAUNCH_SWEEP_MS + LAUNCH_FALLBACK_PADDING_MS,
    );
    return () => window.clearTimeout(timer);
  }, [ready]);
  useEffect(() => {
    if (!ready || !exiting) return;
    const timer = window.setTimeout(
      finish,
      LAUNCH_FADE_MS + LAUNCH_FALLBACK_PADDING_MS,
    );
    return () => window.clearTimeout(timer);
  }, [ready, exiting]);

  return (
    <section
      className="gf-onboarding-launch-screen"
      data-stage={ready ? "ready" : "saving"}
      data-exiting={exiting}
      style={{
        "--launch-sweep-duration": `${LAUNCH_SWEEP_MS}ms`,
        "--launch-fade-duration": `${LAUNCH_FADE_MS}ms`,
      } as CSSProperties}
      role="status"
      aria-labelledby={title}
      onAnimationEnd={(event) => {
        if (event.animationName === "gf-launch-arrive") beginExit();
        if (event.animationName === "gf-launch-depart" && exiting) finish();
      }}
    >
      <p className="gf-launch-name">{name}</p>
      <h1 id={title} className="gf-launch-title" ref={heading} tabIndex={-1}>
        {ready ? "Your workspace is ready" : "Making it yours"}
      </h1>
      <div
        className="gf-launch-track"
        style={{ "--launch-progress": progress[phase] } as CSSProperties}
        aria-hidden="true"
      >
        <span className="gf-launch-fill" />
        <span className="gf-launch-pointer">
          <ArrowRight size={22} />
        </span>
        <span className="gf-launch-check">
          <Check size={16} />
        </span>
      </div>
      <p className="gf-launch-description">{messages[phase]}</p>
    </section>
  );
}
