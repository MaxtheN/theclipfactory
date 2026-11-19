import { useId } from "react";
import { Jobs } from "../components/Jobs";
import type { Clip, SystemInfo } from "../types";
import type { FactoryState } from "../useFactory";
import type { Workspace } from "./useCampaignWorkspace";
import { AiModelCard } from "./AiModelCard";
import { AutomationPanel } from "./AutomationPanel";
import { CloudAccountRow } from "./CloudSignIn";
import { EngineSetup } from "./EngineSetup";
import { Icon } from "./Icon";
import "./settings.css";
import { platformWords } from "../platform";

export const settingsSections = [
  ["device", "Device and runtime", "settings"],
  ["models", "Models", "spark"],
  ["accounts", "Accounts and connections", "link"],
  ["privacy", "Privacy and storage", "lock"],
  ["jobs", "Background jobs", "clock"],
  ["about", "About", "info"],
] as const;
export type SettingsSection = (typeof settingsSections)[number][0];

const readiness = [
  ["platform", "Platform"],
  ["apple_silicon", "Apple Silicon"],
  ["memory_gb", "Memory"],
  ["free_disk_gb", "Free disk"],
  ["ffmpeg", "FFmpeg"],
  ["ffprobe", "FFprobe"],
  ["model_runtime", "Model runtime"],
  ["whisper", "Speech-to-text"],
  ["ollama", "Ollama"],
] as const;
type ReadinessKey = (typeof readiness)[number][0];

function shown(key: ReadinessKey, value: SystemInfo[ReadinessKey]): string {
  if (value === true) return "Ready";
  if (value === false) return key === "apple_silicon" ? "No" : "Missing";
  if (typeof value === "number") return `${Math.round(value * 10) / 10} GB`;
  if (typeof value === "string" && value) return value;
  return "Unknown";
}

/** The missing prerequisites production needs, each with the action that resolves it. */
function missing(system: SystemInfo) {
  const rows: { id: string; label: string; fix: string; models?: boolean }[] = [];
  if (system.ffmpeg === false || system.ffprobe === false)
    rows.push({ id: "ffmpeg", label: "FFmpeg is missing.", fix: platformWords().installFfmpeg });
  if (system.model_runtime === false)
    rows.push({ id: "runtime", label: "The local model runtime isn’t set up.", fix: "Set up the runtime in Models.", models: true });
  if (system.whisper === false)
    rows.push({ id: "speech", label: "Speech-to-text isn’t installed.", fix: "Install speech in Models.", models: true });
  const agents = system.agents?.engine === "ollama" ? system.agents.blocker : null;
  if (agents)
    rows.push({ id: "agents", label: "Local agents can’t run yet.", fix: `${agents.message} Set them up in Models.`, models: true });
  return rows;
}

function NeedsInternet({ children }: { children: string }) {
  return (
    <p className="gf-settings-network">
      <Icon name="download" size={14} />
      <span><strong>Needs internet:</strong> {children}</span>
    </p>
  );
}

/** App-wide settings: one owning section for each device, model and account control. */
export function SettingsScreen({
  w,
  factory,
  section,
  onSection,
  visible,
  onReview,
  onEditingRules,
}: {
  w: Workspace;
  factory: FactoryState;
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  visible: boolean;
  onReview?: (clip: Clip) => void;
  onEditingRules?: () => void;
}) {
  const panelId = useId();
  const system = factory.errors.system ? null : factory.data.system;
  const label = settingsSections.find(([id]) => id === section)?.[1] ?? "Settings";
  const unavailable = (
    <p className="gf-help" role="alert">
      Status unavailable{factory.errors.system ? `: ${factory.errors.system}` : "."} Check that the local service is running, then refresh.
    </p>
  );
  const refresh = (
    <button type="button" className="gf-button secondary compact" disabled={factory.loading} onClick={() => void factory.refresh(["system", "factory"])}>
      <Icon name="refresh" size={14} />
      Refresh status
    </button>
  );
  const gaps = system ? missing(system) : [];
  return (
    <div className="gf-settings">
      <nav className="gf-settings-sections" aria-label="Settings sections">
        {settingsSections.map(([id, name, icon]) => (
          <button type="button" key={id} aria-current={section === id ? "page" : undefined} aria-controls={panelId} onClick={() => onSection(id)}>
            <Icon name={icon} size={16} />
            <span>{name}</span>
          </button>
        ))}
      </nav>
      <section className="gf-settings-panel" id={panelId} aria-label={label} key={section}>
        {section === "device" && <>
          <header><h2>Device and runtime</h2><p>What {platformWords().computer} has ready for local production.</p></header>
          {!system ? unavailable : <>
            {gaps.length > 0 ? (
              <ul className="gf-settings-gaps" aria-label="Missing prerequisites">
                {gaps.map((gap) => (
                  <li key={gap.id}>
                    <span><strong>{gap.label}</strong> {gap.fix}</span>
                    {gap.models && <button type="button" className="gf-button secondary compact" onClick={() => onSection("models")}>Open Models<Icon name="arrow" size={14} /></button>}
                  </li>
                ))}
              </ul>
            ) : <p className="gf-help">Every prerequisite for local production is ready.</p>}
            <dl className="gf-settings-facts">
              {readiness.filter(([key]) => key !== "apple_silicon" || platformWords().os === "macos").map(([key, name]) => <div key={key}><dt>{name}</dt><dd>{shown(key, system[key])}</dd></div>)}
            </dl>
          </>}
          {refresh}
        </>}
        {section === "models" && <>
          <header><h2>Models</h2><p>Speech, the local model library and how the factory reaches a language model.</p></header>
          <NeedsInternet>speech and model downloads, and cloud model routing. Installed local models run offline.</NeedsInternet>
          <AiModelCard />
          <EngineSetup factory={factory} jobs={false} />
        </>}
        {section === "accounts" && <>
          <header><h2>Accounts and connections</h2><p>Your account and connected Instagram accounts.</p></header>
          <NeedsInternet>signing in, syncing, and connecting or measuring Instagram accounts.</NeedsInternet>
          <section className="gf-settings-block" aria-label="Your account"><h3>Account</h3><CloudAccountRow showLocal /></section>
          <div className="gf-settings-block gf-results-accounts">
            <AutomationPanel w={w} factory={factory} visible={visible} onReview={onReview} onEditingRules={onEditingRules} layout="accounts" />
          </div>
        </>}
        {section === "privacy" && <>
          <header><h2>Privacy and storage</h2><p>Where {platformWords().computer} keeps your factory’s data.</p></header>
          {!system ? unavailable : (
            <dl className="gf-settings-facts">
              <div><dt>Data folder</dt><dd>{system.data_dir || "Unknown"}</dd></div>
            </dl>
          )}
          <p className="gf-help">Everything is stored on {platformWords().computer}. Features that use the internet are marked.</p>
        </>}
        {section === "jobs" && <>
          <header><h2>Background jobs</h2><p>Downloads, renders and analysis running on {platformWords().computer}.</p></header>
          <Jobs state={factory} />
        </>}
        {section === "about" && <>
          <header><h2>About</h2><p>Growth Factory on {platformWords().computer}.</p></header>
          <dl className="gf-settings-facts">
            <div><dt>App version</dt><dd>{system?.version || "Version unavailable"}</dd></div>
            {system?.platform && <div><dt>Platform</dt><dd>{system.platform}</dd></div>}
          </dl>
          {!system && unavailable}
        </>}
      </section>
    </div>
  );
}
