import { AutoTextarea } from "../components/AutoTextarea";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, endpoint, post, put } from "../api";
import { Field, Section } from "../components/ui";
import { StructuredData } from "../components/StructuredData";
import type { FactoryState } from "../useFactory";
import {
  objectives,
  type Campaign,
  type Direction,
  type Observation,
  type Profile,
  type StrategyVersion,
} from "../types";
import {
  installedLlms,
  runtimeSatisfied,
  sourceHasActiveJob,
  usableModel,
} from "../productionPreflight";

const lines = (text: string) =>
  text
    .split("\n")
    .map((v) => v.trim())
    .filter(Boolean);
const message = (e: unknown) =>
  e instanceof Error ? e.message : "Request failed.";
const campaignPath = (id: string, action = "") =>
  `/api/campaigns/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");
const validProfile = (p: Profile) =>
  [
    p.name,
    p.audience,
    p.brand_context,
    p.objective,
    p.creative_preferences,
  ].every((v) => typeof v === "string") &&
  (p.primary_metric === null || typeof p.primary_metric === "string");
const validCampaign = (c: Campaign) =>
  typeof c.name === "string" &&
  strings(c.profile_ids) &&
  strings(c.video_ids) &&
  (c.active_strategy_id === null || typeof c.active_strategy_id === "string") &&
  !!c.brief &&
  typeof c.brief.audience === "string" &&
  typeof c.brief.measurement_intent === "string" &&
  strings(c.brief.constraints) &&
  strings(c.brief.requested_outputs);
const validDirection = (d: Direction) =>
  !!d &&
  [
    d.angles,
    d.hooks,
    d.measurement_questions,
    d.next_experiments,
    d.evidence_refs,
  ].every(strings) &&
  [d.moment_selection, d.pacing, d.editing_preferences, d.limitations].every(
    (v) => typeof v === "string",
  ) &&
  Number.isFinite(d.duration_seconds) &&
  d.duration_seconds >= 1 &&
  d.duration_seconds <= 180 &&
  ["fit", "fill"].includes(d.framing) &&
  ["standard", "high_contrast"].includes(d.caption_style) &&
  ["low", "medium", "high"].includes(d.confidence);
const validVersion = (v: StrategyVersion) =>
  typeof v.campaign_id === "string" &&
  Number.isInteger(v.version) &&
  ["proposed", "approved", "rejected"].includes(v.status) &&
  strings(v.changed_profile_ids) &&
  (v.base_version_id === null || typeof v.base_version_id === "string") &&
  !!v.directions &&
  typeof v.directions === "object" &&
  !Array.isArray(v.directions) &&
  Object.values(v.directions).every(validDirection);
const validObservation = (o: Observation) =>
  [
    o.profile_id,
    o.clip_id,
    o.metric,
    o.unit,
    o.publication_reference,
    o.window_start,
    o.window_end,
    o.collected_at,
    o.notes,
  ].every((v) => typeof v === "string") &&
  o.source === "manual_import" &&
  (o.value === null ||
    (typeof o.value === "number" && Number.isFinite(o.value)));
async function list<T extends { id: string }>(
  path: string,
  valid: (row: T) => boolean,
): Promise<T[]> {
  const value = await api<T[]>(path);
  if (
    !Array.isArray(value) ||
    value.some((row) => !row || typeof row.id !== "string" || !valid(row))
  )
    throw new Error(`Invalid list response: ${path}`);
  return value;
}
export const defaultDirection = (): Direction => ({
  angles: [],
  moment_selection: "Choose a self-contained moment with a clear payoff.",
  hooks: [],
  pacing: "Keep a clear setup and payoff; remove dead air.",
  duration_seconds: 30,
  framing: "fit",
  caption_style: "standard",
  editing_preferences: "Preserve meaning; do not invent claims.",
  measurement_questions: [],
  next_experiments: [],
  evidence_refs: [],
  limitations:
    "No performance evidence imported yet. This is a creative hypothesis, not a causal claim.",
  confidence: "low",
});
type Mutate = (
  task: () => Promise<unknown>,
  notice: string,
) => Promise<boolean>;

export function Campaigns({
  state,
  openFactory,
}: {
  state: FactoryState;
  openFactory: () => void;
}) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selected, setSelected] = useState("");
  const [profileId, setProfileId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const alive = useRef(true);
  const generation = useRef(0);
  const lock = useRef(false);
  const reload = useCallback(async () => {
    const token = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const [p, c] = await Promise.all([
        list<Profile>("/api/profiles", validProfile),
        list<Campaign>("/api/campaigns", validCampaign),
      ]);
      if (alive.current && token === generation.current) {
        setProfiles(p);
        setCampaigns(c);
      }
    } catch (e) {
      if (alive.current && token === generation.current) setError(message(e));
      throw e;
    } finally {
      if (alive.current && token === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    state.dismiss();
    void reload().catch(() => {});
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, [reload]);
  const blocked = loading || !!error || working || state.busy;
  const mutate: Mutate = async (task, notice) => {
    if (blocked || lock.current) return false;
    lock.current = true;
    setWorking(true);
    state.dismiss();
    try {
      return await state.run(async () => {
        try {
          await task();
          await reload();
        } catch (e) {
          if (alive.current) setError(message(e));
          throw e;
        }
      }, notice);
    } catch (e) {
      if (alive.current) setError(message(e));
      return false;
    } finally {
      lock.current = false;
      if (alive.current) setWorking(false);
    }
  };
  const current = campaigns.find((c) => c.id === selected);
  return (
    <div className="campaign-workflow">
      <div className="banner">
        <strong>Intent → proposal → approval → production → evidence</strong>
        <span>
          Profile context is editable. Historic clip snapshots are not
          rewritten.
        </span>
      </div>
      {loading && <p role="status">Loading campaign resources…</p>}
      {error && (
        <div className="banner error" role="alert">
          Campaign resources unavailable: {error}. Writes are blocked; an
          accepted request may need reconciliation.
        </div>
      )}
      <button
        className="secondary small"
        disabled={loading || working || state.busy}
        onClick={() => {
          state.dismiss();
          void reload().catch(() => {});
        }}
      >
        Reload campaigns and profiles
      </button>
      <div className="two-col">
        <Section
          title="Saved profiles"
          detail="Save distinct audiences and creative context; reuse them across campaigns."
        >
          <Field label="Edit saved profile">
            <select
              disabled={blocked}
              value={profileId}
              onChange={(e) => {
                state.dismiss();
                setProfileId(e.target.value);
              }}
            >
              <option value="">New profile</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <ProfileForm
            key={profileId}
            profile={profiles.find((p) => p.id === profileId)}
            blocked={blocked}
            mutate={mutate}
          />
        </Section>
        <Section
          title="Campaign brief"
          detail="Attach multiple profiles and source videos. Sources remain in Library."
        >
          <Field label="Selected campaign">
            <select
              disabled={blocked}
              value={selected}
              onChange={(e) => {
                state.dismiss();
                setSelected(e.target.value);
              }}
            >
              <option value="">New campaign</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <CampaignForm
            key={selected}
            campaign={current}
            profiles={profiles}
            state={state}
            blocked={blocked}
            mutate={mutate}
            onCreated={setSelected}
          />
        </Section>
      </div>
      {current && (
        <CampaignWorkspace
          key={current.id}
          campaign={current}
          profiles={profiles}
          state={state}
          blocked={blocked}
          mutate={mutate}
          openFactory={openFactory}
        />
      )}
    </div>
  );
}
function ProfileForm({
  profile,
  blocked,
  mutate,
}: {
  profile?: Profile;
  blocked: boolean;
  mutate: Mutate;
}) {
  const [draft, setDraft] = useState<Omit<Profile, "id">>(
    profile || {
      name: "",
      audience: "",
      brand_context: "",
      objective: "discovery",
      primary_metric: null,
      creative_preferences: "",
    },
  );
  const text = (
    key: "name" | "audience" | "brand_context" | "creative_preferences",
    label: string,
  ) => (
    <Field label={label}>
      <AutoTextarea
        required={key === "name" || key === "audience"}
        rows={2}
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      />
    </Field>
  );
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (blocked) return;
        const {
          name,
          audience,
          brand_context,
          objective,
          primary_metric,
          creative_preferences,
        } = draft;
        await mutate(
          () =>
            profile
              ? put(`/api/profiles/${encodeURIComponent(profile.id)}`, {
                  name,
                  audience,
                  brand_context,
                  objective,
                  primary_metric:
                    objective === "discovery" ? null : primary_metric,
                  creative_preferences,
                })
              : post("/api/profiles", {
                  name,
                  audience,
                  brand_context,
                  objective,
                  primary_metric:
                    objective === "discovery" ? null : primary_metric,
                  creative_preferences,
                }),
          "Profile saved; existing production snapshots are unchanged.",
        );
      }}
    >
      <fieldset disabled={blocked}>
        {text("name", "Profile name")}
        {text("audience", "Profile audience")}
        {text("brand_context", "Brand context")}
        <Field label="Profile objective">
          <select
            value={draft.objective}
            onChange={(e) =>
              setDraft({
                ...draft,
                objective: e.target.value,
                primary_metric:
                  e.target.value === "discovery" ? null : draft.primary_metric,
              })
            }
          >
            {objectives.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </Field>
        <Field
          label="Primary metric"
          hint="Discovery has no primary metric. Other objectives require one."
        >
          <input
            disabled={draft.objective === "discovery"}
            required={draft.objective !== "discovery"}
            value={draft.primary_metric || ""}
            onChange={(e) =>
              setDraft({ ...draft, primary_metric: e.target.value })
            }
          />
        </Field>
        {text("creative_preferences", "Creative preferences")}
        <button>{profile ? "Save profile context" : "Create profile"}</button>
      </fieldset>
    </form>
  );
}
function CampaignForm({
  campaign,
  profiles,
  state,
  blocked,
  mutate,
  onCreated,
}: {
  campaign?: Campaign;
  profiles: Profile[];
  state: FactoryState;
  blocked: boolean;
  mutate: Mutate;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState(campaign?.name || "");
  const [brief, setBrief] = useState(
    campaign?.brief || {
      audience: "",
      constraints: [],
      requested_outputs: [],
      measurement_intent: "",
    },
  );
  const [profileIds, setProfileIds] = useState(campaign?.profile_ids || []);
  const [videoIds, setVideoIds] = useState(campaign?.video_ids || []);
  const stale = state.loading || !!state.errors.videos;
  const toggle = (ids: string[], id: string) =>
    ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id];
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (blocked || stale || !profileIds.length || !videoIds.length) return;
        let saved: Campaign | undefined;
        if (
          await mutate(async () => {
            const payload = {
              name,
              brief,
              profile_ids: profileIds,
              video_ids: videoIds,
            };
            saved = campaign
              ? await put<Campaign>(campaignPath(campaign.id), payload)
              : await post<Campaign>("/api/campaigns", payload);
            if (!saved?.id)
              throw new Error(
                "Invalid campaign response; reload before retrying.",
              );
          }, "Campaign saved.")
        ) {
          if (saved) onCreated(saved.id);
        }
      }}
    >
      <fieldset disabled={blocked || stale}>
        <Field label="Campaign name">
          <AutoTextarea
            rows={1}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Campaign audience">
          <AutoTextarea
            rows={2}
            value={brief.audience}
            onChange={(e) => setBrief({ ...brief, audience: e.target.value })}
          />
        </Field>
        <Field label="Constraints (one per line)">
          <AutoTextarea
            rows={2}
            value={brief.constraints.join("\n")}
            onChange={(e) =>
              setBrief({ ...brief, constraints: e.target.value.split("\n") })
            }
          />
        </Field>
        <Field label="Requested outputs (one per line)">
          <AutoTextarea
            rows={2}
            value={brief.requested_outputs.join("\n")}
            onChange={(e) =>
              setBrief({
                ...brief,
                requested_outputs: e.target.value.split("\n"),
              })
            }
          />
        </Field>
        <Field label="Measurement intent">
          <AutoTextarea
            rows={2}
            value={brief.measurement_intent}
            onChange={(e) =>
              setBrief({ ...brief, measurement_intent: e.target.value })
            }
          />
        </Field>
        <h3>Campaign profiles</h3>
        {profiles.map((p) => (
          <label className="check" key={p.id}>
            <input
              type="checkbox"
              checked={profileIds.includes(p.id)}
              onChange={() => setProfileIds(toggle(profileIds, p.id))}
            />
            {p.name}
          </label>
        ))}
        <h3>Campaign source videos</h3>
        {state.data.videos.map((v) => (
          <label className="check" key={v.id}>
            <input
              type="checkbox"
              checked={videoIds.includes(v.id)}
              onChange={() => setVideoIds(toggle(videoIds, v.id))}
            />
            {v.name}
          </label>
        ))}
        <p className="muted">
          At least one saved profile and one source are required.
        </p>
        <button disabled={!profileIds.length || !videoIds.length}>
          {campaign ? "Save campaign" : "Create campaign"}
        </button>
      </fieldset>
      {stale && (
        <p role="alert">
          Source data unavailable; refresh the workspace before saving.
        </p>
      )}
    </form>
  );
}
function DirectionEditor({
  direction,
  onChange,
}: {
  direction: Direction;
  onChange: (d: Direction) => void;
}) {
  const textFields = {
    moment_selection: "Moment selection rules",
    pacing: "Pacing",
    editing_preferences: "Editing preferences",
    limitations: "Evidence limitations",
  } as const;
  const arrayFields = {
    angles: "Angles",
    hooks: "Hooks",
    measurement_questions: "Measurement questions",
    next_experiments: "Next experiments",
    evidence_refs: "Evidence references",
  } as const;
  return (
    <div className="direction-editor">
      {Object.entries(textFields).map(([key, label]) => (
        <Field key={key} label={label}>
          <AutoTextarea
            required={key === "moment_selection" || key === "limitations"}
            rows={2}
            value={direction[key as keyof typeof textFields]}
            onChange={(e) => onChange({ ...direction, [key]: e.target.value })}
          />
        </Field>
      ))}
      {Object.entries(arrayFields).map(([key, label]) => (
        <Field key={key} label={`${label} (one per line)`}>
          <AutoTextarea
            rows={2}
            value={direction[key as keyof typeof arrayFields].join("\n")}
            onChange={(e) =>
              onChange({ ...direction, [key]: e.target.value.split("\n") })
            }
          />
        </Field>
      ))}
      <div className="form-grid">
        <Field label="Target duration (seconds)">
          <input
            required
            type="number"
            min={1}
            max={180}
            value={direction.duration_seconds}
            onChange={(e) =>
              onChange({
                ...direction,
                duration_seconds: Number(e.target.value),
              })
            }
          />
        </Field>
        <Field label="Framing">
          <select
            value={direction.framing}
            onChange={(e) =>
              onChange({
                ...direction,
                framing: e.target.value as Direction["framing"],
              })
            }
          >
            <option value="fit">Fit · retain frame</option>
            <option value="fill">Fill · crop frame</option>
          </select>
        </Field>
        <Field label="Caption style">
          <select
            value={direction.caption_style}
            onChange={(e) =>
              onChange({
                ...direction,
                caption_style: e.target.value as Direction["caption_style"],
              })
            }
          >
            <option value="standard">Standard</option>
            <option value="high_contrast">High contrast</option>
          </select>
        </Field>
        <Field label="Confidence">
          <select
            value={direction.confidence}
            onChange={(e) =>
              onChange({
                ...direction,
                confidence: e.target.value as Direction["confidence"],
              })
            }
          >
            {["low", "medium", "high"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </Field>
      </div>
    </div>
  );
}
const cleanDirection = (d: Direction): Direction => ({
  ...d,
  angles: lines(d.angles.join("\n")),
  hooks: lines(d.hooks.join("\n")),
  measurement_questions: lines(d.measurement_questions.join("\n")),
  next_experiments: lines(d.next_experiments.join("\n")),
  evidence_refs: lines(d.evidence_refs.join("\n")),
});
function CampaignWorkspace({
  campaign,
  profiles,
  state,
  blocked,
  mutate,
  openFactory,
}: {
  campaign: Campaign;
  profiles: Profile[];
  state: FactoryState;
  blocked: boolean;
  mutate: Mutate;
  openFactory: () => void;
}) {
  const [versions, setVersions] = useState<StrategyVersion[]>([]);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [profileId, setProfileId] = useState(campaign.profile_ids[0] || "");
  const selectedProfile = campaign.profile_ids.includes(profileId)
    ? profileId
    : campaign.profile_ids[0] || "";
  const alive = useRef(true);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const token = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const [s, o] = await Promise.all([
        list<StrategyVersion>(
          campaignPath(campaign.id, "strategies"),
          validVersion,
        ),
        list<Observation>(
          campaignPath(campaign.id, "observations"),
          validObservation,
        ),
      ]);
      if (alive.current && generation.current === token) {
        setVersions(s);
        setObservations(o);
      }
    } catch (e) {
      if (alive.current && generation.current === token) setError(message(e));
      throw e;
    } finally {
      if (alive.current && generation.current === token) setLoading(false);
    }
  }, [campaign.id]);
  useEffect(() => {
    alive.current = true;
    state.dismiss();
    void reload().catch(() => {});
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, [reload]);
  const unavailable = blocked || loading || !!error;
  const act: Mutate = async (task, notice) => {
    if (unavailable) return false;
    return mutate(async () => {
      try {
        await task();
        await reload();
      } catch (e) {
        if (alive.current) setError(message(e));
        throw e;
      }
    }, notice);
  };
  const active = versions.find(
    (v) => v.id === campaign.active_strategy_id && v.status === "approved",
  );
  const campaignProfiles = campaign.profile_ids
    .map((id) => profiles.find((p) => p.id === id))
    .filter((p): p is Profile => !!p);
  const clips = state.data.clips.filter((c) => c.campaign_id === campaign.id);
  return (
    <>
      <Section
        title={`Strategy · ${campaign.name}`}
        detail="Proposals do not change production until explicitly approved. Revisions require the exact active base."
      >
        {loading && (
          <p role="status">Loading strategy versions and evidence…</p>
        )}
        {error && (
          <div className="banner error" role="alert">
            Strategy/evidence unavailable: {error}. No writes until reload
            succeeds.
          </div>
        )}
        <button
          className="secondary small"
          disabled={state.busy || loading}
          onClick={() => {
            state.dismiss();
            void reload().catch(() => {});
          }}
        >
          Reload strategy and evidence
        </button>
        <p className="banner">
          {active
            ? `Production uses approved version ${active.version} (${active.id}).`
            : "No active approved strategy. Production and learning are blocked."}
        </p>
        <ProposalForm
          key={`${active?.id || "initial"}:${campaign.profile_ids.join(",")}`}
          campaign={campaign}
          profiles={campaignProfiles}
          active={active}
          blocked={unavailable || (!!campaign.active_strategy_id && !active)}
          mutate={act}
        />
        <h3>Version history</h3>
        {versions.length === 0 && !loading && (
          <p className="muted">No strategy proposals yet.</p>
        )}
        <div className="campaign-version-list">
          {[...versions]
            .sort((a, b) => b.version - a.version)
            .map((v) => (
              <VersionCard
                key={v.id}
                version={v}
                activeId={campaign.active_strategy_id}
                profileId={selectedProfile}
                campaign={campaign}
                profiles={profiles}
                blocked={unavailable}
                mutate={act}
              />
            ))}
        </div>
      </Section>
      <Section
        title="Produce from approved direction"
        detail="Select any attached source; clip provenance retains its production-time version."
      >
        <ProductionForm
          key={`${active?.id}:${campaign.video_ids.join(",")}:${selectedProfile}`}
          campaign={campaign}
          profiles={profiles}
          profileId={selectedProfile}
          active={active}
          state={state}
          blocked={unavailable}
          mutate={act}
        />
        <button className="secondary small" onClick={openFactory}>
          Open Factory · optional agents, ledger and clip review
        </button>
      </Section>
      <Section
        title="Profile evidence and learning"
        detail="Import real observations; blank values stay unknown. A hypothesis is not a causal winner claim."
      >
        <Field label="Working profile">
          <select
            disabled={unavailable}
            value={selectedProfile}
            onChange={(e) => {
              state.dismiss();
              setProfileId(e.target.value);
            }}
          >
            {campaignProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <EvidenceForm
          key={`${selectedProfile}:${active?.id || "none"}`}
          campaign={campaign}
          profileId={selectedProfile}
          observations={observations.filter(
            (o) => o.profile_id === selectedProfile,
          )}
          active={active}
          state={state}
          blocked={unavailable}
          mutate={act}
        />
      </Section>
      <Section
        title="Linked clips and snapshots"
        detail="Only clips assigned to this campaign appear here. Legacy unassigned outputs remain in Factory."
      >
        {state.errors.clips && (
          <p role="alert">Clip data unavailable; refresh workspace.</p>
        )}
        <div className="clip-grid">
          {clips.map((clip) => (
            <article className="clip-card" key={clip.id}>
              <video
                className="clip-player"
                controls
                preload="metadata"
                src={endpoint("clips", clip.id, "media")}
                aria-label={`Campaign clip preview ${clip.name}`}
              />
              <div className="clip-content">
                <h3>{clip.name}</h3>
                <p>
                  {profiles.find((p) => p.id === clip.profile_id)?.name ||
                    clip.profile_id}{" "}
                  · source{" "}
                  {state.data.videos.find((v) => v.id === clip.video_id)
                    ?.name || clip.video_id}
                </p>
                <p>
                  Strategy version:{" "}
                  {versions.find((v) => v.id === clip.strategy_version_id)
                    ?.version ??
                    clip.strategy_version_id ??
                    "Not assigned"}{" "}
                  · {clip.provenance_mode || "Unknown provenance"} ·{" "}
                  {clip.approved ? "Approved clip" : "Needs human review"}
                </p>
                <details>
                  <summary>Inspect production snapshot and edit plan</summary>
                  <StructuredData
                    value={{
                      strategy_snapshot: clip.strategy_snapshot,
                      edit_plan: clip.edit_plan,
                      creator_instructions: clip.creator_instructions,
                    }}
                  />
                </details>
                <button className="secondary small" onClick={openFactory}>
                  Review and approve in Factory
                </button>
              </div>
            </article>
          ))}
        </div>
        {!clips.length && (
          <p className="muted">
            No linked clips yet. Approval of a strategy does not approve its
            outputs.
          </p>
        )}
      </Section>
    </>
  );
}
function ProposalForm({
  campaign,
  profiles,
  active,
  blocked,
  mutate,
}: {
  campaign: Campaign;
  profiles: Profile[];
  active?: StrategyVersion;
  blocked: boolean;
  mutate: Mutate;
}) {
  const [directions, setDirections] = useState<Record<string, Direction>>(() =>
    Object.fromEntries(
      profiles.map((p) => [
        p.id,
        active?.directions[p.id] || defaultDirection(),
      ]),
    ),
  );
  const [included, setIncluded] = useState<string[]>(
    active ? [profiles[0]?.id].filter(Boolean) : profiles.map((p) => p.id),
  );
  const [reason, setReason] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (blocked || !included.length) return;
        void mutate(
          () =>
            post(campaignPath(campaign.id, "strategies"), {
              directions: Object.fromEntries(
                included.map((id) => [id, cleanDirection(directions[id])]),
              ),
              reason,
              base_version_id: active?.id || null,
            }),
          "Strategy proposed. Explicit approval is still required.",
        );
      }}
    >
      <fieldset disabled={blocked}>
        <Field label="Proposal reason">
          <AutoTextarea
            rows={2}
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        {profiles.map((p) => (
          <div className="campaign-direction" key={p.id}>
            <h3>{p.name} · direction</h3>
            {active && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={included.includes(p.id)}
                  onChange={(e) =>
                    setIncluded(
                      e.target.checked
                        ? [...included, p.id]
                        : included.filter((id) => id !== p.id),
                    )
                  }
                />
                Revise {p.name}
              </label>
            )}
            {included.includes(p.id) && (
              <DirectionEditor
                direction={directions[p.id]}
                onChange={(d) => setDirections({ ...directions, [p.id]: d })}
              />
            )}
          </div>
        ))}
        <button
          disabled={
            !included.length || profiles.length !== campaign.profile_ids.length
          }
        >
          {active
            ? "Propose selected profile revision"
            : "Propose initial strategy"}
        </button>
      </fieldset>
    </form>
  );
}
function VersionCard({
  version: v,
  activeId,
  profileId,
  campaign,
  profiles,
  blocked,
  mutate,
}: {
  version: StrategyVersion;
  profiles: Profile[];
  activeId: string | null;
  profileId: string;
  campaign: Campaign;
  blocked: boolean;
  mutate: Mutate;
}) {
  const [reason, setReason] = useState("");
  const [restoreProfile, setRestoreProfile] = useState(profileId);
  const path = campaignPath(
    campaign.id,
    `strategies/${encodeURIComponent(v.id)}`,
  );
  const exactBase = v.base_version_id === activeId;
  return (
    <article className="campaign-version">
      <h4>
        Version {v.version} · {v.status}
        {v.id === activeId ? " · ACTIVE" : ""}
      </h4>
      <p>{v.reason}</p>
      <p className="muted">
        {v.id} · base {v.base_version_id || "initial"} · created {v.created_at}{" "}
        · approved {v.approved_at || "not approved"}
      </p>
      <p>
        Changed profiles: {v.changed_profile_ids.join(", ")}{" "}
        {v.hypothesis && `· Hypothesis: ${v.hypothesis}`}
      </p>
      <details>
        <summary>Inspect version directions and evidence</summary>
        <StructuredData value={v.directions} />
      </details>
      <fieldset disabled={blocked}>
        {v.status === "proposed" && (
          <>
            <p className="muted">
              Approval applies this complete version to production.{" "}
              {exactBase
                ? ""
                : "Stale base: create a new proposal from the current active version."}
            </p>
            <button
              disabled={!exactBase}
              onClick={() =>
                void mutate(
                  () => post(`${path}/approve`, {}),
                  "Strategy approved for future production only.",
                )
              }
            >
              Approve version {v.version}
            </button>
          </>
        )}
        <Field label={`Reason for version ${v.version} action`}>
          <AutoTextarea rows={1} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {v.status === "proposed" && (
          <button
            className="secondary small"
            disabled={!reason.trim()}
            onClick={() =>
              void mutate(
                () => post(`${path}/reject`, { reason }),
                "Proposal rejected; active production strategy unchanged.",
              )
            }
          >
            Reject version {v.version}
          </button>
        )}
        {v.status === "approved" && (
          <>
            <Field label={`Restore profile from version ${v.version}`}>
              <select
                value={
                  campaign.profile_ids.includes(restoreProfile)
                    ? restoreProfile
                    : profileId
                }
                onChange={(e) => setRestoreProfile(e.target.value)}
              >
                {campaign.profile_ids
                  .filter((id) => v.directions[id])
                  .map((id) => (
                    <option key={id} value={id}>
                      {profiles.find((p) => p.id === id)?.name || id}
                    </option>
                  ))}
              </select>
            </Field>
            <button
              className="secondary small"
              disabled={
                !reason.trim() || !activeId || !v.directions[restoreProfile]
              }
              onClick={() =>
                void mutate(
                  () =>
                    post(`${path}/restore`, {
                      profile_id: restoreProfile,
                      reason,
                    }),
                  "Selected profile restoration proposed; explicit approval required.",
                )
              }
            >
              Propose restoration from version {v.version}
            </button>
          </>
        )}
      </fieldset>
    </article>
  );
}
function ProductionForm({
  campaign,
  profiles,
  profileId,
  active,
  state,
  blocked,
  mutate,
}: {
  campaign: Campaign;
  profileId: string;
  profiles: Profile[];
  active?: StrategyVersion;
  state: FactoryState;
  blocked: boolean;
  mutate: Mutate;
}) {
  const [videoId, setVideoId] = useState(campaign.video_ids[0] || "");
  const [productionProfile, setProductionProfile] = useState(profileId);
  const [mode, setMode] = useState<"strategy" | "direct">("strategy");
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState("");
  const [hook, setHook] = useState("");
  const [caption, setCaption] = useState("");
  const [instructions, setInstructions] = useState("");
  const [pickedModel, setModelId] = useState("qwen-small");
  const llms = installedLlms(state.data.models, { needsVision: true });
  const modelId = usableModel(pickedModel, llms);
  const source = state.data.videos.find((v) => v.id === videoId);
  const busySource = sourceHasActiveJob(state.data.jobs, videoId);
  const rendererReady =
    !state.errors.system &&
    state.data.system?.ffmpeg === true &&
    state.data.system?.ffprobe === true;
  const ready =
    rendererReady &&
    !blocked &&
    !state.loading &&
    !state.errors.videos &&
    !state.errors.jobs &&
    !!active?.directions[productionProfile] &&
    !!source &&
    !busySource &&
    campaign.video_ids.includes(videoId) &&
    campaign.profile_ids.includes(productionProfile);
  const agentReady =
    ready &&
    !state.errors.models &&
    !state.errors.system &&
    runtimeSatisfied(
      state.data.system?.model_runtime,
      modelId,
      !!source?.has_audio && !source.transcript,
    ) &&
    llms.some((m) => m.id === modelId) &&
    (!source?.has_audio ||
      !!source.transcript ||
      state.data.models.some(
        (m) => m.id === "whisper-turbo" && m.installed === true,
      ));
  const rangeValid =
    Number.isFinite(Number(start)) &&
    Number(start) >= 0 &&
    (end === "" ||
      (Number.isFinite(Number(end)) && Number(end) > Number(start))) &&
    (source?.duration == null ||
      (Number(start) < source.duration &&
        (end === "" || Number(end) <= source.duration)));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || !rangeValid || (mode === "direct" && !end)) return;
        void mutate(
          () =>
            post(campaignPath(campaign.id, "render"), {
              expected_strategy_version_id: active!.id,
              video_id: videoId,
              profile_id: productionProfile,
              start: Number(start),
              end: end === "" ? null : Number(end),
              hook: hook.trim() || null,
              caption,
              subtitles: true,
              mode,
              instructions,
            }),
          "Campaign render queued with the approved strategy snapshot. Review the output in Factory.",
        );
      }}
    >
      <fieldset disabled={blocked}>
        <Field label="Production source">
          <select value={videoId} onChange={(e) => setVideoId(e.target.value)}>
            {campaign.video_ids.map((id) => (
              <option key={id} value={id}>
                {state.data.videos.find((v) => v.id === id)?.name || id}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Production profile">
          <select
            value={productionProfile}
            onChange={(e) => setProductionProfile(e.target.value)}
          >
            {campaign.profile_ids.map((id) => (
              <option key={id} value={id}>
                {profiles.find((p) => p.id === id)?.name || id}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Production mode">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="strategy">Approved strategy target</option>
            <option value="direct">
              Direct explicit range · deviation recorded
            </option>
          </select>
        </Field>
        <div className="form-grid">
          <Field label="Start seconds">
            <input
              required
              type="number"
              min={0}
              step="0.1"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </Field>
          <Field
            label="End seconds"
            hint="Blank in strategy mode uses the approved target duration."
          >
            <input
              required={mode === "direct"}
              type="number"
              min={0}
              step="0.1"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Hook override" hint="Blank uses strategy hook selection.">
          <AutoTextarea rows={1} value={hook} onChange={(e) => setHook(e.target.value)} />
        </Field>
        <Field label="Output caption">
          <AutoTextarea
            rows={2}
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
          />
        </Field>
        <Field label="Creator instructions">
          <AutoTextarea
            rows={2}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </Field>
        <p className="muted">
          Subtitles enabled. Strategy duration, framing, captions and hook are
          applied by the renderer. No automatic publication.
        </p>
        {!ready && (
          <p className="render-warning">
            Requires active approved direction, fresh source/queue data, an idle
            selected source, and available FFmpeg/ffprobe. Check Models for
            unavailable local prerequisites.
          </p>
        )}
        <button disabled={!ready || !rangeValid || (mode === "direct" && !end)}>
          Render campaign clip
        </button>
        <Field
          label="Campaign agent model"
          hint="Local agents select source-backed moments using this profile's approved direction. Direct range and free-text instructions above are not supplied to this action."
        >
          <select value={modelId} onChange={(e) => setModelId(e.target.value)}>
            {!llms.some((m) => m.id === modelId) && (
              <option value={modelId}>{modelId} (not installed)</option>
            )}
            {llms.map((m) => (
              <option value={m.id} key={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <button
          type="button"
          className="secondary"
          disabled={!agentReady}
          onClick={() => {
            if (!agentReady || !active) return;
            void mutate(
              () =>
                post(campaignPath(campaign.id, "produce"), {
                  expected_strategy_version_id: active.id,
                  video_id: videoId,
                  profile_id: productionProfile,
                  model_id: modelId,
                  revision_budget: 2,
                }),
              "Campaign agent team queued with approved scoped direction. Inspect handoffs in Factory; human review is still required.",
            );
          }}
        >
          Run campaign agent team
        </button>
        {!agentReady && (
          <p className="muted">
            Agent production additionally requires installed local models and
            runtime; deterministic rendering does not.
          </p>
        )}
      </fieldset>
    </form>
  );
}
function EvidenceForm({
  campaign,
  profileId,
  observations,
  active,
  state,
  blocked,
  mutate,
}: {
  campaign: Campaign;
  profileId: string;
  observations: Observation[];
  active?: StrategyVersion;
  state: FactoryState;
  blocked: boolean;
  mutate: Mutate;
}) {
  const clips = state.data.clips.filter(
    (c) =>
      c.campaign_id === campaign.id && c.profile_id === profileId && c.approved,
  );
  const [clipId, setClipId] = useState("");
  const [metric, setMetric] = useState("");
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState("");
  const [reference, setReference] = useState("");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [collectedAt, setCollectedAt] = useState("");
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [hypothesis, setHypothesis] = useState("");
  const [reason, setReason] = useState("");
  const [direction, setDirection] = useState(
    active?.directions[profileId] || defaultDirection(),
  );
  const clipReady =
    !state.loading && !state.errors.clips && clips.some((c) => c.id === clipId);
  const datesValid =
    [windowStart, windowEnd, collectedAt].every(
      (d) => d && Number.isFinite(Date.parse(d)),
    ) &&
    Date.parse(windowStart) <= Date.parse(windowEnd) &&
    Date.parse(collectedAt) >= Date.parse(windowEnd);
  const valueValid = value.trim() === "" || Number.isFinite(Number(value));
  const selectedIds = selected.filter((id) =>
    observations.some((o) => o.id === id),
  );
  return (
    <div className="two-col">
      <div>
        <h3>Import manual observation</h3>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (blocked || !clipReady || !datesValid || !valueValid) return;
            if (
              await mutate(
                () =>
                  post(campaignPath(campaign.id, "observations"), {
                    clip_id: clipId,
                    metric,
                    value: value.trim() === "" ? null : Number(value),
                    unit,
                    publication_reference: reference,
                    window_start: new Date(windowStart).toISOString(),
                    window_end: new Date(windowEnd).toISOString(),
                    collected_at: new Date(collectedAt).toISOString(),
                    notes,
                  }),
                "Real manual observation imported; unknown values remain null.",
              )
            )
              setValue("");
          }}
        >
          <fieldset disabled={blocked || state.loading || !!state.errors.clips}>
            <Field label="Approved evidence clip">
              <select
                required
                value={clipId}
                onChange={(e) => setClipId(e.target.value)}
              >
                <option value="">Select approved clip</option>
                {clips.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Observation metric">
              <input
                required
                value={metric}
                onChange={(e) => setMetric(e.target.value)}
              />
            </Field>
            <Field
              label="Observed value"
              hint="Leave blank for unknown, never a fabricated zero. Enter 0 only if actually measured."
            >
              <input
                type="number"
                step="any"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </Field>
            <Field label="Metric unit">
              <input
                required
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
              />
            </Field>
            <Field label="Publication reference">
              <input
                required
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </Field>
            <Field label="Observation window start">
              <input
                required
                type="datetime-local"
                value={windowStart}
                onChange={(e) => setWindowStart(e.target.value)}
              />
            </Field>
            <Field label="Observation window end">
              <input
                required
                type="datetime-local"
                value={windowEnd}
                onChange={(e) => setWindowEnd(e.target.value)}
              />
            </Field>
            <Field label="Collected at">
              <input
                required
                type="datetime-local"
                value={collectedAt}
                onChange={(e) => setCollectedAt(e.target.value)}
              />
            </Field>
            <Field label="Observation notes">
              <AutoTextarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>
            <p className="muted">
              Times are entered in your local timezone and sent as ISO
              timestamps. Collection must follow the measurement window.
            </p>
            <button disabled={!clipReady || !datesValid || !valueValid}>
              Import real observation
            </button>
          </fieldset>
        </form>
        {!clips.length && (
          <p className="render-warning">
            Approve a linked clip for this profile in Factory before importing
            evidence.
          </p>
        )}
        <h3>Imported evidence · manual_import</h3>
        {!observations.length && (
          <p className="muted">No real observations for this profile yet.</p>
        )}
        {observations.map((o) => (
          <article className="campaign-observation" key={o.id}>
            <label className="check">
              <input
                type="checkbox"
                disabled={blocked}
                checked={selected.includes(o.id)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, o.id]
                      : selected.filter((id) => id !== o.id),
                  )
                }
              />
              Use {o.metric}: {o.value === null ? "Unknown" : o.value} {o.unit}{" "}
              · clip {o.clip_id}
            </label>
            <p>
              {o.publication_reference} · {o.source}
            </p>
            <p className="muted">
              {o.window_start} → {o.window_end} · collected {o.collected_at}
            </p>
            <p>{o.notes}</p>
            <small>Evidence ID: {o.id}</small>
          </article>
        ))}
      </div>
      <div>
        <h3>Propose selected-profile learning</h3>
        <p className="muted">
          Only this profile changes. Other profile directions are preserved by
          the server. Evidence supports a testable hypothesis, not proof of
          causality.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (
              blocked ||
              !active?.directions[profileId] ||
              !selectedIds.length
            )
              return;
            const proposed = cleanDirection(direction);
            void mutate(
              () =>
                post(campaignPath(campaign.id, "learning"), {
                  profile_id: profileId,
                  observation_ids: selectedIds,
                  hypothesis,
                  reason,
                  base_version_id: active.id,
                  proposed_direction: {
                    ...proposed,
                    evidence_refs: [
                      ...new Set([...proposed.evidence_refs, ...selectedIds]),
                    ],
                  },
                }),
              "Learning revision proposed for the selected profile. No causal winner is claimed; explicit approval required.",
            );
          }}
        >
          <fieldset disabled={blocked || !active?.directions[profileId]}>
            <Field label="Learning hypothesis">
              <AutoTextarea
                rows={2}
                required
                value={hypothesis}
                onChange={(e) => setHypothesis(e.target.value)}
              />
            </Field>
            <Field label="Learning reason">
              <AutoTextarea
                rows={2}
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <DirectionEditor direction={direction} onChange={setDirection} />
            <p className="muted">
              {selectedIds.length} selected observation(s) · base{" "}
              {active?.id || "no approved strategy"}
            </p>
            <button
              disabled={!selectedIds.length || !active?.directions[profileId]}
            >
              Propose learning revision
            </button>
          </fieldset>
        </form>
      </div>
    </div>
  );
}
