import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFactory } from "./useFactory";
import { descriptions, icons, initialTab, rememberTab, tabs, type Tab } from "./navigation";
import { Icon } from "./growth/Icon";
import { BrandMark } from "./growth/BrandMark";
import "./growth/operational-glass.css";
import { Models } from "./pages/Models";
import { SettingsPage } from "./pages/Settings";
const labels: Record<string, string> = {
  system: "this Mac",
  factory: "factory status",
  videos: "footage",
};
/**
 * Local setup: the models on this Mac and the factory's defaults. The Growth Factory shell
 * opens it as "Advanced tools" and passes its sidebar toggle and collapse state; everything
 * else (footage, clips, review, results) lives in the shell.
 */
export function App({
  sidebarToggle,
  sidebarCollapsed = false,
}: {
  sidebarToggle?: ReactNode;
  sidebarCollapsed?: boolean;
}) {
  const state = useFactory();
  const [tab, setTab] = useState<Tab>(initialTab);
  const heading = useRef<HTMLHeadingElement>(null);
  const previous = useRef(tab);
  useEffect(() => {
    if (previous.current !== tab) {
      heading.current?.focus();
      previous.current = tab;
    }
    rememberTab(tab);
  }, [tab]);
  const errorGroups = Object.entries(state.errors).reduce<
    Record<string, string[]>
  >((groups, [key, error]) => {
    if (error) (groups[error] ||= []).push(labels[key] ?? key);
    return groups;
  }, {});
  const active = state.data.jobs.filter((job) =>
    ["queued", "running"].includes(job.status),
  ).length;
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="tools-brand-row">
          <div className="brand" hidden={sidebarCollapsed}>
            <BrandMark />
            <div>
              Growth Factory<small>WORKSPACE TOOLS</small>
            </div>
          </div>
          {sidebarToggle}
        </div>
        <nav
          className="tools-navigation"
          aria-label="Main navigation"
          hidden={sidebarCollapsed}
        >
          <div className="tools-nav-items">
            {tabs.map((item) => (
              <button
                key={item}
                aria-current={tab === item ? "page" : undefined}
                className={tab === item ? "nav-item active" : "nav-item"}
                onClick={() => setTab(item)}
              >
                <span className="nav-icon" aria-hidden="true">
                  <Icon name={icons[item]} size={18} />
                </span>
                <span className="tools-nav-label">{item}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className="sidebar-footer" hidden={sidebarCollapsed}>
          <span className="status-dot" />
          <strong>Private by default</strong>
          <p>
            Footage and models stay on this Mac.
            <br />
            Nothing is published without you.
          </p>
        </div>
      </aside>
      <div className="workspace">
        <div className="topbar">
          <span>{state.data.settings?.brand || "Your studio"}</span>
          <div>
            <span className="badge">
              {state.loading || state.errors.jobs
                ? "Status unknown"
                : active
                  ? `${active} job${active === 1 ? "" : "s"} running`
                  : "Idle"}
            </span>
            <button
              className="text-button"
              disabled={state.loading}
              onClick={() => void state.refresh()}
              aria-label="Refresh"
            >
              ↻ Refresh
            </button>
          </div>
        </div>
        <main id="main" tabIndex={-1}>
          <header className="page-heading">
            <div>
              <h1 ref={heading} tabIndex={-1}>
                {tab}
              </h1>
              <p>{descriptions[tab]}</p>
            </div>
          </header>
          {state.loading && (
            <div className="banner" role="status">
              Connecting to the local service…
            </div>
          )}
          {Object.keys(state.errors).length > 0 && (
            <div className="banner error" role="alert">
              <strong>Some data could not be loaded</strong>
              <ul>
                {Object.entries(errorGroups).map(([error, keys]) => (
                  <li key={error}>
                    <strong>{keys.join(", ")}:</strong> {error}
                  </li>
                ))}
              </ul>
              <small>What you see may be out of date.</small>
              <button
                className="secondary small"
                onClick={() => void state.refresh()}
              >
                Retry connection
              </button>
            </div>
          )}
          {(state.actionError || state.notice) && (
            <div
              className={`banner ${state.actionError ? "error" : "success"}`}
              role={state.actionError ? "alert" : "status"}
            >
              <span>{state.actionError || state.notice}</span>
              <button
                className="text-button"
                onClick={state.dismiss}
                aria-label="Dismiss notification"
              >
                ×
              </button>
            </div>
          )}
          {tab === "Models" && <Models state={state} />}
          {tab === "Settings" && <SettingsPage state={state} />}
        </main>
      </div>
    </div>
  );
}
