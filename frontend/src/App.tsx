import { useEffect, useRef, useState } from "react";
import { useFactory } from "./useFactory";
import { Campaigns } from "./pages/Campaigns";
import { Dashboard } from "./pages/Dashboard";
import { Library } from "./pages/Library";
import { Factory } from "./pages/Factory";
import { Models } from "./pages/Models";
import { Instagram } from "./pages/Instagram";
import { Results } from "./pages/Results";
import { SettingsPage } from "./pages/Settings";
const tabs = [
  "Campaigns",
  "Dashboard",
  "Library",
  "Factory",
  "Models",
  "Instagram",
  "Results",
  "Settings",
] as const;
type Tab = (typeof tabs)[number];
const descriptions: Record<Tab, string> = {
  Campaigns: "Saved profiles. Approved direction. Evidence-led revisions.",
  Dashboard: "Your creative intent. A local production system.",
  Library: "Source footage, ready for your next idea.",
  Factory: "Find the moment. Shape the story. Keep control.",
  Models: "Private intelligence, running on your machine.",
  Instagram: "Connect deliberately. Publish with approval.",
  Results: "Real observations. Clear provenance. No invented performance.",
  Settings: "Define the brand, the objective, and the boundaries.",
};
function initialTab(): Tab {
  try {
    const saved = localStorage.getItem("clip-factory-tab");
    return tabs.includes(saved as Tab) ? (saved as Tab) : "Campaigns";
  } catch {
    return "Campaigns";
  }
}
export function App() {
  const state = useFactory();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [sourceId, setSourceId] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const previous = useRef(tab);
  useEffect(() => {
    if (previous.current !== tab) {
      heading.current?.focus();
      previous.current = tab;
    }
    try {
      localStorage.setItem("clip-factory-tab", tab);
    } catch {
      /* UI preferences are optional. */
    }
  }, [tab]);
  const errorGroups = Object.entries(state.errors).reduce<
    Record<string, string[]>
  >((groups, [key, error]) => {
    if (error) (groups[error] ||= []).push(key);
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
        <div className="brand">
          <span className="brand-symbol" aria-hidden="true">
            c<span>f</span>
          </span>
          <div>
            Growth Factory<small>WORKSPACE TOOLS</small>
          </div>
        </div>
        <nav aria-label="Main navigation">
          {tabs.map((item, index) => (
            <button
              key={item}
              aria-current={tab === item ? "page" : undefined}
              className={tab === item ? "nav-item active" : "nav-item"}
              onClick={() => setTab(item)}
            >
              <span className="nav-icon" aria-hidden="true">
                {["▦", "◫", "▤", "◈", "⬡", "◎", "↗", "⚙"][index]}
              </span>
              {item}
              {item === "Factory" && active > 0 && (
                <span className="nav-count">{active}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="status-dot" />
          <strong>Local-first workspace</strong>
          <p>
            Media stays on this machine.
            <br />
            Meta actions require your opt-in.
          </p>
          <small>GROWTH FACTORY / MVP</small>
        </div>
      </aside>
      <div className="workspace">
        <div className="topbar">
          <span>
            WORKSPACE <span className="slash">/</span>{" "}
            {state.data.settings?.brand || "Your studio"}
          </span>
          <div>
            <span className="badge">
              {state.loading || state.errors.jobs
                ? "Queue unknown"
                : active
                  ? `${active} jobs active`
                  : "Queue idle"}
            </span>
            <button
              className="text-button"
              disabled={state.loading}
              onClick={() => void state.refresh()}
              aria-label="Refresh workspace"
            >
              ↻ Refresh
            </button>
          </div>
        </div>
        <main id="main">
          <header className="page-heading">
            <div>
              <p className="eyebrow">CREATE WITH INTENT</p>
              <h1 ref={heading} tabIndex={-1}>
                {tab}
              </h1>
              <p>{descriptions[tab]}</p>
            </div>
            {tab !== "Library" && (
              <button className="secondary" onClick={() => setTab("Library")}>
                ＋ Add footage
              </button>
            )}
          </header>
          {state.loading && (
            <div className="banner" role="status">
              Connecting to the local service…
            </div>
          )}
          {Object.keys(state.errors).length > 0 && (
            <div className="banner error" role="alert">
              <strong>Some workspace data is unavailable</strong>
              <ul>
                {Object.entries(errorGroups).map(([error, keys]) => (
                  <li key={error}>
                    <strong>{keys.join(", ")}:</strong> {error}
                  </li>
                ))}
              </ul>
              <small>
                Last loaded data may be stale. Capabilities are not assumed.
              </small>
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
          {tab === "Campaigns" && (
            <Campaigns state={state} openFactory={() => setTab("Factory")} />
          )}
          {tab === "Dashboard" && <Dashboard state={state} navigate={setTab} />}
          {tab === "Library" && (
            <Library
              state={state}
              onEdit={(id) => {
                setSourceId(id);
                setTab("Factory");
              }}
            />
          )}
          {tab === "Factory" && (
            <Factory state={state} initialSource={sourceId} />
          )}
          {tab === "Models" && <Models state={state} />}
          {tab === "Instagram" && <Instagram state={state} />}
          {tab === "Results" && <Results state={state} />}
          {tab === "Settings" && <SettingsPage state={state} />}
        </main>
        <footer className="workspace-footer">
          LOCAL BY DEFAULT <span>Human review is part of the pipeline.</span>
        </footer>
      </div>
    </div>
  );
}
