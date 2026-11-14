import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { ArrowRight, Check } from "lucide-react";
import { AutoTextarea } from "../components/AutoTextarea";
import { ApiError } from "../api";
import { objectives, type Campaign, type Profile } from "../types";
import type { Workspace } from "./useCampaignWorkspace";
import {
  workspaceApi,
  type CampaignInput,
  type ProfileInput,
} from "./workspaceApi";
import { Disclosure, Field } from "./parts";
import { Icon } from "./Icon";
import { BrandMark } from "./BrandMark";
import { LaunchTransition, type LaunchPhase } from "./LaunchTransition";

const outcomes = [
  {
    id: "reach",
    title: "Reach new people",
    description: "Introduce the right audience to your show or brand.",
    objective: "awareness",
    metric: "reach",
    measure: "Reach",
    icon: "results",
    accent: "169, 195, 214",
  },
  {
    id: "visits",
    title: "Drive full-episode visits",
    description:
      "Turn a great short into a reason to watch the whole conversation.",
    objective: "traffic",
    metric: "full_episode_visits",
    measure: "Full-episode visits",
    icon: "play",
    accent: "222, 188, 141",
  },
  {
    id: "leads",
    title: "Generate qualified leads",
    description: "Start conversations with people who could become customers.",
    objective: "leads",
    metric: "qualified_leads",
    measure: "Qualified leads",
    icon: "link",
    accent: "171, 201, 181",
  },
] as const;
const voices = [
  {
    id: "insight",
    title: "Useful insights",
    description: "Get to the point. Give people something they can use.",
    icon: "info",
    accent: "169, 195, 214",
  },
  {
    id: "perspective",
    title: "A strong point of view",
    description: "Lead with a clear claim, and keep the context intact.",
    icon: "research",
    accent: "222, 188, 141",
  },
  {
    id: "story",
    title: "Stories that stay with you",
    description: "Find the tension, the turning point, and the payoff.",
    icon: "studio",
    accent: "171, 201, 181",
  },
] as const;
const steps = [
  "Your audience",
  "Your outcome",
  "Your voice",
  "Review & launch",
];
type Outcome = (typeof outcomes)[number]["id"] | "other" | "discovery" | "";
type Voice = (typeof voices)[number]["id"] | "other";

export function onboardingBodies(input: {
  name: string;
  audience: string;
  objective: string;
  metric: string;
  guardrails: string;
  creativePreference?: string;
  outcomeLabel?: string;
}) {
  const name = input.name.trim(),
    audience = input.audience.trim(),
    metric = input.metric.trim(),
    guardrails = input.guardrails.trim(),
    creativePreference = input.creativePreference?.trim() || guardrails,
    outcomeLabel = input.outcomeLabel?.trim() || input.objective;
  const constraints = guardrails
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!name || name.length > 200)
    throw new Error("Use a workspace name between 1 and 200 characters.");
  if (!audience || audience.length > 3000)
    throw new Error("Describe your audience in 1–3,000 characters.");
  if (!(objectives as readonly string[]).includes(input.objective))
    throw new Error("Choose a supported objective.");
  if (input.objective !== "discovery" && (!metric || metric.length > 200))
    throw new Error("Use a primary metric between 1 and 200 characters.");
  if (guardrails.length > 4000)
    throw new Error(
      "Keep voice and boundaries within 4,000 characters in total.",
    );
  if (constraints.length > 30)
    throw new Error("Use up to 30 voice and boundary lines.");
  if (constraints.some((line) => line.length > 1200))
    throw new Error(
      "Keep each voice or boundary line within 1,200 characters.",
    );
  if (creativePreference.length > 4000)
    throw new Error("Keep your creative direction within 4,000 characters.");
  if (outcomeLabel.length > 200)
    throw new Error("Describe your outcome within 200 characters.");
  const profile: ProfileInput = {
    name,
    audience,
    objective: input.objective,
    primary_metric: input.objective === "discovery" ? null : metric,
    brand_context: guardrails,
    creative_preferences: creativePreference,
  };
  const brief: CampaignInput["brief"] = {
    audience,
    constraints,
    requested_outputs: ["Vertical clips"],
    measurement_intent:
      input.objective === "discovery"
        ? "Discovery"
        : `${outcomeLabel}: ${metric}`,
  };
  return { profile, brief };
}

/** Successful writes are retained separately from refreshes. An ambiguous write
 * must be reconciled with saved records before the creator can submit it again. */
export function Onboarding({
  w,
  onComplete,
  onCancel,
  onBusyChange,
  active = true,
}: {
  w: Workspace;
  onComplete: () => void;
  onCancel?: () => void;
  onBusyChange?: (busy: boolean) => void;
  active?: boolean;
}) {
  const [name, setName] = useState("");
  const [audience, setAudience] = useState("");
  const [outcome, setOutcome] = useState<Outcome>("");
  const [customOutcome, setCustomOutcome] = useState("");
  const [customMetric, setCustomMetric] = useState("");
  const [voice, setVoice] = useState<Voice>("insight");
  const [customVoice, setCustomVoice] = useState("");
  const [step, setStep] = useState(0);
  const [furthest, setFurthest] = useState(0);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [editingReview, setEditingReview] = useState(false);
  const [stepError, setStepError] = useState("");
  const [launching, setLaunching] = useState(false);
  const [flight, setFlight] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const recovery = useRef<HTMLDivElement>(null);
  const previousStep = useRef(0);
  const choiceId = useId();
  const selectedOutcome = outcomes.find((o) => o.id === outcome);
  const selectedVoice = voices.find((v) => v.id === voice);
  const objective =
    outcome === "other" ? "custom" : selectedOutcome?.objective || "discovery";
  const metric =
    selectedOutcome?.metric || (outcome === "other" ? customMetric : "");
  const outcomeLabel =
    selectedOutcome?.title ||
    (outcome === "other" ? customOutcome.trim() : "Explore first · Discovery");
  const creativePreference = selectedVoice
    ? `${selectedVoice.title}. ${selectedVoice.description}`
    : customVoice.trim();
  const [guardrails, setGuardrails] = useState(
    "Preserve the speaker’s meaning. Use only the supplied footage.",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState<"profile" | "workspace" | null>(
    null,
  );
  const [profile, setProfile] = useState<Profile>();
  const [campaign, setCampaign] = useState<Campaign>();
  const [matches, setMatches] = useState<Array<Profile | Campaign>>([]);
  const [launchPhase, setLaunchPhase] = useState<LaunchPhase | null>(null);
  const lock = useRef(false);
  const profileReceipt = useRef<Profile>();
  const campaignReceipt = useRef<Campaign>();
  const attemptedProfile = useRef<ProfileInput>();
  const attemptedCampaign = useRef<CampaignInput>();
  useEffect(() => {
    onBusyChange?.(busy || launchPhase !== null);
  }, [busy, launchPhase, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  const locked = busy || launchPhase !== null || !!campaign || !!uncertain;
  useEffect(() => {
    if (
      active &&
      !launchPhase &&
      (previousStep.current !== step ||
        document.activeElement !== heading.current)
    )
      heading.current?.focus();
    previousStep.current = step;
  }, [step, active, launchPhase]);
  useEffect(() => {
    if (active && error && !launchPhase) recovery.current?.focus();
  }, [active, error, launchPhase]);
  useEffect(() => {
    if (
      launching &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      setLaunching(false);
  }, [launching]);

  function move(next: number, reviewEdit = false) {
    setDirection(next < step ? "back" : "forward");
    setEditingReview(reviewEdit);
    setStepError("");
    setStep(next);
  }
  function problem(index: number) {
    if (index === 0) {
      if (!name.trim() || name.trim().length > 200)
        return "Use a workspace name between 1 and 200 characters.";
      if (!audience.trim() || audience.trim().length > 3000)
        return "Describe your audience in 1–3,000 characters.";
    }
    if (index === 1) {
      if (!outcome)
        return "Choose an outcome, or explore first with Discovery.";
      if (
        outcome === "other" &&
        (!customOutcome.trim() || customOutcome.trim().length > 200)
      )
        return "Describe your outcome in 1–200 characters.";
      if (
        objective !== "discovery" &&
        (!metric.trim() || metric.trim().length > 200)
      )
        return "Use a primary metric between 1 and 200 characters.";
    }
    if (index === 2) {
      if (voice === "other" && !customVoice.trim())
        return "Describe how you’d like your edits to feel.";
      try {
        onboardingBodies({
          name,
          audience,
          objective,
          metric,
          guardrails,
          creativePreference,
          outcomeLabel,
        });
      } catch (e) {
        return e instanceof Error
          ? e.message
          : "Check your creative direction.";
      }
    }
    return "";
  }
  function animateClick() {
    setFlight((n) => n + 1);
    setLaunching(true);
  }
  function advance() {
    if (locked || w.busy || w.loading) return;
    const message = problem(step);
    if (message) {
      setStepError(message);
      return;
    }
    animateClick();
    const next = editingReview ? 3 : Math.min(3, step + 1);
    setFurthest((value) => Math.max(value, next));
    move(next);
  }

  function adopt(record: Profile | Campaign) {
    if (uncertain === "profile") {
      profileReceipt.current = record as Profile;
      setProfile(record as Profile);
    } else {
      campaignReceipt.current = record as Campaign;
      setCampaign(record as Campaign);
    }
    setUncertain(null);
    setMatches([]);
    setError("");
  }

  async function reconcile() {
    if (lock.current || !uncertain) return;
    lock.current = true;
    setBusy(true);
    try {
      let found: Array<Profile | Campaign>;
      if (uncertain === "profile") {
        const wanted = attemptedProfile.current!;
        found = (await workspaceApi.profiles()).filter(
          (p) =>
            (!profileReceipt.current || p.id === profileReceipt.current.id) &&
            p.name === wanted.name &&
            p.audience === wanted.audience &&
            p.objective === wanted.objective &&
            p.primary_metric === wanted.primary_metric &&
            p.brand_context === wanted.brand_context &&
            p.creative_preferences === wanted.creative_preferences,
        );
      } else {
        const wanted = attemptedCampaign.current!;
        found = (await workspaceApi.campaigns()).filter(
          (c) =>
            c.name === wanted.name &&
            c.profile_ids.includes(wanted.profile_ids[0]) &&
            c.brief.audience === wanted.brief.audience &&
            c.brief.measurement_intent === wanted.brief.measurement_intent &&
            JSON.stringify(c.brief.constraints) ===
              JSON.stringify(wanted.brief.constraints) &&
            JSON.stringify(c.brief.requested_outputs) ===
              JSON.stringify(wanted.brief.requested_outputs),
        );
      }
      if (found.length === 1) adopt(found[0]);
      else if (!found.length) {
        setUncertain(null);
        setError(
          "No matching saved record was found. Your details are intact; you can try again.",
        );
      } else {
        setMatches(found);
        setError(
          "More than one matching record exists. Choose the saved record to continue with.",
        );
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Saved records are unavailable. Refresh before trying again.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function create() {
    if (lock.current || uncertain || w.loading || w.busy) return;
    for (let index = 0; index < 3; index++) {
      const message = problem(index);
      if (message) {
        setDirection("back");
        setStep(index);
        setStepError(message);
        return;
      }
    }
    let bodies: ReturnType<typeof onboardingBodies>;
    try {
      bodies = onboardingBodies({
        name,
        audience,
        objective,
        metric,
        guardrails,
        creativePreference,
        outcomeLabel,
      });
    } catch (e) {
      setStepError(
        e instanceof Error ? e.message : "Check your workspace details.",
      );
      return;
    }
    lock.current = true;
    animateClick();
    onBusyChange?.(true);
    setLaunchPhase("profile");
    setBusy(true);
    setStepError("");
    setError("");
    let phase: "profile" | "workspace" | "refresh" = "profile";
    let succeeded = false;
    try {
      let savedProfile = profileReceipt.current;
      if (!savedProfile) {
        const body = bodies.profile;
        attemptedProfile.current = body;
        savedProfile = await workspaceApi.profile(body);
        if (!savedProfile?.id || savedProfile.id.length > 128)
          throw new Error("The saved profile could not be confirmed.");
        profileReceipt.current = savedProfile;
        setProfile(savedProfile);
      } else if (
        Object.entries(bodies.profile).some(
          ([key, value]) => savedProfile?.[key as keyof ProfileInput] !== value,
        )
      ) {
        // A confirmed profile is updated by ID if corrected fields change;
        // campaign validation recovery must never POST a duplicate profile.
        attemptedProfile.current = bodies.profile;
        savedProfile = await workspaceApi.updateProfile(
          savedProfile.id,
          bodies.profile,
        );
        if (!savedProfile?.id || savedProfile.id !== profileReceipt.current?.id)
          throw new Error("The updated profile could not be confirmed.");
        profileReceipt.current = savedProfile;
        setProfile(savedProfile);
      }
      phase = "workspace";
      setLaunchPhase("workspace");
      let savedCampaign = campaignReceipt.current;
      if (!savedCampaign) {
        const body: CampaignInput = {
          name: name.trim(),
          profile_ids: [savedProfile.id],
          video_ids: [],
          brief: bodies.brief,
        };
        attemptedCampaign.current = body;
        savedCampaign = await workspaceApi.save(body);
        if (!savedCampaign?.id)
          throw new Error("The saved workspace could not be confirmed.");
        campaignReceipt.current = savedCampaign;
        setCampaign(savedCampaign);
      }
      phase = "refresh";
      setLaunchPhase("opening");
      await w.load(savedCampaign.id);
      w.setProfileId(savedProfile.id);
      succeeded = true;
      setLaunchPhase("ready");
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "The workspace could not be saved.";
      const rejected =
        e instanceof ApiError && (e.status === 400 || e.status === 422);
      if (phase !== "refresh" && !rejected) setUncertain(phase);
      setError(
        phase === "refresh"
          ? `Your workspace was saved. Refresh to open it. ${message}`
          : rejected
            ? `${message} Correct your details and try again.${profileReceipt.current ? " Your saved profile will be reused." : " Your inputs are still editable."}`
            : `${message} Check saved records before resubmitting; your details stay here.`,
      );
    } finally {
      if (!succeeded) {
        lock.current = false;
        setLaunchPhase(null);
      }
      setBusy(false);
      setLaunching(false);
    }
  }

  const stepTitles = [
    "Who are we making this for?",
    "What are we working toward?",
    "How should your edits feel?",
    "Review your workspace",
  ];
  const descriptions = [
    "Tell us who you make this for. We’ll use it to guide your edits.",
    "One clear goal helps every edit work toward the same thing.",
    "Choose the approach that feels most like you. You can refine it later.",
    "Check your choices, then save them and open Factory.",
  ];
  function goToProgress(index: number) {
    if (locked || index > furthest) return;
    if (index > step) {
      for (let earlier = 0; earlier < index; earlier++) {
        const message = problem(earlier);
        if (message) {
          move(earlier, furthest === 3);
          setStepError(message);
          return;
        }
      }
    }
    move(index, furthest === 3 && index < 3);
  }
  function submit() {
    if (step === 3) void create();
    else advance();
  }

  return (
    <section
      className={`gf-onboarding gf-onboarding-wizard${launchPhase ? " is-launching" : ""}`}
      aria-label="Workspace onboarding"
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
      <nav
        className="gf-onboarding-progress-wrap"
        aria-label="Workspace setup"
        hidden={!!launchPhase}
      >
        <div
          className="gf-onboarding-track"
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={1}
          aria-valuemax={4}
          aria-valuenow={step + 1}
          aria-valuetext={`Step ${step + 1} of 4: ${steps[step]}`}
        >
          <span
            className="gf-onboarding-track-fill"
            style={{ width: `${(step / 3) * 100}%` }}
          />
        </div>
        <ol className="gf-onboarding-progress" aria-label="Onboarding progress">
          {steps.map((label, index) => (
            <li
              key={label}
              className={
                index === step
                  ? "is-current"
                  : index < step
                    ? "is-complete"
                    : ""
              }
            >
              <button
                type="button"
                aria-label={`Go to ${label}`}
                aria-current={step === index ? "step" : undefined}
                disabled={locked || index > furthest}
                onClick={() => goToProgress(index)}
              >
                <span className="gf-onboarding-marker" aria-hidden="true">
                  {index < step ? (
                    <Check size={13} strokeWidth={1.8} />
                  ) : (
                    String(index + 1).padStart(2, "0")
                  )}
                </span>
                <span className="gf-onboarding-progress-label">
                  {["Audience", "Outcome", "Voice", "Launch"][index]}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <form
        className="gf-onboarding-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {launchPhase && (
          <LaunchTransition
            phase={launchPhase}
            name={name.trim()}
            onComplete={() => {
              lock.current = false;
              setLaunchPhase(null);
              onBusyChange?.(false);
              onComplete();
            }}
          />
        )}
        <div
          className="gf-onboarding-scroll"
          hidden={!!launchPhase}
          aria-busy={busy || undefined}
          role="region"
          aria-label="Setup questions"
          tabIndex={0}
        >
          <p className="gf-command-sr-only" role="status">
            Step {step + 1} of 4: {steps[step]}
          </p>
          <section
            key={step}
            className={`gf-onboarding-step ${direction}`}
            aria-labelledby={`${choiceId}-step-${step}`}
          >
            <span className="gf-onboarding-step-count">
              {String(step + 1).padStart(2, "0")} / 04
            </span>
            <h1 id={`${choiceId}-step-${step}`} ref={heading} tabIndex={-1}>
              {stepTitles[step]}
            </h1>
            <p className="gf-onboarding-step-description">{descriptions[step]}</p>

            {step === 0 && (
              <>
                <Field label="Podcast or workspace name">
                  {(id) => (
                    <AutoTextarea
                      id={id}
                      rows={1}
                      required
                      maxLength={200}
                      value={name}
                      disabled={locked}
                      placeholder="e.g. Founder stories"
                      onChange={(e) => setName(e.target.value)}
                    />
                  )}
                </Field>
                <Field label="Who are we speaking to?">
                  {(id) => (
                    <AutoTextarea
                      id={id}
                      rows={3}
                      required
                      maxLength={3000}
                      value={audience}
                      disabled={locked}
                      placeholder="Who watches, and what do they care about?"
                      onChange={(e) => setAudience(e.target.value)}
                    />
                  )}
                </Field>
              </>
            )}

            {step === 1 && (
              <>
                <fieldset className="gf-onboarding-options">
                  <legend className="gf-command-sr-only">Your outcome</legend>
                  {outcomes.map((option) => (
                    <label
                      key={option.id}
                      className={`gf-onboarding-choice${outcome === option.id ? " is-selected" : ""}`}
                      style={{ "--choice-accent": option.accent } as CSSProperties}
                    >
                      <Icon name={option.icon} size={19} />
                      <span className="gf-onboarding-choice-copy">
                        <strong>{option.title}</strong>
                        <small>{option.description}</small>
                      </span>
                      <input
                        type="radio"
                        name={`${choiceId}-outcome`}
                        value={option.id}
                        checked={outcome === option.id}
                        disabled={locked}
                        onChange={() => setOutcome(option.id)}
                      />
                    </label>
                  ))}
                  <label
                    className={`gf-onboarding-choice is-other${outcome === "other" ? " is-selected" : ""}`}
                  >
                    <Icon name="plus" size={18} />
                    <span className="gf-onboarding-choice-copy">
                      <strong>Other</strong>
                      <small>Set an outcome in your own words.</small>
                    </span>
                    <input
                      type="radio"
                      name={`${choiceId}-outcome`}
                      value="other"
                      checked={outcome === "other"}
                      disabled={locked}
                      onChange={() => setOutcome("other")}
                    />
                  </label>
                </fieldset>
                {outcome === "other" && (
                  <div className="gf-onboarding-custom">
                    <Field label="Your outcome">
                      {(id) => (
                        <AutoTextarea
                          id={id}
                          rows={1}
                          required
                          maxLength={200}
                          disabled={locked}
                          value={customOutcome}
                          placeholder="What would make these clips useful to your business?"
                          onChange={(e) => setCustomOutcome(e.target.value)}
                        />
                      )}
                    </Field>
                    <Field
                      label="Primary metric"
                      hint="The measure you’ll bring back later. This sets a goal, not a result."
                    >
                      {(id) => (
                        <input
                          id={id}
                          required
                          maxLength={200}
                          disabled={locked}
                          value={customMetric}
                          placeholder="e.g. qualified demo requests"
                          onChange={(e) => setCustomMetric(e.target.value)}
                        />
                      )}
                    </Field>
                  </div>
                )}
                {outcome === "discovery" && (
                  <p className="gf-onboarding-review-note">
                    Discovery selected. Explore the creative options without
                    choosing a primary metric.
                  </p>
                )}
                <button
                  type="button"
                  className="gf-button ghost compact gf-onboarding-skip"
                  disabled={locked}
                  onClick={() => {
                    setOutcome("discovery");
                    setFurthest((v) => Math.max(v, 2));
                    animateClick();
                    move(editingReview ? 3 : 2);
                  }}
                >
                  Explore first
                </button>
              </>
            )}

            {step === 2 && (
              <>
                <fieldset className="gf-onboarding-options">
                  <legend className="gf-command-sr-only">Creative voice</legend>
                  {voices.map((option) => (
                    <label
                      key={option.id}
                      className={`gf-onboarding-choice${voice === option.id ? " is-selected" : ""}`}
                      style={{ "--choice-accent": option.accent } as CSSProperties}
                    >
                      <Icon name={option.icon} size={19} />
                      <span className="gf-onboarding-choice-copy">
                        <strong>{option.title}</strong>
                        <small>{option.description}</small>
                      </span>
                      <input
                        type="radio"
                        name={`${choiceId}-voice`}
                        value={option.id}
                        checked={voice === option.id}
                        disabled={locked}
                        onChange={() => setVoice(option.id)}
                      />
                    </label>
                  ))}
                  <label
                    className={`gf-onboarding-choice is-other${voice === "other" ? " is-selected" : ""}`}
                  >
                    <Icon name="plus" size={18} />
                    <span className="gf-onboarding-choice-copy">
                      <strong>Other</strong>
                      <small>Give your edits a voice of their own.</small>
                    </span>
                    <input
                      type="radio"
                      name={`${choiceId}-voice`}
                      value="other"
                      checked={voice === "other"}
                      disabled={locked}
                      onChange={() => setVoice("other")}
                    />
                  </label>
                </fieldset>
                {voice === "other" && (
                  <div className="gf-onboarding-custom">
                    <Field label="Your creative direction">
                      {(id) => (
                        <AutoTextarea
                          id={id}
                          rows={3}
                          required
                          maxLength={4000}
                          disabled={locked}
                          value={customVoice}
                          placeholder="Describe the tone, pace, or storytelling you want."
                          onChange={(e) => setCustomVoice(e.target.value)}
                        />
                      )}
                    </Field>
                  </div>
                )}
                <Disclosure title="Voice & boundaries" icon="settings">
                  <Field
                    label="What should every edit respect?"
                    hint="Up to 30 lines, 1,200 characters per line, and 4,000 characters in total."
                  >
                    {(id) => (
                      <AutoTextarea
                        id={id}
                        rows={3}
                        maxLength={4000}
                        value={guardrails}
                        disabled={locked}
                        onChange={(e) => setGuardrails(e.target.value)}
                      />
                    )}
                  </Field>
                </Disclosure>
              </>
            )}

            {step === 3 && (
              <>
                <dl className="gf-onboarding-summary">
                  <div className="gf-onboarding-summary-row">
                    <div className="gf-onboarding-summary-copy">
                      <dt>Workspace & audience</dt>
                      <dd>
                        <strong>{name.trim()}</strong>
                        <p>{audience.trim()}</p>
                      </dd>
                    </div>
                    <button
                      type="button"
                      className="gf-button ghost compact"
                      disabled={locked}
                      onClick={() => move(0, true)}
                      aria-label="Edit audience"
                    >
                      Edit
                    </button>
                  </div>
                  <div className="gf-onboarding-summary-row">
                    <div className="gf-onboarding-summary-copy">
                      <dt>What we’re working toward</dt>
                      <dd>
                        <strong>{outcomeLabel}</strong>
                        <p>
                          {objective === "discovery"
                            ? "No primary metric selected."
                            : `Metric to track: ${selectedOutcome?.measure || customMetric.trim()}`}
                        </p>
                      </dd>
                    </div>
                    <button
                      type="button"
                      className="gf-button ghost compact"
                      disabled={locked}
                      onClick={() => move(1, true)}
                      aria-label="Edit outcome"
                    >
                      Edit
                    </button>
                  </div>
                  <div className="gf-onboarding-summary-row">
                    <div className="gf-onboarding-summary-copy">
                      <dt>Creative voice</dt>
                      <dd>
                        <strong>
                          {selectedVoice?.title || "Your direction"}
                        </strong>
                        <p>{selectedVoice?.description || customVoice.trim()}</p>
                      </dd>
                    </div>
                    <button
                      type="button"
                      className="gf-button ghost compact"
                      disabled={locked}
                      onClick={() => move(2, true)}
                      aria-label="Edit creative voice"
                    >
                      Edit
                    </button>
                  </div>
                </dl>
                <Disclosure title="Review boundaries" icon="settings">
                  <p className="gf-onboarding-boundaries">
                    {guardrails.trim() || "No additional boundaries."}
                  </p>
                </Disclosure>
                <p className="gf-onboarding-review-note">
                  Launch saves your choices and opens Factory. You choose when to
                  add footage and start production.
                </p>
              </>
            )}
          </section>

          {(stepError || error) && (
            <div className="gf-onboarding-recovery" role="alert" ref={recovery} tabIndex={-1}>
              <p>{stepError || error}</p>
              {uncertain && (
                <button
                  type="button"
                  className="gf-button secondary compact"
                  disabled={busy}
                  onClick={() => void reconcile()}
                >
                  Check saved{" "}
                  {uncertain === "profile" ? "profiles" : "workspaces"}
                </button>
              )}
              {!!matches.length && (
                <label>
                  Saved matching record
                  <select
                    disabled={busy}
                    value=""
                    onChange={(e) => {
                      const match = matches.find((m) => m.id === e.target.value);
                      if (match) adopt(match);
                    }}
                  >
                    <option value="">Choose a saved record</option>
                    {matches.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} · {m.id.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
          {(profile || campaign) && (
            <p className="gf-flow-note">
              <Icon name="check" size={14} />
              {campaign
                ? "Workspace saved. Ready to open."
                : "Profile saved. Your next attempt will reuse it."}
            </p>
          )}
        </div>
        <footer className="gf-onboarding-actions" hidden={!!launchPhase}>
          {step > 0 ? (
            <button
              type="button"
              className="gf-button ghost"
              disabled={locked}
              onClick={() => move(step - 1)}
            >
              <Icon name="back" size={15} />
              Back
            </button>
          ) : onCancel && !profile && !uncertain ? (
            <button
              type="button"
              className="gf-button ghost"
              disabled={busy}
              onClick={onCancel}
            >
              Back to Factory
            </button>
          ) : (
            <span />
          )}
          <button
            type="submit"
            className="gf-button gf-onboarding-cta"
            data-error={!!(stepError || error)}
            data-launching={launching}
            disabled={busy || !!uncertain || w.busy || w.loading}
          >
            <span className="gf-onboarding-cta-label">
              {busy
                ? "Saving workspace…"
                : step === 3
                  ? campaign
                    ? "Open workspace"
                    : "Launch workspace"
                  : editingReview
                    ? "Review changes"
                    : "Continue"}
            </span>
            <span
              key={flight}
              className="gf-onboarding-arrow"
              aria-hidden="true"
              onAnimationEnd={(event) => {
                if (event.animationName === "gf-onboarding-advance")
                  setLaunching(false);
              }}
            >
              <ArrowRight size={18} strokeWidth={1.8} />
            </span>
          </button>
        </footer>
      </form>
    </section>
  );
}
