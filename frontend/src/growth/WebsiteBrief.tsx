import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ArrowRight, Check, Globe, Quote, Sparkles, X } from "lucide-react";
import { AutoTextarea } from "../components/AutoTextarea";
import {
  GOALS,
  briefFromDraft,
  editableFrom,
  statusLine,
  websiteBriefApi,
  type BrandDraft,
  type EditableBrief,
  type Research,
  type WebsiteBriefApi,
  type WebsiteBriefResult,
} from "./websiteBriefApi";
import { AiModelHint } from "./AiModelCard";
import "./website-brief.css";

type Phase = "input" | "reading" | "review" | "error";

const STEPS = [
  { id: "open", label: "Open your site", stages: ["opening"] },
  { id: "read", label: "Read your pages", stages: ["reading", "found"] },
  { id: "voice", label: "Find your voice", stages: ["voice"] },
  { id: "draft", label: "Draft your brief", stages: ["drafting"] },
] as const;

const FIELD_LABELS: Record<string, string> = {
  brand_name: "brand name",
  one_liner: "one-liner",
  audience: "audience",
  suggested_goal: "goal",
  voice: "voice",
  key_messages: "key messages",
  topics: "topics",
  must_avoid: "boundaries",
  cta: "call to action",
};

function prefersReducedMotion() {
  try {
    return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query?.addEventListener) return;
    const change = () => setReduced(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return reduced;
}

function hostOf(value: string) {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return value.trim();
  }
}

function pathLabel(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

export function WebsiteBrief({
  onApply,
  onSkip,
  client = websiteBriefApi,
  pollMs = 700,
  initialUrl = "",
  disabled = false,
}: {
  /** Fill onboarding and the first campaign brief from the creator-edited draft. Nothing is saved here. */
  onApply: (result: WebsiteBriefResult) => void;
  /** Continue with the manual onboarding steps. */
  onSkip: () => void;
  client?: WebsiteBriefApi;
  pollMs?: number;
  initialUrl?: string;
  disabled?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("input");
  const [url, setUrl] = useState(initialUrl);
  const [inputError, setInputError] = useState("");
  const [research, setResearch] = useState<Research | null>(null);
  const [draft, setDraft] = useState<BrandDraft | null>(null);
  const [edited, setEdited] = useState<EditableBrief | null>(null);
  const [error, setError] = useState("");
  const [applyError, setApplyError] = useState("");
  const [openEvidence, setOpenEvidence] = useState<string | null>(null);
  const reduced = useReducedMotion();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const timer = useRef<number>();
  const current = useRef<string>();
  const failures = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
      const running = current.current;
      current.current = undefined;
      if (running) void client.cancel(running).catch(() => undefined);
    };
  }, [client]);
  useEffect(() => {
    if (phase !== "input") heading.current?.focus();
  }, [phase]);

  const host = hostOf(research?.url || url);

  function fail(message: string) {
    current.current = undefined;
    window.clearTimeout(timer.current);
    setError(message || "We couldn't read that site.");
    setPhase("error");
  }

  function schedule(identifier: string) {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void poll(identifier), pollMs);
  }

  async function poll(identifier: string) {
    if (!mounted.current || current.current !== identifier) return;
    let next: Research;
    try {
      next = await client.get(identifier);
      failures.current = 0;
    } catch (e) {
      failures.current += 1;
      if (failures.current >= 4)
        return fail(e instanceof Error ? e.message : "Lost contact with the local service.");
      return schedule(identifier);
    }
    if (!mounted.current || current.current !== identifier) return;
    setResearch(next);
    if (next.status === "running") return schedule(identifier);
    current.current = undefined;
    if (next.status === "done" && next.draft) {
      setDraft(next.draft);
      setEdited(editableFrom(next.draft));
      setPhase("review");
    } else if (next.status === "cancelled") {
      setPhase("input");
    } else {
      fail(next.error || "We couldn't read that site.");
    }
  }

  async function begin() {
    if (disabled || phase === "reading") return;
    const value = url.trim();
    if (!value) {
      setInputError("Enter your website address, for example allin.com.");
      return;
    }
    if (/\s/.test(value) || !/\.[a-z]{2,}|^\[|\d+\.\d+/i.test(hostOf(value))) {
      setInputError("That doesn’t look like a website address. Try something like allin.com.");
      return;
    }
    setInputError("");
    setError("");
    setResearch(null);
    setPhase("reading");
    failures.current = 0;
    try {
      const started = await client.start(value);
      if (!mounted.current) return;
      current.current = started.id;
      setResearch(started);
      schedule(started.id);
    } catch (e) {
      if (mounted.current)
        fail(e instanceof Error ? e.message : "We couldn't start reading that site.");
    }
  }

  function stop() {
    const running = current.current;
    current.current = undefined;
    window.clearTimeout(timer.current);
    if (running) void client.cancel(running).catch(() => undefined);
  }

  function skip() {
    stop();
    onSkip();
  }

  function restart() {
    stop();
    setResearch(null);
    setDraft(null);
    setEdited(null);
    setError("");
    setOpenEvidence(null);
    setPhase("input");
  }

  function apply() {
    if (!edited || disabled) return;
    const result = briefFromDraft(edited, draft);
    if (!result.name) {
      setApplyError("Add your brand name to use this brief.");
      return;
    }
    setApplyError("");
    onApply(result);
  }

  const titles: Record<Phase, string> = {
    input: "Drop your website — we’ll draft your brand brief and learn who you are.",
    reading: `Reading ${host}`,
    review: "Here’s your brand, drafted from your site",
    error: "We couldn’t draft it this time",
  };
  const descriptions: Record<Phase, string> = {
    input:
      "We’ll read a few public pages and draft your audience, voice and key messages with the model on this Mac. You edit everything; nothing is saved until you continue.",
    reading:
      "A few public pages, read once, understood on this Mac. This usually takes under a minute.",
    review:
      "Every line is editable. Tap “from your site” to see the words each one came from.",
    error: "Your details are safe. You can type them yourself in a minute.",
  };

  return (
    <section
      className={`gf-onboarding-step gf-website-brief is-${phase}`}
      data-motion={reduced ? "reduced" : "full"}
      aria-labelledby={`${id}-title`}
    >
      {phase === "input" && <WebsiteIllustration />}
      <span className="gf-website-brief-kicker">
        <Sparkles size={14} strokeWidth={1.8} aria-hidden="true" />
        Brand from your website
      </span>
      <h1 id={`${id}-title`} ref={heading} tabIndex={-1}>
        {titles[phase]}
      </h1>
      <p className="gf-onboarding-step-description">{descriptions[phase]}</p>

      {phase === "input" && (
        // Not a <form>: this step renders inside the onboarding wizard's own form.
        <div className="gf-wb-input" role="group" aria-label="Your website">
          <label className="gf-wb-url" htmlFor={`${id}-url`}>
            <span className="gf-command-sr-only">Your website</span>
            <Globe size={18} strokeWidth={1.7} aria-hidden="true" />
            <input
              id={`${id}-url`}
              type="text"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              placeholder="yourshow.com"
              maxLength={2048}
              value={url}
              disabled={disabled}
              aria-invalid={!!inputError || undefined}
              aria-describedby={inputError ? `${id}-url-error` : undefined}
              onChange={(e) => {
                setUrl(e.target.value);
                setInputError("");
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                void begin();
              }}
            />
          </label>
          {inputError && (
            <p className="gf-wb-input-error" id={`${id}-url-error`} role="alert">
              {inputError}
            </p>
          )}
          <div className="gf-wb-actions">
            <button type="button" className="gf-button ghost" disabled={disabled} onClick={skip}>
              Skip, I’ll type it
            </button>
            <button
              type="button"
              className="gf-button gf-onboarding-cta"
              disabled={disabled}
              onClick={() => void begin()}
            >
              <span className="gf-onboarding-cta-label">Read my website</span>
              <ArrowRight size={18} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
          <p className="gf-wb-fineprint">
            Reads up to 6 public pages and respects robots.txt. No scripts run; nothing leaves this Mac
            except the page requests.
          </p>
        </div>
      )}

      {phase === "reading" && (
        <Reading research={research} host={host} reduced={reduced} onCancel={skip} />
      )}

      {phase === "review" && edited && draft && (
        <Review
          draft={draft}
          edited={edited}
          host={host}
          openEvidence={openEvidence}
          setOpenEvidence={setOpenEvidence}
          onChange={(changes) => setEdited((value) => (value ? { ...value, ...changes } : value))}
          error={applyError}
          disabled={disabled}
          onApply={apply}
          onRestart={restart}
          onSkip={skip}
        />
      )}

      {phase === "error" && (
        <div className="gf-wb-error" role="alert">
          <p>{error}</p>
          <AiModelHint kind={research?.error_kind} onRetry={restart} />
          <div className="gf-wb-actions">
            <button type="button" className="gf-button ghost" onClick={restart}>
              Try another address
            </button>
            <button type="button" className="gf-button gf-onboarding-cta" onClick={skip}>
              <span className="gf-onboarding-cta-label">Type it instead</span>
              <ArrowRight size={18} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function Reading({
  research,
  host,
  reduced,
  onCancel,
}: {
  research: Research | null;
  host: string;
  reduced: boolean;
  onCancel: () => void;
}) {
  const events = research?.events ?? [];
  const stage = research?.stage ?? "opening";
  const found = events.find((e) => e.stage === "found");
  const read = events.filter((e) => e.stage === "reading" && e.page);
  const readLabels = read.map((e) => e.page!.label);
  // Chips: Home as soon as it is read, then every found page (pending until its own read event).
  const chips: Array<{ label: string; done: boolean; key: string }> = [];
  if (readLabels.includes("Home")) chips.push({ label: "Home", done: true, key: "home" });
  const pending = [...readLabels.filter((l) => l !== "Home")];
  (found?.labels ?? []).forEach((label, index) => {
    const at = pending.indexOf(label);
    if (at >= 0) pending.splice(at, 1);
    chips.push({ label, done: at >= 0 || stage === "voice" || stage === "drafting", key: `${label}-${index}` });
  });
  const lines = useMemo(() => {
    const out: string[] = [];
    for (const event of events) {
      const line = statusLine(event, host);
      if (out[out.length - 1] !== line) out.push(line);
    }
    if (!out.length) out.push(`Opening ${host}…`);
    if (research?.waiting) out.push("Waiting for other work on this Mac to finish…");
    return out;
  }, [events, host, research?.waiting]);
  const visible = lines.slice(-3);
  const progress = Math.max(4, Math.min(100, research?.progress ?? 4));
  const activeStep = STEPS.findIndex((s) => (s.stages as readonly string[]).includes(stage));
  const latestTitle = [...read].reverse()[0]?.page;

  return (
    <div className="gf-wb-reading" data-stage={stage}>
      <div className="gf-wb-browser" aria-hidden="true">
        <div className="gf-wb-browser-bar">
          <span className="gf-wb-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="gf-wb-address">
            <Globe size={12} strokeWidth={1.8} />
            {latestTitle && latestTitle.label !== "Home" ? pathLabel(latestTitle.url) : host}
          </span>
        </div>
        <div className="gf-wb-browser-body">
          <span className="gf-wb-sk is-hero" />
          <span className="gf-wb-sk is-wide" />
          <span className="gf-wb-sk" />
          <span className="gf-wb-sk is-short" />
          <span className="gf-wb-sk-row">
            <span className="gf-wb-sk is-card" />
            <span className="gf-wb-sk is-card" />
            <span className="gf-wb-sk is-card" />
          </span>
          {!reduced && <span className="gf-wb-scan" data-testid="wb-scan" />}
          {(stage === "voice" || stage === "drafting") && <span className="gf-wb-glow" />}
        </div>
      </div>

      <ul className="gf-wb-chips" aria-label="Pages">
        {chips.map((chip, index) => (
          <li
            key={chip.key}
            className={`gf-wb-chip${chip.done ? " is-done" : ""}`}
            style={{ "--i": index } as CSSProperties}
          >
            {chip.done ? <Check size={12} strokeWidth={2} aria-hidden="true" /> : <span className="gf-wb-chip-dot" aria-hidden="true" />}
            {chip.label}
            <span className="gf-command-sr-only">{chip.done ? " (read)" : " (queued)"}</span>
          </li>
        ))}
      </ul>

      <div className="gf-wb-status" role="status" aria-live="polite" aria-atomic="true">
        {visible.map((line, index) => (
          <p
            key={`${lines.length - visible.length + index}-${line}`}
            className={index === visible.length - 1 ? "is-current" : "is-past"}
            aria-hidden={index === visible.length - 1 ? undefined : true}
          >
            {line}
          </p>
        ))}
      </div>

      <div
        className="gf-wb-progress"
        role="progressbar"
        aria-label="Reading progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <span style={{ width: `${progress}%` }} />
      </div>

      <ol className="gf-wb-steps" aria-label="Steps">
        {STEPS.map((step, index) => (
          <li
            key={step.id}
            className={index < activeStep ? "is-done" : index === activeStep ? "is-current" : ""}
            aria-current={index === activeStep ? "step" : undefined}
          >
            <span className="gf-wb-step-mark" aria-hidden="true">
              {index < activeStep ? <Check size={11} strokeWidth={2.2} /> : null}
            </span>
            {step.label}
          </li>
        ))}
      </ol>

      <div className="gf-wb-actions is-centered">
        <button type="button" className="gf-button ghost compact" onClick={onCancel}>
          Stop and type it instead
        </button>
      </div>
    </div>
  );
}

function Review({
  draft,
  edited,
  host,
  openEvidence,
  setOpenEvidence,
  onChange,
  error,
  disabled,
  onApply,
  onRestart,
  onSkip,
}: {
  draft: BrandDraft;
  edited: EditableBrief;
  host: string;
  openEvidence: string | null;
  setOpenEvidence: (value: string | null) => void;
  onChange: (changes: Partial<EditableBrief>) => void;
  error: string;
  disabled: boolean;
  onApply: () => void;
  onRestart: () => void;
  onSkip: () => void;
}) {
  const goal = GOALS.find((g) => g.objective === edited.objective);
  let order = 0;
  const field = (
    key: string,
    label: string,
    control: (id: string) => ReactNode,
    hint?: string,
  ) => (
    <DraftField
      key={key}
      index={order++}
      field={key}
      label={label}
      hint={hint}
      draft={draft}
      open={openEvidence === key}
      onToggle={() => setOpenEvidence(openEvidence === key ? null : key)}
    >
      {control}
    </DraftField>
  );
  const kit = draft.brand_kit;
  return (
    <div className="gf-wb-review">
      <p className="gf-wb-source">
        <Globe size={13} strokeWidth={1.8} aria-hidden="true" />
        Drafted from {host} · {draft.pages.length} page{draft.pages.length === 1 ? "" : "s"} read ·
        a draft for you to edit
      </p>
      {draft.dropped.length > 0 && (
        <p className="gf-wb-dropped">
          We couldn’t confirm your {draft.dropped.map((f) => FIELD_LABELS[f] || f).join(", ")} from the
          site’s own words, so we left {draft.dropped.length === 1 ? "it" : "them"} for you.
        </p>
      )}
      <div className="gf-wb-fields">
        {field("brand_name", "Brand name", (id) => (
          <input id={id} type="text" maxLength={200} value={edited.brandName} disabled={disabled}
            onChange={(e) => onChange({ brandName: e.target.value })} />
        ))}
        {field("one_liner", "In one line", (id) => (
          <AutoTextarea id={id} rows={1} maxLength={300} value={edited.oneLiner} disabled={disabled}
            onChange={(e) => onChange({ oneLiner: e.target.value })} />
        ))}
        {field("audience", "Who it’s for", (id) => (
          <AutoTextarea id={id} rows={2} maxLength={3000} value={edited.audience} disabled={disabled}
            placeholder="Who watches, and what do they care about?"
            onChange={(e) => onChange({ audience: e.target.value })} />
        ))}
        {field("suggested_goal", "Goal", (id) => (
          <span className="gf-wb-goal">
            <select id={id} value={edited.objective} disabled={disabled}
              onChange={(e) => {
                const next = GOALS.find((g) => g.objective === e.target.value);
                onChange({ objective: e.target.value, metric: next?.metric ?? "" });
              }}>
              {GOALS.map((g) => (
                <option key={g.objective} value={g.objective}>{g.label}</option>
              ))}
            </select>
            {edited.objective !== "discovery" && (
              <input type="text" aria-label="Primary metric" maxLength={200} value={edited.metric}
                disabled={disabled} placeholder={goal?.metric || "metric"}
                onChange={(e) => onChange({ metric: e.target.value })} />
            )}
          </span>
        ))}
        {field("voice", "Voice", (id) => (
          <span className="gf-wb-voice">
            <input id={id} type="text" maxLength={220} value={edited.adjectives} disabled={disabled}
              placeholder="3–5 words, comma separated" aria-describedby={`${id}-voice-hint`}
              onChange={(e) => onChange({ adjectives: e.target.value })} />
            <small id={`${id}-voice-hint`}>3–5 words, comma separated</small>
            <label>
              <span>Do</span>
              <input type="text" maxLength={240} value={edited.voiceDo} disabled={disabled}
                onChange={(e) => onChange({ voiceDo: e.target.value })} />
            </label>
            <label>
              <span>Don’t</span>
              <input type="text" maxLength={240} value={edited.voiceDont} disabled={disabled}
                onChange={(e) => onChange({ voiceDont: e.target.value })} />
            </label>
          </span>
        ))}
        {field("key_messages", "Key messages", (id) => (
          <AutoTextarea id={id} rows={3} value={edited.keyMessages} disabled={disabled}
            onChange={(e) => onChange({ keyMessages: e.target.value })} />
        ), "One per line, up to 5.")}
        {field("topics", "Topics", (id) => (
          <AutoTextarea id={id} rows={2} value={edited.topics} disabled={disabled}
            onChange={(e) => onChange({ topics: e.target.value })} />
        ), "One per line, up to 8.")}
        {field("must_avoid", "Never touch", (id) => (
          <AutoTextarea id={id} rows={2} value={edited.mustAvoid} disabled={disabled}
            placeholder="Topics or claims to stay away from"
            onChange={(e) => onChange({ mustAvoid: e.target.value })} />
        ), "One per line. These become hard limits for every clip.")}
        {field("cta", "Call to action", (id) => (
          <span className="gf-wb-cta">
            <input id={id} type="text" maxLength={80} value={edited.ctaText} disabled={disabled}
              placeholder="e.g. Listen to the full episode"
              onChange={(e) => onChange({ ctaText: e.target.value })} />
            <input type="url" aria-label="Call to action link" maxLength={500} value={edited.ctaLink}
              disabled={disabled} placeholder="https://"
              onChange={(e) => onChange({ ctaLink: e.target.value })} />
          </span>
        ))}
        {(kit.primary_color || kit.accent_color || kit.logo_url) && (
          <div className="gf-wb-field gf-wb-kit" style={{ "--i": order++ } as CSSProperties}>
            <span className="gf-wb-field-label">Brand kit found</span>
            <span className="gf-wb-kit-row">
              {[kit.primary_color, kit.accent_color].filter(Boolean).map((color) => (
                <span key={color} className="gf-wb-swatch">
                  <i style={{ background: color! }} aria-hidden="true" />
                  {color}
                </span>
              ))}
              {kit.logo_url && <span className="gf-wb-swatch">Logo found</span>}
            </span>
            <small>From your site’s {Object.values(kit.sources ?? {}).filter((v, i, a) => a.indexOf(v) === i).join(" and ") || "markup"}. You can set fonts and a logo file later.</small>
          </div>
        )}
      </div>
      {error && <p className="gf-wb-input-error" role="alert">{error}</p>}
      <div className="gf-wb-actions">
        <span className="gf-wb-secondary">
          <button type="button" className="gf-button ghost" onClick={onRestart}>
            Start over
          </button>
          <button type="button" className="gf-button ghost" onClick={onSkip}>
            Type it instead
          </button>
        </span>
        <button type="button" className="gf-button gf-onboarding-cta" disabled={disabled} onClick={onApply}>
          <span className="gf-onboarding-cta-label">Use this brief</span>
          <ArrowRight size={18} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function DraftField({
  index,
  field,
  label,
  hint,
  draft,
  open,
  onToggle,
  children,
}: {
  index: number;
  field: string;
  label: string;
  hint?: string;
  draft: BrandDraft;
  open: boolean;
  onToggle: () => void;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  const evidence = draft.evidence.filter((e) => e.field === field);
  const dropped = draft.dropped.includes(field);
  const pageLabel = (url: string) =>
    draft.pages.find((p) => p.url === url)?.label || pathLabel(url);
  return (
    <div className={`gf-wb-field${dropped ? " is-dropped" : ""}`} style={{ "--i": index } as CSSProperties}>
      <span className="gf-wb-field-head">
        <label className="gf-wb-field-label" htmlFor={id}>
          {label}
        </label>
        {evidence.length > 0 && (
          <button
            type="button"
            className={`gf-wb-evidence-toggle${open ? " is-open" : ""}`}
            aria-expanded={open}
            aria-controls={`${id}-evidence`}
            onClick={onToggle}
          >
            <Quote size={11} strokeWidth={2} aria-hidden="true" />
            from your site
          </button>
        )}
        {dropped && <span className="gf-wb-unconfirmed">Not confirmed — add your own</span>}
      </span>
      {open && evidence.length > 0 && (
        <div
          className="gf-wb-evidence"
          id={`${id}-evidence`}
          role="note"
          aria-label={`Where your ${label.toLowerCase()} came from`}
          onKeyDown={(e) => {
            if (e.key === "Escape") onToggle();
          }}
        >
          {evidence.map((item) => (
            <figure key={item.quote}>
              <blockquote>“{item.quote}”</blockquote>
              <figcaption>
                {pageLabel(item.page_url)} · <span>{pathLabel(item.page_url)}</span>
              </figcaption>
            </figure>
          ))}
          <button type="button" className="gf-wb-evidence-close" aria-label="Close source" onClick={onToggle}>
            <X size={12} strokeWidth={2} />
          </button>
        </div>
      )}
      <span className="gf-wb-control">{children(id)}</span>
      {hint && <small>{hint}</small>}
    </div>
  );
}

/** Browser window with a spark: drawn in the app's own frost-and-sand language. */
function WebsiteIllustration() {
  return (
    <svg
      className="gf-wb-illustration"
      width="168"
      height="112"
      viewBox="0 0 168 112"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="gf-wb-glass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.22" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.06" />
        </linearGradient>
        <linearGradient id="gf-wb-sand" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#e2c49d" />
          <stop offset="1" stopColor="#f3e2c9" />
        </linearGradient>
        <radialGradient id="gf-wb-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#f3e2c9" stopOpacity="0.55" />
          <stop offset="1" stopColor="#f3e2c9" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="10" y="18" width="128" height="86" rx="12" fill="url(#gf-wb-glass)" stroke="#ffffff" strokeOpacity="0.32" />
      <path d="M10 38h128" stroke="#ffffff" strokeOpacity="0.22" />
      <circle cx="24" cy="28" r="3" fill="#f0b9ac" fillOpacity="0.8" />
      <circle cx="34" cy="28" r="3" fill="#f9e1bf" fillOpacity="0.8" />
      <circle cx="44" cy="28" r="3" fill="#9bd3b0" fillOpacity="0.8" />
      <rect x="58" y="24" width="64" height="8" rx="4" fill="#ffffff" fillOpacity="0.12" />
      <rect className="gf-wb-line l1" x="24" y="52" width="70" height="8" rx="4" fill="url(#gf-wb-sand)" />
      <rect className="gf-wb-line l2" x="24" y="68" width="98" height="6" rx="3" fill="#ffffff" fillOpacity="0.28" />
      <rect className="gf-wb-line l3" x="24" y="80" width="82" height="6" rx="3" fill="#ffffff" fillOpacity="0.2" />
      <rect className="gf-wb-line l4" x="24" y="92" width="54" height="6" rx="3" fill="#ffffff" fillOpacity="0.14" />
      <g className="gf-wb-spark">
        <circle cx="138" cy="22" r="22" fill="url(#gf-wb-glow)" />
        <path d="M138 8l4.2 9.8L152 22l-9.8 4.2L138 36l-4.2-9.8L124 22l9.8-4.2z" fill="url(#gf-wb-sand)" />
        <path d="M156 42l1.6 3.4L161 47l-3.4 1.6L156 52l-1.6-3.4L151 47l3.4-1.6z" fill="#f3e2c9" fillOpacity="0.8" />
      </g>
    </svg>
  );
}
