import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { BrandMark } from "./BrandMark";

const SEEN_KEY = "gf-intro-seen";
const TAGLINE = "Your autonomous growth engine for podcasts and brands.";

export function introSeen() {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}
function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* preference only */
  }
}
const reducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** First-run welcome: a typed tagline over soft frost, one button, always skippable. */
export function OnboardingIntro({ onStart }: { onStart: () => void }) {
  const [typed, setTyped] = useState(() =>
    reducedMotion() ? TAGLINE.length : 0,
  );
  const start = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    start.current?.focus();
    if (typed >= TAGLINE.length) return;
    const timer = window.setInterval(
      () =>
        setTyped((n) => {
          if (n + 1 >= TAGLINE.length) window.clearInterval(timer);
          return n + 1;
        }),
      28,
    );
    return () => window.clearInterval(timer);
    // Typing runs once per mount.
  }, []);
  function go() {
    markSeen();
    onStart();
  }
  const done = typed >= TAGLINE.length;
  return (
    <section
      className="gf-intro"
      aria-labelledby="gf-intro-title"
      onKeyDown={(e) => {
        if (e.key === "Escape") go();
      }}
    >
      <div className="gf-intro-aurora" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="gf-intro-body">
        <span className="gf-intro-mark">
          <BrandMark />
        </span>
        <h1 id="gf-intro-title">Welcome to Growth Factory</h1>
        <p className="gf-intro-tagline" aria-label={TAGLINE}>
          <span aria-hidden="true">{TAGLINE.slice(0, typed)}</span>
          <span className={`gf-intro-caret${done ? " is-done" : ""}`} aria-hidden="true" />
        </p>
        <button
          ref={start}
          type="button"
          className="gf-button gf-intro-start"
          onClick={go}
        >
          Get started
          <ArrowRight size={17} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <button type="button" className="gf-intro-skip" onClick={go}>
          Skip intro
        </button>
      </div>
    </section>
  );
}
