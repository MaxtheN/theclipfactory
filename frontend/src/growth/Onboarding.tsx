import { useEffect, useRef, useState } from "react";
import { AutoTextarea } from "../components/AutoTextarea";
import { ApiError } from "../api";
import { objectives, type Campaign, type Profile } from "../types";
import type { Workspace } from "./useCampaignWorkspace";
import {
  workspaceApi,
  type CampaignInput,
  type ProfileInput,
} from "./workspaceApi";
import { Disclosure, Field, PrimaryAction } from "./parts";
import { Icon } from "./Icon";

export function onboardingBodies(input: {
  name: string;
  audience: string;
  objective: string;
  metric: string;
  guardrails: string;
}) {
  const name = input.name.trim(),
    audience = input.audience.trim(),
    metric = input.metric.trim(),
    guardrails = input.guardrails.trim();
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
  const profile: ProfileInput = {
    name,
    audience,
    objective: input.objective,
    primary_metric: input.objective === "discovery" ? null : metric,
    brand_context: guardrails,
    creative_preferences: guardrails,
  };
  const brief: CampaignInput["brief"] = {
    audience,
    constraints,
    requested_outputs: ["Vertical clips"],
    measurement_intent:
      input.objective === "discovery"
        ? "Discovery"
        : `${input.objective}: ${metric}`,
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
}: {
  w: Workspace;
  onComplete: () => void;
  onCancel?: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [audience, setAudience] = useState("");
  const [objective, setObjective] = useState("discovery");
  const [metric, setMetric] = useState("");
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
  const lock = useRef(false);
  const profileReceipt = useRef<Profile>();
  const campaignReceipt = useRef<Campaign>();
  const attemptedProfile = useRef<ProfileInput>();
  const attemptedCampaign = useRef<CampaignInput>();
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  const locked = busy || !!campaign || !!uncertain;

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
    let bodies: ReturnType<typeof onboardingBodies>;
    try {
      bodies = onboardingBodies({
        name,
        audience,
        objective,
        metric,
        guardrails,
      });
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Check your workspace details.",
      );
      return;
    }
    lock.current = true;
    setBusy(true);
    setError("");
    let phase: "profile" | "workspace" | "refresh" = "profile";
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
      await w.load(savedCampaign.id);
      w.setProfileId(savedProfile.id);
      onComplete();
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
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <section
      className="gf-onboarding gf-card"
      aria-label="Workspace onboarding"
    >
      <div className="gf-onboarding-intro">
        <span className="gf-eyebrow">YOUR WORKSPACE</span>
        <h2>Start with your audience.</h2>
        <p>
          Set this once for your podcast or brand. You can edit it later in
          Workspace settings.
        </p>
        <ol className="gf-onboarding-loop" aria-label="Factory workflow">
          <li>
            <Icon name="upload" />
            Upload footage
          </li>
          <li>
            <Icon name="studio" />
            Review the cuts
          </li>
          <li>
            <Icon name="results" />
            Learn what to try next
          </li>
        </ol>
      </div>
      <form
        className="gf-onboarding-form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
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
        <Field label="What are we working toward?">
          {(id) => (
            <select
              id={id}
              value={objective}
              disabled={locked}
              onChange={(e) => setObjective(e.target.value)}
            >
              {objectives.map((o) => (
                <option value={o} key={o}>
                  {o === "discovery"
                    ? "Discovery · find what resonates"
                    : o.charAt(0).toUpperCase() + o.slice(1)}
                </option>
              ))}
            </select>
          )}
        </Field>
        {objective !== "discovery" && (
          <Field
            label="Primary metric"
            hint="The measure you want to track. A goal is not a measured result."
          >
            {(id) => (
              <input
                id={id}
                required
                maxLength={200}
                value={metric}
                disabled={locked}
                placeholder="e.g. full_episode_visits"
                onChange={(e) => setMetric(e.target.value)}
              />
            )}
          </Field>
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
        {error && (
          <div className="gf-onboarding-recovery" role="alert">
            <p>{error}</p>
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
        <div className="gf-onboarding-actions">
          {onCancel && !profile && !uncertain && (
            <button
              type="button"
              className="gf-button ghost"
              disabled={busy}
              onClick={onCancel}
            >
              Back
            </button>
          )}
          <PrimaryAction
            label={
              busy
                ? "Saving…"
                : campaign
                  ? "Open workspace"
                  : "Continue to Factory"
            }
            disabled={
              busy ||
              !!uncertain ||
              !name.trim() ||
              !audience.trim() ||
              (objective !== "discovery" && !metric.trim())
            }
            onClick={() => void create()}
          />
        </div>
        <p className="gf-flow-note">
          A local planning profile. No social sign-in or publishing permission
          needed.
        </p>
      </form>
    </section>
  );
}
