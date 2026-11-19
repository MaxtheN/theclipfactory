import { useCallback, useEffect, useRef, useState } from "react";
import { Palette, PanelLeft, Settings } from "lucide-react";
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
import {
  FactoryHome,
  type LibraryView,
  type OpenProduction,
} from "./FactoryHome";
import { FactoryTabs } from "./FactoryMap";
import { loadDemoResult, saveDemoResult, type DemoResult } from "./demoStore";
import { post } from "../api";
import type { LearningDemoPlan } from "./LearningLoopDemo";
import { Library } from "./Library";
import { NewCampaign } from "./NewCampaign";
import { QuickActions, type QuickAction } from "./QuickActions";
import { BrandMark } from "./BrandMark";
import "./tokens.css";
import "./growth.css";
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
import "./pearl-studio.css";
import "./shell-polish.css";
import "./website-alignment.css";
import "@fontsource-variable/bricolage-grotesque";
import "./identity.css";
import { cloudApi } from "./cloudApi";
import { SettingsScreen, type SettingsSection } from "./SettingsScreen";
import { ActivityCenter, type ActivityTarget } from "./ActivityCenter";
import { CLOUD_CHANGED } from "./appEvents";
import { UnsavedDraftProvider, useDraftRegistry, type DraftFilter, type UnsavedDraft } from "./unsavedDrafts";
import { createLibraryViewStore } from "./libraryViewState";
import { platformWords, usePlatform } from "../platform";

/** Pages whose title, selector and content already say what they are; their
    sub stays only as command-palette keywords. */
const QUIET_VIEWS = new Set<string>(["factory", "library"]);

const views = {
  factory: {
    label: "Factory",
    title: "Factory",
    sub: "Bring your footage. Your agents create drafts and prepare the next experiment.",
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
    icon: "headphones",
  },
  settings: {
    label: "Settings",
    title: "Settings",
    sub: "This computer, its models, and the accounts the factory connects to.",
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
/** Older deep links (the desktop shell and earlier builds) to connected accounts. */
const accountHash = () => ["#connections", "#gf-accounts"].includes(window.location.hash);
/** Where go() lands within a destination. */
export type GoTarget = { section?: SettingsSection };
/** The Primary Destination that owns a stage, for the nav's "not saved" marker. */
const destinationOf = (stage: string): string =>
  stage === "studio" ? "factory" : stage === "research" || stage === "campaign" ? "setup" : stage;
function storedView(): Stage {
  if (accountHash()) return "settings";
  try {
    const saved = localStorage.getItem("growth-view-v2");
    return saved && saved in views ? (saved as Stage) : "factory";
  } catch {
    return "factory";
  }
}

export function GrowthApp() {
  // Re-render the tree when /api/system reports an OS other than the browser's guess.
  usePlatform();
  const factory = useFactory();
  const w = useCampaignWorkspace(factory.refresh);
  const [stage, setStage] = useState<Stage>(storedView);
  const [goalsRequest, setGoalsRequest] = useState({ context: "", sequence: 0 });
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(() =>
    accountHash() ? "accounts" : "device",
  );
  const [demoOpen, setDemoOpen] = useState(false);
  // Demo Mode is chosen by the creator and never persisted, so every launch starts on real results.
  const [demoMode, setDemoMode] = useState(false);
  // Account creation is the last onboarding step, asked only when the cloud
  // is configured, nobody is signed in and the creator hasn't chosen offline.
  const [askAccount, setAskAccount] = useState(false);
  const [creating, setCreating] = useState(
    () => reviewPreview && ["#onboarding", "#intro"].includes(window.location.hash),
  );
  const [onboardingSession, setOnboardingSession] = useState(0);
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [preferredSource, setPreferredSource] = useState<string>();
  const [preferredMode, setPreferredMode] = useState<"manual" | "agent">();
  const [preferredClip, setPreferredClip] = useState<string>();
  const [libraryView, setLibraryView] = useState<LibraryView>("edits");
  // Library filters, view and scroll, per campaign, held above the Library stage.
  const [libraryStore] = useState(createLibraryViewStore);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const drafts = useDraftRegistry();
  const unsavedIn = (destination: string) =>
    drafts.drafts.some((d) => destinationOf(d.screen) === destination);
  const [quickOpen, setQuickOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
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
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  useEffect(() => {
    setLibraryView(libraryStore.get(contextKey).view ?? "edits");
  }, [contextKey, libraryStore]);
  function chooseLibraryView(view: LibraryView) {
    libraryStore.patch(currentContext.current, { view });
    setLibraryView(view);
  }
  const stageRef = useRef(stage);
  stageRef.current = stage;
  useEffect(() => {
    setGoalsRequest({ context: contextKey, sequence: 0 });
    setDemoOpen(false);
    setDemoMode(false);
  }, [contextKey]);
  // Leaving Factory closes the demo; it only lives inside that pane.
  useEffect(() => {
    if (stage !== "results") setDemoOpen(false);
  }, [stage]);
  // The demo's simulated outcome lives in its own per-brand store, never in account history.
  // Nothing simulated is loaded or fetched until the creator turns Demo Mode on.
  const [demoResult, setDemoResult] = useState<DemoResult | null>(null);
  useEffect(() => {
    if (!demoMode) {
      setDemoResult(null);
      return;
    }
    const stored = loadDemoResult(w.profileId);
    setDemoResult(stored);
    if (stored || !w.profileId) return;
    // The desktop app runs in private mode, so browser storage is empty on each launch. The
    // demo plan is a read-only, deterministic computation over real clips: rebuild it.
    let live = true;
    const day = new Date();
    day.setHours(12, 0, 0, 0);
    post<LearningDemoPlan>(`/api/demo-loop/${encodeURIComponent(w.profileId)}/learning-loop`)
      .then((plan) => live && setDemoResult({ plan, after: null, ran_at: day.toISOString() }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [w.profileId, demoMode]);
  const keepDemoResult = useCallback(
    (result: DemoResult) => {
      saveDemoResult(w.profileId, result);
      setDemoResult(result);
    },
    [w.profileId],
  );
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
      return;
    }
    // Read the saved position first: focusing the heading can scroll and overwrite it.
    const restore = stage === "library" ? libraryStore.get(currentContext.current).scrollTop : null;
    heading.current?.focus();
    const scroller = workspaceRef.current;
    if (restore === null || !scroller) return;
    scroller.scrollTop = restore;
    // Clips may lay out a frame later; apply again once they have.
    const frame = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(() => { scroller.scrollTop = restore; })
      : 0;
    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [stage, onboarding, libraryStore]);
  const [activityRequest, setActivityRequest] = useState(0);
  /**
   * Every navigation goes through here. Destinations stay mounted, so their Unsaved Drafts are kept;
   * only leaving New campaign, whose form closes, asks first.
   */
  function go(next: Stage, target?: GoTarget, options?: { keepDrafts?: false; then?: () => void }) {
    const move = () => {
      if (target?.section) setSettingsSection(target.section);
      setStage(next);
      options?.then?.();
    };
    if (stageRef.current !== "campaign" || next === "campaign" || options?.keepDrafts === false) return move();
    whenSafe("Leaving New campaign closes this form.", move, (d) => d.screen === "campaign");
  }
  /** Runs `then` once no matching draft is at risk: at once when none is, after the creator answers otherwise. */
  function whenSafe(reason: string, then: () => void, filter?: DraftFilter) {
    const answer = drafts.guard(reason, filter);
    if (answer === true) then();
    else void answer.then((ok) => ok && then());
  }
  useEffect(() => {
    function landOnAccounts() {
      if (!accountHash()) return;
      setSettingsSection("accounts");
      setStage("settings");
      // A one-time jump: the next launch opens where the person left off.
      if (window.location.hash === "#gf-accounts")
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    landOnAccounts();
    window.addEventListener("hashchange", landOnAccounts);
    return () => window.removeEventListener("hashchange", landOnAccounts);
  }, []);
  function newWorkspace() {
    if (blocked) return;
    // Onboarding opens over the mounted workspace; cancelling it returns to any draft untouched.
    setOnboardingSession((n) => n + 1);
    setCreating(true);
    setStage("factory");
  }
  const openProduction: OpenProduction = (source, mode, clip) => {
    // Studio replaces its change request and caption when it opens another clip or episode.
    const replaces = (d: UnsavedDraft) =>
      d.screen === "studio" &&
      d.record !== clip &&
      (clip !== preferredClip || source !== preferredSource);
    whenSafe("Studio is about to open another clip.", () => {
      setPreferredSource(source);
      setPreferredMode(mode);
      setPreferredClip(clip);
      go("studio");
    }, replaces);
  };
  /** Open the focused brief editor from navigation and quick actions. */
  function openGoals() {
    go("setup", undefined, {
      then: () => setGoalsRequest((request) => ({ context: contextKey, sequence: request.sequence + 1 })),
    });
  }
  function openRehearsal() {
    if (blocked || onboarding || !usable || currentContext.current !== contextKey) return;
    go("results"); // the demo expands inline on Results, below the strip
    setDemoMode(true);
    setDemoOpen(true);
  }
  function exitDemoMode() {
    setDemoOpen(false);
    setDemoMode(false);
  }
  function reviewClip(clip: Clip) {
    openProduction(clip.video_id, undefined, clip.id);
  }
  /** Activity Center: open the screen holding a job's outputs or its fix. */
  function openActivity(target: ActivityTarget) {
    if (target.to === "source") openProduction(target.videoId);
    else if (target.to === "clip") reviewClip(target.clip);
    else if (target.to === "settings") go("settings", { section: target.section });
    else go(target.to);
  }
  function refreshWorkspace() {
    void w.load().catch(() => {});
    void factory.refresh();
  }
  const quickActions: QuickAction[] = [
    ...(["factory", "library", "results", "setup", "settings"] as const).map((id) => ({
      id,
      label: `Go to ${views[id].label}`,
      icon: views[id].icon,
      group: id === "setup" ? ("Brand" as const) : id === "settings" ? ("App" as const) : ("Clips" as const),
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
      id: "engine",
      label: "Engine & models",
      icon: "settings",
      group: "App",
      disabled: blocked || onboarding || !usable,
      keywords: "models runtime speech whisper install hardware advanced settings",
      hint: "Settings · Models",
      run: () => go("settings", { section: "models" }),
    },
    {
      id: "accounts",
      label: "Connected accounts",
      icon: "link",
      group: "App",
      disabled: blocked || onboarding || !usable,
      keywords: "instagram account connect sign in sync settings",
      hint: "Settings · Accounts and connections",
      run: () => go("settings", { section: "accounts" }),
    },
    {
      id: "activity",
      label: "Activity",
      icon: "clock",
      group: "App",
      disabled: blocked || onboarding || !usable,
      keywords: "jobs running progress failed failures cancel renders downloads posts background",
      hint: "Jobs, posts and failures",
      run: () => setActivityRequest((n) => n + 1),
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
      aria-keyshortcuts={platformWords().os === "macos" ? "Meta+K Control+K" : "Control+K"}
      onClick={() => setQuickOpen(true)}
    >
      <Icon name="research" size={16} />
      <span>Search or run a command</span>
      <kbd>{platformWords().paletteShortcut}</kbd>
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
    <UnsavedDraftProvider api={drafts.api}>
      <div
        className={`gf-app gf-flow-app${onboarding ? " is-onboarding" : ""}${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`}
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
                  aria-describedby={unsavedIn(id) ? "gf-unsaved-description" : undefined}
                  onClick={() => go(id)}
                >
                  <Icon name={views[id].icon} size={18} />
                  <span>
                    <strong>{views[id].label}</strong>
                  </span>
                  {unsavedIn(id) && <span className="gf-nav-unsaved" title="Not saved" aria-hidden="true" />}
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
                aria-describedby={unsavedIn("setup") ? "gf-unsaved-description" : undefined}
                aria-current={primaryStage === "setup" ? "page" : undefined}
                title={unsavedIn("setup") ? "Brand profile · Not saved" : "Brand profile"}
                disabled={blocked || !usable || onboarding}
                onClick={() => go("setup")}
              >
                <Palette size={17} strokeWidth={1.6} aria-hidden="true" />
                <span>Brand profile</span>
                {unsavedIn("setup") && <span className="gf-nav-unsaved" aria-hidden="true" />}
              </button>
              <button
                type="button"
                className="gf-channel-settings"
                aria-label="Settings"
                aria-current={primaryStage === "settings" ? "page" : undefined}
                title="Settings"
                disabled={blocked || !usable || onboarding}
                onClick={() => go("settings")}
              >
                <Settings size={17} strokeWidth={1.6} aria-hidden="true" />
                <span>Settings</span>
              </button>
              {accountEmail && (
                <p className="gf-sidebar-account" title={`Signed in as ${accountEmail}`}>
                  <span aria-hidden="true" className="gf-sidebar-account-dot" />
                  <span>{accountEmail}</span>
                </p>
              )}
            </div>
          </aside>
          <div
            className="gf-workspace"
            ref={workspaceRef}
            onScroll={(e) => {
              if (stageRef.current === "library")
                libraryStore.patch(currentContext.current, { scrollTop: e.currentTarget.scrollTop });
            }}
          >
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
                      whenSafe("Switching brand reloads every screen.", () => {
                        setCreating(false);
                        setPreferredClip(undefined);
                        setPreferredSource(undefined);
                        setPreferredMode(undefined);
                        w.setProfileId(next);
                        if (target !== w.selected) {
                          setStage("factory");
                          void w.select(target);
                        }
                      });
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
                        const next = e.target.value;
                        if (next === "__new_campaign__")
                          return go("campaign");
                        if (next === "__brief__") return openGoals();
                        whenSafe("Switching campaign reloads every screen.", () => {
                          setPreferredClip(undefined);
                          setPreferredSource(undefined);
                          setPreferredMode(undefined);
                          setStage("factory");
                          void w.select(next);
                        });
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
              <div className="gf-top-right">
                <ActivityCenter
                  factory={factory}
                  campaigns={w.campaigns}
                  disabled={onboarding || !usable}
                  openRequest={activityRequest}
                  onOpen={openActivity}
                />
                {commandTrigger}
              </div>
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
                  {(onboarding || !QUIET_VIEWS.has(stage)) && (
                    <p>
                      {onboarding
                        ? "From long-form footage to clips worth sharing. Give your agents a little context before the first edit."
                        : current.sub}
                    </p>
                  )}
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
                  active={onboarding}
                  askAccount={askAccount}
                  intro={
                    (!w.loading && w.profiles.length === 0) ||
                    (reviewPreview && window.location.hash === "#intro")
                  }
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
                <div>
                  <FactoryTabs
                    w={w}
                    factory={factory}
                    active={!onboarding && stage === "factory"}
                  >
                    <FactoryHome
                      key={contextKey}
                      w={w}
                      factory={factory}
                      active={!onboarding && stage === "factory"}
                      onProduce={openProduction}
                      onReview={reviewClip}
                      onLibrary={(view) => {
                        if (view) chooseLibraryView(view);
                        void go("library");
                      }}
                      onDirection={() => go("research")}
                      onSettings={() => go("settings", { section: "models" })}
                    />
                  </FactoryTabs>
                </div>
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
                  view={libraryView}
                  onView={chooseLibraryView}
                  viewState={{ store: libraryStore, key: contextKey }}
                />
              </div>
              <div
                className="gf-stage"
                hidden={onboarding || stage !== "setup"}
              >
                <Setup
                  key={contextKey}
                  active={!onboarding && stage === "setup"}
                  goalsRequest={goalsRequest.context === contextKey ? goalsRequest.sequence : 0}
                  creating={false}
                  onSaved={() => {}}
                  w={w}
                  factory={factory}
                  next={() => go("research")}
                  onNewCampaign={() => go("campaign")}
                  onAccounts={() => go("settings", { section: "accounts" })}
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
                  onFactory={() => go("factory")}
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
                    onCreated={() => void go("factory", undefined, { keepDrafts: false })}
                    onCancel={() => void go("setup", undefined, { keepDrafts: false })}
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
                  activeSurface={!onboarding && stage === "studio"}
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
                  onAccounts={() => go("settings", { section: "accounts" })}
                  onRehearse={openRehearsal}
                  demo={demoResult}
                  demoMode={demoMode}
                  onExitDemo={exitDemoMode}
                  demoOpen={demoOpen && !onboarding && usable && stage === "results"}
                  onCloseDemo={() => setDemoOpen(false)}
                  onDemoResult={keepDemoResult}
                />
              </div>
              <div
                className="gf-stage"
                hidden={onboarding || !usable || stage !== "settings"}
              >
                <SettingsScreen
                  key={contextKey}
                  w={w}
                  factory={factory}
                  section={settingsSection}
                  onSection={setSettingsSection}
                  visible={!onboarding && usable && stage === "settings"}
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
      <span id="gf-unsaved-description" hidden>
        Has changes that are not saved
      </span>
      {drafts.dialog}
    </UnsavedDraftProvider>
  );
}
