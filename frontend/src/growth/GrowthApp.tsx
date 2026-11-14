import { useEffect, useRef, useState } from "react";
import { PanelLeft, Settings } from "lucide-react";
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
import { Onboarding, OFFLINE_KEY } from "./Onboarding";
import { FactoryHome, type OpenProduction } from "./FactoryHome";
import { FactoryTabs } from "./FactoryMap";
import { Library } from "./Library";
import { NewCampaign } from "./NewCampaign";
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
import "./navigation.css";
import "./polish.css";
import { cloudApi } from "./cloudApi";
import { CLOUD_CHANGED } from "./cloudEvents";

const views = {
  factory: {
    label: "Factory",
    title: "Factory",
    sub: "Add an episode. Agents find the clips. You approve.",
    icon: "studio",
  },
  library: {
    label: "Library",
    title: "Library",
    sub: "Every episode and clip for this brand.",
    icon: "folder",
  },
  results: {
    label: "Results",
    title: "Results",
    sub: "What you posted, what it taught us, and what to try next.",
    icon: "results",
  },
  setup: {
    label: "Brand profile",
    title: "Brand profile",
    sub: "Your brand, its voice and look, and what the clips should achieve.",
    icon: "settings",
  },
  research: {
    label: "Style rules",
    title: "Style rules",
    sub: "How agents pick and open clips for this brand. Save, then approve.",
    icon: "research",
  },
  campaign: {
    label: "New campaign",
    title: "New campaign",
    sub: "A new push for this brand, with its own goal and episodes.",
    icon: "plus",
  },
  studio: {
    label: "Studio",
    title: "Studio",
    sub: "Find clips in an episode, then review each one.",
    icon: "studio",
  },
} as const;
export type Stage = keyof typeof views;
function storedView(): Stage {
  if (["#connections", "#gf-accounts"].includes(window.location.hash))
    return "results";
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
  // Account creation is the last onboarding step, asked only when the cloud
  // is configured, nobody is signed in and the creator hasn't chosen offline.
  const [askAccount, setAskAccount] = useState(false);
  const [creating, setCreating] = useState(
    () => reviewPreview && window.location.hash === "#onboarding",
  );
  const [onboardingSession, setOnboardingSession] = useState(0);
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [preferredSource, setPreferredSource] = useState<string>();
  const [preferredMode, setPreferredMode] = useState<"manual" | "agent">();
  const [preferredClip, setPreferredClip] = useState<string>();
  const [quickOpen, setQuickOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const toolsReturn = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousTools = useRef(false);
  const usable =
    !!w.campaign &&
    w.campaign.profile_ids.includes(w.profileId) &&
    w.profiles.some((p) => p.id === w.profileId);
  // Brand = one person, show or company (a backend profile). Campaigns are the
  // goal-scoped pushes linked to it.
  const workspaces = w.profiles.filter((p) =>
    w.campaigns.some((c) => c.profile_ids.includes(p.id)),
  );
  const workspaceCampaigns = w.campaigns.filter((c) =>
    c.profile_ids.includes(w.profileId),
  );
  const onboarding =
    creating || onboardingBusy || (!w.loading && !w.error && !usable);
  const blocked = w.busy || onboardingBusy;
  const contextKey = `${w.campaign?.id || "empty"}-${w.profileId}`;
  const current = views[stage];
  // Sub-pages: a quiet "← Back" sits top-left above the title.
  const back: Stage | undefined =
    stage === "research" || stage === "campaign"
      ? "setup"
      : stage === "studio"
        ? "factory"
        : undefined;
  const narrowStage = stage === "setup" || stage === "research" || stage === "campaign";
  const primaryStage =
    stage === "studio"
      ? "factory"
      : stage === "research" || stage === "campaign"
        ? "setup"
        : stage;

  useEffect(() => {
    if (!onboarding) return;
    let live = true;
    try {
      if (localStorage.getItem(OFFLINE_KEY) === "1") return;
    } catch {
      /* preference only */
    }
    cloudApi
      .status()
      .then((s) => live && setAskAccount(s.configured && !s.signed_in))
      .catch(() => live && setAskAccount(false));
    return () => {
      live = false;
    };
  }, [onboarding, onboardingSession]);
  // Small signed-in email in the sidebar footer; refreshed when the account changes.
  useEffect(() => {
    let live = true;
    const read = () =>
      cloudApi
        .status()
        .then((s) => live && setAccountEmail(s.signed_in ? s.email : null))
        .catch(() => live && setAccountEmail(null));
    read();
    window.addEventListener(CLOUD_CHANGED, read);
    return () => {
      live = false;
      window.removeEventListener(CLOUD_CHANGED, read);
    };
  }, []);
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
  /** Brand profile, scrolled to Goals & brief (the default campaign's brief). */
  function openGoals() {
    go("setup");
    window.setTimeout(
      () => document.getElementById("gf-goals")?.scrollIntoView?.({ block: "start" }),
      0,
    );
  }
  function reviewClip(clip: Clip) {
    openProduction(clip.video_id, undefined, clip.id);
  }
  function refreshWorkspace() {
    void w.load().catch(() => {});
    void factory.refresh();
  }
  const quickActions: QuickAction[] = [
    ...(["factory", "library", "results", "setup"] as const).map((id) => ({
      id,
      label: `Go to ${views[id].label}`,
      icon: views[id].icon,
      group: id === "setup" ? ("Brand" as const) : ("Clips" as const),
      keywords: `${id} ${views[id].sub}`,
      disabled: blocked || onboarding || !usable,
      hint: id === "factory" ? "Add episodes and review clips" : undefined,
      run: () => go(id),
    })),
    {
      id: "research",
      label: "Style rules",
      icon: "research",
      group: "Brand",
      disabled: blocked || onboarding || !usable,
      keywords:
        "style rules editing rules creative direction approval brand profile settings",
      hint: "Brand profile",
      run: () => go("research"),
    },
    {
      id: "brief",
      label: "Goals & brief",
      icon: "research",
      group: "Brand",
      disabled: blocked || onboarding || !usable,
      keywords: "brief goal key messages call to action avoid",
      hint: "Brand profile",
      run: openGoals,
    },
    // Separate pushes (campaigns) are an advanced idea: offered here only once one exists.
    ...(workspaceCampaigns.length > 1
      ? [
          {
            id: "campaign",
            label: "New campaign",
            icon: "plus",
            group: "Brand" as const,
            disabled: blocked || onboarding || !usable,
            keywords: "campaign goal push episode launch series",
            run: () => go("campaign"),
          },
        ]
      : []),
    {
      id: "new",
      label: "New brand",
      icon: "plus",
      group: "Brand",
      disabled: blocked,
      keywords: "podcast brand workspace onboarding",
      run: newWorkspace,
    },
    {
      id: "tools",
      label: "Advanced tools",
      icon: "settings",
      group: "Brand",
      disabled: blocked,
      keywords: "models runtime integrations settings",
      hint: "Models and local tools",
      run: () => setTools(true),
    },
    {
      id: "refresh",
      label: "Refresh",
      icon: "refresh",
      group: "Brand",
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
              <button
                type="button"
                className="gf-channel-settings"
                aria-label="Brand profile"
                aria-current={primaryStage === "setup" ? "page" : undefined}
                title="Brand profile"
                disabled={blocked || !usable || onboarding}
                onClick={() => go("setup")}
              >
                <Settings size={17} strokeWidth={1.6} aria-hidden="true" />
                <span>Brand profile</span>
              </button>
              {accountEmail && (
                <p className="gf-sidebar-account" title={`Signed in as ${accountEmail}`}>
                  <span aria-hidden="true" className="gf-sidebar-account-dot" />
                  <span>{accountEmail}</span>
                </p>
              )}
            </div>
          </aside>
          <div className="gf-workspace">
            <header className="gf-topbar" hidden={onboarding}>
              <div className="gf-context-switcher">
                <label className="gf-workspace-switcher">
                  <span>Brand</span>
                  <select
                    aria-label="Current brand"
                    value={onboarding ? "__new__" : w.profileId}
                    disabled={blocked || w.loading}
                    onChange={(e) => {
                      const next = e.target.value;
                      if (next === "__new__") return newWorkspace();
                      // Stay on the current campaign if it belongs to this
                      // brand; otherwise open the brand's first one.
                      const target = w.campaign?.profile_ids.includes(next)
                        ? w.campaign.id
                        : w.campaigns.find((c) => c.profile_ids.includes(next))
                            ?.id;
                      if (!target) return;
                      setCreating(false);
                      setPreferredClip(undefined);
                      setPreferredSource(undefined);
                      setPreferredMode(undefined);
                      w.setProfileId(next);
                      if (target !== w.selected) {
                        setStage("factory");
                        void w.select(target);
                      }
                    }}
                  >
                    {onboarding && (
                      <option value="__new__">Set up your brand</option>
                    )}
                    {!onboarding && !workspaces.some((p) => p.id === w.profileId) && (
                      <option value="">Choose a brand</option>
                    )}
                    {workspaces.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                    {!onboarding && <option value="__new__">New brand…</option>}
                  </select>
                </label>
                {!onboarding && workspaceCampaigns.length > 1 && (
                  <label className="gf-campaign-switcher">
                    <span>Campaign:</span>
                    <select
                      aria-label="Current campaign"
                      value={w.selected}
                      disabled={blocked || w.loading}
                      onChange={(e) => {
                        if (e.target.value === "__new_campaign__")
                          return go("campaign");
                        if (e.target.value === "__brief__") return openGoals();
                        setPreferredClip(undefined);
                        setPreferredSource(undefined);
                        setPreferredMode(undefined);
                        setStage("factory");
                        void w.select(e.target.value);
                      }}
                    >
                      {workspaceCampaigns.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                      <option value="__brief__">Goals & brief…</option>
                      <option value="__new_campaign__">New campaign…</option>
                    </select>
                  </label>
                )}
              </div>
              <div className="gf-top-right">{commandTrigger}</div>
            </header>
            <main id="growth-main" className="gf-main" tabIndex={-1}>
              <header
                className={`gf-page-heading${stage === "factory" ? " gf-landing-heading" : ""}${narrowStage ? " is-narrow" : ""}`}
                hidden={onboarding}
              >
                {back && !onboarding && (
                  <button
                    type="button"
                    className="gf-back-link"
                    aria-label={`Back to ${views[back].label}`}
                    title={`Back to ${views[back].label}`}
                    disabled={blocked}
                    onClick={() => go(back)}
                  >
                    <Icon name="back" size={15} />
                    <span>{views[back].label}</span>
                  </button>
                )}
                <div>
                  <h1 tabIndex={-1} ref={heading}>
                    {onboarding ? "Your stories start here." : current.title}
                  </h1>
                  <p>
                    {onboarding
                      ? "From long-form footage to clips worth sharing. Give your agents a little context before the first edit."
                      : current.sub}
                  </p>
                </div>
              </header>
              {!onboarding && w.loading && (
                <div className="gf-skeleton-page" role="status" aria-label="Loading your brand…">
                  <span className="gf-skeleton is-title" />
                  <span className="gf-skeleton is-line" />
                  <span className="gf-skeleton is-card" />
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
                      <small>Your inputs are kept. Reconnect, then retry.</small>
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
                  askAccount={askAccount}
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
                <FactoryTabs
                  w={w}
                  factory={factory}
                  active={!tools && !onboarding && stage === "factory"}
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
                </FactoryTabs>
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
                  key={contextKey}
                  creating={false}
                  onSaved={() => {}}
                  w={w}
                  factory={factory}
                  next={() => go("research")}
                  onNewCampaign={() => go("campaign")}
                  onAccounts={() => {
                    window.history.replaceState(null, "", "#gf-accounts");
                    go("results");
                  }}
                  goals={
                    <Setup
                      key={`goals-${contextKey}`}
                      part="campaign"
                      creating={false}
                      onSaved={() => {}}
                      w={w}
                      factory={factory}
                      next={() => go("research")}
                    />
                  }
                  advanced={
                    <nav
                      className="gf-advanced-actions"
                      aria-label="Advanced navigation"
                    >
                      <button
                        type="button"
                        className="gf-button secondary compact"
                        disabled={blocked}
                        onClick={newWorkspace}
                      >
                        <Icon name="plus" size={15} />
                        New brand
                      </button>
                      <button
                        type="button"
                        className="gf-button secondary compact"
                        disabled={blocked}
                        onClick={() => setTools(true)}
                      >
                        <Icon name="settings" size={15} />
                        Advanced tools
                      </button>
                    </nav>
                  }
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
                hidden={onboarding || !usable || stage !== "campaign"}
              >
                {stage === "campaign" && (
                  <NewCampaign
                    key={contextKey}
                    w={w}
                    factory={factory}
                    onCreated={() => go("factory")}
                    onCancel={() => go("setup")}
                  />
                )}
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
                  onEditBrief={openGoals}
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
                  visible={!onboarding && stage === "results"}
                  onReview={reviewClip}
                  onEditingRules={() => go("research")}
                />
              </div>
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
