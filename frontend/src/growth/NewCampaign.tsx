import { useState } from "react";
import { AutoTextarea } from "../components/AutoTextarea";
import type { FactoryState } from "../useFactory";
import { objectives } from "../types";
import type { Workspace } from "./useCampaignWorkspace";
import { workspaceApi } from "./workspaceApi";
import { Field, PrimaryAction, formatTime } from "./parts";
import { Icon } from "./Icon";
import { objectiveLabels } from "./Setup";

/**
 * A goal-scoped push inside the current workspace. It creates one campaign
 * linked only to the selected workspace (profile); the workspace itself is
 * never changed here.
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
  const [footage, setFootage] = useState<string[]>([]);
  const metricNeeded = objective !== "discovery";
  const valid = !!name.trim() && (!metricNeeded || !!metric.trim());
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
    const label = objectiveLabels[objective as keyof typeof objectiveLabels];
    let createdId = "";
    const ok = await w.run(
      async () => {
        const saved = await workspaceApi.save({
          name: name.trim(),
          brief: {
            audience: workspace.audience,
            constraints: workspace.brand_context
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
              .slice(0, 30),
            requested_outputs: ["Vertical clips"],
            measurement_intent:
              objective === "discovery"
                ? "Discovery"
                : `${label}: ${metric.trim()}`,
          },
          profile_ids: [workspace.id],
          video_ids: footage,
        });
        if (
          !saved ||
          typeof saved.id !== "string" ||
          !saved.profile_ids?.includes(workspace.id)
        )
          throw new Error("The new campaign was not confirmed. Refresh before trying again.");
        createdId = saved.id;
      },
      "Campaign created. Approve its style rules before finding clips.",
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
        <span>For {workspace?.name || "this workspace"}. Nothing is published.</span>
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
