import { useEffect, useRef, useState } from "react";
import { App } from "../App";
import { useFactory } from "../useFactory";
import { useCampaignWorkspace } from "./useCampaignWorkspace";
import { reviewPreview } from "./workspaceApi";
import { Icon } from "./Icon";
import { Setup } from "./Setup";
import { Research } from "./Research";
import { Studio } from "./Studio";
import { Results } from "./Results";
import "./growth.css";

const steps = [
  {
    id: "setup",
    label: "Setup",
    detail: "Set the intention",
    title: "Set up your campaign.",
    sub: "Bring your footage, define your audience, and give the next edit a purpose.",
  },
  {
    id: "research",
    label: "Research",
    detail: "Find your direction",
    title: "Choose a creative direction.",
    sub: "Turn a useful reference into one clear idea and two openings to test.",
  },
  {
    id: "studio",
    label: "Studio",
    detail: "Make & refine",
    title: "Make the cut.",
    sub: "Choose a moment, refine the edit, and approve the exact version you want.",
  },
  {
    id: "results",
    label: "Results",
    detail: "Learn & repeat",
    title: "Learn from every edit.",
    sub: "Review the evidence and decide what to try in the next production.",
  },
] as const;
export type Stage = (typeof steps)[number]["id"];
function storedStage(): Stage {
  try {
    const v = localStorage.getItem("growth-stage");
    return steps.some((s) => s.id === v) ? (v as Stage) : "setup";
  } catch {
    return "setup";
  }
}
export function GrowthApp() {
  const factory = useFactory();
  const w = useCampaignWorkspace(factory.refresh);
  const [stage, setStage] = useState<Stage>(storedStage);
  const [tools, setTools] = useState(false),
    [creating, setCreating] = useState(false);
  const [preferredSource, setPreferredSource] = useState<string>();
  const [help, setHelp] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null),
    previous = useRef(stage);
  const current = steps.find((s) => s.id === stage)!;
  useEffect(() => {
    try {
      localStorage.setItem("growth-stage", stage);
    } catch {
      /* optional preference */
    }
    if (previous.current !== stage) {
      heading.current?.focus();
      previous.current = stage;
    }
  }, [stage]);
  const active = creating
    ? undefined
    : w.versions.find((v) => v.id === w.campaign?.active_strategy_id);
  const factoryErrors = Object.keys(factory.errors);
  const campaignClips = creating
    ? []
    : factory.data.clips.filter(
        (c) => c.campaign_id === w.campaign?.id && c.profile_id === w.profileId,
      );
  const completed = [
    !creating && !!w.campaign,
    !!active,
    campaignClips.length > 0,
    campaignClips.some((c) => c.approved),
    !!active && active.version > 1,
  ];
  const contextKey = `${creating ? "new" : w.campaign?.id || "empty"}-${w.profileId}`;
  return (
    <>
      {tools && (
        <div className="gf-operational">
          <div className="gf-tools-return">
            <button onClick={() => setTools(false)}>
              <Icon name="back" size={16} />
              Back to Growth Factory
            </button>
            <span>Workspace tools · existing local capabilities</span>
          </div>
          <App />
        </div>
      )}
      <div className="gf-app" hidden={tools}>
        <a className="gf-skip" href="#growth-main">
          Skip to content
        </a>
        <div className="gf-window">
          <aside className="gf-sidebar">
            <a
              className="gf-brand"
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setStage("setup");
              }}
              aria-label="Growth Factory home"
            >
              <span className="gf-brand-mark" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span>
                Growth
                <br />
                Factory<span className="gf-brand-period">.</span>
              </span>
            </a>
            <div className="gf-nav-caption">CAMPAIGN WORKSPACE</div>
            <nav aria-label="Campaign stages">
              {steps.map((s, i) => (
                <button
                  aria-label={`${String(i + 1).padStart(2, "0")} ${s.label} ${s.detail}`}
                  disabled={w.busy || (creating && s.id !== "setup")}
                  className={`gf-nav-item ${stage === s.id ? "active" : ""}`}
                  aria-current={stage === s.id ? "step" : undefined}
                  key={s.id}
                  onClick={() => setStage(s.id)}
                >
                  <span className="gf-nav-number">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span>
                    <strong>{s.label}</strong>
                    <small>{s.detail}</small>
                  </span>
                  {stage === s.id && <span className="gf-active-dot" />}
                </button>
              ))}
            </nav>
            <div className="gf-sidebar-note">
              <Icon name="lock" size={16} />
              <strong>Your creative loop.</strong>
              <p>
                From source footage to a reviewed edit. Your approval at every
                step.
              </p>
            </div>
            <div className="gf-sidebar-bottom">
              <button onClick={() => setTools(true)}>
                <Icon name="settings" size={17} />
                Workspace tools
                <Icon name="arrow" size={14} />
              </button>
              <button onClick={() => setHelp((v) => !v)}>
                <Icon name="info" size={17} />
                The way it works
              </button>
              <div className="gf-local-status">
                <span />
                {reviewPreview ? "INTERACTIVE PREVIEW" : "LOCAL-FIRST DESKTOP"}
                <span>v0.1</span>
              </div>
            </div>
          </aside>
          <div className="gf-workspace">
            <header className="gf-topbar">
              <div className="gf-breadcrumb">
                <Icon name="folder" size={17} />
                <select
                  aria-label="Current campaign"
                  value={creating ? "new" : w.selected}
                  disabled={w.busy || w.loading}
                  onChange={(e) => {
                    setCreating(false);
                    void w.select(e.target.value);
                  }}
                >
                  {creating ? (
                    <option value="new">New campaign</option>
                  ) : !w.campaign ? (
                    <option value="">Your workspace</option>
                  ) : null}
                  {w.campaigns.map((c) => (
                    <option value={c.id} key={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <span className="gf-top-divider" />
                <span className="gf-workspace-label">
                  {reviewPreview ? "Review workspace" : "On this Mac"}
                </span>
              </div>
              <div className="gf-top-right">
                {w.campaign && !creating && (
                  <select
                    aria-label="Active account profile"
                    value={w.profileId}
                    disabled={w.busy || w.loading}
                    onChange={(e) => w.setProfileId(e.target.value)}
                  >
                    {w.profiles
                      .filter((p) => w.campaign?.profile_ids.includes(p.id))
                      .map((p) => (
                        <option value={p.id} key={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                )}
                <button
                  className="gf-icon-button"
                  title="Refresh workspace"
                  aria-label="Refresh workspace"
                  disabled={w.busy || w.loading}
                  onClick={() => {
                    void w.load().catch(() => {});
                    void factory.refresh();
                  }}
                >
                  <Icon name="refresh" size={16} />
                </button>
                <span className="gf-avatar">K</span>
              </div>
            </header>
            {reviewPreview && (
              <div className="gf-preview-bar">
                <span className="gf-preview-dot" />
                <strong>Design preview</strong>
                <span>
                  Sample content. Local to this browser. No rendering or live
                  analytics.
                </span>
                <span className="gf-preview-tag">ALL-IN EXAMPLE</span>
              </div>
            )}
            <main id="growth-main" className="gf-main">
              <header className="gf-page-heading">
                <div>
                  <div className="gf-eyebrow">
                    <span />
                    {`STEP ${String(steps.findIndex((s) => s.id === stage) + 1).padStart(2, "0")} / ${current.label.toUpperCase()}`}
                  </div>
                  <h1 tabIndex={-1} ref={heading}>
                    {current.title}
                  </h1>
                  <p>{current.sub}</p>
                </div>
                <button
                  className="gf-button secondary compact gf-new"
                  disabled={w.busy}
                  onClick={() => {
                    setCreating(true);
                    setStage("setup");
                  }}
                >
                  <Icon name="plus" size={15} />
                  New campaign
                </button>
              </header>
              {help && (
                <div className="gf-message">
                  <Icon name="info" />
                  <span>
                    <strong>One campaign. A continuous creative loop.</strong>{" "}
                    Set a brief, approve direction, review a clip, then use
                    evidence to shape the next edit. Your approval stays part of
                    every handoff.
                  </span>
                  <button
                    className="gf-icon-button"
                    aria-label="Close guide"
                    onClick={() => setHelp(false)}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              )}
              {w.loading && (
                <div className="gf-loading" role="status">
                  <span className="gf-spinner" />
                  Opening your workspace…
                </div>
              )}
              {(w.error || factoryErrors.length > 0) && (
                <div className="gf-message error" role="alert">
                  <Icon name="info" />
                  <span>
                    <strong>
                      {w.error || "Some local resources are unavailable."}
                    </strong>
                    {factoryErrors.length > 0 && (
                      <small>
                        {[...new Set(Object.values(factory.errors))].join(" ")}
                      </small>
                    )}
                    <small>
                      Your draft stays here. Refresh to reconcile saved state
                      before retrying a failed action.
                    </small>
                  </span>
                  <button
                    className="gf-button secondary compact"
                    disabled={w.busy}
                    onClick={() => {
                      void w.load().catch(() => {});
                      void factory.refresh();
                    }}
                  >
                    Reconnect
                  </button>
                </div>
              )}
              {w.notice && (
                <div className="gf-message success" role="status">
                  <Icon name="check" />
                  <span>{w.notice}</span>
                  <button
                    className="gf-icon-button"
                    aria-label="Dismiss update"
                    onClick={w.clearNotice}
                  >
                    <Icon name="close" size={15} />
                  </button>
                </div>
              )}
              <div className="gf-stage" hidden={stage !== "setup"}>
                <Setup
                  key={creating ? "new" : w.campaign?.id || "empty"}
                  creating={creating}
                  onSaved={() => setCreating(false)}
                  w={w}
                  factory={factory}
                  next={() => setStage("research")}
                />
              </div>
              <div className="gf-stage" hidden={stage !== "research"}>
                <Research
                  key={contextKey}
                  w={w}
                  next={() => setStage("studio")}
                />
              </div>
              <div className="gf-stage" hidden={stage !== "studio"}>
                <Studio
                  key={contextKey}
                  w={w}
                  factory={factory}
                  preferredSource={preferredSource}
                  next={() => setStage("results")}
                />
              </div>
              <div className="gf-stage" hidden={stage !== "results"}>
                <Results
                  key={contextKey}
                  w={w}
                  factory={factory}
                  next={(id) => {
                    setPreferredSource(id);
                    setStage("studio");
                  }}
                />
              </div>
              <footer className="gf-bottom-line">
                <span>
                  <Icon name="lock" size={12} />
                  {reviewPreview
                    ? "Your feedback shapes the next version."
                    : "Local footage. Human decisions. Better creative work."}
                </span>
                <span>
                  {active ? (
                    <>
                      <span className="gf-tiny-dot" />
                      Strategy v{active.version} approved
                    </>
                  ) : (
                    "Your next great edit is waiting."
                  )}
                </span>
              </footer>
            </main>
            <div className="gf-journey" aria-label="Production journey">
              {["Brief", "Direction", "Create", "Review", "Learn"].map(
                (label, i) => (
                  <div className={completed[i] ? "reached" : ""} key={label}>
                    <span>
                      {completed[i] ? <Icon name="check" size={10} /> : i + 1}
                    </span>
                    <strong>{label}</strong>
                    {i < 4 && <i />}
                  </div>
                ),
              )}
              <Icon name="refresh" size={16} />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
