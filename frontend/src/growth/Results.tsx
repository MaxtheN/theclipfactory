import { AutoTextarea } from "../components/AutoTextarea";
import { useState } from "react";
import type { FactoryState } from "../useFactory";
import type { Workspace } from "./useCampaignWorkspace";
import { reviewPreview, workspaceApi } from "./workspaceApi";
import { Disclosure, Empty, Field, Pill, PrimaryAction } from "./parts";
import { Icon } from "./Icon";

export function Results({
  w,
  factory,
  next,
}: {
  w: Workspace;
  factory: FactoryState;
  next: (id?: string) => void;
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
  const active = w.versions.find(
    (v) => v.id === w.campaign?.active_strategy_id,
  );
  const pending = [...w.versions]
    .sort((a, b) => b.version - a.version)
    .find(
      (v) =>
        v.status === "proposed" &&
        v.base_version_id === active?.id &&
        v.changed_profile_ids.includes(w.profileId) &&
        !!v.hypothesis?.trim() &&
        v.directions[w.profileId]?.evidence_refs.some((id) =>
          observations.some((o) => o.id === id),
        ),
    );
  const [rule, setRule] = useState(
    pending?.directions[w.profileId]?.moment_selection ||
      "Lead with the point. Move supporting context after the opening.",
  );
  const [hypothesis, setHypothesis] = useState(
    pending?.hypothesis ||
      "Test whether a more direct opening improves the selected metric.",
  );
  const canApprove =
    !!pending &&
    pending.hypothesis === hypothesis &&
    pending.directions[w.profileId]?.moment_selection === rule;
  const [metric, setMetric] = useState("full_episode_visits"),
    [value, setValue] = useState("");
  const [publication, setPublication] = useState("");
  const [clipId, setClipId] = useState(clips[0]?.id || "");
  const now = new Date();
  const previous = new Date(now.getTime() - 86400000);
  const local = (d: Date) =>
    new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  const [from, setFrom] = useState(local(previous)),
    [to, setTo] = useState(local(now));
  const known = observations.filter((o) => o.value !== null);
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
    if (!w.campaign || !active || blocked) return;
    if (canApprove && pending) {
      if (
        await w.run(
          () => workspaceApi.approve(w.campaign!.id, pending.id),
          "Next test approved. Let's give the next source a different opening.",
        )
      )
        next(nextSource);
    } else if (active.directions[w.profileId] && known.length)
      await w.run(
        () =>
          workspaceApi.learn(w.campaign!.id, {
            profile_id: w.profileId,
            observation_ids: known.map((o) => o.id),
            hypothesis,
            reason:
              "Creator-proposed test from imported observations; no causal improvement claimed.",
            base_version_id: active.id,
            proposed_direction: {
              ...active.directions[w.profileId],
              moment_selection: rule,
              limitations:
                "Observational evidence motivates this test; it does not establish audience improvement.",
              confidence: "low",
            },
          }),
        "Next test proposed. It needs your approval before it changes production.",
      );
  }
  if (!w.campaign)
    return (
      <Empty title="Every next edit needs a reason" icon="results">
        Start a campaign to build a traceable production and learning loop.
      </Empty>
    );
  const validDates =
    Number.isFinite(Date.parse(from)) &&
    Number.isFinite(Date.parse(to)) &&
    Date.parse(to) > Date.parse(from) &&
    Date.parse(to) <= Date.now();
  return (
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
          <h3>No winner. Yet.</h3>
          <p>
            {observations.length
              ? "Observations can inform a new test. They don't establish why an edit performed."
              : "There isn't enough evidence to compare outcomes. That's useful to know, too."}
          </p>
        </div>
        {observations.map((o) => (
          <div className="gf-observation" key={o.id}>
            <span>{o.metric.replace(/_/g, " ")}</span>
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
            evaluation service and cannot name a causal winner.
          </p>
        </Disclosure>
      </section>
      <section className="gf-card gf-next-test">
        <div className="gf-card-header">
          <div>
            <span className="gf-overline">02 / PLAN THE NEXT TEST</span>
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
                  ? `${known.length} known-value observation${known.length === 1 ? "" : "s"}, scoped to this profile.`
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
              <Field label="Proposed source-selection rule">
                {(id) => (
                  <AutoTextarea
                    id={id}
                    rows={2}
                    value={rule}
                    onChange={(e) => setRule(e.target.value)}
                  />
                )}
              </Field>
            </div>
          </div>
        </div>
        {pending && (
          <div className="gf-rule-diff">
            <span>PROPOSED DIRECTION</span>
            <p>{pending.directions[w.profileId]?.moment_selection}</p>
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
                (!known.length || !rule.trim() || !hypothesis.trim()))
            }
            onClick={() => void primary()}
          />
        </div>
        <Disclosure title="Production impact & receipts" icon="clock">
          <p>
            {clips.length} human-approved {reviewPreview ? "sample " : ""}
            outputs for this profile.
          </p>
          <p>
            Elapsed time, human minutes and cost per accepted asset need a
            matched baseline and actual recorded receipts. Missing values are
            unknown; no productivity advantage is claimed by this preview.
          </p>
        </Disclosure>
      </section>
    </div>
  );
}
