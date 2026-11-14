import { useState } from "react";
import { workspaceApi, initialDirection, reviewPreview } from "./workspaceApi";
import type { Workspace } from "./useCampaignWorkspace";
import { Disclosure, Field, Pill, Poster, Empty } from "./parts";
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
  const canApprove = !!pending && !changed;
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
        "Direction saved as a draft. Review it, then approve explicitly.",
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
      <section className="gf-card gf-reference">
        <div className="gf-card-header">
          <div>
            <span className="gf-overline">THE INSPIRATION</span>
            <h2>A place to start.</h2>
          </div>
          <Icon name="link" />
        </div>
        <div className="gf-reference-art">
          <Poster compact />
        </div>
        <Pill tone="quiet">
          {reviewPreview
            ? "Illustrative reference"
            : "Creator-supplied material"}
        </Pill>
        <p className="gf-body-copy">
          A good reference suggests an experiment. It doesn't predict a result.
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
        <Disclosure title="What has been inspected?" icon="research">
          <p>
            This screen saves your supplied rationale. Automated reference
            inspection is not connected yet. A link alone is not evidence that
            its contents were analyzed.
          </p>
        </Disclosure>
      </section>
      <section className="gf-card gf-hypothesis">
        <div className="gf-card-header">
          <div>
            <span className="gf-overline">THE CREATIVE DIRECTION</span>
            <h2>One idea. Two ways in.</h2>
          </div>
          <Pill tone={active ? "mint" : "quiet"}>
            {pending
              ? `v${pending.version} · Draft`
              : active
                ? `v${active.version} · Approved`
                : "Draft"}
          </Pill>
        </div>
        <Field label="The idea worth testing">
          {(id) => (
            <input
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
            <textarea
              id={id}
              value={selection}
              onChange={(e) => setSelection(e.target.value)}
              rows={2}
            />
          )}
        </Field>
        <div className="gf-variant-pair">
          <div>
            <span className="gf-variant-letter">A</span>
            <span className="gf-overline">FIRST APPROACH</span>
            <Field label="Opening A">
              {(id) => (
                <input
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
                <input
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
        <Disclosure title="Reasoning & limits" icon="info">
          <Field label="Why try this?">
            {(id) => (
              <textarea
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
        <div className="gf-card-action">
          <span>
            <Icon name="lock" size={13} /> Scoped to{" "}
            {w.profiles.find((p) => p.id === w.profileId)?.name ||
              "this profile"}
          </span>
          <button
            className="gf-button"
            disabled={
              blocked ||
              !angle.trim() ||
              !selection.trim() ||
              !hookA.trim() ||
              !hookB.trim() ||
              !reason.trim()
            }
            onClick={() => void primary()}
          >
            {w.busy
              ? "Saving…"
              : canApprove
                ? "Approve direction"
                : "Save direction draft"}
            <Icon name={canApprove ? "arrow" : "check"} size={16} />
          </button>
        </div>
      </section>
    </div>
  );
}
