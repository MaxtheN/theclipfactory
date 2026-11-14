import { useState } from "react";
import { AutoTextarea } from "../components/AutoTextarea";
import type { FactoryState } from "../useFactory";
import { objectives } from "../types";
import type { Workspace } from "./useCampaignWorkspace";
import { workspaceApi } from "./workspaceApi";
import { Field, FieldGroup, PrimaryAction, formatTime } from "./parts";
import { Icon } from "./Icon";
import { objectiveLabels } from "./Setup";
import { BriefFields } from "./CampaignBrief";
import { briefBody, briefProblem, emptyBrief } from "./briefModel";

/**
 * A goal-scoped push inside the current workspace. It creates one campaign
 * linked only to the selected workspace (profile) with its own goal and
 * metric. It inherits the workspace's approved style rules, so there is no
 * separate approval; the workspace itself is never changed here.
 */
export function NewCampaign({
  w,
  factory,
  onCreated,
  onCancel,
}: {
  w: Workspace;
  factory: FactoryState;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const workspace = w.profiles.find((p) => p.id === w.profileId);
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("discovery");
  const [metric, setMetric] = useState("");
  const [notes, setNotes] = useState("");
  const [brief, setBrief] = useState(emptyBrief);
  const problem = briefProblem(brief);
  const rulesApproved = !!workspace?.active_strategy_id;
  const [footage, setFootage] = useState<string[]>([]);
  const metricNeeded = objective !== "discovery";
  const valid = !!name.trim() && (!metricNeeded || !!metric.trim()) && !problem;
  const blocked = w.busy || w.loading || !workspace;
  // Footage already in this workspace's campaigns: attaching reuses it, nothing is uploaded.
  const own = new Set(
    w.campaigns
      .filter((c) => c.profile_ids.includes(w.profileId))
      .flatMap((c) => c.video_ids),
  );
  const videos = factory.data.videos.filter((v) => own.has(v.id));

  async function create() {
    if (blocked || !valid || !workspace) return;
    let createdId = "";
    const ok = await w.run(
      async () => {
        const saved = await workspaceApi.save({
          name: name.trim(),
          // The workspace's audience, voice and boundaries are read from the workspace;
          // the brief only says what this campaign adds.
          brief: briefBody(brief),
          profile_ids: [workspace.id],
          video_ids: footage,
          objective,
          primary_metric: metricNeeded ? metric.trim() : null,
          notes: notes.trim(),
        });
        if (
          !saved ||
          typeof saved.id !== "string" ||
          !saved.profile_ids?.includes(workspace.id)
        )
          throw new Error("The new campaign was not confirmed. Refresh before trying again.");
        createdId = saved.id;
      },
      rulesApproved
        ? "Campaign created. It uses this brand's approved style rules."
        : "Campaign created. Approve the style rules before finding clips.",
    );
    if (!ok || !createdId) return;
    // Open the new campaign; this workspace stays selected because it is linked.
    await w.load(createdId).catch(() => {});
    onCreated();
  }

  return (
    <section className="gf-card gf-new-campaign" aria-label="New campaign">
      <div className="gf-form-fields">
        <Field label="Campaign name">
          {(id) => (
            <AutoTextarea
              rows={1}
              id={id}
              maxLength={200}
              placeholder="e.g. Episode 210 launch"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label="Goal">
          {(id) => (
            <select
              id={id}
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
            >
              {objectives.map((value) => (
                <option key={value} value={value}>
                  {objectiveLabels[value]}
                </option>
              ))}
            </select>
          )}
        </Field>
        {metricNeeded && (
          <Field label="Metric">
            {(id) => (
              <input
                id={id}
                maxLength={200}
                placeholder="e.g. full_episode_visits"
                value={metric}
                onChange={(e) => setMetric(e.target.value)}
              />
            )}
          </Field>
        )}
        <Field
          label="Campaign notes"
          hint="Optional. Added to the agents' instructions for this campaign only."
        >
          {(id) => (
            <AutoTextarea
              rows={2}
              id={id}
              maxLength={2000}
              placeholder="e.g. Favour the guest's founding story"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          )}
        </Field>
        <FieldGroup title="Campaign brief">
          <BriefFields
            value={brief}
            onChange={setBrief}
            disabled={w.busy}
            workspaceAudience={workspace?.audience}
          />
        </FieldGroup>
        {videos.length > 0 && (
          <fieldset className="gf-profile-options">
            <legend>Attach episodes</legend>
            {videos.map((v) => {
              const on = footage.includes(v.id);
              return (
                <label key={v.id} className={on ? "selected" : ""}>
                  <input
                    type="checkbox"
                    aria-label={`Attach ${v.name}`}
                    checked={on}
                    onChange={(e) =>
                      setFootage((old) =>
                        e.target.checked
                          ? [...old, v.id]
                          : old.filter((id) => id !== v.id),
                      )
                    }
                  />
                  <Icon name="studio" size={14} />
                  {v.name}
                  {typeof v.duration === "number" && (
                    <small> · {formatTime(v.duration)}</small>
                  )}
                </label>
              );
            })}
          </fieldset>
        )}
      </div>
      <div className="gf-stage-action">
        <span>
          {problem ? `${problem} ` : ""}
          For {workspace?.name || "this brand"}.{" "}
          {rulesApproved
            ? "Uses the brand's style rules."
            : "The style rules still need approval."}{" "}
          Nothing is published.
        </span>
        <div className="gf-channel-actions">
          <button
            type="button"
            className="gf-button ghost compact"
            disabled={w.busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <PrimaryAction
            label={w.busy ? "Creating…" : "Create campaign"}
            intent="approve"
            disabled={blocked || !valid}
            onClick={() => void create()}
          />
        </div>
      </div>
    </section>
  );
}
