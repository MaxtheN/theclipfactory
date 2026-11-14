import { AutoTextarea } from "../components/AutoTextarea";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { AiModelCard } from "./AiModelCard";
import { PanelDialog } from "./PanelDialog";
import { EngineSetup } from "./EngineSetup";
import "./brand-profile.css";
import { objectives, type BrandKit, type Campaign, type Profile } from "../types";
import { campaignGoalBody } from "./learningState";
import { CampaignBriefEditor } from "./CampaignBrief";
import { sameBrief } from "./briefModel";
import {
  briefFromDraft,
  editableFrom,
  statusLine,
  websiteBriefApi,
  type Research as SiteResearch,
} from "./websiteBriefApi";

/** The brand's website, remembered on this Mac (the backend brand has no URL field). */
const websiteKey = (profileId: string) => `gf-brand-website:${profileId}`;
export function rememberWebsite(profileId: string, url: string) {
  try {
    if (url.trim()) localStorage.setItem(websiteKey(profileId), url.trim());
  } catch {
    /* preference only */
  }
}
function storedWebsite(profileId: string) {
  try {
    return localStorage.getItem(websiteKey(profileId)) || "";
  } catch {
    return "";
  }
}
type SiteProposal = { name: string; audience: string; voice: string };

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

/** Brand fields only (a backend profile): goals belong to campaigns and are never sent here. */
type ProfileBody = Pick<
  Profile,
  "name" | "audience" | "brand_context" | "creative_preferences"
> & { brand_kit?: BrandKit | null };
type Part = "brand" | "campaign";
type Attempt =
  | { part: "brand"; profileId: string; profile: ProfileBody }
  | { part: "campaign"; campaign: CampaignInput };
type SaveState =
  | { kind: "idle" }
  | { kind: "saved"; message: string }
  | { kind: "failed"; message: string }
  // Something may have been written. Saving again is blocked until a readback.
  | { kind: "unknown"; message: string };

const DEFAULT_KIT = { primary_color: "#111111", accent_color: "#FFD400" };
const HEX = /^#[0-9A-Fa-f]{6}$/;
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
function sameKit(saved: BrandKit | null | undefined, sent: BrandKit | null) {
  const a = saved || null;
  if (!a || !sent) return a === sent;
  return (
    (a.font_family || "") === (sent.font_family || "") &&
    (a.primary_color || "").toUpperCase() === (sent.primary_color || "").toUpperCase() &&
    (a.accent_color || "").toUpperCase() === (sent.accent_color || "").toUpperCase() &&
    (a.logo_file || null) === (sent.logo_file || null) &&
    (a.font_file || null) === (sent.font_file || null)
  );
}
function profileMatches(saved: Profile | undefined, body: ProfileBody) {
  return (
    !!saved &&
    saved.name === body.name &&
    saved.audience === body.audience &&
    saved.brand_context === body.brand_context &&
    saved.creative_preferences === body.creative_preferences &&
    (body.brand_kit === undefined || sameKit(saved.brand_kit, body.brand_kit))
  );
}
function campaignMatches(saved: Campaign | undefined, body: CampaignInput) {
  return (
    !!saved &&
    saved.name === body.name &&
    sameBrief(saved.brief, body.brief) &&
    (saved.objective ?? "discovery") === body.objective &&
    (saved.primary_metric ?? null) === (body.primary_metric ?? null) &&
    (saved.notes ?? "") === (body.notes ?? "") &&
    body.profile_ids.every((id) => saved.profile_ids.includes(id)) &&
    body.video_ids.every((id) => saved.video_ids.includes(id))
  );
}

/**
 * Brand profile (part "brand"): the brand's name, audience, voice and look.
 * Goals & brief (part "campaign"): the selected campaign's goal, notes and brief. Every brand
 * has one automatic campaign, so the word "campaign" (and its name) only shows once a brand
 * has a second one.
 * Each part saves only its own record, then confirms it by reading it back.
 */
export function Setup({
  w,
  factory,
  next,
  creating,
  onSaved,
  advanced,
  onNewCampaign,
  onAccounts,
  goals,
  part = "brand",
  active = true,
  goalsRequest = 0,
  engineRequest = 0,
}: {
  w: Workspace;
  factory: FactoryState;
  /** Opens Style rules. */
  next: () => void;
  creating: boolean;
  onSaved: () => void;
  /** Rarely used actions, shown inside the single Advanced section. */
  advanced?: ReactNode;
  /** Opens the New campaign form for this brand (Advanced: a separate push). */
  onNewCampaign?: () => void;
  /** The Goals & brief section shown below the brand (part "campaign"). */
  goals?: ReactNode;
  /** Opens connected accounts (Results). */
  onAccounts?: () => void;
  part?: Part;
  /** Hides native modals when this screen is not the active app surface. */
  active?: boolean;
  /** A new positive value opens Goals & brief, including through quick actions. */
  goalsRequest?: number;
  /** A new positive value opens local Engine & models maintenance. */
  engineRequest?: number;
}) {
  const campaign = creating ? undefined : w.campaign;
  // The brand being edited is fixed for this mount (GrowthApp keys Setup by
  // campaign and profile). It is never silently replaced by another one.
  const profile =
    campaign && campaign.profile_ids.includes(w.profileId)
      ? w.profiles.find((p) => p.id === w.profileId)
      : undefined;
  const [editor, setEditor] = useState<"identity" | "kit" | "account" | "goals" | "engine" | null>(null);
  const handledGoalsRequest = useRef(0);
  const handledEngineRequest = useRef(0);
  useEffect(() => {
    if (!active) setEditor(null);
    else if (engineRequest > 0 && engineRequest !== handledEngineRequest.current) {
      handledEngineRequest.current = engineRequest;
      setEditor("engine");
    } else if (goals && goalsRequest > 0 && goalsRequest !== handledGoalsRequest.current) {
      handledGoalsRequest.current = goalsRequest;
      setEditor("goals");
    }
  }, [active, goalsRequest, engineRequest, goals]);
  const [name, setName] = useState(campaign?.name || "");
  const [brandName, setBrandName] = useState(profile?.name || "");
  const [audience, setAudience] = useState(profile?.audience || "");
  // The goal belongs to this campaign; each campaign has its own.
  const [objective, setObjective] = useState(
    campaign?.objective || "discovery",
  );
  const [metric, setMetric] = useState(campaign?.primary_metric || "");
  const [notes, setNotes] = useState(campaign?.notes || "");
  const [voice, setVoice] = useState(
    profile?.brand_context ||
      campaign?.brief.constraints.join("\n") ||
      "Preserve the speaker's meaning. Keep captions readable.",
  );
  const [creative, setCreative] = useState(profile?.creative_preferences || "");
  const [website, setWebsite] = useState(() =>
    profile ? storedWebsite(profile.id) : "",
  );
  const [reading, setReading] = useState<SiteResearch | null>(null);
  const [siteError, setSiteError] = useState("");
  const [proposal, setProposal] = useState<SiteProposal | null>(null);
  const siteLive = useRef(true);
  useEffect(
    () => () => {
      siteLive.current = false;
    },
    [],
  );
  // Brand kit: sent only when it already exists or is edited here.
  const savedKit = profile?.brand_kit || null;
  const [kitEdited, setKitEdited] = useState(false);
  const [fontFamily, setFontFamily] = useState(savedKit?.font_family || "");
  const [primary, setPrimary] = useState(savedKit?.primary_color || DEFAULT_KIT.primary_color);
  const [accent, setAccent] = useState(savedKit?.accent_color || DEFAULT_KIT.accent_color);
  const [logo, setLogo] = useState(savedKit?.logo_file || "");
  const brandDraft = {
    name: brandName.trim(), audience: audience.trim(), voice: voice.trim(), creative: creative.trim(),
    kit: { font: fontFamily.trim(), primary: primary.toUpperCase(), accent: accent.toUpperCase(), logo: logo.trim() },
  };
  const [savedBrandDraft, setSavedBrandDraft] = useState(brandDraft);
  const brandDirty = JSON.stringify(brandDraft) !== JSON.stringify(savedBrandDraft);
  const kitDirty = JSON.stringify(brandDraft.kit) !== JSON.stringify(savedBrandDraft.kit);
  function confirmBrandDraft() {
    const sent = attempt.current;
    if (sent?.part !== "brand") return;
    setSavedBrandDraft((previous) => ({
      name: sent.profile.name, audience: sent.profile.audience,
      voice: sent.profile.brand_context, creative: sent.profile.creative_preferences,
      kit: sent.profile.brand_kit ? {
        font: sent.profile.brand_kit.font_family?.trim() || "",
        primary: (sent.profile.brand_kit.primary_color || DEFAULT_KIT.primary_color).toUpperCase(),
        accent: (sent.profile.brand_kit.accent_color || DEFAULT_KIT.accent_color).toUpperCase(),
        logo: sent.profile.brand_kit.logo_file?.trim() || "",
      } : previous.kit,
    }));
  }
  const [linkProfiles, setLinkProfiles] = useState<string[]>([]);
  const [attachSources, setAttachSources] = useState<string[]>([]);
  const [profileName, setProfileName] = useState("");
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const [checking, setChecking] = useState(false);
  const attempt = useRef<Attempt | null>(null);
  // Campaigns are invisible until a brand has more than one.
  const severalCampaigns =
    w.campaigns.filter((c) => c.profile_ids.includes(w.profileId)).length > 1;
  const linked = new Set(campaign?.profile_ids || []);
  const attached = new Set(campaign?.video_ids || []);
  const needsReadback = state.kind === "unknown";
  useEffect(() => {
    if (part !== "brand" || state.kind !== "saved" || brandDirty) return;
    const timer = window.setTimeout(() => setState({ kind: "idle" }), 4000);
    return () => window.clearTimeout(timer);
  }, [part, state.kind, brandDirty]);
  const blocked =
    w.busy || w.loading || checking || factory.loading || !campaign || !profile;
  const metricNeeded = objective !== "discovery";
  const kitError =
    !HEX.test(primary) || !HEX.test(accent)
      ? "Use colours like #112233."
      : logo.trim() && !/^\/.+\.png$/i.test(logo.trim())
        ? "The logo must be a full path to a .png file."
        : fontFamily && !/^[A-Za-z0-9 _.-]*$/.test(fontFamily)
          ? "Use letters, numbers and spaces in the font name."
          : "";
  const valid =
    part === "brand"
      ? !!brandName.trim() && !((kitEdited || kitDirty) && kitError)
      : !!name.trim() && (!metricNeeded || !!metric.trim());

  function edited() {
    if (state.kind === "saved" || state.kind === "failed")
      setState({ kind: "idle" });
  }
  function editKit() {
    setKitEdited(true);
    edited();
  }

  function profileBody(): ProfileBody {
    const constraints = lines(voice);
    if (constraints.length > 30)
      throw new Error("Use up to 30 voice and boundary lines.");
    if (constraints.some((line) => line.length > 1200))
      throw new Error(
        "Keep each voice or boundary line within 1,200 characters.",
      );
    // Only writable fields; read-only production_history is never sent.
    const body: ProfileBody = {
      name: brandName.trim(),
      audience: audience.trim(),
      brand_context: voice.trim(),
      creative_preferences: creative.trim(),
    };
    if (kitEdited || kitDirty)
      body.brand_kit = {
        ...(savedKit || {}),
        font_family: fontFamily.trim(),
        primary_color: primary,
        accent_color: accent,
        logo_file: logo.trim() || null,
      };
    return body;
  }
  function campaignBody(latestCampaign: Campaign): CampaignInput {
    return {
      name: name.trim(),
      // The brief has its own Save brief; this save keeps the latest saved one exactly.
      brief: latestCampaign.brief,
      ...campaignGoalBody(objective, metric),
      notes: notes.trim(),
      // Membership is a union with the latest saved record, so footage or
      // brands attached elsewhere since this screen loaded are retained.
      profile_ids: union(latestCampaign.profile_ids, linkProfiles),
      video_ids: union(latestCampaign.video_ids, attachSources),
    };
  }

  async function save() {
    if (blocked || needsReadback || !valid || !campaign || !profile) return;
    const campaignId = campaign.id,
      profileId = profile.id;
    // Assigned inside the task; casts stop TypeScript narrowing them here.
    let stage = "read" as "read" | "write" | "readback";
    let started = false as boolean,
      unknownOutcome = false as boolean,
      failure = "" as string;
    const ok = await w.run(
      async () => {
        started = true;
        try {
          // 1. Latest saved state, never the possibly stale screen copy.
          const [campaigns, profiles] = await Promise.all([
            workspaceApi.campaigns(),
            workspaceApi.profiles(),
          ]);
          const latestCampaign = campaigns.find((c) => c.id === campaignId);
          if (!latestCampaign)
            throw new Error("These goals are no longer available. Refresh and try again.");
          // 2. The selected brand must still belong to this campaign. There is
          // no fallback to another one.
          const latestProfile = profiles.find((p) => p.id === profileId);
          if (!latestProfile || !latestCampaign.profile_ids.includes(profileId))
            throw new Error(
              "This brand is no longer linked to these goals. Refresh and choose again.",
            );
          // 3. One strict writable body for this part only, by exact ID.
          if (part === "brand") {
            const body = profileBody();
            attempt.current = { part, profileId, profile: body };
            stage = "write";
            await workspaceApi.updateProfile(profileId, body);
          } else {
            const body = campaignBody(latestCampaign);
            attempt.current = { part, campaign: body };
            stage = "write";
            await workspaceApi.save(body, campaignId);
          }
          // 4. Confirm by reading back.
          stage = "readback";
          if (!(await confirmed())) throw new Error("Saved state did not match your edits.");
        } catch (error) {
          unknownOutcome = stage === "readback" || uncertain(error);
          failure = message(error, "The save failed.");
          throw error;
        }
      },
      part === "brand"
        ? "Brand profile saved. Style rules and earlier clips are unchanged."
        : "Goals saved. Style rules and earlier clips are unchanged.",
    );
    if (!started) return;
    if (ok) {
      confirmBrandDraft();
      setLinkProfiles([]);
      setAttachSources([]);
      setKitEdited(false);
      setState({ kind: "saved", message: "Saved and confirmed." });
      onSaved();
      return;
    }
    // 5. Keep every draft and say exactly what may have been written.
    if (!failure)
      // Writes were confirmed by readback, but the refresh failed.
      setState({
        kind: "unknown",
        message:
          "Your changes were confirmed, but the screen could not refresh. Check saved state before saving again.",
      });
    else if (stage === "read")
      setState({
        kind: "failed",
        message: `${failure} Nothing was saved; your edits are still here.`,
      });
    else if (stage === "write")
      setState(
        unknownOutcome
          ? {
              kind: "unknown",
              message: `${failure} The save was not confirmed and may or may not have been written. Check saved state before saving again.`,
            }
          : {
              kind: "failed",
              message: `${failure} Nothing was saved. Your edits are still here.`,
            },
      );
    else
      setState({
        kind: "unknown",
        message: `${failure} Your changes were sent but could not be confirmed. Check saved state before saving again.`,
      });
  }

  /** True when the saved record matches the last attempt exactly. */
  async function confirmed() {
    const last = attempt.current;
    if (!last || !campaign) return false;
    if (last.part === "brand")
      return profileMatches(
        (await workspaceApi.profiles()).find((p) => p.id === last.profileId),
        last.profile,
      );
    return campaignMatches(
      (await workspaceApi.campaigns()).find((c) => c.id === campaign.id),
      last.campaign,
    );
  }

  async function checkSaved() {
    if (!attempt.current || !campaign || checking) return;
    setChecking(true);
    try {
      const ok = await confirmed();
      setState(
        ok
          ? {
              kind: "saved",
              message: "Readback confirms every change is saved.",
            }
          : {
              kind: "failed",
              message:
                "Readback: not saved. Your edits are still here; saving again is now safe.",
            },
      );
      if (ok) {
        confirmBrandDraft();
        setLinkProfiles([]);
        setAttachSources([]);
        setKitEdited(false);
        onSaved();
      }
      await w.load().catch(() => {});
    } catch (error) {
      setState({
        kind: "unknown",
        message: `Could not read saved state: ${message(error, "the service is unavailable")}. Try again before saving.`,
      });
    } finally {
      setChecking(false);
    }
  }

  async function createProfile() {
    const title = profileName.trim();
    if (!title || blocked) return;
    // Explicit, separate action. It creates one new local brand and only
    // queues it for linking; the campaign changes when it is saved.
    await w.run(async () => {
      const created = await workspaceApi.profile({
        name: title,
        audience: audience.trim(),
        brand_context: voice.trim(),
        creative_preferences: creative.trim(),
      });
      setLinkProfiles((old) => union(old, [created.id]));
      setProfileName("");
    }, "Brand created. Save goals to share them with it. No social account was connected.");
  }

  /** Reads the website again and shows what would change; nothing is applied until accepted. */
  async function rereadWebsite() {
    const url = website.trim();
    if (!url || reading) return;
    setSiteError("");
    setProposal(null);
    try {
      let run = await websiteBriefApi.start(url);
      setReading(run);
      for (let i = 0; run.status === "running" && i < 240; i++) {
        await new Promise((done) => setTimeout(done, 1000));
        if (!siteLive.current) return;
        run = await websiteBriefApi.get(run.id);
        setReading(run);
      }
      if (!siteLive.current) return;
      if (run.status !== "done" || !run.draft)
        throw new Error(run.error || "We couldn't read that website. Check the address and try again.");
      const result = briefFromDraft(editableFrom(run.draft), run.draft);
      if (profile) rememberWebsite(profile.id, url);
      setProposal({
        name: result.name || brandName,
        audience: result.audience || audience,
        voice: [result.voice, ...result.boundaries].filter(Boolean).join("\n") || voice,
      });
    } catch (error) {
      if (siteLive.current) setSiteError(message(error, "The website could not be read."));
    } finally {
      if (siteLive.current) setReading(null);
    }
  }
  function acceptProposal() {
    if (!proposal) return;
    setBrandName(proposal.name);
    setAudience(proposal.audience);
    setVoice(proposal.voice);
    setProposal(null);
    edited();
  }

  if (!campaign)
    return (
      <Empty title="Nothing open yet" icon="settings">
        {w.loading ? "Opening…" : "Choose a brand from the top bar."}
      </Empty>
    );
  if (!profile)
    return (
      <Empty title="Choose a brand" icon="settings">
        This brand isn't linked here. Refresh and pick another; nothing
        changes automatically.
      </Empty>
    );

  const identityForm = (
      <FieldGroup title="Brand">
        <Field label="Brand name">
          {(id) => (
            <AutoTextarea
              rows={1}
              id={id}
              maxLength={200}
              placeholder="e.g. All-In Podcast"
              value={brandName}
              onChange={(e) => {
                setBrandName(e.target.value);
                edited();
              }}
            />
          )}
        </Field>
        <div className="gf-website-row">
          <Field label="Website">
            {(id) => (
              <input
                id={id}
                type="url"
                inputMode="url"
                maxLength={500}
                placeholder="https://yourbrand.com"
                value={website}
                onChange={(e) => {
                  setWebsite(e.target.value);
                  setSiteError("");
                }}
                onBlur={() => profile && rememberWebsite(profile.id, website)}
              />
            )}
          </Field>
          <button
            type="button"
            className="gf-button secondary compact"
            disabled={!website.trim() || !!reading || w.busy}
            onClick={() => void rereadWebsite()}
          >
            <Icon name="refresh" size={14} />
            {reading ? "Reading…" : "Re-read website"}
          </button>
          <small className="gf-website-hint">
            Optional. We read public pages and show changes before anything is used.
          </small>
        </div>
        {reading && (
          <p className="gf-website-progress" role="status">
            <span className="gf-skeleton is-dot" aria-hidden="true" />
            {reading.events.length
              ? statusLine(reading.events[reading.events.length - 1], website)
              : "Opening your website…"}
          </p>
        )}
        {siteError && (
          <p className="gf-help" role="alert">
            {siteError}
          </p>
        )}
        {proposal && (
          <section className="gf-website-diff" aria-label="Changes from your website">
            <h3>From your website</h3>
            <dl>
              {(
                [
                  ["Brand name", brandName, proposal.name],
                  ["Who it's for", audience, proposal.audience],
                  ["Voice & boundaries", voice, proposal.voice],
                ] as const
              ).map(([label, before, after]) => (
                <div key={label} style={{ display: "contents" }}>
                  <dt>{label}</dt>
                  <dd>
                    {before.trim() === after.trim() ? (
                      <span>No change</span>
                    ) : (
                      <>
                        {before && <del>{before}</del>}
                        <ins>{after}</ins>
                      </>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            <footer>
              <button
                type="button"
                className="gf-button ghost compact"
                onClick={() => setProposal(null)}
              >
                Keep mine
              </button>
              <button
                type="button"
                className="gf-button compact"
                onClick={acceptProposal}
              >
                <Icon name="check" size={14} />
                Use these
              </button>
            </footer>
          </section>
        )}
        <Field label="Who it's for">
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
        <Field label="Voice & boundaries" hint="One rule per line.">
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
      </FieldGroup>
  );

  const kitForm = (
      <FieldGroup title="Brand kit">
        <div className="gf-form-pair">
          <Field label="Main colour">
            {(id) => (
              <input
                id={id}
                type="color"
                value={HEX.test(primary) ? primary : DEFAULT_KIT.primary_color}
                onChange={(e) => {
                  setPrimary(e.target.value.toUpperCase());
                  editKit();
                }}
              />
            )}
          </Field>
          <Field label="Accent colour">
            {(id) => (
              <input
                id={id}
                type="color"
                value={HEX.test(accent) ? accent : DEFAULT_KIT.accent_color}
                onChange={(e) => {
                  setAccent(e.target.value.toUpperCase());
                  editKit();
                }}
              />
            )}
          </Field>
        </div>
        <Field label="Font" hint="An installed font's name. Blank uses the default.">
          {(id) => (
            <input
              id={id}
              maxLength={80}
              placeholder="e.g. Inter"
              value={fontFamily}
              onChange={(e) => {
                setFontFamily(e.target.value);
                editKit();
              }}
            />
          )}
        </Field>
        <Field label="Logo (PNG file on this Mac)">
          {(id) => (
            <input
              id={id}
              maxLength={1024}
              placeholder="/Users/you/Pictures/logo.png"
              value={logo}
              onChange={(e) => {
                setLogo(e.target.value);
                editKit();
              }}
            />
          )}
        </Field>
        {(kitEdited || kitDirty) && kitError && (
          <p className="gf-help" role="alert">
            {kitError}
          </p>
        )}
      </FieldGroup>
  );

  const advancedForm = (
      <details className="gf-disclosure gf-advanced-settings">
        <summary aria-label="Advanced controls">
          <Icon name="settings" />
          Advanced
          <Icon name="down" size={15} />
        </summary>
        <div className="gf-disclosure-body">
          <button type="button" className="gf-link-row gf-engine-settings-link" onClick={() => setEditor("engine")}>
            <Icon name="settings" size={17} /><span><strong>Engine & models</strong><small>Speech, local models, runtime and background jobs.</small></span><Icon name="arrow" size={15} />
          </button>
          <Field label="Extra creative notes">
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
          {onNewCampaign && (
            <button
              type="button"
              className="gf-button secondary compact"
              disabled={w.busy || checking}
              onClick={onNewCampaign}
            >
              <Icon name="plus" size={14} />
              Run a separate push (campaign)
            </button>
          )}
          {advanced}
        </div>
      </details>
  );

  const campaignForm = (
    <>
      <FieldGroup title="Goals & brief">
        {severalCampaigns && <Field label="Campaign name">
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
        </Field>}
        <Field label="What are we working toward?">
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
        <Field label="Notes for the agents" hint="Optional.">
          {(id) => (
            <AutoTextarea
              id={id}
              rows={2}
              maxLength={2000}
              placeholder="e.g. Favour the guest's founding story"
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                edited();
              }}
            />
          )}
        </Field>
        <CampaignBriefEditor
          w={w}
          campaign={campaign}
          workspaceAudience={profile.audience}
        />
      </FieldGroup>
      <details className="gf-disclosure gf-advanced-settings">
        <summary aria-label="Episodes and sharing">
          <Icon name="settings" />
          Episodes & sharing
          <Icon name="down" size={15} />
        </summary>
        <div className="gf-disclosure-body">
          <h3>Episodes</h3>
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
          <h3>Shared with brands</h3>
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
          <Field label="New brand name">
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
            Create brand
            <Icon name="plus" size={14} />
          </button>
          {advanced}
        </div>
      </details>
    </>
  );

  const kitNeedsAttention = part === "brand" && (kitEdited || kitDirty) && !!kitError && editor !== "kit";
  const identityNeedsAttention = part === "brand" && !brandName.trim() && editor !== "identity";
  const saveActions = part === "brand" && !brandDirty && state.kind === "idle" ? null : (
      <div className={`gf-stage-action${part === "brand" ? " gf-profile-save-status" : ""}${part === "brand" && !brandDirty ? " is-clean" : ""}`}>
        <span
          role={
            state.kind === "idle"
              ? kitNeedsAttention || identityNeedsAttention ? "alert" : undefined
              : state.kind === "saved"
                ? "status"
                : "alert"
          }
        >
          {state.kind === "idle"
            ? kitNeedsAttention
              ? `Brand kit needs attention. ${kitError}`
              : identityNeedsAttention
                ? "Your brand name needs attention. Add a name before saving."
                : part === "brand"
              ? "Saves your brand. Nothing is published."
              : "Saves your goals. Nothing is published."
            : part === "brand" && state.kind === "saved" && brandDirty
              ? "Earlier changes saved. Your newer edits are still unsaved."
              : state.message}
        </span>
        <div className="gf-channel-actions">
          {identityNeedsAttention && <button type="button" className="gf-button secondary compact" onClick={() => setEditor("identity")}>
            Review brand details
          </button>}
          {kitNeedsAttention && <button type="button" className="gf-button secondary compact" onClick={() => setEditor("kit")}>
            Review brand kit
          </button>}
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
          {(part === "campaign" || brandDirty) && <PrimaryAction
            label={w.busy ? "Saving…" : part === "brand" ? "Save brand" : "Save goals"}
            intent="approve"
            disabled={blocked || needsReadback || !valid}
            onClick={() => void save()}
          />}
        </div>
      </div>
  );

  return (
    <>
    <div
      className="gf-setup-grid gf-channel-settings-grid"
      id={part === "campaign" ? "gf-goals" : undefined}
    >
      {part === "brand" ? (
        <>
          <section className="gf-brand-overview" aria-label="Brand profile overview">
            <div className="gf-brand-overview-heading">
              <div><span className="gf-brand-eyebrow">Your brand</span><h2>{brandName || "Untitled brand"}</h2></div>
              <span className="gf-brand-caption">A shared direction for every clip.</span>
            </div>
            <div className="gf-brand-settings-grid">
              <button type="button" className="gf-brand-setting-row" onClick={() => setEditor("identity")}>
                <span className="gf-brand-setting-icon"><Icon name="headphones" size={19} /></span>
                <span><strong>Brand, audience & voice</strong><small>{audience.trim() || "Define who you’re speaking to and how you sound."}</small></span>
                <span className="gf-brand-row-action">Edit details<Icon name="arrow" size={15} /></span>
              </button>
              {goals && <button type="button" className="gf-brand-setting-row" onClick={() => setEditor("goals")}>
                <span className="gf-brand-setting-icon"><Icon name="results" size={19} /></span>
                <span><strong>Goals & brief</strong><small>Your outcome, creative brief and episode sharing.</small></span>
                <span className="gf-brand-row-action">Review direction<Icon name="arrow" size={15} /></span>
              </button>}
              <button type="button" className="gf-brand-setting-row" onClick={() => setEditor("kit")}>
                <span className="gf-brand-setting-icon"><Icon name="studio" size={19} /></span>
                <span><strong>Brand kit</strong><small>{(kitEdited || kitDirty) && kitError ? "Needs attention · " + kitError : `${fontFamily.trim() || "Default font"} · ${logo.trim() ? "Logo added" : "No logo yet"}`}</small></span>
                <span className="gf-brand-row-action"><span className="gf-brand-swatches" aria-label="Brand colours"><i style={{ background: primary }} /><i style={{ background: accent }} /></span>Edit appearance<Icon name="arrow" size={15} /></span>
              </button>
              <button type="button" className="gf-brand-setting-row" onClick={() => setEditor("account")}>
                <span className="gf-brand-setting-icon"><Icon name="settings" size={19} /></span>
                <span><strong>Account & AI model</strong><small>Sign-in, model routing and processing preferences.</small></span>
                <span className="gf-brand-row-action">Manage<Icon name="arrow" size={15} /></span>
              </button>
            </div>
          </section>
          <div className="gf-brand-quick-links">
            <div className="gf-link-rows">
          <button
            type="button"
            className="gf-link-row"
            disabled={w.busy || checking}
            onClick={next}
          >
            <Icon name="research" size={16} />
            <span>Style rules</span>
            <Icon name="arrow" size={14} />
          </button>
          {onAccounts && (
            <button
              type="button"
              className="gf-link-row"
              disabled={w.busy || checking}
              onClick={onAccounts}
            >
              <Icon name="results" size={16} />
              <span>Connected accounts</span>
              <Icon name="arrow" size={14} />
            </button>
          )}
            </div>
          </div>
          {advancedForm}
          {!editor && saveActions}
          <PanelDialog open={active && editor === "identity"} onClose={() => setEditor(null)} title="Brand, audience & voice" description="A clear identity keeps every clip on brand. Your drafts stay here when you close.">
            <div className="gf-brand-editor">{identityForm}</div>
            {editor === "identity" && saveActions && <div className="gf-panel-dialog-footer">{saveActions}</div>}
          </PanelDialog>
          <PanelDialog open={active && editor === "kit"} onClose={() => setEditor(null)} title="Brand kit" description="Colours, typography and the logo used in your clips.">
            <div className="gf-brand-editor">{kitForm}</div>
            {editor === "kit" && saveActions && <div className="gf-panel-dialog-footer">{saveActions}</div>}
          </PanelDialog>
          <PanelDialog open={active && editor === "account"} onClose={() => setEditor(null)} title="Account & AI model" size="wide" description="Manage your account and choose how the factory processes your footage.">
            <div className="gf-brand-account-grid">
              <section className="gf-profile-account" aria-label="Your account"><h3>Account</h3><CloudAccountRow showLocal /></section>
              <AiModelCard />
            </div>
          </PanelDialog>
          <PanelDialog open={active && editor === "engine"} onClose={() => setEditor(null)} title="Engine & models" size="wide" description="Manage this Mac’s runtime, local model library and background work.">
            <EngineSetup factory={factory} />
          </PanelDialog>
          {goals && <PanelDialog open={active && editor === "goals"} onClose={() => setEditor(null)} title="Goals & brief" size="wide" description="Keep the desired outcome, creative direction and episode context together.">
            <div className="gf-brand-goals-editor">{goals}</div>
          </PanelDialog>}
        </>
      ) : (
        <>
          <section className="gf-card gf-brief" aria-label="Goals & brief form"><div className="gf-form-fields">{campaignForm}</div></section>
          {saveActions}
        </>
      )}
    </div>

    </>
  );
}
