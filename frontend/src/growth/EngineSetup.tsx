import { useEffect, useRef, useState } from "react";
import { endpoint, patch, post, remove } from "../api";
import { AutoTextarea } from "../components/AutoTextarea";
import { Jobs } from "../components/Jobs";
import { Narration } from "../components/Narration";
import { ReadOnlyValue } from "../components/ui";
import { installedLlms, usableModel } from "../productionPreflight";
import type { Settings } from "../types";
import type { FactoryState } from "../useFactory";
import { Field } from "./parts";
import { Icon } from "./Icon";
import { SpeechSetup, engineOf } from "./SpeechSetup";
import "./engine-setup.css";

const readiness = [
  ["platform", "Platform"], ["apple_silicon", "Apple Silicon"],
  ["memory_gb", "Memory"], ["free_disk_gb", "Free disk"],
  ["ffmpeg", "FFmpeg"], ["ffprobe", "FFprobe"],
  ["model_runtime", "Model runtime"], ["whisper", "Speech-to-text"],
  ["ollama", "Ollama"],
] as const;

/** Local maintenance, explicitly requested by the user; mounting performs no work. */
export function EngineSetup({ factory }: { factory: FactoryState }) {
  const [consent, setConsent] = useState<Record<string, boolean>>({});
  const [prompt, setPrompt] = useState("");
  const [picked, setPicked] = useState("qwen-small");
  const installed = installedLlms(factory.data.models);
  const model = usableModel(picked, installed);
  const system = factory.errors.system ? null : factory.data.system;
  const ollama = system?.ollama;
  const engine = engineOf(factory);
  const inference = factory.data.jobs.filter((job) => job.kind === "inference");
  const canInfer = !factory.busy && !!prompt.trim() && installed.some((entry) => entry.id === model) && !factory.errors.models;
  return (
    <div className="gf-local-engine">
      <SpeechSetup factory={factory} variant="engine" />
      <section className="gf-local-engine-section" aria-label="Local runtime">
        <header><div><h3>Local runtime</h3><p>Prepare this Mac for local processing.</p></div><Icon name="settings" size={20} /></header>
        <div className="gf-local-engine-runtime">
          <div><strong>Runtime: <ReadOnlyValue value={system?.model_runtime} /></strong><small>{engine?.ready ? "Speech recognition is ready." : "Readiness is reported by the local service."}</small></div>
          <button type="button" className="gf-button secondary compact" disabled={factory.busy} onClick={() => void factory.run(() => post("/api/runtime/setup"), "Runtime setup queued. Watch the job output for errors.")}>Set up runtime</button>
        </div>
        <details className="gf-local-engine-disclosure">
          <summary>This Mac <span>{typeof system?.memory_gb === "number" ? `${system.memory_gb} GB memory` : "Memory unknown"} · {typeof system?.free_disk_gb === "number" ? `${system.free_disk_gb} GB free` : "Disk space unknown"}</span><Icon name="down" size={14} /></summary>
          <dl className="gf-local-engine-readiness">{readiness.map(([key, label]) => { const value = system?.[key]; return <div key={key}><dt>{label}</dt><dd><ReadOnlyValue value={value} />{typeof value === "number" ? " GB" : ""}</dd></div>; })}</dl>
        </details>
        {factory.errors.system && <p className="gf-help" role="alert">System status unavailable: {factory.errors.system}</p>}
      </section>
      <section className="gf-local-engine-section" aria-label="Local model catalog">
        <header><div><h3>Model library</h3><p>Choose a model only after reviewing its license and storage.</p></div><span className="gf-pill quiet">{factory.errors.models || factory.loading || !factory.data.models.length ? "Catalog unavailable" : `${factory.data.models.filter((entry) => entry.installed === true).length} installed`}</span></header>
        <p className="gf-local-engine-note">Ollama: {ollama === true ? "running. Its local models are listed below; cloud models are not included." : ollama === false ? "not running. Open Ollama or run “ollama serve” to use models you already pulled." : "status unknown."}</p>
        {factory.errors.models && <p className="gf-help" role="alert">Model status unavailable: {factory.errors.models}</p>}
        {!factory.data.models.length ? <p className="gf-help">Model catalog unavailable. Refresh or check the local service.</p> : <div className="gf-local-model-list">{factory.data.models.map((entry) => <details className="gf-local-model" key={entry.id}>
          <summary><span><strong>{entry.name}</strong><small>{entry.kind || "Model"}{entry.vision === false ? " · Text only" : entry.vision === true ? " · Vision" : ""}</small></span><span className="gf-pill quiet">{entry.status || (entry.installed === true ? "Installed" : entry.installed === false ? "Not installed" : "Unknown")}</span><Icon name="down" size={14} /></summary>
          <div className="gf-local-model-body">
            <p className="gf-local-engine-note">{entry.repo || "Repository unknown"}</p>
            <dl className="gf-local-model-facts"><div><dt>Estimated storage</dt><dd>{typeof entry.estimated_gb === "number" ? `${entry.estimated_gb} GB` : "Unknown"}</dd></div><div><dt>License</dt><dd>{entry.license || "Unknown — check repository terms"}</dd></div></dl>
            {entry.source === "ollama" ? <p className="gf-help">Managed by Ollama. Add or remove it with “ollama pull” / “ollama rm”.{entry.vision === false && " Text-only models cannot analyze clip frames."}</p> : entry.installed === true ? <button type="button" className="gf-button secondary compact" disabled={factory.busy} onClick={() => { if (window.confirm(`Remove installed model “${entry.name}”?`)) void factory.run(() => remove(endpoint("models", entry.id)), "Model removal requested."); }}>Remove model</button> : <>
              <label className="gf-local-model-consent"><input type="checkbox" checked={!!consent[entry.id]} onChange={(event) => setConsent((previous) => ({ ...previous, [entry.id]: event.target.checked }))} />I have reviewed and accept {entry.name}’s license.</label>
              <button type="button" className="gf-button secondary compact" disabled={factory.busy || !consent[entry.id] || !!factory.errors.models} onClick={() => void factory.run(() => post(endpoint("models", entry.id, "download"), { accept_license: true }), "Model download queued. Installation is complete only when the worker succeeds.")}>{entry.status === "damaged" ? "Repair (re-download)" : "Install model"}</button>
            </>}
          </div>
        </details>)}</div>}
      </section>
      <LocalPreferences factory={factory} />
      <details className="gf-local-engine-section gf-local-engine-tools">
        <summary><Icon name="research" size={18} /><span>Local testing & narration<small>Try an installed model or generate a separate audio file.</small></span><Icon name="down" size={14} /></summary>
        <div className="gf-local-engine-tools-body">
          <section aria-label="Inference playground"><h3>Inference playground</h3><p className="gf-local-engine-note">Runs on this Mac. No cloud requests.</p><form onSubmit={(event) => { event.preventDefault(); if (canInfer) void factory.run(() => post("/api/inference", { prompt, model_id: model }), "Inference queued. Output appears after the job completes."); }}>
            <Field label="Inference model">{(id) => <select id={id} value={model} onChange={(event) => setPicked(event.target.value)}>{!installed.some((entry) => entry.id === model) && <option value={model}>{model} (not installed)</option>}{installed.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select>}</Field>
            <Field label="Prompt">{(id) => <AutoTextarea id={id} required rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Ask for a hook, a story angle, or a caption…" />}</Field>
            <button className="gf-button secondary compact" disabled={!canInfer}>Run locally</button>
          </form>{inference.slice(0, 3).map((job) => <article className="gf-local-inference-output" key={job.id}><strong>{job.status}</strong>{job.error && <p role="alert">{job.error}</p>}{job.result?.output !== undefined && <ReadOnlyValue value={job.result.output} />}</article>)}</section>
          <Narration state={factory} />
        </div>
      </details>
      <details className="gf-local-engine-section gf-local-engine-tools">
        <summary><Icon name="clock" size={18} /><span>Background jobs<small>Real progress, errors, results and cancellation.</small></span><Icon name="down" size={14} /></summary>
        <div className="gf-local-engine-tools-body"><Jobs state={factory} /></div>
      </details>
    </div>
  );
}


type LocalDefaults = Pick<Settings, "default_model" | "clip_count" | "production_strategy" | "autonomy" | "language">;
/** Patch only local defaults. Publishing permissions, budgets and brand data are never sent. */
function LocalPreferences({ factory }: { factory: FactoryState }) {
  const [draft, setDraft] = useState<Partial<LocalDefaults>>({});
  const [saving, setSaving] = useState(false);
  const submitted = useRef<Partial<LocalDefaults> | null>(null);
  const saved = factory.data.settings;
  useEffect(() => {
    if (!saved || factory.errors.settings || factory.busy || saving) return;
    // An older readback must not clear a newer edit that reverted to the old value.
    if (submitted.current && !Object.entries(submitted.current).every(([key, next]) => saved[key as keyof LocalDefaults] === next)) return;
    submitted.current = null;
    setDraft((current) => {
      const remaining = Object.entries(current).filter(([key, next]) => next !== saved[key as keyof LocalDefaults]);
      return remaining.length === Object.keys(current).length ? current : Object.fromEntries(remaining);
    });
  }, [saved, factory.errors.settings, factory.busy, saving]);
  const value = <K extends keyof LocalDefaults>(key: K) => draft[key] ?? saved?.[key];
  const change = <K extends keyof LocalDefaults>(key: K, next: LocalDefaults[K]) => setDraft((previous) => ({ ...previous, [key]: next }));
  const changes = Object.fromEntries(Object.entries(draft).filter(([key, next]) => next !== saved?.[key as keyof LocalDefaults])) as Partial<LocalDefaults>;
  const language = value("language") || "";
  const valid = /^[A-Za-z-]{2,12}$/.test(language);
  const installed = installedLlms(factory.data.models);
  const chosen = value("default_model") || "";
  async function save() {
    if (!saved || factory.errors.settings || factory.busy || saving || !valid || !Object.keys(changes).length) return;
    const sent = { ...changes };
    submitted.current = sent;
    setSaving(true);
    try {
      // Keep drafts until the actual settings readback confirms this request.
      await factory.run(() => patch("/api/settings", sent), "Local production defaults sent.");
    } finally { setSaving(false); }
  }
  return <details className="gf-local-engine-section gf-local-engine-tools">
    <summary><Icon name="settings" size={18} /><span>Production defaults<small>Language, model choice and what happens when footage arrives.</small></span><Icon name="down" size={14} /></summary>
    <div className="gf-local-engine-tools-body">
      {!saved || factory.errors.settings ? <p className="gf-help" role="alert">Production defaults unavailable. Unknown settings will not be overwritten.</p> : <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <Field label="When footage arrives">{(id) => <select id={id} value={value("autonomy") || "review"} onChange={(event) => change("autonomy", event.target.value)}><option value="auto">Start production automatically</option><option value="review">Wait for me to start production</option>{value("autonomy") === "manual" && <option value="manual">Manual (saved setting)</option>}</select>}</Field>
        <p className="gf-local-engine-note">Clips always wait for your approval. These defaults do not publish anything.</p>
        <Field label="Default model">{(id) => <select id={id} value={chosen} onChange={(event) => change("default_model", event.target.value)}><option value="">Automatic</option>{chosen && !installed.some((entry) => entry.id === chosen) && <option value={chosen}>{chosen} (not installed)</option>}{installed.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{entry.vision === false ? " (text only)" : ""}</option>)}</select>}</Field>
        <div className="gf-form-pair">
          <Field label="Clips per source">{(id) => <select id={id} value={value("clip_count") ?? 3} onChange={(event) => change("clip_count", Number(event.target.value))}>{[1, 2, 3, 4, 5, 6].map((count) => <option key={count} value={count}>{count}</option>)}</select>}</Field>
          <Field label="Language">{(id) => <input id={id} required maxLength={12} value={language} onChange={(event) => change("language", event.target.value)} placeholder="en" />}</Field>
        </div>
        <Field label="Production strategy">{(id) => <select id={id} value={value("production_strategy") || "swarm"} onChange={(event) => change("production_strategy", event.target.value as LocalDefaults["production_strategy"])}><option value="swarm">Swarm — different hypotheses</option><option value="team">Team — collaborative review</option><option value="baseline">Baseline — variant pipeline</option></select>}</Field>
        {!valid && <p className="gf-help" role="alert">Use a language code of 2–12 letters or hyphens, such as en.</p>}
        <button className="gf-button secondary compact" disabled={factory.busy || saving || !valid || !Object.keys(changes).length}>Save production defaults</button>
      </form>}
    </div>
  </details>;
}
