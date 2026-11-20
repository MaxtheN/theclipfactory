import { AutoTextarea } from "../components/AutoTextarea";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { Clip, Direction } from "../types";
import {
  parseAutomationState,
  parseLearningMemory,
  type LearningMemory,
} from "./AutomationPanel";
import { pendingRules, scopeAutomation, type Row } from "./flowEvents";
import { postedRows, resultsStory, type PostedRow } from "./resultsModel";
import { StrategistPanel } from "./StrategistPanel";
import { GrowthLoopPanel } from "./GrowthLoopPanel";
import { DemoLoopButton, LearningLoopDemo } from "./LearningLoopDemo";
import { brandClips, simulateResults, type SimResults } from "./demoResults";
import type { DemoResult } from "./demoStore";
import "./results-minimal.css";
import { FactoryUpgrades } from "./FactoryUpgrades";
import { PanelDialog } from "./PanelDialog";
import type { StrategistView } from "./strategistApi";
import "./results-story.css";
import {
  applyLearningEdit,
  nextProductionMode,
  performanceRecommendations,
  type EvidenceRecommendation,
  type LearningEdit,
} from "./learningState";
import { object } from "./productionState";
import type { FactoryState } from "../useFactory";
import { activeRulesId, type Workspace } from "./useCampaignWorkspace";
import { reviewPreview, workspaceApi } from "./workspaceApi";
import { Disclosure, Empty, Field, Pill, PrimaryAction } from "./parts";
import { Icon } from "./Icon";
import { ListRow, Panel, Section, Stack, StatRow } from "./layout";

const productionKeys: (keyof Direction)[] = [
  "angles",
  "moment_selection",
  "hooks",
  "pacing",
  "duration_seconds",
  "framing",
  "caption_style",
  "editing_preferences",
  "measurement_questions",
  "next_experiments",
];
const sameProductionDirection = (a: Direction, b: Direction) =>
  JSON.stringify(productionKeys.map((key) => a[key])) ===
  JSON.stringify(productionKeys.map((key) => b[key]));
const sameIds = (a: string[], b: string[]) =>
  JSON.stringify([...new Set(a)].sort()) ===
  JSON.stringify([...new Set(b)].sort());
function firstChangedKind(
  before: Direction,
  after: Direction,
): LearningEdit["kind"] {
  if (JSON.stringify(before.hooks) !== JSON.stringify(after.hooks))
    return "opening";
  if (before.duration_seconds !== after.duration_seconds) return "duration";
  if (before.framing !== after.framing) return "framing";
  if (before.caption_style !== after.caption_style) return "captions";
  return "selection";
}
function editText(direction: Direction, kind: LearningEdit["kind"]): string {
  return kind === "opening"
    ? direction.hooks[0] || ""
    : kind === "duration"
      ? String(direction.duration_seconds)
      : kind === "framing"
        ? direction.framing
        : kind === "captions"
          ? direction.caption_style
          : direction.moment_selection;
}
function learningEdit(kind: LearningEdit["kind"], value: string): LearningEdit {
  if (kind === "duration") return { kind, value: Number(value) };
  if (kind === "framing")
    return { kind, value: value === "fill" ? "fill" : "fit" };
  if (kind === "captions")
    return {
      kind,
      value: value === "high_contrast" ? "high_contrast" : "standard",
    };
  return { kind, value };
}
function AnalystRecommendations({
  w,
  observations,
  blocked,
  onUse,
}: {
  w: Workspace;
  observations: Workspace["observations"];
  blocked: boolean;
  onUse: (row: EvidenceRecommendation, source: string) => void;
}) {
  const [rows, setRows] = useState<
    { row: EvidenceRecommendation; source: string }[] | null
  >(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const alive = useRef(true),
    lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function load() {
    if (lock.current) return;
    lock.current = true;
    setLoading(true);
    setError("");
    try {
      const runs = await workspaceApi.teamRuns();
      const scoped = runs.filter((run) => {
        const snapshot = object(object(run.context)?.campaign_snapshot);
        return (
          snapshot?.campaign_id === w.campaign?.id &&
          snapshot?.profile_id === w.profileId
        );
      });
      const found = scoped
        .slice(0, 3)
        .flatMap((run) =>
          run.tasks.flatMap((task) =>
            performanceRecommendations(task, observations).map((row) => ({
              row,
              source: `${run.id} / ${task.id}`,
            })),
          ),
        )
        .slice(0, 8);
      if (alive.current) setRows(found);
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error
            ? e.message
            : "Analyst recommendations are unavailable.",
        );
    } finally {
      lock.current = false;
      if (alive.current) setLoading(false);
    }
  }
  return (
    <Disclosure title="Performance analyst recommendations" icon="results">
      <p>
        Completed recommendations for this brand.
      </p>
      <button
        type="button"
        className="gf-button secondary compact"
        disabled={blocked || loading}
        onClick={() => void load()}
      >
        {loading ? "Loading recommendations…" : "Load analyst recommendations"}
      </button>
      {error && (
        <p className="gf-help" role="alert">
          {error}
        </p>
      )}
      {rows?.length === 0 && (
        <p>
          No recommendations yet.
        </p>
      )}
      {rows?.map(({ row, source }, index) => (
        <article key={`${source}-${index}`} className="gf-rule-diff">
          <p>{row.recommendation}</p>
          <small>{row.limitation}</small>
          <p>
            Known observations:{" "}
            {row.observationIds.join(", ") || "None cited"}
          </p>
          {row.otherEvidenceRefs.length > 0 && (
            <p>
              Preference or other references: {row.otherEvidenceRefs.join(", ")}
              . These are not automatically eligible measured evidence.
            </p>
          )}
          <button
            type="button"
            className="gf-button secondary compact"
            disabled={blocked}
            onClick={() => onUse(row, source)}
          >
            Use as a planning draft
            <Icon name="arrow" size={14} />
          </button>
        </article>
      ))}
    </Disclosure>
  );
}

/** Hand-entered results and a creator-proposed test. Kept under "Add a result by hand". */
export function HandEnteredResults({
  w,
  factory,
  next,
}: {
  w: Workspace;
  factory: FactoryState;
  next: (id?: string, mode?: "manual" | "agent") => void;
}) {
  const observations = w.observations.filter(
    (o) => o.profile_id === w.profileId,
  );
  const clips = factory.data.clips.filter(
    (c) =>
      c.campaign_id === w.campaign?.id &&
      c.profile_id === w.profileId &&
      c.approved,
  );
  // The workspace's approved rules, inherited by this campaign.
  const activeId = activeRulesId(w);
  const active = w.versions.find((v) => v.id === activeId);
  const activeDirection = active?.directions[w.profileId];
  const pending = [...w.versions]
    .sort((a, b) => b.version - a.version)
    .find(
      (v) =>
        v.status === "proposed" &&
        // Pre-workspace campaign drafts are history; only workspace drafts can be approved.
        v.scope !== "campaign" &&
        v.base_version_id === active?.id &&
        v.changed_profile_ids.includes(w.profileId) &&
        !!v.hypothesis?.trim() &&
        v.directions[w.profileId]?.evidence_refs.some((id) =>
          observations.some(
            (o) =>
              o.id === id &&
              typeof o.value === "number" &&
              Number.isFinite(o.value),
          ),
        ),
    );
  const pendingDirection = pending?.directions[w.profileId];
  const [editKind, setEditKind] = useState<LearningEdit["kind"]>(() =>
    activeDirection && pendingDirection
      ? firstChangedKind(activeDirection, pendingDirection)
      : "selection",
  );
  const [editValue, setEditValue] = useState(() =>
    pendingDirection
      ? editText(
          pendingDirection,
          activeDirection
            ? firstChangedKind(activeDirection, pendingDirection)
            : "selection",
        )
      : "Lead with the point. Move supporting context after the opening.",
  );
  const [hypothesis, setHypothesis] = useState(
    pending?.hypothesis ||
      "Test whether a more direct opening improves the selected metric.",
  );
  const known = observations.filter(
    (o) => typeof o.value === "number" && Number.isFinite(o.value),
  );
  const [selectedEvidence, setSelectedEvidence] = useState<string[] | null>(
    () =>
      pendingDirection
        ? pendingDirection.evidence_refs.filter((id) =>
            known.some((o) => o.id === id),
          )
        : null,
  );
  const selectedKnown = known.filter(
    (o) => selectedEvidence === null || selectedEvidence.includes(o.id),
  );
  const [recommendationSource, setRecommendationSource] = useState("");
  let proposedDirection: Direction | undefined;
  let editError = "";
  if (activeDirection) {
    try {
      proposedDirection = applyLearningEdit(
        activeDirection,
        learningEdit(editKind, editValue),
      );
    } catch (error) {
      editError =
        error instanceof Error ? error.message : "Check the proposed edit.";
    }
  }
  const evidenceRefs = [
    ...new Set([
      ...(activeDirection?.evidence_refs || []),
      ...selectedKnown.map((o) => o.id),
    ]),
  ];
  const canApprove =
    !!pending &&
    !!pendingDirection &&
    !!proposedDirection &&
    !!activeDirection &&
    selectedKnown.length > 0 &&
    !sameProductionDirection(activeDirection, proposedDirection) &&
    pending.hypothesis === hypothesis &&
    sameProductionDirection(pendingDirection, proposedDirection) &&
    sameIds(pendingDirection.evidence_refs, evidenceRefs);
  const hasProductionChange =
    !!activeDirection &&
    !!proposedDirection &&
    !sameProductionDirection(activeDirection, proposedDirection);
  const [metric, setMetric] = useState("full_episode_visits"),
    [value, setValue] = useState("");
  const [publication, setPublication] = useState("");
  const [clipId, setClipId] = useState(clips[0]?.id || "");
  const now = new Date(),
    previous = new Date(now.getTime() - 86400000);
  const local = (d: Date) =>
    new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  const [from, setFrom] = useState(local(previous)),
    [to, setTo] = useState(local(now));
  const nextSource = w.campaign?.video_ids[1] || w.campaign?.video_ids[0];
  const blocked =
    w.busy ||
    w.loading ||
    !!w.error ||
    factory.loading ||
    !!factory.errors.clips;
  async function importObservation(sample = false) {
    const clip = clips.find((c) => c.id === (clipId || clips[0]?.id));
    if (!clip || !w.campaign) return;
    await w.run(
      () =>
        workspaceApi.observe(w.campaign!.id, {
          clip_id: clip.id,
          metric: sample ? "full_episode_visits" : metric,
          value: sample ? 12 : value.trim() === "" ? null : Number(value),
          unit: "count",
          source: "manual_import",
          publication_reference: sample
            ? "Illustrative publication sample — not live analytics"
            : publication,
          window_start: sample
            ? previous.toISOString()
            : new Date(from).toISOString(),
          window_end: sample
            ? new Date(now.getTime() - 60000).toISOString()
            : new Date(to).toISOString(),
          collected_at: new Date().toISOString(),
          notes: sample
            ? "UI fixture only. This is not All-In account data or evidence of growth."
            : "Creator imported. Observational, not causal.",
        }),
      sample
        ? "Illustrative observations loaded. These are not real account results."
        : "Observation imported with its publication reference and window.",
    );
  }
  async function primary() {
    if (
      !w.campaign ||
      !active ||
      !activeDirection ||
      !proposedDirection ||
      blocked
    )
      return;
    if (canApprove && pending && pendingDirection) {
      const mode = nextProductionMode(activeDirection, pendingDirection);
      if (
        await w.run(
          () => workspaceApi.approve(w.profileId, pending.id),
          "Next test approved. Its saved direction will guide the next source.",
        )
      )
        next(nextSource, mode);
    } else if (selectedKnown.length && hasProductionChange) {
      await w.run(
        () =>
          workspaceApi.learn(w.campaign!.id, {
            profile_id: w.profileId,
            observation_ids: selectedKnown.map((o) => o.id),
            hypothesis,
            reason: `Creator-proposed ${editKind} test from selected observations; no causal improvement claimed.${recommendationSource ? ` Planning suggestion: ${recommendationSource}.` : ""}`,
            base_version_id: active.id,
            proposed_direction: proposedDirection!,
          }),
        "Next test proposed. Review the exact saved edit, then approve it explicitly.",
      );
    }
  }
  if (!w.campaign)
    return (
      <Empty title="Every next edit needs a reason" icon="results">
        Set up your brand to start.
      </Empty>
    );
  const validDates =
    Number.isFinite(Date.parse(from)) &&
    Number.isFinite(Date.parse(to)) &&
    Date.parse(to) > Date.parse(from) &&
    Date.parse(to) <= Date.now();
  return (
    <>
      <div className="gf-results-grid">
        <section className="gf-card gf-evidence">
        <div className="gf-card-header">
          <div>
            <span className="gf-overline">01 / REVIEW EVIDENCE</span>
            <h2>Evidence</h2>
          </div>
          <Icon name="results" />
        </div>
        <Pill tone="sand">
          {reviewPreview
            ? "Illustrative sample · not live analytics"
            : "Imported observations"}
        </Pill>
        <div className="gf-evidence-status">
          <span className="gf-overline">AUDIENCE OUTCOME</span>
          <h3>Nothing proven yet.</h3>
          <p>
            {observations.length
              ? "Observations can inform a new test. They don't establish why an edit performed."
              : "Not enough evidence to compare yet."}
          </p>
        </div>
        {observations.map((o) => (
          <div className="gf-observation" key={o.id}>
            <span>{o.metric.replace(/_/g, " ")}</span>
            <label>
              <input
                type="checkbox"
                aria-label={`Use observation ${o.id} for next test`}
                disabled={blocked || !known.some((item) => item.id === o.id)}
                checked={
                  o.value !== null &&
                  selectedKnown.some((item) => item.id === o.id)
                }
                onChange={(event) =>
                  setSelectedEvidence((old) => {
                    const current = old ?? known.map((item) => item.id);
                    return event.target.checked
                      ? [...new Set([...current, o.id])]
                      : current.filter((id) => id !== o.id);
                  })
                }
              />{" "}
              Use for this test
            </label>
            <strong>
              {o.value === null ? "Unknown" : o.value}
              <small>{o.unit}</small>
            </strong>
            <small>{o.publication_reference}</small>
          </div>
        ))}
        {reviewPreview && (
          <button
            className="gf-button secondary full"
            disabled={blocked || !clips.length || !!observations.length}
            onClick={() => void importObservation(true)}
          >
            <Icon name="plus" size={15} />
            {observations.length
              ? "Sample evidence loaded"
              : "Load sample observations"}
          </button>
        )}
        {!clips.length && (
          <p className="gf-help">
            Approve a clip in Studio before associating an observation with it.
          </p>
        )}
        <Disclosure title="Import an observation" icon="upload">
          <Field label="Approved clip">
            {(id) => (
              <select
                id={id}
                value={clipId || clips[0]?.id || ""}
                onChange={(e) => setClipId(e.target.value)}
              >
                {!clips.length && (
                  <option value="">Approve a clip first</option>
                )}
                {clips.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Metric name">
            {(id) => (
              <input
                id={id}
                value={metric}
                onChange={(e) => setMetric(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Observed count"
            hint="Leave blank for unknown. Only enter a measured number."
          >
            {(id) => (
              <input
                id={id}
                type="number"
                min="0"
                step="1"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
          </Field>
          <Field label="Publication reference">
            {(id) => (
              <input
                id={id}
                value={publication}
                onChange={(e) => setPublication(e.target.value)}
                placeholder="Post URL or publication ID"
              />
            )}
          </Field>
          <Field label="Window start">
            {(id) => (
              <input
                id={id}
                type="datetime-local"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            )}
          </Field>
          <Field label="Window end">
            {(id) => (
              <input
                id={id}
                type="datetime-local"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            )}
          </Field>
          <button
            className="gf-button secondary full"
            disabled={
              blocked ||
              !clips.length ||
              !metric.trim() ||
              !publication.trim() ||
              !validDates ||
              (value !== "" && (!Number.isInteger(+value) || +value < 0))
            }
            onClick={() => void importObservation()}
          >
            Import observation
            <Icon name="arrow" size={14} />
          </button>
        </Disclosure>
        <Disclosure title="Source, window & limits">
          <p>
            Unknown values stay unknown. Causes aren't inferred.
          </p>
        </Disclosure>
      </section>
      <section className="gf-card gf-next-test">
        <div className="gf-card-header">
          <div>
            <span className="gf-overline">02 / SET UP A TEST</span>
            <h2>Next test</h2>
          </div>
          <Pill tone="quiet">
            {active
              ? `v${active.version} → v${pending?.version || active.version + 1}`
              : "Direction needed"}
          </Pill>
        </div>
        <div className="gf-reason-chain">
          <div>
            <span>01</span>
            <div>
              <strong>Observe</strong>
              <p>
                {known.length
                  ? `${selectedKnown.length} selected known-value observation${selectedKnown.length === 1 ? "" : "s"}, for this brand.`
                  : "Import real evidence before proposing an evidence-led change."}
              </p>
            </div>
          </div>
          <i />
          <div>
            <span>02</span>
            <div>
              <strong>Question</strong>
              <Field label="What would we like to learn?">
                {(id) => (
                  <AutoTextarea
                    id={id}
                    rows={2}
                    value={hypothesis}
                    onChange={(e) => setHypothesis(e.target.value)}
                  />
                )}
              </Field>
            </div>
          </div>
          <i />
          <div>
            <span>03</span>
            <div>
              <strong>Change one thing</strong>
              <Field label="What changes in the next edit?">
                {(id) => (
                  <select
                    id={id}
                    value={editKind}
                    disabled={blocked}
                    onChange={(event) => {
                      const kind = event.target.value as LearningEdit["kind"];
                      setEditKind(kind);
                      setEditValue(
                        activeDirection ? editText(activeDirection, kind) : "",
                      );
                      setRecommendationSource("");
                    }}
                  >
                    <option value="opening">Opening text</option>
                    <option value="duration">Target duration</option>
                    <option value="framing">Framing</option>
                    <option value="captions">Caption style</option>
                    <option value="selection">
                      Source-selection rule · agent planning
                    </option>
                  </select>
                )}
              </Field>
              <Field
                label={
                  editKind === "opening"
                    ? "Proposed opening text"
                    : editKind === "duration"
                      ? "Proposed target duration (seconds)"
                      : editKind === "framing"
                        ? "Proposed framing"
                        : editKind === "captions"
                          ? "Proposed caption style"
                          : "Proposed source-selection rule"
                }
              >
                {(id) =>
                  editKind === "framing" ? (
                    <select
                      id={id}
                      value={editValue}
                      disabled={blocked}
                      onChange={(event) => setEditValue(event.target.value)}
                    >
                      <option value="fit">Fit · keep the full frame</option>
                      <option value="fill">
                        Fill · crop to the vertical frame
                      </option>
                    </select>
                  ) : editKind === "captions" ? (
                    <select
                      id={id}
                      value={editValue}
                      disabled={blocked}
                      onChange={(event) => setEditValue(event.target.value)}
                    >
                      <option value="standard">Standard</option>
                      <option value="high_contrast">High contrast</option>
                    </select>
                  ) : editKind === "duration" ? (
                    <input
                      id={id}
                      type="number"
                      min={1}
                      max={180}
                      step="0.1"
                      value={editValue}
                      disabled={blocked}
                      onChange={(event) => setEditValue(event.target.value)}
                    />
                  ) : (
                    <AutoTextarea
                      id={id}
                      rows={2}
                      value={editValue}
                      disabled={blocked}
                      maxLength={editKind === "opening" ? 250 : 4000}
                      onChange={(event) => setEditValue(event.target.value)}
                    />
                  )
                }
              </Field>
              {editError && (
                <p className="gf-help" role="alert">
                  {editError}
                </p>
              )}
              {activeDirection && proposedDirection && (
                <div className="gf-rule-diff">
                  <span>CURRENT → PROPOSED</span>
                  <p>
                    Current: {editText(activeDirection, editKind) || "Not set"}
                  </p>
                  <p>
                    Next: {editText(proposedDirection, editKind) || "Not set"}
                  </p>
                  <small>
                    {nextProductionMode(activeDirection, proposedDirection) ===
                    "agent"
                      ? "The agent will interpret this planning rule against the next source. A manual range alone cannot apply it."
                      : "This saved production field will be applied by the renderer on the next source."}
                  </small>
                </div>
              )}
              {!hasProductionChange && activeDirection && (
                <p className="gf-help">
                  Change one saved production field before proposing a new test.
                </p>
              )}
            </div>
          </div>
        </div>
        {pending && (
          <div className="gf-rule-diff">
            <span>PROPOSED DIRECTION</span>
            <p>
              {editText(
                pending.directions[w.profileId],
                firstChangedKind(
                  activeDirection!,
                  pending.directions[w.profileId],
                ),
              )}
            </p>
            <small>
              {canApprove
                ? "Matches the visible draft."
                : "The visible draft differs. Save it before approval."}
            </small>
            <small>{pending.hypothesis}</small>
          </div>
        )}
        <div className="gf-next-source">
          <div className="gf-next-source-art">
            <Icon name="file" size={24} />
          </div>
          <div>
            <span className="gf-overline">UP NEXT</span>
            <strong>
              {factory.data.videos.find((v) => v.id === nextSource)?.name ||
                "Attach a second source"}
            </strong>
            <span>Ready after your approval</span>
          </div>
          <Icon name="arrow" />
        </div>
        <div className="gf-card-action">
          <span>
            <Icon name="lock" size={13} /> Other profiles stay unchanged.
          </span>
          <PrimaryAction
            label={
              w.busy
                ? "Saving…"
                : canApprove
                  ? "Approve next test"
                  : pending
                    ? "Save next test draft"
                    : "Propose next test"
            }
            intent={canApprove ? "approve" : "iterate"}
            disabled={
              blocked ||
              !active ||
              (!canApprove &&
                (!selectedKnown.length ||
                  !hasProductionChange ||
                  !!editError ||
                  !hypothesis.trim()))
            }
            onClick={() => void primary()}
          />
        </div>
        <AnalystRecommendations
          key={`${w.campaign.id}-${w.profileId}`}
          w={w}
          observations={observations}
          blocked={blocked}
          onUse={(row, source) => {
            setEditKind("selection");
            setEditValue(row.recommendation);
            setHypothesis(
              "Test the selected analyst suggestion on the next source; it is not a proven improvement.",
            );
            setSelectedEvidence(row.observationIds);
            setRecommendationSource(source);
          }}
        />
        <Disclosure title="Production impact & receipts" icon="clock">
          <p>
            {clips.length} human-approved {reviewPreview ? "sample " : ""}
            outputs for this brand.
          </p>
          <p>
            Needs a matched baseline and recorded receipts.
          </p>
        </Disclosure>
      </section>
      </div>
    </>
  );
}

type ResultsData = {
  scoped: ReturnType<typeof scopeAutomation>;
  experiments: Row[];
  memory: LearningMemory | null;
  error: string;
};
const textOf = (v: unknown) => (typeof v === "string" ? v : "");

function useResultsData(w: Workspace, visible: boolean): ResultsData {
  const [data, setData] = useState<ResultsData>({
    scoped: null,
    experiments: [],
    memory: null,
    error: "",
  });
  const campaignId = w.campaign?.id,
    profileId = w.profileId;
  useEffect(() => {
    if (!visible || !profileId) return;
    let live = true;
    const load = async () => {
      const query = new URLSearchParams({ profile_id: profileId });
      if (campaignId) query.set("campaign_id", campaignId);
      const [state, accounts, digest] = await Promise.all([
        api<unknown>("/api/automation/state").catch(() => null),
        api<unknown>("/api/automation/accounts").catch(() => null),
        api<unknown>(`/api/automation/memory?${query}`).catch(() => null),
      ]);
      if (!live) return;
      try {
        const parsed = state ? parseAutomationState(state) : null;
        const rows = Array.isArray(accounts)
          ? (accounts.filter(
              (a) => a && typeof a === "object" && typeof a.id === "string",
            ) as Row[])
          : [];
        setData({
          scoped: scopeAutomation(
            parsed ? { ...parsed, accounts: rows } : null,
            campaignId,
            profileId,
          ),
          experiments: (parsed?.experiments ?? []).filter(
            (e) => e.campaign_id === campaignId && e.profile_id === profileId,
          ),
          memory: parseLearningMemory(digest),
          error: parsed ? "" : "Tracking data is unavailable right now.",
        });
      } catch (e) {
        setData((old) => ({
          ...old,
          error: e instanceof Error ? e.message : "Tracking data is unavailable.",
        }));
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 15000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [visible, campaignId, profileId]);
  return data;
}

function StoryHeader({ story }: { story: ReturnType<typeof resultsStory> }) {
  return (
    <section className="gf-results-story" aria-labelledby="gf-results-now">
      <ol aria-label="Post, measure, learn">
        {story.steps.map((step, n) => (
          <li
            key={step.key}
            className={`is-${step.state}`}
            aria-current={step.state === "current" ? "step" : undefined}
          >
            <span className="gf-results-story-num">
              {step.state === "done" ? <Icon name="check" size={13} /> : n + 1}
            </span>
            <span>
              <strong>{step.label}</strong>
              <small>{step.note}</small>
            </span>
          </li>
        ))}
      </ol>
      <p id="gf-results-now" className="gf-results-now" role="status">
        <span>Right now</span>
        {story.headline}
      </p>
    </section>
  );
}

function PostedClips({
  rows,
  untracked,
  error,
  onAccounts,
}: {
  rows: PostedRow[];
  untracked: Clip[];
  error: string;
  onAccounts: () => void;
}) {
  return (
    <section className="gf-results-card" aria-labelledby="gf-posted-title">
      <span className="gf-results-step">01</span>
      <h2 id="gf-posted-title">Posted clips</h2>
      {error && (
        <p className="gf-help" role="alert">
          {error}
        </p>
      )}
      {!rows.length && !untracked.length && (
        <div className="gf-results-empty">
          <p>
            Nothing posted yet.
          </p>
          <button
            type="button"
            className="gf-button secondary compact"
            onClick={onAccounts}
          >
            Instagram accounts
            <Icon name="arrow" size={14} />
          </button>
        </div>
      )}
      <ul className="gf-posted-list">
        {rows.map((row) => (
          <li key={row.id} className="gf-posted">
            <div className="gf-posted-head">
              <strong>{row.title}</strong>
              <span>
                {row.account}
                {row.postedAt
                  ? ` · posted ${new Date(row.postedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
                  : ""}
              </span>
            </div>
            {row.demo && (
              <span className="gf-automation-badge">
                Demo override · measured{" "}
                {row.demoHours === null ? "early" : `${row.demoHours} h after posting`}, before its window
              </span>
            )}
            {row.chips.length ? (
              <ul className="gf-ratio-chips" aria-label="Latest numbers vs your typical post">
                {row.chips.map((chip) => (
                  <li key={chip.metric} className={`is-${chip.tone}`}>
                    {chip.label}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="gf-posted-wait">No numbers yet — the first reading comes at the end of the window.</p>
            )}
            <div className="gf-posted-window">
              <span
                className="gf-posted-window-bar"
                role="progressbar"
                aria-label="Measurement window"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(row.window * 100)}
              >
                <i style={{ width: `${Math.round(row.window * 100)}%` }} />
              </span>
              <small>{row.windowLabel}</small>
            </div>
          </li>
        ))}
        {untracked.map((clip) => (
          <li key={clip.id} className="gf-posted is-untracked">
            <div className="gf-posted-head">
              <strong>{clip.hook || clip.name}</strong>
              <span>
                Posted
                {clip.published_at
                  ? ` ${new Date(clip.published_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
                  : ""}{" "}
                · not tracked yet
              </span>
            </div>
            <button
              type="button"
              className="gf-strategist-link"
              onClick={onAccounts}
            >
              Track it to measure
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LearnedExtra({ memory }: { memory: LearningMemory | null }) {
  if (!memory || (!memory.posts && !memory.comparisons.length)) return null;
  const known = memory.baseline.filter((m) => m.median !== null).slice(0, 4);
  const label = (name: string) => name.replace(/_/g, " ");
  return (
    <Panel padding="compact">
      {known.length > 0 && (
        <Section
          as="div"
          level={3}
          title="Your typical post"
          meta={`Median of ${memory.posts} tracked post${memory.posts === 1 ? "" : "s"}`}
        >
          <StatRow
            items={known.map((m) => ({ key: m.name, label: label(m.name), value: m.median!.toLocaleString() }))}
          />
        </Section>
      )}
      {memory.comparisons.length > 0 && (
        <Section as="div" level={3} title="Measured tests" count={memory.comparisons.length}>
          <Stack gap="xs">
            {memory.comparisons.map((c) => (
              <ListRow key={c.experimentId}>
                <span>{label(c.variable)}</span>
                <small>
                  {c.metrics
                    .map((m) => `${label(m.name)} ${m.parent?.toLocaleString() ?? "unknown"} → ${m.variant?.toLocaleString() ?? "unknown"}`)
                    .join(" · ")}
                </small>
              </ListRow>
            ))}
          </Stack>
        </Section>
      )}
    </Panel>
  );
}

/** Results: Post → Measure → Learn, then what is next and what needs you. */
const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));

/** The demo's outcome on Results: a simulated, deterministic history built from the brand's real clips. */
function DemoOutcome({ demo, sim, onReplay }: { demo: DemoResult; sim: SimResults; onReplay?: () => void }) {
  const { plan, after } = demo;
  const parent = plan.clips.find((c) => c.clip_id === plan.recut.clip_id);
  const byClip = new Map(sim.posts.map((p) => [p.clip_id, p]));
  const t = sim.typical;
  const chip = (label: string, value: number, typical: number, text = compact(value)) => (
    <span className={`gf-sim-chip${value > typical * 1.05 ? " is-up" : value < typical * 0.95 ? " is-down" : ""}`}>
      {label} <b>{text}</b>
    </span>
  );
  return (
    <section className="gf-results-sim" aria-labelledby="gf-results-sim-title">
      <header>
        <h2 id="gf-results-sim-title">Learning loop</h2>
        <span className="gf-results-sim-pill">Simulated</span>
        {onReplay && (
          <button type="button" className="gf-results-reset" onClick={onReplay}>
            Replay demo
          </button>
        )}
      </header>
      <h3 className="gf-sim-h">What we learned</h3>
      <div className="gf-results-learned-grid">
        {sim.beliefs.map((belief) => (
          <article key={belief.id} className="gf-results-belief">
            <strong>{belief.headline}</strong>
            <span className="gf-results-belief-bar" aria-hidden="true">
              <i style={{ width: `${Math.round(belief.confidence * 100)}%` }} />
            </span>
            <small>{belief.detail} · {Math.round(belief.confidence * 100)}% sure</small>
            <span className="gf-sim-cite" aria-label={`Supported by ${belief.support.length} clips`}>
              {belief.support.map((id) => {
                const post = byClip.get(id);
                return post ? <img key={id} src={post.cover_url} alt="" title={post.hook} /> : null;
              })}
            </span>
          </article>
        ))}
      </div>
      <article className="gf-results-sim-recut">
        <figure>
          <figcaption>Before</figcaption>
          {parent && <video src={parent.media_url} poster={parent.cover_url} controls playsInline preload="metadata" />}
        </figure>
        <div>
          <span className="gf-results-sim-chip">Hook: {plan.recut.before_kind} → {plan.recut.after_kind}</span>
          <p className="is-old">“{plan.recut.before_hook}”</p>
          <p>“{plan.recut.after_hook}”</p>
          <small>Draft · needs approval · next test: {plan.recut.next_test.toLowerCase()}</small>
        </div>
        <figure>
          <figcaption>After · new render</figcaption>
          {after ? (
            <video src={after.media_url} controls playsInline preload="metadata" />
          ) : (
            <div className="gf-results-sim-wait">Re-edit not rendered yet</div>
          )}
        </figure>
      </article>
      <h3 className="gf-sim-h">Posted clips <small>· typical {Math.round(t.hold_3s * 100)}% 3-sec hold</small></h3>
      <ul className="gf-sim-posts">
        {sim.posts.map((post) => {
          const m = post.metrics;
          return (
            <li key={post.clip_id} className={`gf-sim-post${post.role ? ` is-${post.role}` : ""}`}>
              <img src={post.cover_url} alt="" loading="lazy" />
              <div>
                <strong>{post.hook}</strong>
                <small>
                  {shortDate(post.posted_at)}
                  {post.role === "win" ? " · demo winner" : post.role === "loss" ? " · re-edited" : post.role ? " · in the demo" : ""}
                </small>
                <span className="gf-sim-chips">
                  {chip("Views", m.views, t.views)}
                  {chip("3s hold", m.hold_3s, t.hold_3s, `${Math.round(m.hold_3s * 100)}%`)}
                  {chip("Watch", m.avg_watch, t.avg_watch, `${Math.round(m.avg_watch * 100)}%`)}
                  {chip("Saves", m.saves, t.saves)}
                  {chip("Shares", m.shares, t.shares)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function Results({
  w,
  factory,
  next,
  visible = true,
  onReview,
  onEditingRules,
  onAccounts,
  onRehearse,
  demo = null,
  demoMode = false,
  demoOpen = false,
  onCloseDemo,
  onExitDemo,
  onDemoResult,
}: {
  w: Workspace;
  factory: FactoryState;
  next: (id?: string, mode?: "manual" | "agent") => void;
  visible?: boolean;
  onReview?: (clip: Clip) => void;
  onEditingRules?: () => void;
  /** Opens Settings > Accounts and connections, which owns the Instagram accounts. */
  onAccounts?: () => void;
  onRehearse?: () => void;
  /** The learning-loop demo's simulated outcome (its own store, never account history). */
  demo?: DemoResult | null;
  /** Demo Mode: the creator chose to explore simulated results. Off on every launch. */
  demoMode?: boolean;
  /** The demo panel expands inline below the strip. */
  demoOpen?: boolean;
  onCloseDemo?: () => void;
  onExitDemo?: () => void;
  onDemoResult?: (result: DemoResult) => void;
}) {
  const data = useResultsData(w, visible);
  const [view, setView] = useState<StrategistView | null>(null);
  const onView = useCallback((v: StrategistView) => setView(v), []);
  const clips = factory.data.clips.filter(
    (c) => c.campaign_id === w.campaign?.id && c.profile_id === w.profileId,
  );
  const approved = clips.filter((c) => c.approved);
  const publications = data.scoped?.publications ?? [];
  const tracked = new Set(publications.map((p) => textOf(p.clip_id)));
  const untracked = clips.filter(
    (c) => (c.instagram_media_id || c.published_at) && !tracked.has(c.id),
  );
  const now = Date.now();
  const rows = postedRows({
    publications,
    snapshots: data.scoped?.snapshots ?? [],
    policies: data.scoped?.policies ?? [],
    accounts: data.scoped?.accounts ?? [],
    clips,
    baseline: data.memory?.baseline ?? [],
    now,
  });
  const strategistPending = pendingRules([], view);
  // Proposed brand Style rules (from any source) that the Strategist did not list itself.
  const versionPending = pendingRules(
    w.versions.filter(
      (v) =>
        v.profile_id === w.profileId ||
        v.changed_profile_ids.includes(w.profileId),
    ),
    null,
  ).filter((p) => !strategistPending.some((s) => s.id === p.id));
  const memoryPending = [
    ...versionPending,
    ...(data.memory?.pending ?? []).filter(
      (p) =>
        !strategistPending.some((s) => s.id === p.id) &&
        !versionPending.some((v) => v.id === p.id),
    ),
  ];
  const drafts = data.experiments
    .map((e) => ({
      experiment: e,
      clip: clips.find((c) => c.id === e.clip_id && !c.approved),
    }))
    .filter((d): d is { experiment: Row; clip: Clip } => !!d.clip);
  const pendingCount =
    strategistPending.length +
    memoryPending.length +
    (view?.pending_proposals.campaign.length ?? 0);
  const story = resultsStory({
    approvedClips: approved.length,
    posted: rows.length + untracked.length,
    publications,
    snapshots: data.scoped?.snapshots ?? [],
    learned: (view?.beliefs ?? []).filter(
      (b) => b.status !== "retired" && b.counts.matching > 0,
    ).length,
    pendingRules: pendingCount,
    now,
  });
  const [moreOpen, setMoreOpen] = useState(false);
  const [demoShown, setDemoShown] = useState(demoOpen);
  const demoPanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (demoOpen) {
      setDemoShown(true);
      // Bring the whole panel, controls included, into view once it has expanded.
      const timer = window.setTimeout(() => demoPanel.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }), 400);
      return () => window.clearTimeout(timer);
    }
    // Keep the demo mounted while the panel collapses, then unmount it.
    const timer = window.setTimeout(() => setDemoShown(false), 380);
    return () => window.clearTimeout(timer);
  }, [demoOpen]);
  const brandPool = brandClips(factory.data.clips, w.profileId);
  const brandKey = brandPool.map((c) => c.id).join();
  const posted = rows.length + untracked.length;
  const measuring = rows.filter((r) => r.window < 1).length;
  const learned = (view?.beliefs ?? []).filter((b) => b.status !== "retired" && b.counts.matching > 0);
  // A demo draft already rendered for the re-edited clip fills the "after" side.
  const draft = demo && !demo.after
    ? [...factory.data.clips]
        .filter((c) => (c as Clip & { parent_clip_id?: string | null }).parent_clip_id === demo.plan.recut.clip_id)
        .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0]
    : undefined;
  const demoView: DemoResult | null = demo && draft
    ? { ...demo, after: { clip_id: draft.id, media_url: `/api/clips/${encodeURIComponent(draft.id)}/media`, hook: draft.hook } }
    : demo;
  // Simulated history only in Demo Mode, which the creator must choose. Display only:
  // never written to real tables and never shown beside real records.
  const sim = useMemo(
    () => (demoMode && demo ? simulateResults(demo, brandPool) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demoMode, demo, brandKey],
  );
  const connected = (data.scoped?.accounts ?? []).length > 0;
  const [manualOpen, setManualOpen] = useState(false);
  const [upgradesOpen, setUpgradesOpen] = useState(false);
  const toAccounts = useCallback(() => onAccounts?.(), [onAccounts]);

  return (
    <div className="gf-results-page is-minimal">
      <header className="gf-results-top">
        <dl className="gf-results-strip">
          <div><dt>Posted</dt><dd>{sim ? sim.posts.length : posted}</dd></div>
          <div><dt>Measuring</dt><dd>{sim ? sim.posts.length : measuring}</dd></div>
          <div><dt>Learned</dt><dd>{sim ? sim.beliefs.length : learned.length}</dd></div>
          {sim && <span className="gf-results-sim-pill">Simulated</span>}
        </dl>
        <div className="gf-results-top-actions">
          <button type="button" className={`gf-results-ig${connected ? " is-on" : ""}`} onClick={toAccounts}>
            <i aria-hidden="true" /> Instagram: {connected ? "connected" : "connect"}
          </button>
        </div>
      </header>
      {demoMode ? (
        <div className="gf-results-demo-banner" role="status">
          <span className="gf-results-sim-pill">Simulated</span>
          <p>
            <strong>Demo Mode.</strong> Sample data. Not your audience, not saved.
          </p>
          <div className="gf-results-demo-actions">
            {onRehearse && (
              <DemoLoopButton onClick={demoOpen ? () => onCloseDemo?.() : onRehearse} expanded={demoOpen} />
            )}
            <button type="button" className="gf-results-reset" onClick={() => onExitDemo?.()}>
              Exit Demo Mode
            </button>
          </div>
        </div>
      ) : (
        data.error && posted === 0 && (
          <p className="gf-help gf-results-error" role="alert">
            {data.error} Results will update when collection works again.
          </p>
        )
      )}
      <div ref={demoPanel} className={`gf-results-demo-panel${demoOpen ? " is-open" : ""}`}>
        <div>
          {w.profileId && demoMode && (demoOpen || demoShown) && (
            <LearningLoopDemo
              profileId={w.profileId}
              open
              onClose={() => onCloseDemo?.()}
              onResult={onDemoResult}
            />
          )}
        </div>
      </div>
      {demoMode && !sim && !demoOpen && (
        <p className="gf-results-empty" role="status">Preparing sample results from this brand&apos;s clips…</p>
      )}
      {demoView && sim && <DemoOutcome demo={demoView} sim={sim} onReplay={demoOpen ? undefined : onRehearse} />}
      {!demoMode && <p id="gf-results-now" className="gf-results-now" role="status">{story.headline}</p>}
      {!demoMode && posted === 0 && (
        <section className="gf-results-empty gf-results-start" aria-labelledby="gf-results-start-title">
          <div>
            <h2 id="gf-results-start-title">No results yet</h2>
            <p>
              Results appear once a clip is posted. Connect Instagram or add one by hand.
            </p>
          </div>
          <div className="gf-results-start-actions">
            <button type="button" className="gf-button" onClick={toAccounts}>
              {connected ? "Track a post" : "Connect Instagram"}
            </button>
            <button type="button" className="gf-button secondary" onClick={() => setManualOpen(true)}>
              Add a result by hand
            </button>
            {onRehearse && (
              <button type="button" className="gf-button ghost" onClick={onRehearse}>
                Try Demo Mode (simulated data)
              </button>
            )}
          </div>
        </section>
      )}
      {!demoMode && (posted > 0 || learned.length > 0) && <section className="gf-results-learned" aria-labelledby="gf-results-learned-title">
        <h2 id="gf-results-learned-title">What we learned</h2>
        {learned.length ? (
          <div className="gf-results-learned-grid">
            {learned.map((belief) => (
              <article key={belief.id} className="gf-results-belief">
                <strong>{belief.statement}</strong>
                <span className="gf-results-belief-bar" aria-hidden="true"><i style={{ width: `${Math.round(belief.confidence * 100)}%` }} /></span>
                <small>{Math.round(belief.confidence * 100)}% sure · {belief.counts.matching} posts</small>
              </article>
            ))}
          </div>
        ) : (
          <p className="gf-results-empty">No measured posts yet.</p>
        )}
      </section>}
      {!demoMode && posted > 0 && <PostedClips rows={rows} untracked={untracked} error={data.error} onAccounts={toAccounts} />}
      {!demoMode && onRehearse && posted > 0 && (
        <div className="gf-results-run">
          <button type="button" className="gf-results-reset" onClick={onRehearse}>
            Try Demo Mode (simulated data)
          </button>
        </div>
      )}
      {!demoMode && <details className="gf-results-more gf-ui-disclosure" open={moreOpen} onToggle={(event) => setMoreOpen(event.currentTarget.open)}>
        <summary>Strategist and tools{pendingCount + drafts.length > 0 ? ` · ${pendingCount + drafts.length} to review` : ""}</summary>
      {visible && w.profileId && (
        <StrategistPanel
          key={w.profileId}
          profileId={w.profileId}
          onOpenStyleRules={onEditingRules}
          onView={onView}
          learnedExtra={<LearnedExtra memory={data.memory} />}
          extraWaitingCount={memoryPending.length + drafts.length}
          extraWaiting={
            <>
              {memoryPending.map((p) => (
                <ListRow
                  key={p.id}
                  action={
                    <button
                      type="button"
                      className="gf-ui-text-button"
                      onClick={onEditingRules}
                      disabled={!onEditingRules}
                    >
                      Review in Style rules
                    </button>
                  }
                >
                  <span>New Style rules{p.version !== null ? ` version ${p.version}` : ""}</span>
                  {!("source" in p) && <small>From a measured test</small>}
                </ListRow>
              ))}
              {drafts.map(({ experiment, clip }) => (
                <ListRow
                  key={experiment.id}
                  action={
                    <button
                      type="button"
                      className="gf-ui-text-button"
                      onClick={() => onReview?.(clip)}
                      disabled={!onReview}
                    >
                      Review draft
                    </button>
                  }
                >
                  <span>
                    New draft: {textOf(experiment.variable).replace(/_/g, " ") || "edit"} change
                  </span>
                  <small>
                    “{clip.hook || clip.name}”
                    {experiment.trigger === "demo_override" && " · Demo override, measured early"}
                  </small>
                </ListRow>
              ))}
            </>
          }
        />
      )}
      {w.profileId && w.campaign?.id && <GrowthLoopPanel
        profileId={w.profileId}
        campaignId={w.campaign.id}
        strategyVersionId={activeRulesId(w) || w.campaign.active_strategy_id || null}
        clips={clips}
        visible={visible && moreOpen}
        onReview={onReview}
        onEditingRules={onEditingRules}
      />}
        <div className="gf-results-workspace-tools">
          <button type="button" onClick={() => setManualOpen(true)}><Icon name="upload" size={15} /> Add a result by hand</button>
          <button type="button" onClick={() => setUpgradesOpen(true)}><Icon name="settings" size={15} /> Factory upgrades</button>
        </div>
      </details>}
      <PanelDialog open={manualOpen && visible} onClose={() => setManualOpen(false)} title="Add a result by hand" description="For numbers the app can't read.">
        <HandEnteredResults w={w} factory={factory} next={next} />
      </PanelDialog>
      <PanelDialog open={upgradesOpen && visible} onClose={() => setUpgradesOpen(false)} title="Factory upgrades" description="Review craft gaps and proposed improvements.">
        {visible && <FactoryUpgrades />}
      </PanelDialog>
    </div>
  );
}
