import { useEffect, useRef, useState } from "react";
import { CircleUserRound, PanelLeft } from "lucide-react";
import { App } from "../App";
import { useFactory } from "../useFactory";
import { useCampaignWorkspace } from "./useCampaignWorkspace";
import { reviewPreview } from "./workspaceApi";
import type { Clip } from "../types";
import { Icon } from "./Icon";
import { Setup } from "./Setup";
import { Research } from "./Research";
import { Studio } from "./Studio";
import { Results } from "./Results";
import { Onboarding } from "./Onboarding";
import { FactoryHome, type OpenProduction } from "./FactoryHome";
import { Library } from "./Library";
import { AutomationPanel } from "./AutomationPanel";
import { QuickActions, type QuickAction } from "./QuickActions";
import { BrandMark } from "./BrandMark";
import "./growth.css";
import "./material-tokens.css";
import "./desktop-glass.css";
import "./interactions.css";
import "./action-craft.css";
import "./writing-fields.css";
import "./workspace-motion.css";
import "./account-chrome.css";
import "./factory-flow.css";
import "./landing.css";
import "./desktop-shell.css";

const views = {
  factory: {
    label: "Factory",
    title: "Factory",
    sub: "Turn long-form video into short-form clips. Set the direction, let agents shape the edit, and review every cut.",
    icon: "studio",
  },
  library: {
    label: "Library",
    title: "Library",
    sub: "Your footage and every version worth keeping.",
    icon: "folder",
  },
  results: {
    label: "Results",
    title: "Results & next test",
    sub: "Bring the evidence back into your next edit.",
    icon: "results",
  },
  setup: {
    label: "Workspace settings",
    title: "Workspace settings",
    sub: "Audience, goals and the boundaries your edits should respect.",
    icon: "settings",
  },
  research: {
    label: "Creative direction",
    title: "Creative direction",
    sub: "Review the idea and the opening treatments before production.",
    icon: "research",
  },
  studio: {
    label: "Production & review",
    title: "Production & review",
    sub: "Inspect the source, produce options, and review the exact version.",
    icon: "studio",
  },
} as const;
export type Stage = keyof typeof views;
function storedView(): Stage {
  if (window.location.hash === "#connections") return "results";
  try {
    const saved = localStorage.getItem("growth-view-v2");
    return saved && saved in views ? (saved as Stage) : "factory";
  } catch {
    return "factory";
  }
}

export function GrowthApp() {
  const factory = useFactory();
  const w = useCampaignWorkspace(factory.refresh);
  const [stage, setStage] = useState<Stage>(storedView);
  const [tools, setTools] = useState(false);
  const [creating, setCreating] = useState(
    () => reviewPreview && window.location.hash === "#onboarding",
  );
  const [onboardingSession, setOnboardingSession] = useState(0);
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [preferredSource, setPreferredSource] = useState<string>();
  const [preferredMode, setPreferredMode] = useState<"manual" | "agent">();
  const [preferredClip, setPreferredClip] = useState<string>();
  const [help, setHelp] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const toolsReturn = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousTools = useRef(false);
  const usable =
    !!w.campaign &&
    w.campaign.profile_ids.includes(w.profileId) &&
    w.profiles.some((p) => p.id === w.profileId);
  const onboarding =
    creating || onboardingBusy || (!w.loading && !w.error && !usable);
  const blocked = w.busy || onboardingBusy;
  const contextKey = `${w.campaign?.id || "empty"}-${w.profileId}`;
  const current = views[stage];
  const primaryStage =
    stage === "studio" || stage === "research" ? "factory" : stage;

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
        if (onboarding) return;
        setQuickOpen((value) => !value);
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [onboarding]);
  useEffect(() => {
    try {
      localStorage.setItem("growth-view-v2", stage);
    } catch {
      /* optional preference */
    }
    if (onboarding) {
      setQuickOpen(false);
      setTools(false);
    } else if (!tools) heading.current?.focus();
  }, [stage, onboarding]);
  useEffect(() => {
    if (tools) toolsReturn.current?.focus();
    else if (previousTools.current && !onboarding) heading.current?.focus();
    previousTools.current = tools;
  }, [tools, onboarding]);

  function go(next: Stage) {
    setTools(false);
    setStage(next);
  }
  function newWorkspace() {
    if (blocked) return;
    setTools(false);
    setOnboardingSession((n) => n + 1);
    setCreating(true);
    setStage("factory");
  }
  const openProduction: OpenProduction = (source, mode, clip) => {
    setPreferredSource(source);
    setPreferredMode(mode);
    setPreferredClip(clip);
    go("studio");
  };
  function reviewClip(clip: Clip) {
    openProduction(clip.video_id, undefined, clip.id);
  }
  function refreshWorkspace() {
    void w.load().catch(() => {});
    void factory.refresh();
  }
  const quickActions: QuickAction[] = [
    ...(["factory", "library", "results", "research", "setup"] as const).map(
      (id) => ({
        id,
        label: `Go to ${views[id].label}`,
        icon: views[id].icon,
        group: "Workspace" as const,
        keywords: `${id} ${views[id].sub}`,
        disabled: blocked || onboarding || !usable,
        hint:
          id === "factory"
            ? "Upload footage and review your cuts"
            : id === "research"
              ? "Advanced · review and approve direction"
              : undefined,
        run: () => go(id),
      }),
    ),
    {
      id: "new",
      label: "New workspace",
      icon: "plus",
      group: "Workspace",
      disabled: blocked,
      keywords: "podcast profile onboarding",
      run: newWorkspace,
    },
    {
      id: "tools",
      label: "Advanced workspace tools",
      icon: "settings",
      group: "Workspace",
      disabled: blocked,
      keywords: "models runtime integrations settings",
      run: () => setTools(true),
    },
    {
      id: "guide",
      label: "How the factory works",
      icon: "info",
      group: "Workspace",
      keywords: "help guide loop",
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
      disabled: blocked || w.loading,
      keywords: "reload reconnect",
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
      onClick={() => setSidebarCollapsed((value) => !value)}
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
              Back to Factory
            </button>
            <span>Advanced tools · local capabilities</span>
            {commandTrigger}
          </div>
          <App
            sidebarToggle={sidebarToggle}
            sidebarCollapsed={sidebarCollapsed}
          />
        </div>
      )}
      <div
        className={`gf-app gf-flow-app${onboarding ? " is-onboarding" : ""}${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`}
        hidden={tools}
      >
        <a className="gf-skip" href="#growth-main">
          Skip to content
        </a>
        <div className="gf-window">
          <aside className="gf-sidebar" hidden={onboarding}>
            <div className="gf-brand-row">
              <a
                className="gf-brand"
                hidden={sidebarCollapsed}
                href="#"
                aria-label="Growth Factory home"
                onClick={(e) => {
                  e.preventDefault();
                  if (!blocked) go("factory");
                }}
              >
                <BrandMark />
                <span>
                  Growth
                  <br />
                  Factory<span className="gf-brand-period">.</span>
                </span>
              </a>
              {sidebarToggle}
            </div>
            <nav
              className="gf-primary-navigation"
              aria-label="Main navigation"
              hidden={sidebarCollapsed}
            >
              {(["factory", "library", "results"] as const).map((id) => (
                <button
                  type="button"
                  key={id}
                  className={`gf-nav-item${primaryStage === id && !onboarding ? " active" : ""}`}
                  aria-current={
                    primaryStage === id && !onboarding ? "page" : undefined
                  }
                  disabled={blocked || onboarding || !usable}
                  onClick={() => go(id)}
                >
                  <Icon name={views[id].icon} size={18} />
                  <span>
                    <strong>{views[id].label}</strong>
                  </span>
                  {primaryStage === id && !onboarding && (
                    <span className="gf-active-dot" />
                  )}
                </button>
              ))}
            </nav>
            <div className="gf-sidebar-bottom" hidden={sidebarCollapsed}>
              <details className="gf-nav-group gf-workspace-menu">
                <summary aria-label="Workspace menu">
                  <Icon name="settings" size={16} />
                  <span>Workspace</span>
                  <Icon name="down" size={13} />
                </summary>
                <nav aria-label="Workspace navigation">
                  <button
                    type="button"
                    disabled={blocked || !usable || onboarding}
                    onClick={() => go("setup")}
                  >
                    <Icon name="settings" size={17} />
                    Workspace settings
                  </button>
                  <button
                    type="button"
                    disabled={blocked || !usable || onboarding}
                    onClick={() => go("research")}
                  >
                    <Icon name="research" size={17} />
                    Creative direction
                  </button>
                  <button
                    type="button"
                    disabled={blocked}
                    onClick={newWorkspace}
                  >
                    <Icon name="plus" size={17} />
                    New workspace
                  </button>
                  <button
                    type="button"
                    disabled={blocked}
                    onClick={() => setTools(true)}
                  >
                    <Icon name="settings" size={17} />
                    Advanced tools
                  </button>
                </nav>
              </details>
            </div>
          </aside>
          <div className="gf-workspace">
            <header className="gf-topbar" hidden={onboarding}>
              <label className="gf-workspace-switcher">
                <span>Campaign</span>
                <select
                  aria-label="Current campaign"
                  value={onboarding ? "__new__" : w.selected}
                  disabled={blocked || w.loading}
                  onChange={(e) => {
                    if (e.target.value === "__new__") newWorkspace();
                    else {
                      setCreating(false);
                      setPreferredClip(undefined);
                      setPreferredSource(undefined);
                      setStage("factory");
                      void w.select(e.target.value);
                    }
                  }}
                >
                  {onboarding && (
                    <option value="__new__">Set up your workspace</option>
                  )}
                  {!onboarding && !w.campaign && (
                    <option value="">Choose a workspace</option>
                  )}
                  {w.campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="gf-top-right">
                {commandTrigger}
                {!tools && usable && !onboarding && (
                  <label className="gf-profile-selector">
                    <CircleUserRound
                      size={20}
                      strokeWidth={1.5}
                      aria-hidden="true"
                    />
                    <select
                      aria-label="Active account profile"
                      value={w.profileId}
                      disabled={blocked || w.loading}
                      onChange={(e) => {
                        setPreferredSource(undefined);
                        setPreferredClip(undefined);
                        setPreferredMode(undefined);
                        w.setProfileId(e.target.value);
                      }}
                    >
                      {w.profiles
                        .filter((p) => w.campaign?.profile_ids.includes(p.id))
                        .map((p) => (
                          <option value={p.id} key={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
              </div>
            </header>
            <main id="growth-main" className="gf-main" tabIndex={-1}>
              <header className={`gf-page-heading${stage === "factory" ? " gf-landing-heading" : ""}`} hidden={onboarding}>
                <div>
                  <div className="gf-eyebrow">
                    {onboarding
                      ? "WELCOME TO GROWTH FACTORY"
                      : stage === "setup"
                        ? "WORKSPACE"
                        : stage === "research" || stage === "studio"
                          ? "FACTORY"
                          : stage === "factory"
                            ? "YOUR VIDEO PRODUCTION WORKSPACE"
                            : "YOUR WORKSPACE"}
                  </div>
                  <h1 tabIndex={-1} ref={heading}>
                    {onboarding ? "Your stories start here." : current.title}
                  </h1>
                  <p>
                    {onboarding
                      ? "From long-form footage to clips worth sharing. Give your agents a little context before the first edit."
                      : current.sub}
                  </p>
                </div>
                {(stage === "research" || stage === "setup") &&
                  !onboarding && (
                    <button
                      type="button"
                      className="gf-button secondary compact"
                      disabled={blocked}
                      onClick={() => go("factory")}
                    >
                      <Icon name="back" size={15} />
                      Back to Factory
                    </button>
                  )}
              </header>
              {help && !onboarding && (
                <div className="gf-message">
                  <Icon name="info" />
                  <span>
                    <strong>Upload → produce → review → learn.</strong> Your
                    workspace keeps the audience and goal. Local production
                    still needs a ready model and your approved direction.
                    Export follows human approval; publishing and scheduled
                    analytics are separate connections.
                  </span>
                  <button
                    type="button"
                    className="gf-icon-button"
                    aria-label="Close guide"
                    onClick={() => setHelp(false)}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              )}
              {!onboarding && w.loading && (
                <div className="gf-loading" role="status">
                  <span className="gf-spinner" />
                  Opening your workspace…
                </div>
              )}
              {!onboarding &&
                (w.error || Object.keys(factory.errors).length > 0) && (
                  <div className="gf-message error" role="alert">
                    <Icon name="info" />
                    <span>
                      <strong>
                        {w.error || "Some local resources are unavailable."}
                      </strong>
                      {Object.keys(factory.errors).length > 0 && (
                        <small>
                          {[...new Set(Object.values(factory.errors))].join(
                            " ",
                          )}
                        </small>
                      )}
                      <small>
                        Your inputs stay here. Refresh saved state before
                        retrying an uncertain action.
                      </small>
                    </span>
                    <button
                      type="button"
                      className="gf-button secondary compact"
                      disabled={blocked}
                      onClick={refreshWorkspace}
                    >
                      Reconnect
                    </button>
                  </div>
                )}
              {!onboarding && w.notice && (
                <div className="gf-message success" role="status">
                  <Icon name="check" />
                  <span>{w.notice}</span>
                  <button
                    type="button"
                    className="gf-icon-button"
                    aria-label="Dismiss update"
                    onClick={w.clearNotice}
                  >
                    <Icon name="close" size={15} />
                  </button>
                </div>
              )}
              <div className="gf-stage" hidden={!onboarding}>
                <Onboarding
                  key={onboardingSession}
                  w={w}
                  active={onboarding && !tools}
                  onBusyChange={setOnboardingBusy}
                  onCancel={usable ? () => setCreating(false) : undefined}
                  onComplete={() => {
                    setCreating(false);
                    setPreferredSource(undefined);
                    setPreferredClip(undefined);
                    setPreferredMode(undefined);
                    go("factory");
                  }}
                />
              </div>
              <div
                className="gf-stage"
                hidden={onboarding || !usable || stage !== "factory"}
              >
                <FactoryHome
                  key={contextKey}
                  w={w}
                  factory={factory}
                  active={!tools && !onboarding && stage === "factory"}
                  onProduce={openProduction}
                  onReview={reviewClip}
                  onLibrary={() => go("library")}
                  onDirection={() => go("research")}
                />
              </div>
              <div
                className="gf-stage"
                hidden={onboarding || !usable || stage !== "library"}
              >
                <Library
                  key={contextKey}
                  w={w}
                  factory={factory}
                  onReview={reviewClip}
                  onProduce={openProduction}
                  onFactory={() => go("factory")}
                />
              </div>
              <div
                className="gf-stage"
                hidden={onboarding || stage !== "setup"}
              >
                <Setup
                  key={w.campaign?.id || "empty"}
                  creating={false}
                  onSaved={() => {}}
                  w={w}
                  factory={factory}
                  next={() => go("research")}
                />
              </div>
              <div
                className="gf-stage"
                hidden={onboarding || stage !== "research"}
              >
                <Research
                  key={contextKey}
                  w={w}
                  next={() => openProduction(preferredSource, "agent")}
                />
              </div>
              <div
                className="gf-stage"
                hidden={onboarding || stage !== "studio"}
              >
                <Studio
                  key={contextKey}
                  w={w}
                  factory={factory}
                  preferredSource={preferredSource}
                  preferredMode={preferredMode}
                  preferredClip={preferredClip}
                  next={() => go("results")}
                  onDirection={() => go("research")}
                />
              </div>
              <div
                className="gf-stage"
                hidden={onboarding || stage !== "results"}
              >
                <Results
                  key={contextKey}
                  w={w}
                  factory={factory}
                  next={(source, mode) => openProduction(source, mode)}
                />
                <AutomationPanel
                  key={`automation-${contextKey}`}
                  w={w}
                  factory={factory}
                  visible={!onboarding && stage === "results"}
                  onReview={reviewClip}
                />
              </div>
              {reviewPreview && stage === "factory" && !onboarding && (
                <p className="gf-flow-preview-note">
                  Sources and outputs marked illustrative are sample content,
                  not rendered media or measured performance.
                </p>
              )}
            </main>
          </div>
        </div>
      </div>
      <QuickActions
        open={quickOpen && !onboarding}
        onDismiss={() => setQuickOpen(false)}
        actions={quickActions}
      />
    </>
  );
}
