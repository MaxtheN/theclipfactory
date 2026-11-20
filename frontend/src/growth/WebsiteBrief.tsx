import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { AutoTextarea } from "../components/AutoTextarea";
import {
  goalOptions,
  goalLabel,
  NO_SUGGESTIONS,
  briefFromDraft,
  editableFrom,
  statusLine,
  websiteBriefApi,
  type AcceptedSuggestions,
  type BrandDraft,
  type EditableBrief,
  type Research,
  type WebsiteBriefApi,
  type WebsiteBriefResult,
} from "./websiteBriefApi";
import { AiModelHint, llmApi, type LlmView } from "./AiModelCard";
import "./website-brief.css";
import { PillList, PillSelect } from "./PillField";
import { AUDIENCE, CTA, METRIC, METRIC_LABELS, MUST_AVOID, TONE } from "./choiceOptions";
import { platformWords } from "../platform";

type Phase = "input" | "reading" | "review" | "error";

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

const sameText = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** Which model drafts the brief, read from the same route the AI model settings show. */
export function modelRouteText(view: LlmView | null, failed: boolean) {
  if (failed) return "Drafted by the model chosen in AI model settings.";
  if (!view) return "Checking which model drafts it…";
  if (view.routes?.brand_research === "openrouter") {
    const label = view.models.find((m) => m.id === view.settings.model)?.label ?? view.settings.model;
    return `Drafted by ${label} via OpenRouter (page text is sent to OpenRouter).`;
  }
  return `Drafted by the model on ${platformWords().computer}.`;
}

export function WebsiteBrief({
  onApply,
  onSkip,
  client = websiteBriefApi,
  modelRoute = llmApi.view,
  pollMs = 700,
  initialUrl = "",
  disabled = false,
  stepNumber,
  stepCount,
}: {
  /** Fill onboarding and the first campaign brief from the creator-edited draft. Nothing is saved here. */
  onApply: (result: WebsiteBriefResult) => void;
  /** Continue with the manual onboarding steps. */
  onSkip: () => void;
  client?: WebsiteBriefApi;
  /** The active model route (local or OpenRouter) for the "How this works" note. */
  modelRoute?: () => Promise<LlmView>;
  pollMs?: number;
  initialUrl?: string;
  disabled?: boolean;
  stepNumber?: number;
  stepCount?: number;
}) {
  const [phase, setPhase] = useState<Phase>("input");
  const [url, setUrl] = useState(initialUrl);
  const [inputError, setInputError] = useState("");
  const [research, setResearch] = useState<Research | null>(null);
  const [draft, setDraft] = useState<BrandDraft | null>(null);
  const [edited, setEdited] = useState<EditableBrief | null>(null);
  const [accepted, setAccepted] = useState<AcceptedSuggestions>(NO_SUGGESTIONS);
  const [error, setError] = useState("");
  const [applyError, setApplyError] = useState("");
  const [openEvidence, setOpenEvidence] = useState<string | null>(null);
  const [route, setRoute] = useState<LlmView | null>(null);
  const [routeFailed, setRouteFailed] = useState(false);
  const routeAsked = useRef(false);
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

  function loadRoute() {
    if (routeAsked.current) return;
    routeAsked.current = true;
    modelRoute()
      .then((view) => mounted.current && setRoute(view))
      .catch(() => mounted.current && setRouteFailed(true));
  }

  function fail(message: string) {
    current.current = undefined;
    window.clearTimeout(timer.current);
    setError(message || "We couldn’t read that site.");
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
      setAccepted(NO_SUGGESTIONS);
      setPhase("review");
    } else if (next.status === "cancelled") {
      setPhase("input");
    } else {
      fail(next.error || "We couldn’t read that site.");
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
        fail(e instanceof Error ? e.message : "We couldn’t start reading that site.");
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
    setAccepted(NO_SUGGESTIONS);
    setError("");
    setOpenEvidence(null);
    setPhase("input");
  }

  function apply() {
    if (!edited || disabled) return;
    const result = briefFromDraft(edited, draft, accepted);
    if (!result.name) {
      setApplyError("Add your brand name to use this brief.");
      return;
    }
    setApplyError("");
    onApply(result);
  }

  const titles: Record<Phase, string> = {
    input: "What’s your website?",
    reading: "Getting to know your brand.",
    review: "Here’s what we understood.",
    error: "We couldn’t draft it this time",
  };
  const descriptions: Record<Phase, string> = {
    input: "We’ll draft your brand brief from it. You review it first.",
    reading: "Reading your pages for your audience, voice, and what makes you different.",
    review: "Make it sound like you. Confirm the details you want your agents to use.",
    error: "Your details are safe. You can type them yourself instead.",
  };

  return (
    <section
      className={`gf-onboarding-step gf-website-brief is-${phase}`}
      aria-labelledby={`${id}-title`}
    >
      <p className="gf-wb-step">
        {stepNumber && stepCount ? `Step ${stepNumber} of ${stepCount}` : "Before we start"}
      </p>
      <h1 id={`${id}-title`} ref={heading} tabIndex={-1}>
        {titles[phase]}
      </h1>
      <p className="gf-wb-lede">{descriptions[phase]}</p>
      

      {phase === "input" && (
        // Not a <form>: this step renders inside the onboarding wizard's own form.
        <div className="gf-wb-input" role="group" aria-label="Your website">
          <div className="gf-wb-url-row">
            <label className="gf-command-sr-only" htmlFor={`${id}-url`}>
              Your website
            </label>
            <input
              id={`${id}-url`}
              className="gf-wb-url"
              type="text"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              placeholder="yourbrand.com"
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
                if (url.trim()) void begin();
              }}
            />
            <button
              type="button"
              className="gf-button gf-wb-continue"
              disabled={disabled || !url.trim()}
              onClick={() => void begin()}
            >
              Build my brand brief
            </button>
          </div>
          {inputError && (
            <p className="gf-wb-input-error" id={`${id}-url-error`} role="alert">
              {inputError}
            </p>
          )}
          <button type="button" className="gf-wb-text-button" disabled={disabled} onClick={skip}>
            Enter details myself
          </button>
        </div>
      )}

      {phase === "reading" && <Reading research={research} host={host} onCancel={skip} />}

      {phase === "review" && edited && draft && (
        <Review
          draft={draft}
          edited={edited}
          host={host}
          accepted={accepted}
          setAccepted={setAccepted}
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
            <button type="button" className="gf-button" onClick={skip}>
              Type it instead
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
  onCancel,
}: {
  research: Research | null;
  host: string;
  onCancel: () => void;
}) {
  const events = research?.events ?? [];
  const last = events[events.length - 1];
  const line = research?.waiting
    ? `Waiting for other work on ${platformWords().computer} to finish…`
    : last
      ? statusLine(last, host)
      : `Opening ${host}…`;
  const progress = Math.max(4, Math.min(100, research?.progress ?? 4));

  return (
    <div className="gf-wb-reading" data-stage={research?.stage ?? "opening"}>
      <p className="gf-wb-status" role="status" aria-live="polite" aria-atomic="true">
        {line}
      </p>
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
      <button type="button" className="gf-wb-text-button" onClick={onCancel}>
        Stop and type it instead
      </button>
    </div>
  );
}

function Review({
  draft,
  edited,
  host,
  accepted,
  setAccepted,
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
  accepted: AcceptedSuggestions;
  setAccepted: (value: AcceptedSuggestions) => void;
  openEvidence: string | null;
  setOpenEvidence: (value: string | null) => void;
  onChange: (changes: Partial<EditableBrief>) => void;
  error: string;
  disabled: boolean;
  onApply: () => void;
  onRestart: () => void;
  onSkip: () => void;
}) {
  const goals = goalOptions(edited.metric);
  const goal = goals.find((g) => g.objective === edited.objective);
  const groupId = useId();
  // What a ticked suggestion replaced, so unticking puts the creator's value back.
  const before = useRef<{ cta?: Pick<EditableBrief, "ctaText" | "ctaLink">; goal?: Pick<EditableBrief, "objective" | "metric"> }>({});
  const field = (key: string, label: string, control: (id: string) => ReactNode, hint?: string) => (
    <DraftField
      key={key}
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
  const suggested = draft.suggested;
  const avoidLines = edited.mustAvoid.split("\n").map((v) => v.trim()).filter(Boolean);
  const hasSuggestions = !!suggested && (suggested.must_avoid.length > 0 || !!suggested.cta || !!suggested.goal);

  function toggleAvoid(value: string, on: boolean) {
    const rest = avoidLines.filter((v) => !sameText(v, value));
    onChange({ mustAvoid: (on ? [...rest, value] : rest).join("\n") });
    setAccepted({
      ...accepted,
      mustAvoid: on ? [...accepted.mustAvoid, value] : accepted.mustAvoid.filter((v) => !sameText(v, value)),
    });
  }
  function toggleCta(on: boolean) {
    if (!suggested?.cta) return;
    if (on) {
      before.current.cta = { ctaText: edited.ctaText, ctaLink: edited.ctaLink };
      onChange({ ctaText: suggested.cta.text, ctaLink: suggested.cta.link || edited.ctaLink });
    } else if (sameText(edited.ctaText, suggested.cta.text)) {
      onChange(before.current.cta ?? { ctaText: "", ctaLink: "" });
    }
    setAccepted({ ...accepted, cta: on });
  }
  function toggleGoal(on: boolean) {
    if (!suggested?.goal) return;
    if (on) {
      before.current.goal = { objective: edited.objective, metric: edited.metric };
      onChange({ objective: suggested.goal.objective, metric: suggested.goal.metric });
    } else if (edited.objective === suggested.goal.objective) {
      onChange(before.current.goal ?? { objective: "discovery", metric: "" });
    }
    setAccepted({ ...accepted, goal: on });
  }

  return (
    <div className="gf-wb-review">
      <p className="gf-wb-meta">
        From {host}, {draft.pages.length} page{draft.pages.length === 1 ? "" : "s"} read.
      </p>
      {draft.dropped.length > 0 && (
        <p className="gf-wb-meta">
          We couldn’t confirm your {draft.dropped.map((f) => FIELD_LABELS[f] || f).join(", ")} from the
          site’s own words, so we left {draft.dropped.length === 1 ? "it" : "them"} for you.
        </p>
      )}

      <section className="gf-wb-group" aria-labelledby={`${groupId}-site`}>
        <h2 id={`${groupId}-site`} className="gf-wb-group-title">
          From your site
        </h2>
        {field("brand_name", "Brand name", (id) => (
          <input id={id} type="text" maxLength={200} value={edited.brandName} disabled={disabled}
            onChange={(e) => onChange({ brandName: e.target.value })} />
        ))}
        {field("one_liner", "In one line", (id) => (
          <AutoTextarea id={id} rows={1} maxLength={300} value={edited.oneLiner} disabled={disabled}
            onChange={(e) => onChange({ oneLiner: e.target.value })} />
        ))}
        {field("audience", "Who it’s for", (id) => (
          <PillList labelledBy={`${id}-label`} label="Who it’s for" format="comma" options={AUDIENCE}
            value={edited.audience} disabled={disabled}
            onChange={(audience) => onChange({ audience })} />
        ))}
        {field("suggested_goal", "Goal", (id) => (
          <span className="gf-wb-pair">
            <select id={id} value={edited.objective} disabled={disabled}
              onChange={(e) => {
                const next = goals.find((g) => g.objective === e.target.value);
                onChange({ objective: e.target.value, metric: next?.metric ?? "" });
              }}>
              {goals.map((g) => (
                <option key={g.objective} value={g.objective}>{g.label}</option>
              ))}
            </select>
          </span>
        ))}
        {edited.objective !== "discovery" && (
          <div className="gf-wb-field">
            <PillSelect label="Primary metric" className="gf-wb-pills" options={METRIC} labels={METRIC_LABELS}
              suggested={[goal?.metric]} value={edited.metric} disabled={disabled}
              onChange={(metric) => onChange({ metric })} />
          </div>
        )}
        {field("voice", "Voice", (id) => (
          <span className="gf-wb-voice">
            <PillList labelledBy={`${id}-label`} label="Voice" format="comma" options={TONE} max={5}
              maxLength={40} value={edited.adjectives} disabled={disabled}
              onChange={(adjectives) => onChange({ adjectives })} />
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
          <PillList labelledBy={`${id}-label`} label="Never touch" format="lines" options={MUST_AVOID}
            maxLength={120} value={edited.mustAvoid} disabled={disabled}
            onChange={(mustAvoid) => onChange({ mustAvoid })} />
        ), "These become hard limits for every clip.")}
        {field("cta", "Call to action", (id) => (
          <span className="gf-wb-pair">
            <PillSelect labelledBy={`${id}-label`} label="Call to action" options={CTA} maxLength={80}
              value={edited.ctaText} disabled={disabled}
              onChange={(ctaText) => onChange({ ctaText })} />
            <input type="url" aria-label="Call to action link" maxLength={500} value={edited.ctaLink}
              disabled={disabled} placeholder="https://"
              onChange={(e) => onChange({ ctaLink: e.target.value })} />
          </span>
        ))}
        {(kit.primary_color || kit.accent_color || kit.logo_url) && (
          <div className="gf-wb-field">
            <span className="gf-wb-field-label">Brand kit</span>
            <span className="gf-wb-kit-row">
              {[kit.primary_color, kit.accent_color].filter(Boolean).map((color) => (
                <span key={color} className="gf-wb-swatch">
                  <i style={{ background: color! }} aria-hidden="true" />
                  {color}
                </span>
              ))}
              {kit.logo_url && <span className="gf-wb-swatch">Logo found</span>}
            </span>
            <small>
              From your site’s{" "}
              {Object.values(kit.sources ?? {}).filter((v, i, a) => a.indexOf(v) === i).join(" and ") || "markup"}.
              You can set fonts and a logo file later.
            </small>
          </div>
        )}
      </section>

      {hasSuggestions && suggested && (
        <section className="gf-wb-group is-suggested" aria-labelledby={`${groupId}-suggested`}>
          <h2 id={`${groupId}-suggested`} className="gf-wb-group-title">
            Suggested
          </h2>
          <p className="gf-wb-group-note">
            Ideas from the model, not from your site. Tick any you want to add.
          </p>
          <ul className="gf-wb-suggestions">
            {suggested.must_avoid.map((value) => (
              <Suggestion
                key={`avoid-${value}`}
                kind="Never touch"
                value={value}
                checked={accepted.mustAvoid.some((v) => sameText(v, value))}
                disabled={disabled}
                onChange={(on) => toggleAvoid(value, on)}
              />
            ))}
            {suggested.cta && (
              <Suggestion
                kind="Call to action"
                value={suggested.cta.text}
                checked={accepted.cta}
                disabled={disabled}
                onChange={toggleCta}
              />
            )}
            {suggested.goal && (
              <Suggestion
                kind="Goal"
                value={goalLabel(suggested.goal.objective, suggested.goal.metric)}
                reason={suggested.goal.reason}
                checked={accepted.goal}
                disabled={disabled}
                onChange={toggleGoal}
              />
            )}
          </ul>
        </section>
      )}

      {error && <p className="gf-wb-input-error" role="alert">{error}</p>}
      <div className="gf-wb-actions">
        <span className="gf-wb-secondary">
          <button type="button" className="gf-wb-text-button" onClick={onRestart}>
            Start over
          </button>
          <button type="button" className="gf-wb-text-button" onClick={onSkip}>
            Type it instead
          </button>
        </span>
        <button type="button" className="gf-button gf-wb-continue" disabled={disabled} onClick={onApply}>
          Use this brand brief
        </button>
      </div>
    </div>
  );
}

function Suggestion({
  kind,
  value,
  reason,
  checked,
  disabled,
  onChange,
}: {
  kind: string;
  value: string;
  reason?: string;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <li className={`gf-wb-suggestion${checked ? " is-on" : ""}`}>
      <label>
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>
          <span className="gf-wb-suggestion-kind">{kind}</span>
          <span className="gf-wb-suggestion-value">{value}</span>
          {reason && <span className="gf-wb-suggestion-reason">{reason}</span>}
        </span>
      </label>
    </li>
  );
}

function DraftField({
  field,
  label,
  hint,
  draft,
  open,
  onToggle,
  children,
}: {
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
  const pageLabel = (url: string) => draft.pages.find((p) => p.url === url)?.label || pathLabel(url);
  return (
    <div className={`gf-wb-field${dropped ? " is-dropped" : ""}`}>
      <span className="gf-wb-field-head">
        <label className="gf-wb-field-label" htmlFor={id} id={`${id}-label`}>
          {label}
        </label>
        {evidence.length > 0 && (
          <button
            type="button"
            className="gf-wb-source"
            aria-expanded={open}
            aria-controls={`${id}-evidence`}
            onClick={onToggle}
          >
            Source
            <ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
        {dropped && <span className="gf-wb-unconfirmed">Not confirmed. Add your own.</span>}
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
                {pageLabel(item.page_url)}, {pathLabel(item.page_url)}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      <span className="gf-wb-control">{children(id)}</span>
      {hint && <small>{hint}</small>}
    </div>
  );
}
