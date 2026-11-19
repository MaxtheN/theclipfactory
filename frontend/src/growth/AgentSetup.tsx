import { useState } from "react";
import { post } from "../api";
import { platformWords } from "../platform";
import { activeJob } from "../productionPreflight";
import type { AgentModel, AgentsState, FactoryBlocker, Job } from "../types";
import type { FactoryState } from "../useFactory";
import { Icon } from "./Icon";
import "./engine-setup.css";
import "./speech-setup.css";

/** The engine's agents state when agent roles run on Ollama here (Windows and Linux); else null. */
export function ollamaAgents(factory: FactoryState): AgentsState | null {
  const agents = factory.errors.system ? undefined : factory.data.system?.agents;
  return agents?.engine === "ollama" ? agents : null;
}

/** Why agents cannot run on this computer right now, from the engine; null when they can. */
export function agentsBlocker(factory: FactoryState): FactoryBlocker | null {
  return ollamaAgents(factory)?.blocker ?? null;
}

const ALTERNATIVES: Record<string, string> = {
  openrouter_key: "Use your own OpenRouter key: add it in Settings → Models → AI model, then turn on cloud agents.",
  manual: "Edit clips by hand in the Studio. Manual edits do not need agents.",
};

function downloading(jobs: Job[], modelId: string | undefined) {
  return jobs.find((job) => {
    const context = job.context as { model_id?: unknown } | null | undefined;
    return job.kind === "download" && activeJob(job) && !!modelId && context?.model_id === modelId;
  });
}

function hardwareLine(agents: AgentsState) {
  const { ram_gb, gpu, vram_gb } = agents.hardware;
  return `${ram_gb} GB memory${gpu ? ` · ${gpu}${vram_gb ? ` (${vram_gb} GB)` : ""}` : ""}`;
}

/**
 * Local agents off the Mac: Ollama, the recommended model and the hardware check, as the engine
 * reports them. Each blocker names what still works and has a way to check again. Mounting does no
 * work; the creator starts every check and download.
 */
export function AgentSetup({ factory, variant = "card" }: { factory: FactoryState; variant?: "card" | "inline" }) {
  const [busy, setBusy] = useState<"" | "check" | "pull">("");
  const [error, setError] = useState("");
  const [consent, setConsent] = useState(false);
  const agents = ollamaAgents(factory);
  if (!agents) return null;
  const blocker = agents.blocker;
  if (!blocker && variant === "inline") return null;
  const words = platformWords();
  const model: AgentModel | undefined =
    agents.catalogue.find((entry) => entry.id === blocker?.model_id) ?? agents.catalogue.find((entry) => entry.recommended);
  const installed = agents.catalogue.find((entry) => entry.installed && entry.fits) ?? agents.catalogue.find((entry) => entry.installed);
  const job = downloading(factory.data.jobs, blocker?.code === "agent_model_missing" ? blocker.model_id : undefined);

  async function act(kind: "check" | "pull", request: () => Promise<unknown>) {
    setBusy(kind);
    setError("");
    try {
      await request();
    } catch (e) {
      setError(e instanceof Error ? e.message : kind === "check" ? "Could not check again." : "The download could not start.");
    } finally {
      setBusy("");
      void factory.refresh(["system", "factory", "jobs", "models"]);
    }
  }
  const check = (
    <button type="button" className="gf-button secondary compact" disabled={!!busy} onClick={() => void act("check", () => post("/api/agents/check"))}>
      <Icon name="refresh" size={14} />
      {busy === "check" ? "Checking…" : "Check again"}
    </button>
  );

  let actions = check;
  if (blocker?.code === "ollama_missing")
    actions = (
      <>
        <a className="gf-button primary compact" href={blocker.install_url || agents.ollama.install_url} target="_blank" rel="noreferrer">
          Get Ollama<Icon name="arrow" size={14} />
        </a>
        {check}
      </>
    );
  if (blocker?.code === "agent_model_missing" && model)
    actions = job ? (
      <div className="gf-speech-progress" role="status">
        <span>{job.status === "queued" ? "Waiting for the download lane" : job.message || `Downloading ${model.name}`}</span>
        <progress aria-label={`${model.name} download progress`} max={100} value={typeof job.progress === "number" ? job.progress : undefined} />
      </div>
    ) : (
      <>
        <label className="gf-local-model-consent">
          <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
          I accept {model.name}’s {model.license} license.
        </label>
        <button
          type="button"
          className="gf-button primary compact"
          disabled={!!busy || !consent}
          onClick={() => void act("pull", () => post("/api/agents/ollama/pull", { model_id: model.id, accept_license: true }))}
        >
          {busy === "pull" ? "Starting…" : `Download ${model.name} (about ${model.download_gb} GB)`}
        </button>
        {check}
      </>
    );

  const alternatives = (blocker?.alternatives?.length ? blocker.alternatives : ["openrouter_key", "manual"])
    .map((code) => ALTERNATIVES[code])
    .filter(Boolean);
  const body = blocker && (
    <>
      <p>{blocker.message}</p>
      {blocker.code === "agent_model_missing" && model && <p className="gf-local-engine-note">{model.note}</p>}
      <div className="gf-engine-actions">{actions}</div>
      <div className="gf-agent-alternatives">
        <strong>Other ways to make clips</strong>
        <ul>{alternatives.map((line) => <li key={line}>{line}</li>)}</ul>
      </div>
      {error && <p className="gf-speech-error" role="alert">{error}</p>}
    </>
  );

  if (variant === "inline")
    return (
      <div className="gf-speech-blocker gf-agent-blocker" data-code={blocker?.code} role="group" aria-label="Local agents">
        {body}
      </div>
    );
  return (
    <section className="gf-local-engine-section gf-agent-setup" aria-label="Local agents" data-code={blocker?.code ?? "ready"}>
      <header>
        <div>
          <h3>Local agents</h3>
          <p>Agents run on {words.computer} through Ollama. {hardwareLine(agents)}.</p>
        </div>
        <Icon name="spark" size={20} />
      </header>
      {blocker ? body : (
        <>
          <p className="gf-local-engine-note">
            {agents.cloud
              ? "Agents use your cloud key, so the local check is skipped."
              : installed
                ? `Ready: ${installed.name} runs on the ${installed.device === "cuda" ? "NVIDIA GPU" : "CPU"}.`
                : "Ready."}
          </p>
          <div className="gf-engine-actions">{check}</div>
          {error && <p className="gf-speech-error" role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}
