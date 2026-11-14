import { useEffect, useRef, useState } from "react";
import { useFactory } from "./useFactory";
import { descriptions, groups, icons, initialTab, rememberTab, type Tab } from "./navigation";
import { Campaigns } from "./pages/Campaigns";
import { Clips } from "./pages/Clips";
import { Footage } from "./pages/Footage";
import { Home } from "./pages/Home";
import { Instagram } from "./pages/Instagram";
import { Models } from "./pages/Models";
import { Results } from "./pages/Results";
import { SettingsPage } from "./pages/Settings";
import { Studio } from "./pages/Studio";
const labels: Record<string, string> = {
  system: "this Mac",
  factory: "factory status",
  videos: "footage",
};
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
  const waiting = state.errors.clips
    ? 0
    : state.data.clips.filter((clip) => !clip.approved).length;
  const counts: Partial<Record<Tab, number>> = { Factory: active, Clips: waiting };
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
            Clip Factory<small>RUNS ON THIS MAC</small>
          </div>
        </div>
        <nav aria-label="Main navigation">
          {groups.map((group) => (
            <div
              className="nav-group"
              role="group"
              aria-label={group.label}
              key={group.label}
            >
              <span className="nav-group-label" aria-hidden="true">
                {group.label}
              </span>
              {group.tabs.map((item) => (
                <button
                  key={item}
                  aria-current={tab === item ? "page" : undefined}
                  className={tab === item ? "nav-item active" : "nav-item"}
                  onClick={() => setTab(item)}
                >
                  <span className="nav-icon" aria-hidden="true">
                    {icons[item]}
                  </span>
                  {item}
                  {!!counts[item] && (
                    <span className="nav-count">
                      {counts[item]}
                      <span className="visually-hidden">
                        {item === "Clips" ? " to review" : " running"}
                      </span>
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
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
              aria-label="Refresh workspace"
            >
              ↻ Refresh
            </button>
          </div>
        </div>
        <main id="main">
          <header className="page-heading">
            <div>
              <h1 ref={heading} tabIndex={-1}>
                {tab}
              </h1>
              <p>{descriptions[tab]}</p>
            </div>
            {tab !== "Factory" && (
              <button className="secondary" onClick={() => setTab("Factory")}>
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
          {tab === "Factory" && <Home state={state} navigate={setTab} />}
          {tab === "Clips" && <Clips state={state} navigate={setTab} />}
          {tab === "Footage" && (
            <Footage
              state={state}
              onEdit={(id) => {
                setSourceId(id);
                setTab("Studio");
              }}
            />
          )}
          {tab === "Campaigns" && (
            <Campaigns
              state={state}
              openFactory={() => setTab("Studio")}
              openClips={() => setTab("Clips")}
            />
          )}
          {tab === "Results" && <Results state={state} />}
          {tab === "Instagram" && <Instagram state={state} />}
          {tab === "Studio" && <Studio state={state} initialSource={sourceId} />}
          {tab === "Models" && <Models state={state} />}
          {tab === "Settings" && <SettingsPage state={state} />}
        </main>
      </div>
    </div>
  );
}
