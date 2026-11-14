import { useState } from "react";
import { AutoTextarea } from "../components/AutoTextarea";
import type { Campaign } from "../types";
import type { Workspace } from "./useCampaignWorkspace";
import { workspaceApi, type CampaignInput } from "./workspaceApi";
import { Field, FieldGroup, PrimaryAction } from "./parts";
import { Icon } from "./Icon";
import {
  BRIEF_LIMITS as L,
  briefBody,
  briefProblem,
  normalizeBrief,
  sameBrief,
  type FullBrief,
} from "./briefModel";
import "./campaign-brief.css";

/** A short list typed one item at a time: Enter or Add, × removes. */
function Chips({
  label,
  hint,
  values,
  onChange,
  max,
  maxLength,
  placeholder,
  disabled,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (values: string[]) => void;
  max: number;
  maxLength: number;
  placeholder: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const value = draft.trim();
  const full = values.length >= max;
  const repeated = values.some((v) => v.toLowerCase() === value.toLowerCase());
  const add = () => {
    if (!value || full || repeated) return;
    onChange([...values, value]);
    setDraft("");
  };
  return (
    <Field label={label} hint={hint ?? `Up to ${max}.`}>
      {(id) => (
        <div className="gf-brief-chips">
          {values.length > 0 && (
            <ul aria-label={label}>
              {values.map((v, index) => (
                <li key={v} className="gf-pill">
                  <span>{v}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${v}`}
                    disabled={disabled}
                    onClick={() => onChange(values.filter((_, i) => i !== index))}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="gf-brief-chip-input">
            <input
              id={id}
              value={draft}
              maxLength={maxLength}
              placeholder={full ? `${max} added` : placeholder}
              disabled={disabled || full}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <button
              type="button"
              className="gf-button ghost compact"
              aria-label={`Add to ${label}`}
              disabled={disabled || !value || full || repeated}
              onClick={add}
            >
              <Icon name="plus" size={14} />
              Add
            </button>
          </div>
        </div>
      )}
    </Field>
  );
}

const numberOrNull = (text: string) => (text.trim() === "" ? null : Number(text));

/** The brief's fields, grouped. Controlled: the caller owns the value and the save. */
export function BriefFields({
  value,
  onChange,
  disabled,
  workspaceAudience,
}: {
  value: FullBrief;
  onChange: (next: FullBrief) => void;
  disabled?: boolean;
  workspaceAudience?: string;
}) {
  const set = (patch: Partial<FullBrief>) => onChange({ ...value, ...patch });
  const deliverables = (patch: Partial<FullBrief["deliverables"]>) =>
    set({ deliverables: { ...value.deliverables, ...patch } });
  const [refUrl, setRefUrl] = useState("");
  const [refNote, setRefNote] = useState("");
  return (
    <div className="gf-campaign-brief">
      <FieldGroup title="Message">
        <Chips
          label="Key messages"
          hint="Up to 5. Agents prefer moments that make one of these points."
          values={value.key_messages}
          onChange={(key_messages) => set({ key_messages })}
          max={L.messages}
          maxLength={L.message}
          placeholder="e.g. Agents still need human review"
          disabled={disabled}
        />
        <Field label="Call to action" hint="Shown on the closing card of every clip.">
          {(id) => (
            <input
              id={id}
              maxLength={L.cta}
              value={value.cta}
              disabled={disabled}
              placeholder="e.g. Listen to the full episode"
              onChange={(e) => set({ cta: e.target.value })}
            />
          )}
        </Field>
        <Field label="Call-to-action link" hint="Optional. Not shown in the video.">
          {(id) => (
            <input
              id={id}
              type="url"
              maxLength={L.link}
              value={value.cta_link || ""}
              disabled={disabled}
              placeholder="https://"
              onChange={(e) => set({ cta_link: e.target.value || null })}
            />
          )}
        </Field>
      </FieldGroup>
      <FieldGroup title="Audience and tone">
        <Field
          label="Target audience"
          hint={workspaceAudience ? `Blank uses the brand's audience: ${workspaceAudience.slice(0, 80)}` : "Blank uses the brand's audience."}
        >
          {(id) => (
            <AutoTextarea
              id={id}
              rows={1}
              maxLength={L.audience}
              value={value.audience}
              disabled={disabled}
              placeholder="e.g. Engineering leads evaluating AI agents"
              onChange={(e) => set({ audience: e.target.value })}
            />
          )}
        </Field>
        <Field label="Tone">
          {(id) => (
            <AutoTextarea
              id={id}
              rows={1}
              maxLength={L.tone}
              value={value.tone}
              disabled={disabled}
              placeholder="e.g. Dry, specific, no hype"
              onChange={(e) => set({ tone: e.target.value })}
            />
          )}
        </Field>
      </FieldGroup>
      <FieldGroup title="Topics">
        <Chips
          label="Must include"
          values={value.must_include}
          onChange={(must_include) => set({ must_include })}
          max={L.topics}
          maxLength={L.topic}
          placeholder="e.g. agent evaluation"
          disabled={disabled}
        />
        <Chips
          label="Must avoid"
          hint="Up to 8. Moments that touch these are rejected."
          values={value.must_avoid}
          onChange={(must_avoid) => set({ must_avoid })}
          max={L.topics}
          maxLength={L.topic}
          placeholder="e.g. market predictions"
          disabled={disabled}
        />
      </FieldGroup>
      <FieldGroup title="Deliverables">
        <div className="gf-brief-row">
          <Field label="Clips">
            {(id) => (
              <input
                id={id}
                type="number"
                min={1}
                max={50}
                step={1}
                value={value.deliverables.clip_count ?? ""}
                disabled={disabled}
                placeholder="Any"
                onChange={(e) => deliverables({ clip_count: numberOrNull(e.target.value) })}
              />
            )}
          </Field>
          <Field label="Max length (s)">
            {(id) => (
              <input
                id={id}
                type="number"
                min={5}
                max={180}
                value={value.deliverables.max_duration_seconds ?? ""}
                disabled={disabled}
                placeholder="Style rules"
                onChange={(e) => deliverables({ max_duration_seconds: numberOrNull(e.target.value) })}
              />
            )}
          </Field>
          <div className="gf-field">
            <span>Platform</span>
            <strong>Instagram Reels</strong>
          </div>
        </div>
      </FieldGroup>
      <FieldGroup title="Context">
        <Field label="Context" hint={`${value.context.length.toLocaleString()} / ${L.context.toLocaleString()}`}>
          {(id) => (
            <AutoTextarea
              id={id}
              rows={2}
              maxLength={L.context}
              value={value.context}
              disabled={disabled}
              placeholder="e.g. Episode 42 with a startup CTO about agent reliability"
              onChange={(e) => set({ context: e.target.value })}
            />
          )}
        </Field>
        <Field label="References" hint="For you and reviewers. Agents never open these links.">
          {(id) => (
            <div className="gf-brief-chips">
              {value.references.length > 0 && (
                <ul aria-label="References">
                  {value.references.map((r, index) => (
                    <li key={`${r.url}-${index}`} className="gf-pill">
                      <span>
                        {r.url}
                        {r.note ? ` · ${r.note}` : ""}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${r.url}`}
                        disabled={disabled}
                        onClick={() => set({ references: value.references.filter((_, i) => i !== index) })}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="gf-brief-chip-input">
                <input
                  id={id}
                  type="url"
                  value={refUrl}
                  maxLength={L.link}
                  placeholder="https://www.instagram.com/reel/…"
                  disabled={disabled || value.references.length >= L.references}
                  onChange={(e) => setRefUrl(e.target.value)}
                />
                <input
                  aria-label="Reference note"
                  value={refNote}
                  maxLength={L.note}
                  placeholder="Why (optional)"
                  disabled={disabled || value.references.length >= L.references}
                  onChange={(e) => setRefNote(e.target.value)}
                />
                <button
                  type="button"
                  className="gf-button ghost compact"
                  aria-label="Add reference"
                  disabled={disabled || !refUrl.trim() || value.references.length >= L.references}
                  onClick={() => {
                    set({ references: [...value.references, { url: refUrl.trim(), note: refNote.trim() }] });
                    setRefUrl("");
                    setRefNote("");
                  }}
                >
                  <Icon name="plus" size={14} />
                  Add
                </button>
              </div>
            </div>
          )}
        </Field>
      </FieldGroup>
    </div>
  );
}

type SaveState = { kind: "idle" | "saved" | "failed" | "unknown"; message: string };

/** The exact campaign body for a brief-only save: every other field from the latest saved record. */
export function briefSaveBody(latest: Campaign, brief: FullBrief): CampaignInput {
  return {
    name: latest.name,
    brief: briefBody(brief),
    profile_ids: [...latest.profile_ids],
    video_ids: [...latest.video_ids],
    objective: latest.objective ?? "discovery",
    primary_metric: latest.primary_metric ?? null,
    notes: latest.notes ?? "",
  };
}

/**
 * Edit and save one campaign's brief. Save reads the latest campaign, PUTs that exact record with
 * only the brief changed (membership preserved), then reads it back before saying it is saved.
 */
export function CampaignBriefEditor({
  w,
  campaign,
  workspaceAudience,
}: {
  w: Workspace;
  campaign: Campaign;
  workspaceAudience?: string;
}) {
  const [draft, setDraft] = useState<FullBrief>(() => normalizeBrief(campaign.brief));
  const [state, setState] = useState<SaveState>({ kind: "idle", message: "" });
  const problem = briefProblem(draft);
  const changed = !sameBrief(draft, campaign.brief);
  const blocked = w.busy || w.loading || state.kind === "unknown";

  async function save() {
    if (blocked || problem) return;
    let stage = "read" as "read" | "write" | "readback";
    let failure = "";
    const ok = await w.run(async () => {
      try {
        const latest = (await workspaceApi.campaigns()).find((c) => c.id === campaign.id);
        if (!latest) throw new Error("These goals are no longer available. Refresh and try again.");
        const body = briefSaveBody(latest, draft);
        stage = "write";
        await workspaceApi.save(body, campaign.id);
        stage = "readback";
        const saved = (await workspaceApi.campaigns()).find((c) => c.id === campaign.id);
        if (
          !saved ||
          !sameBrief(saved.brief, body.brief) ||
          !body.profile_ids.every((id) => saved.profile_ids.includes(id)) ||
          !body.video_ids.every((id) => saved.video_ids.includes(id))
        )
          throw new Error("The saved brief did not match your edits.");
      } catch (error) {
        failure = error instanceof Error && error.message ? error.message : "The save failed.";
        throw error;
      }
    }, "Brief saved. The next production uses it; earlier clips keep theirs.");
    if (ok) setState({ kind: "saved", message: "Brief saved and confirmed." });
    else if (!failure) setState({ kind: "unknown", message: "Saved, but the screen could not refresh. Reload before editing again." });
    else if (stage === "read") setState({ kind: "failed", message: `${failure} Nothing was saved.` });
    else
      setState({
        kind: stage === "readback" ? "unknown" : "failed",
        message:
          stage === "readback"
            ? `${failure} The brief may or may not have been saved. Reload before editing again.`
            : `${failure} Your edits are still here.`,
      });
  }

  return (
    <section className="gf-brief-editor" aria-label="Brief">
      <BriefFields
        value={draft}
        disabled={w.busy}
        workspaceAudience={workspaceAudience}
        onChange={(next) => {
          setDraft(next);
          if (state.kind !== "unknown") setState({ kind: "idle", message: "" });
        }}
      />
      <div className="gf-brief-actions">
        <span role={problem || state.kind === "failed" || state.kind === "unknown" ? "alert" : state.kind === "saved" ? "status" : undefined}>
          {problem || state.message || (changed ? "Unsaved brief changes." : "Every agent reads this brief.")}
        </span>
        <PrimaryAction
          label={w.busy ? "Saving…" : "Save brief"}
          intent="approve"
          disabled={blocked || !!problem || !changed}
          onClick={() => void save()}
        />
      </div>
    </section>
  );
}
