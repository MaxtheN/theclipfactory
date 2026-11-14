import { AutoTextarea } from "../components/AutoTextarea";
import { useRef, useState, type ReactNode } from "react";
import { ApiError } from "../api";
import type { FactoryState } from "../useFactory";
import type { Workspace } from "./useCampaignWorkspace";
import { workspaceApi, type CampaignInput } from "./workspaceApi";
import {
  Empty,
  Field,
  FieldGroup,
  PrimaryAction,
  formatTime,
} from "./parts";
import { Icon } from "./Icon";
import { CloudAccountRow } from "./CloudSignIn";
import { objectives, type Campaign, type Profile } from "../types";
import { profileGoalBody } from "./learningState";

/** Human-readable labels for the existing backend objective enum. */
export const objectiveLabels: Record<(typeof objectives)[number], string> = {
  discovery: "Explore and learn (discovery, no primary metric)",
  awareness: "Reach new people (awareness)",
  engagement: "Deeper engagement",
  followers: "Grow followers",
  traffic: "Drive visits, such as full episodes (traffic)",
  leads: "Generate qualified leads",
  sales: "Drive sales",
  custom: "Something else (custom)",
};

type ProfileBody = ReturnType<typeof profileGoalBody>;
type Attempt = {
  profileId: string;
  profile: ProfileBody;
  campaign: CampaignInput;
};
type SaveState =
  | { kind: "idle" }
  | { kind: "saved"; message: string }
  | { kind: "failed"; message: string }
  // Something may have been written. Saving again is blocked until a readback.
  | { kind: "partial" | "unknown"; message: string };

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
/** A definite 4xx rejection means nothing was written by that request. A lost
 * connection, server error or unreadable success body leaves it unknown. */
const uncertain = (error: unknown) =>
  !(error instanceof ApiError) ||
  error.status === 0 ||
  error.status >= 500 ||
  error.status < 400;
const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;
function profileMatches(saved: Profile | undefined, body: ProfileBody) {
  return (
    !!saved &&
    saved.name === body.name &&
    saved.audience === body.audience &&
    saved.brand_context === body.brand_context &&
    saved.creative_preferences === body.creative_preferences &&
    saved.objective === body.objective &&
    (saved.primary_metric ?? null) === body.primary_metric
  );
}
function campaignMatches(saved: Campaign | undefined, body: CampaignInput) {
  return (
    !!saved &&
    saved.name === body.name &&
    saved.brief.audience === body.brief.audience &&
    saved.brief.measurement_intent === body.brief.measurement_intent &&
    JSON.stringify(saved.brief.constraints) ===
      JSON.stringify(body.brief.constraints) &&
    body.profile_ids.every((id) => saved.profile_ids.includes(id)) &&
    body.video_ids.every((id) => saved.video_ids.includes(id))
  );
}

export function Setup({
  w,
  factory,
  next,
  creating,
  onSaved,
  advanced,
}: {
  w: Workspace;
  factory: FactoryState;
  next: () => void;
  creating: boolean;
  onSaved: () => void;
  /** Rarely used workspace actions, shown inside the single Advanced section. */
  advanced?: ReactNode;
}) {
  const campaign = creating ? undefined : w.campaign;
  // The profile being edited is fixed for this mount (GrowthApp keys Setup by
  // campaign and profile). It is never silently replaced by another profile.
  const profile =
    campaign && campaign.profile_ids.includes(w.profileId)
      ? w.profiles.find((p) => p.id === w.profileId)
      : undefined;
  const [name, setName] = useState(campaign?.name || "");
  const [audience, setAudience] = useState(
    campaign?.brief.audience || profile?.audience || "",
  );
  const [objective, setObjective] = useState(profile?.objective || "discovery");
  const [metric, setMetric] = useState(profile?.primary_metric || "");
  const [voice, setVoice] = useState(
    profile?.brand_context ||
      campaign?.brief.constraints.join("\n") ||
      "Preserve the speaker's meaning. Keep captions readable.",
  );
  const [creative, setCreative] = useState(profile?.creative_preferences || "");
  const [linkProfiles, setLinkProfiles] = useState<string[]>([]);
  const [attachSources, setAttachSources] = useState<string[]>([]);
  const [profileName, setProfileName] = useState("");
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const [checking, setChecking] = useState(false);
  const attempt = useRef<Attempt | null>(null);
  const linked = new Set(campaign?.profile_ids || []);
  const attached = new Set(campaign?.video_ids || []);
  const needsReadback = state.kind === "partial" || state.kind === "unknown";
  const blocked =
    w.busy || w.loading || checking || factory.loading || !campaign || !profile;
  const metricNeeded = objective !== "discovery";
  const valid = !!name.trim() && (!metricNeeded || !!metric.trim());

  function edited() {
    if (state.kind === "saved" || state.kind === "failed")
      setState({ kind: "idle" });
  }

  function bodies(latestCampaign: Campaign, latestProfile: Profile) {
    const goal = profileGoalBody(latestProfile, objective, metric);
    const constraints = lines(voice);
    if (constraints.length > 30)
      throw new Error("Use up to 30 voice and boundary lines.");
    if (constraints.some((line) => line.length > 1200))
      throw new Error(
        "Keep each voice or boundary line within 1,200 characters.",
      );
    // Only writable fields; read-only production_history is never sent.
    const profileBody: ProfileBody = {
      ...goal,
      audience: audience.trim(),
      brand_context: voice.trim(),
      creative_preferences: creative.trim(),
    };
    const label = objectiveLabels[objective as keyof typeof objectiveLabels];
    const campaignBody: CampaignInput = {
      name: name.trim(),
      brief: {
        audience: audience.trim(),
        constraints,
        requested_outputs: latestCampaign.brief.requested_outputs,
        measurement_intent:
          objective === "discovery"
            ? "Discovery"
            : `${label}: ${goal.primary_metric}`,
      },
      // Membership is a union with the latest saved record, so footage or
      // profiles attached elsewhere since this screen loaded are retained.
      profile_ids: union(latestCampaign.profile_ids, linkProfiles),
      video_ids: union(latestCampaign.video_ids, attachSources),
    };
    return { profileBody, campaignBody };
  }

  async function save() {
    if (blocked || needsReadback || !valid || !campaign || !profile) return;
    const campaignId = campaign.id,
      profileId = profile.id;
    // Assigned inside the task; casts stop TypeScript narrowing them here.
    let stage = "read" as "read" | "profile" | "campaign" | "readback";
    let started = false as boolean,
      unknownOutcome = false as boolean,
      failure = "" as string;
    const ok = await w.run(async () => {
      started = true;
      try {
        // 1. Latest saved state, never the possibly stale screen copy.
        const [campaigns, profiles] = await Promise.all([
          workspaceApi.campaigns(),
          workspaceApi.profiles(),
        ]);
        const latestCampaign = campaigns.find((c) => c.id === campaignId);
        if (!latestCampaign)
          throw new Error("This channel is no longer available.");
        // 2. The selected profile must still belong to this channel. There is
        // no fallback to another profile.
        const latestProfile = profiles.find((p) => p.id === profileId);
        if (!latestProfile || !latestCampaign.profile_ids.includes(profileId))
          throw new Error(
            "The selected profile is no longer linked to this channel. Refresh and choose a profile.",
          );
        // 3. Strict writable bodies.
        const { profileBody, campaignBody } = bodies(
          latestCampaign,
          latestProfile,
        );
        attempt.current = {
          profileId,
          profile: profileBody,
          campaign: campaignBody,
        };
        // 4. Exact selected profile by ID.
        stage = "profile";
        await workspaceApi.updateProfile(profileId, profileBody);
        // 5. Channel metadata with preserved membership.
        stage = "campaign";
        await workspaceApi.save(campaignBody, campaignId);
        // 6. Confirm by reading back.
        stage = "readback";
        const [savedCampaigns, savedProfiles] = await Promise.all([
          workspaceApi.campaigns(),
          workspaceApi.profiles(),
        ]);
        if (
          !profileMatches(
            savedProfiles.find((p) => p.id === profileId),
            profileBody,
          ) ||
          !campaignMatches(
            savedCampaigns.find((c) => c.id === campaignId),
            campaignBody,
          )
        )
          throw new Error("Saved state did not match your edits.");
      } catch (error) {
        unknownOutcome = stage === "readback" || uncertain(error);
        failure = message(error, "The save failed.");
        throw error;
      }
    }, "Channel settings saved. Style rules and earlier clips are unchanged.");
    if (!started) return;
    if (ok) {
      setLinkProfiles([]);
      setAttachSources([]);
      setState({ kind: "saved", message: "Saved and confirmed." });
      onSaved();
      return;
    }
    // 7. Keep every draft and say exactly what may have been written.
    if (!failure) {
      // Writes were confirmed by readback, but the workspace refresh failed.
      setState({
        kind: "unknown",
        message:
          "Your changes were confirmed, but the workspace could not refresh. Check saved state before saving again.",
      });
      return;
    }
    if (stage === "read")
      setState({
        kind: "failed",
        message: `${failure} Nothing was saved; your edits are still here.`,
      });
    else if (stage === "profile")
      setState(
        unknownOutcome
          ? {
              kind: "unknown",
              message: `${failure} The profile save was not confirmed and may or may not have been written. Check saved state before saving again.`,
            }
          : {
              kind: "failed",
              message: `${failure} The profile was not saved, so nothing changed. Your edits are still here.`,
            },
      );
    else if (stage === "campaign")
      setState(
        unknownOutcome
          ? {
              kind: "unknown",
              message: `${failure} Profile settings saved; the channel details save was not confirmed. Check saved state before saving again.`,
            }
          : {
              kind: "partial",
              message: `${failure} Partially saved: profile settings saved, channel details were not. Check saved state before saving again.`,
            },
      );
    else
      setState({
        kind: "unknown",
        message: `${failure} Your changes were sent but could not be confirmed. Check saved state before saving again.`,
      });
  }

  async function checkSaved() {
    const last = attempt.current;
    if (!last || !campaign || checking) return;
    setChecking(true);
    try {
      const [campaigns, profiles] = await Promise.all([
        workspaceApi.campaigns(),
        workspaceApi.profiles(),
      ]);
      const profileOk = profileMatches(
        profiles.find((p) => p.id === last.profileId),
        last.profile,
      );
      const campaignOk = campaignMatches(
        campaigns.find((c) => c.id === campaign.id),
        last.campaign,
      );
      setState(
        profileOk && campaignOk
          ? {
              kind: "saved",
              message: "Readback confirms every change is saved.",
            }
          : {
              kind: "failed",
              message: `Readback: profile settings ${profileOk ? "saved" : "not saved"}; channel details ${campaignOk ? "saved" : "not saved"}. Your edits are still here; saving again is now safe.`,
            },
      );
      if (profileOk && campaignOk) {
        setLinkProfiles([]);
        setAttachSources([]);
        onSaved();
      }
      await w.load().catch(() => {});
    } catch (error) {
      setState((old) => ({
        kind: old.kind === "partial" ? "partial" : "unknown",
        message: `Could not read saved state: ${message(error, "the service is unavailable")}. Try again before saving.`,
      }));
    } finally {
      setChecking(false);
    }
  }

  async function createProfile() {
    const title = profileName.trim();
    if (!title || blocked) return;
    // Explicit, separate action. It creates one new local profile and only
    // queues it for linking; the channel changes when settings are saved.
    await w.run(async () => {
      const created = await workspaceApi.profile({
        name: title,
        audience: audience.trim(),
        objective: "discovery",
        primary_metric: null,
        brand_context: voice.trim(),
        creative_preferences: creative.trim(),
      });
      setLinkProfiles((old) => union(old, [created.id]));
      setProfileName("");
    }, "Local profile created. Save channel settings to link it. No social account was connected.");
  }

  if (!campaign)
    return (
      <Empty title="No channel selected" icon="settings">
        {w.loading
          ? "Opening your channel…"
          : "Choose a channel from the top bar."}
      </Empty>
    );
  if (!profile)
    return (
      <Empty title="Choose a linked profile" icon="settings">
        This profile isn't linked to the channel. Refresh and pick another;
        nothing changes automatically.
      </Empty>
    );
  const otherLinked = w.profiles.filter(
    (p) => linked.has(p.id) && p.id !== profile.id,
  );
  return (
    <div className="gf-setup-grid gf-channel-settings-grid">
      <section className="gf-card gf-brief" aria-label="Channel settings form">
        <div className="gf-form-fields">
          <CloudAccountRow />
          <FieldGroup title="Your channel">
            <Field label="Channel name">
              {(id) => (
                <AutoTextarea
                  rows={1}
                  id={id}
                  maxLength={200}
                  placeholder="e.g. Founder stories"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    edited();
                  }}
                />
              )}
            </Field>
            <Field label="Who are we speaking to?">
              {(id) => (
                <AutoTextarea
                  rows={1}
                  id={id}
                  maxLength={3000}
                  placeholder="Builders, founders and curious minds"
                  value={audience}
                  onChange={(e) => {
                    setAudience(e.target.value);
                    edited();
                  }}
                />
              )}
            </Field>
            <Field
              label="What are we working toward?"
              hint="Applies to new clips only."
            >
              {(id) => (
                <select
                  id={id}
                  value={objective}
                  onChange={(e) => {
                    setObjective(e.target.value);
                    edited();
                  }}
                >
                  {objectives.map((value) => (
                    <option key={value} value={value}>
                      {objectiveLabels[value]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field
              label="Primary metric"
              hint={
                metricNeeded
                  ? "Required for this goal."
                  : "Not needed while exploring."
              }
            >
              {(id) => (
                <AutoTextarea
                  id={id}
                  rows={1}
                  maxLength={200}
                  value={metricNeeded ? metric : ""}
                  disabled={!metricNeeded}
                  placeholder={
                    metricNeeded
                      ? "e.g. full_episode_visits"
                      : "Not needed for discovery"
                  }
                  onChange={(e) => {
                    setMetric(e.target.value);
                    edited();
                  }}
                />
              )}
            </Field>
            <Field
              label="Voice and boundaries"
              hint="One rule per line."
            >
              {(id) => (
                <AutoTextarea
                  id={id}
                  rows={3}
                  maxLength={4000}
                  value={voice}
                  onChange={(e) => {
                    setVoice(e.target.value);
                    edited();
                  }}
                />
              )}
            </Field>
            <Field label="Creative preferences">
              {(id) => (
                <AutoTextarea
                  id={id}
                  rows={2}
                  maxLength={4000}
                  placeholder="e.g. Lead with a clear claim; keep the context intact."
                  value={creative}
                  onChange={(e) => {
                    setCreative(e.target.value);
                    edited();
                  }}
                />
              )}
            </Field>
            {otherLinked.length > 0 && (
              <p className="gf-help">
                Editing <strong>{profile.name}</strong> only.
              </p>
            )}
          </FieldGroup>
          <details className="gf-disclosure gf-advanced-settings">
            <summary aria-label="Advanced controls">
              <Icon name="settings" />
              Advanced
              <Icon name="down" size={15} />
            </summary>
            <div className="gf-disclosure-body">
              <h3>Episodes in this channel</h3>
              {factory.data.videos.length === 0 && (
                <p className="gf-help">No imported footage yet.</p>
              )}
              <div className="gf-profile-options">
                {factory.data.videos.map((v) => {
                  const on = attached.has(v.id) || attachSources.includes(v.id);
                  return (
                    <label key={v.id} className={on ? "selected" : ""}>
                      <input
                        type="checkbox"
                        aria-label={`Attach ${v.name}`}
                        checked={on}
                        disabled={blocked || attached.has(v.id)}
                        onChange={(e) => {
                          setAttachSources((old) =>
                            e.target.checked
                              ? union(old, [v.id])
                              : old.filter((id) => id !== v.id),
                          );
                          edited();
                        }}
                      />
                      <Icon name="studio" size={14} />
                      {v.name}
                      {typeof v.duration === "number" && (
                        <small> · {formatTime(v.duration)}</small>
                      )}
                    </label>
                  );
                })}
              </div>
              <h3>Linked profiles</h3>
              <div className="gf-profile-options">
                {w.profiles.map((p) => {
                  const on = linked.has(p.id) || linkProfiles.includes(p.id);
                  return (
                    <label key={p.id} className={on ? "selected" : ""}>
                      <input
                        type="checkbox"
                        aria-label={`Link ${p.name}`}
                        checked={on}
                        disabled={blocked || linked.has(p.id)}
                        onChange={(e) => {
                          setLinkProfiles((old) =>
                            e.target.checked
                              ? union(old, [p.id])
                              : old.filter((id) => id !== p.id),
                          );
                          edited();
                        }}
                      />
                      <Icon name="headphones" size={14} />
                      {p.name}
                    </label>
                  );
                })}
              </div>
              <Field label="New profile name">
                {(id) => (
                  <AutoTextarea
                    rows={1}
                    id={id}
                    maxLength={200}
                    placeholder="e.g. Founder stories · clips"
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                  />
                )}
              </Field>
              <button
                type="button"
                className="gf-button secondary compact"
                disabled={!profileName.trim() || blocked}
                onClick={() => void createProfile()}
              >
                Create profile
                <Icon name="plus" size={14} />
              </button>
              {advanced && (
                <>
                  <h3>Workspace</h3>
                  {advanced}
                </>
              )}
            </div>
          </details>
        </div>
      </section>
      <div className="gf-stage-action">
        <span
          role={
            state.kind === "idle"
              ? undefined
              : state.kind === "saved"
                ? "status"
                : "alert"
          }
        >
          {state.kind === "idle"
            ? "Saves this channel only. Nothing is published."
            : state.message}
        </span>
        <div className="gf-channel-actions">
          {needsReadback && (
            <button
              type="button"
              className="gf-button secondary compact"
              disabled={checking || w.busy}
              onClick={() => void checkSaved()}
            >
              {checking ? "Checking…" : "Check saved state"}
              <Icon name="refresh" size={14} />
            </button>
          )}
          <button
            type="button"
            className="gf-button secondary compact"
            disabled={w.busy || checking}
            onClick={next}
          >
            Style rules
            <Icon name="research" size={14} />
          </button>
          <PrimaryAction
            label={w.busy ? "Saving…" : "Save channel settings"}
            intent="approve"
            disabled={blocked || needsReadback || !valid}
            onClick={() => void save()}
          />
        </div>
      </div>
    </div>
  );
}
