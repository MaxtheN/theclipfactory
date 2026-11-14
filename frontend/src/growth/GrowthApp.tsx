import { useEffect, useRef, useState } from "react";
import { PanelLeft } from "lucide-react";
import { App } from "../App";
import { useFactory } from "../useFactory";
import { useCampaignWorkspace } from "./useCampaignWorkspace";
import { reviewPreview } from "./workspaceApi";
import { Icon } from "./Icon";
import { Setup } from "./Setup";
import { Research } from "./Research";
import { Studio } from "./Studio";
import { Results } from "./Results";
import { Disclosure } from "./parts";
import { QuickActions, type QuickAction } from "./QuickActions";
import "./growth.css";
import "./material-tokens.css";
import "./desktop-glass.css";
import "./interactions.css";
import "./action-craft.css";
import "./writing-fields.css";
import "./workspace-motion.css";

const steps = [
  {
    id: "setup",
    label: "Setup",
    detail: "Brief & sources",
    title: "Campaign setup",
    sub: "Define the brief, then choose your footage.",
  },
  {
    id: "research",
    label: "Research",
    detail: "Hypothesis & openings",
    title: "Creative direction",
    sub: "Set one hypothesis and compare two openings.",
  },
  {
    id: "studio",
    label: "Studio",
    detail: "Make & refine",
    title: "Clip studio",
    sub: "Choose a moment, refine the edit, and approve the exact version you want.",
  },
  {
    id: "results",
    label: "Results",
    detail: "Evidence & next test",
    title: "Results & next test",
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
  const [quickOpen, setQuickOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const toolsReturn = useRef<HTMLButtonElement>(null);
  const previousTools = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null),
    previous = useRef(stage);
  const current = steps.find((s) => s.id === stage)!;
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "k" &&
        !event.repeat &&
        !event.isComposing
      ) {
        event.preventDefault();
        setQuickOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  useEffect(() => {
    if (tools) toolsReturn.current?.focus();
    else if (previousTools.current) heading.current?.focus();
    previousTools.current = tools;
  }, [tools]);
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
  function goToStage(next: Stage) {
    setTools(false);
    setStage(next);
  }
  function newCampaign() {
    setTools(false);
    setCreating(true);
    setStage("setup");
  }
  function refreshWorkspace() {
    void w.load().catch(() => {});
    void factory.refresh();
  }
  const quickActions: QuickAction[] = [
    ...steps.map((s) => ({
      id: s.id,
      label: `Go to ${s.label}`,
      icon: s.id,
      group: "Campaign" as const,
      keywords: s.detail,
      disabled: w.busy || (creating && s.id !== "setup"),
      hint:
        creating && s.id !== "setup" ? "Save the new campaign first" : s.detail,
      run: () => goToStage(s.id),
    })),
    {
      id: "new",
      label: "New campaign",
      icon: "plus",
      group: "Campaign",
      keywords: "create brief",
      disabled: w.busy,
      run: newCampaign,
    },
    {
      id: "tools",
      label: "Workspace tools",
      icon: "settings",
      group: "Workspace",
      keywords: "models runtime integrations settings",
      run: () => setTools(true),
    },
    {
      id: "guide",
      label: "The way it works",
      icon: "info",
      group: "Workspace",
      keywords: "help guide",
      run: () => {
        setTools(false);
        setHelp(true);
      },
    },
    {
      id: "refresh",
      label: "Refresh workspace",
      icon: "refresh",
      group: "Workspace",
      keywords: "reload reconnect",
      disabled: w.busy || w.loading,
      run: refreshWorkspace,
    },
  ];
  const commandTrigger = (
    <button
      type="button"
      className="gf-command-trigger"
      aria-label="Open quick actions"
      aria-haspopup="dialog"
      aria-keyshortcuts="Meta+K Control+K"
      onClick={() => setQuickOpen(true)}
    >
      <Icon name="research" size={16} />
      <span>Quick actions</span>
      <kbd>⌘K</kbd>
    </button>
  );
  const sidebarToggle = (
    <button
      type="button"
      className="gf-sidebar-toggle"
      aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-expanded={!sidebarCollapsed}
      title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
    >
      <PanelLeft size={17} strokeWidth={1.6} aria-hidden="true" />
    </button>
  );
  return (
    <>
      {tools && (
        <div
          className={`gf-operational${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`}
        >
          <div className="gf-tools-return">
            <button ref={toolsReturn} onClick={() => setTools(false)}>
              <Icon name="back" size={16} />
              Back to Growth Factory
            </button>
            <span>Workspace tools · existing local capabilities</span>
            {commandTrigger}
          </div>
          <App
            sidebarToggle={sidebarToggle}
            sidebarCollapsed={sidebarCollapsed}
          />
        </div>
      )}
      <div
        className={`gf-app${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`}
        hidden={tools}
      >
        <a className="gf-skip" href="#growth-main">
          Skip to content
        </a>
        <div className="gf-window">
          <aside className="gf-sidebar">
            <div className="gf-brand-row">
              <a
                className="gf-brand"
                hidden={sidebarCollapsed}
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
              {sidebarToggle}
            </div>
            <section
              className="gf-nav-group"
              aria-label="Campaign navigation"
              hidden={sidebarCollapsed}
            >
              <div className="gf-nav-group-label">
                <Icon name="folder" size={16} />
                <span>Campaign</span>
              </div>
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
                    <Icon name={s.id} size={18} />
                    <span>
                      <strong>{s.label}</strong>
                    </span>
                    {stage === s.id && <span className="gf-active-dot" />}
                  </button>
                ))}
              </nav>
            </section>
            <div className="gf-sidebar-bottom" hidden={sidebarCollapsed}>
              <details className="gf-nav-group gf-workspace-menu">
                <summary aria-label="Workspace menu">
                  <Icon name="settings" size={16} />
                  <span>Workspace</span>
                  <Icon name="down" size={13} />
                </summary>
                <nav aria-label="Workspace navigation">
                  <button onClick={() => setTools(true)}>
                    <Icon name="settings" size={17} />
                    Workspace tools
                    <Icon name="arrow" size={14} />
                  </button>
                  <button onClick={() => setHelp((v) => !v)}>
                    <Icon name="info" size={17} />
                    The way it works
                  </button>
                </nav>
              </details>
              <div className="gf-local-status">
                <span />
                {reviewPreview ? "PREVIEW" : "ON THIS MAC"}
                <span>v0.1</span>
              </div>
            </div>
          </aside>
          <div className="gf-workspace">
            <header className="gf-topbar">
              <div className="gf-breadcrumb">
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
              </div>
              <div className="gf-top-right">
                {commandTrigger}
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
              </div>
            </header>
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
                  onClick={newCampaign}
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
              <div className="gf-campaign-details">
                <Disclosure title="Campaign progress & details" icon="results">
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
                  <div className="gf-journey" aria-label="Production journey">
                    {["Brief", "Direction", "Create", "Review", "Learn"].map(
                      (label, i) => (
                        <div
                          className={completed[i] ? "reached" : ""}
                          key={label}
                        >
                          <span>
                            {completed[i] ? (
                              <Icon name="check" size={10} />
                            ) : (
                              i + 1
                            )}
                          </span>
                          <strong>{label}</strong>
                          {i < 4 && <i />}
                        </div>
                      ),
                    )}
                    <Icon name="refresh" size={16} />
                  </div>
                </Disclosure>
              </div>
            </main>
          </div>
        </div>
        <div className="gf-ambient" aria-hidden="true" />
      </div>
      <QuickActions
        open={quickOpen}
        onDismiss={() => setQuickOpen(false)}
        actions={quickActions}
      />
    </>
  );
}
