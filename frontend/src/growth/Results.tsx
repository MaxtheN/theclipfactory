import { AutoTextarea } from "../components/AutoTextarea";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Clip, Direction } from "../types";
import {
  AutomationPanel,
  parseAutomationState,
  parseLearningMemory,
  type LearningMemory,
} from "./AutomationPanel";
import { pendingRules, scopeAutomation, type Row } from "./flowEvents";
import { postedRows, resultsStory, type PostedRow } from "./resultsModel";
import { StrategistPanel } from "./StrategistPanel";
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
        Read completed recommendations for this brand. This does
        not run an agent or establish audience lift.
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
          No completed, scoped performance recommendations were found. The
          performance role may be skipped until observations or feedback exist.
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
        Set up your brand to build a traceable production and learning loop.
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
              : "There isn't enough evidence to compare outcomes. That's useful to know, too."}
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
            Manual publication references are retained with each observation.
            Unknown values remain unknown. This interface has no statistical
            evaluation service and cannot say which edit caused a result.
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
            Elapsed time, human minutes and cost per accepted asset need a
            matched baseline and actual recorded receipts. Missing values are
            unknown; no productivity advantage is claimed by this preview.
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
            Nothing posted yet. Approve a clip in Studio, post it, then track
            it here so it can be measured.
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
  return (
    <div className="gf-results-typical">
      {known.length > 0 && (
        <p>
          <strong>Your typical post</strong> (middle of {memory.posts} tracked):{" "}
          {known
            .map((m) => `${m.median!.toLocaleString()} ${m.name.replace(/_/g, " ")}`)
            .join(" · ")}
        </p>
      )}
      {memory.comparisons.map((c) => (
        <p key={c.experimentId}>
          <strong>Measured test · {c.variable.replace(/_/g, " ")}:</strong>{" "}
          {c.metrics
            .map(
              (m) =>
                `${m.name.replace(/_/g, " ")} ${m.parent?.toLocaleString() ?? "unknown"} → ${m.variant?.toLocaleString() ?? "unknown"}`,
            )
            .join(" · ")}
        </p>
      ))}
    </div>
  );
}

/** Results: Post → Measure → Learn, then what is next and what needs you. */
export function Results({
  w,
  factory,
  next,
  visible = true,
  onReview,
  onEditingRules,
}: {
  w: Workspace;
  factory: FactoryState;
  next: (id?: string, mode?: "manual" | "agent") => void;
  visible?: boolean;
  onReview?: (clip: Clip) => void;
  onEditingRules?: () => void;
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
  const accounts = useRef<HTMLDivElement>(null);
  const toAccounts = useCallback(() => {
    const el = accounts.current;
    if (!el) return;
    const details = el.querySelector("details");
    if (details && !details.open) details.open = true;
    el.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, []);
  useEffect(() => {
    if (!visible || !["#gf-accounts", "#connections"].includes(window.location.hash))
      return;
    const frame = window.requestAnimationFrame(() => {
      toAccounts();
      // A one-time jump: the next launch opens where the person left off.
      if (window.location.hash === "#gf-accounts")
        window.history.replaceState(
          null,
          "",
          window.location.pathname + window.location.search,
        );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [visible, toAccounts]);

  return (
    <div className="gf-results-page">
      <StoryHeader story={story} />
      <PostedClips
        rows={rows}
        untracked={untracked}
        error={data.error}
        onAccounts={toAccounts}
      />
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
                <article key={p.id} className="gf-strategist-proposal">
                  <span>
                    New Style rules
                    {p.version !== null ? ` version ${p.version}` : ""} to review
                    {"source" in p ? "" : " · from a measured test"}
                  </span>
                  <button
                    type="button"
                    className="gf-strategist-link"
                    onClick={onEditingRules}
                    disabled={!onEditingRules}
                  >
                    Review in Style rules
                  </button>
                </article>
              ))}
              {drafts.map(({ experiment, clip }) => (
                <article key={experiment.id} className="gf-strategist-proposal">
                  <span>
                    New draft to review: changes the{" "}
                    {textOf(experiment.variable).replace(/_/g, " ") || "edit"} ·{" "}
                    “{clip.hook || clip.name}”
                    {experiment.trigger === "demo_override" && (
                      <span className="gf-automation-badge">
                        Demo override · measured early
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    className="gf-strategist-link"
                    onClick={() => onReview?.(clip)}
                    disabled={!onReview}
                  >
                    Review draft
                  </button>
                </article>
              ))}
            </>
          }
        />
      )}
      <div ref={accounts} className="gf-results-accounts">
        <AutomationPanel
          w={w}
          factory={factory}
          visible={visible}
          onReview={onReview}
          onEditingRules={onEditingRules}
          layout="accounts"
        />
      </div>
      <Disclosure title="Add a result by hand" icon="upload">
        <p className="gf-help">
          For numbers from somewhere the app can't read. Each one keeps its
          source and window; nothing here proves why a clip did well.
        </p>
        <HandEnteredResults w={w} factory={factory} next={next} />
      </Disclosure>
    </div>
  );
}
