import { AutoTextarea } from "../components/AutoTextarea";
import { useState } from "react";
import { workspaceApi, initialDirection, reviewPreview } from "./workspaceApi";
import type { Workspace } from "./useCampaignWorkspace";
import {
  Disclosure,
  Field,
  FieldGroup,
  Pill,
  Poster,
  Empty,
  PrimaryAction,
} from "./parts";
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
          "Direction approved. You're ready to make something.",
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
        "Draft saved. Step 2: click Approve direction to activate it.",
      );
  }
  if (!w.campaign)
    return (
      <Empty title="Give your idea a home" icon="research">
        Save a campaign in Setup before choosing its creative direction.
      </Empty>
    );
  return (
    <div className="gf-research-grid">
      <section className="gf-card gf-hypothesis">
        <div className="gf-card-header">
          <div>
            <span className="gf-overline">THE CREATIVE DIRECTION</span>
            <h2>Proposed test</h2>
          </div>
          <Pill tone={pending ? "sand" : active ? "mint" : "quiet"}>
            {pending
              ? `v${pending.version} · Draft, not active`
              : active
                ? `v${active.version} · Approved`
                : "Not saved"}
          </Pill>
        </div>
        <div className="gf-research-reference">
          <Disclosure title="Reference & inspection details" icon="link">
            <div className="gf-reference-art">
              <Poster compact />
            </div>
            <Pill tone="quiet">
              {reviewPreview
                ? "Illustrative reference"
                : "Creator-supplied material"}
            </Pill>
            <p className="gf-body-copy">
              A good reference suggests an experiment. It doesn't predict a
              result.
            </p>
            <Field label="Reference link or source locator">
              {(id) => (
                <input
                  id={id}
                  placeholder="URL, episode and timestamp"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              )}
            </Field>

            <p>
              This screen saves your supplied rationale. Automated reference
              inspection is not connected yet. A link alone is not evidence that
              its contents were analyzed.
            </p>
          </Disclosure>
          <p className="gf-research-note">
            Creator-provided direction. Automated reference inspection is not
            connected.
          </p>
        </div>
        <FieldGroup
          title="01 / The idea & source moment"
          className="gf-direction-group"
        >
          <Field label="The idea worth testing">
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
          <Field label="What should the source moment do?">
            {(id) => (
              <AutoTextarea
                id={id}
                value={selection}
                onChange={(e) => setSelection(e.target.value)}
                rows={2}
              />
            )}
          </Field>
        </FieldGroup>
        <FieldGroup
          title="02 / The opening experiment"
          className="gf-experiment-group"
        >
          <div className="gf-variant-pair">
            <div>
              <span className="gf-variant-letter">A</span>
              <span className="gf-overline">FIRST APPROACH</span>
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
            </div>
            <div>
              <span className="gf-variant-letter">B</span>
              <span className="gf-overline">THE ALTERNATIVE</span>
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
          </div>
          <div className="gf-test-variable">
            <Icon name="settings" size={15} />
            <span>
              One variable: <strong>opening treatment</strong>
            </span>
            <span>Same source. Same context.</span>
          </div>
        </FieldGroup>
        <Disclosure title="Reasoning & limits" icon="info">
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
          <p>{seed.limitations}</p>
          <p>
            Confidence describes creative judgment, not predicted business
            impact. Only explicit approval activates a version.
          </p>
        </Disclosure>
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
            <Icon name="lock" size={13} /> Scoped to{" "}
            {w.profiles.find((p) => p.id === w.profileId)?.name ||
              "this profile"}
          </span>
          <PrimaryAction
            label={
              w.busy
                ? "Saving…"
                : canApprove
                  ? "Approve direction"
                  : "Save direction draft"
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
        `Draft v${draft} is out of date: a profile was added or the approved direction changed since it was saved. Save the draft again, then approve it.`,
    };
  if (pending && changed)
    return {
      saved: false,
      approved: false,
      message: (draft?: number) =>
        `You've edited this since draft v${draft} was saved. Save the draft again, then approve it.`,
    };
  if (pending)
    return {
      saved: true,
      approved: false,
      message: (draft?: number) =>
        `Step 2 of 2: draft v${draft} is saved but not active yet. Click Approve direction to unlock Studio.`,
    };
  if (active && !changed)
    return {
      saved: true,
      approved: true,
      message: (_draft?: number, current?: number) =>
        `v${current} is approved and active. Studio is unlocked; editing here creates a new draft to approve.`,
    };
  return {
    saved: false,
    approved: false,
    message: () =>
      active
        ? "Step 1 of 2: save your edits as a draft. The approved direction stays active until you approve the new one."
        : "Step 1 of 2: save this direction as a draft. Then approve it to unlock Studio.",
  };
}
