import { AutoTextarea } from "../components/AutoTextarea";
import { useState } from "react";
import { workspaceApi, initialDirection } from "./workspaceApi";
import type { Workspace } from "./useCampaignWorkspace";
import { Disclosure, Field, Pill, Empty, PrimaryAction } from "./parts";
import { Icon } from "./Icon";

export function Research({ w, next }: { w: Workspace; next: () => void }) {
  const pending = [...w.versions]
    .sort((a, b) => b.version - a.version)
    .find((v) => v.status === "proposed" && v.directions[w.profileId]);
  const active = w.versions.find(
    (v) => v.id === w.campaign?.active_strategy_id,
  );
  const seed =
    pending?.directions[w.profileId] ||
    active?.directions[w.profileId] ||
    initialDirection();
  const [angle, setAngle] = useState(seed.angles[0] || "");
  const [selection, setSelection] = useState(seed.moment_selection);
  const [hookA, setHookA] = useState(seed.hooks[0] || "Claim first");
  const [hookB, setHookB] = useState(seed.hooks[1] || "Question first");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState(
    pending?.reason ||
      "Test the opening treatment while preserving source meaning.",
  );
  const direction = {
    ...seed,
    angles: [angle],
    moment_selection: selection,
    hooks: [hookA, hookB],
    editing_preferences: seed.editing_preferences,
  };
  const proposedReason = `${reason}${reference ? ` Supplied reference (not automatically inspected): ${reference}` : ""}`;
  const changed =
    proposedReason !== pending?.reason ||
    JSON.stringify(direction) !==
      JSON.stringify(pending?.directions[w.profileId]);
  // The server only approves a draft built on the current active version that
  // covers every profile in the campaign; anything else must be saved again.
  const draftCurrent =
    !!pending &&
    !!w.campaign &&
    pending.base_version_id === (w.campaign.active_strategy_id ?? null) &&
    w.campaign.profile_ids.every((id) => id in pending.directions);
  const canApprove = !!pending && !changed && draftCurrent;
  const changedFromActive =
    !active ||
    JSON.stringify(direction) !==
      JSON.stringify(active.directions[w.profileId]);
  const step = approvalStep({
    pending: !!pending,
    active: !!active,
    changed: pending ? changed : changedFromActive,
    draftCurrent,
  });
  const blocked = w.busy || w.loading || !!w.error || !w.campaign;
  async function primary() {
    if (!w.campaign || blocked) return;
    if (canApprove) {
      if (
        await w.run(
          () => workspaceApi.approve(w.campaign!.id, pending!.id),
          "Style rules approved. New clips will follow them.",
        )
      )
        next();
    } else
      await w.run(
        () =>
          workspaceApi.propose(
            w.campaign!.id,
            w.campaign!.active_strategy_id,
            Object.fromEntries(
              (active ? [w.profileId] : w.campaign!.profile_ids).map((id) => [
                id,
                id === w.profileId ? direction : initialDirection(),
              ]),
            ),
            proposedReason,
          ),
        "Draft saved. Approve it to use it.",
      );
  }
  if (!w.campaign)
    return (
      <Empty title="No channel yet" icon="research">
        Set up a channel first.
      </Empty>
    );
  return (
    <div className="gf-research-grid gf-style-rules">
      <section className="gf-card gf-hypothesis">
        <div className="gf-card-header">
          <div>
            <h2>Rules for the next clips</h2>
          </div>
          <Pill tone={pending ? "sand" : active ? "mint" : "quiet"}>
            {pending
              ? `v${pending.version} · Draft, not active`
              : active
                ? `v${active.version} · Approved`
                : "Not saved"}
          </Pill>
        </div>
        <div className="gf-form-fields gf-style-rule-fields">
          <Field label="What moments to look for">
            {(id) => (
              <AutoTextarea
                id={id}
                value={selection}
                onChange={(e) => setSelection(e.target.value)}
                rows={2}
              />
            )}
          </Field>
          <Field label="The angle">
            {(id) => (
              <AutoTextarea
                rows={1}
                className="gf-idea-input"
                id={id}
                value={angle}
                onChange={(e) => setAngle(e.target.value)}
                placeholder="Put the point before the context"
              />
            )}
          </Field>
          <div className="gf-form-pair">
            <Field label="Opening A">
              {(id) => (
                <AutoTextarea
                  rows={1}
                  id={id}
                  value={hookA}
                  onChange={(e) => setHookA(e.target.value)}
                  maxLength={250}
                />
              )}
            </Field>
            <Field label="Opening B">
              {(id) => (
                <AutoTextarea
                  rows={1}
                  id={id}
                  value={hookB}
                  onChange={(e) => setHookB(e.target.value)}
                  maxLength={250}
                />
              )}
            </Field>
          </div>
          <Disclosure title="Notes & reference" icon="info">
            <Field label="Why try this?">
              {(id) => (
                <AutoTextarea
                  id={id}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                />
              )}
            </Field>
            <Field
              label="Reference link or source locator"
              hint="Saved as a note. Links aren't opened or analyzed."
            >
              {(id) => (
                <input
                  id={id}
                  placeholder="URL, episode and timestamp"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              )}
            </Field>
            {seed.limitations && <p className="gf-help">{seed.limitations}</p>}
          </Disclosure>
        </div>
        <div className="gf-approval">
          <ol
            className="gf-approval-steps"
            aria-label="Direction approval steps"
          >
            <li data-state={step.saved ? "done" : "current"}>
              <span aria-hidden="true">{step.saved ? "✓" : "1"}</span> Save
              draft
            </li>
            <li
              data-state={
                step.approved ? "done" : step.saved ? "current" : "todo"
              }
            >
              <span aria-hidden="true">{step.approved ? "✓" : "2"}</span>{" "}
              Approve
            </li>
          </ol>
          <p
            className={step.approved ? "gf-approval-note" : "gf-help"}
            role="status"
          >
            {step.message(pending?.version, active?.version)}
          </p>
        </div>
        <div className="gf-card-action">
          <span>
            <Icon name="lock" size={13} /> For{" "}
            {w.profiles.find((p) => p.id === w.profileId)?.name ||
              "this channel"}
          </span>
          <PrimaryAction
            label={
              w.busy
                ? "Saving…"
                : canApprove
                  ? "Approve style rules"
                  : "Save draft"
            }
            intent={canApprove ? "approve" : "direction"}
            disabled={
              blocked ||
              !angle.trim() ||
              !selection.trim() ||
              !hookA.trim() ||
              !hookB.trim() ||
              !reason.trim()
            }
            onClick={() => void primary()}
          />
        </div>
      </section>
    </div>
  );
}

/** Where the creator is in save-draft -> approve, in words they can act on. */
export function approvalStep(state: {
  pending: boolean;
  active: boolean;
  changed: boolean;
  draftCurrent: boolean;
}) {
  const { pending, active, changed, draftCurrent } = state;
  if (pending && !draftCurrent)
    return {
      saved: false,
      approved: false,
      message: (draft?: number) =>
        `Draft v${draft} is out of date: a profile was added or the approved rules changed. Save again, then approve.`,
    };
  if (pending && changed)
    return {
      saved: false,
      approved: false,
      message: (draft?: number) =>
        `You've edited this since draft v${draft} was saved. Save again, then approve.`,
    };
  if (pending)
    return {
      saved: true,
      approved: false,
      message: (draft?: number) =>
        `Step 2 of 2: draft v${draft} is saved but not active yet. Approve it to use it.`,
    };
  if (active && !changed)
    return {
      saved: true,
      approved: true,
      message: (_draft?: number, current?: number) =>
        `v${current} is approved and active. Edits here become a new draft.`,
    };
  return {
    saved: false,
    approved: false,
    message: () =>
      active
        ? "Step 1 of 2: save your edits as a draft. The approved rules stay active until you approve the new one."
        : "Step 1 of 2: save these rules as a draft, then approve them.",
  };
}
