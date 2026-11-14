import { useEffect, useId, useState } from "react";
import { api } from "../api";
import "./ai-model.css";

/** Optional cloud model (OpenRouter, the creator's own key in macOS Keychain). The key never comes back. */
export type LlmRole =
  | "brand_research"
  | "post_copy"
  | "reference_pattern"
  | "strategist_hypothesis"
  | "learning_analyst"
  | "agents";

export interface LlmView {
  key: { present: boolean; error: string | null };
  groq_configured?: boolean;
  settings: {
    provider: "cloud" | "local";
    model: string;
    cloud_agents: boolean;
    cloud_agent_frames: boolean;
    fallback_to_local: boolean;
    speech_provider?: "local" | "groq";
  };
  routes: Record<LlmRole, "local" | "openrouter">;
  models: { id: string; label: string; tier: string; vision: boolean }[];
  spend: { calls: number; cost_usd: number };
  check?: { ok: boolean | null; kind: string; message: string };
}

export const llmApi = {
  view: () => api<LlmView>("/api/llm-provider"),
  settings: (changes: Partial<LlmView["settings"]>) =>
    api<LlmView>("/api/llm-provider/settings", {
      method: "PUT",
      body: JSON.stringify(changes),
    }),
  saveKey: (apiKey: string) =>
    api<LlmView>("/api/llm-provider/key", {
      method: "PUT",
      body: JSON.stringify({ api_key: apiKey }),
    }),
  removeKey: () =>
    api<LlmView>("/api/llm-provider/key", { method: "DELETE" }),
};

function message(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

function money(value: number) {
  if (!value) return "$0.00";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** Paste/replace field. The value lives only in this input until Keychain has it. */
function KeyForm({
  onSaved,
  onCancel,
  submitLabel = "Save key",
}: {
  onSaved: (view: LlmView) => void;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const id = useId();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    if (!value.trim()) return setError("Paste your OpenRouter key first.");
    setBusy(true);
    setError("");
    try {
      const view = await llmApi.saveKey(value.trim());
      setValue("");
      onSaved(view);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="gf-ai-key-form"
      onSubmit={e => {
        e.preventDefault();
        void save();
      }}
    >
      <label htmlFor={id}>OpenRouter key</label>
      <div className="gf-ai-key-row">
        <input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-or-…"
          value={value}
          onChange={e => setValue(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="gf-button" disabled={busy}>
          {busy ? "Checking…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="gf-button ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
      <small>Saved only in your Mac’s Keychain. Create one at openrouter.ai/keys.</small>
      {error && <p className="gf-ai-error" role="alert">{error}</p>}
    </form>
  );
}

/** Brand profile → "AI model": local vs cloud, key status, agent toggle and model choice. */
export function AiModelCard() {
  const [view, setView] = useState<LlmView | null>(null);
  const [editingKey, setEditingKey] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [savingSpeech, setSavingSpeech] = useState(false);
  const speechHelpId = useId();

  useEffect(() => {
    let live = true;
    llmApi
      .view()
      .then(v => live && setView(v))
      .catch(e => live && setError(message(e)));
    return () => {
      live = false;
    };
  }, []);

  async function change(changes: Partial<LlmView["settings"]>) {
    setError("");
    try {
      setView(await llmApi.settings(changes));
    } catch (e) {
      setError(message(e));
    }
  }

  async function changeSpeech(provider: "local" | "groq") {
    if (savingSpeech || (provider === "groq" && !view?.groq_configured)) return;
    setSavingSpeech(true);
    setError("");
    try {
      setView(await llmApi.settings({ speech_provider: provider }));
      setNote(provider === "groq" ? "Cloud speech selected. Audio for future transcription is sent to Groq." : "Local speech selected. Future transcription runs on this Mac.");
    } catch (e) {
      setError(message(e));
    } finally {
      setSavingSpeech(false);
    }
  }

  async function removeKey() {
    setError("");
    try {
      setView(await llmApi.removeKey());
      setNote("OpenRouter key removed from Keychain. Text models now run locally; your speech setting is unchanged.");
    } catch (e) {
      setError(message(e));
    }
  }

  if (!view)
    return (
      <section className="gf-card gf-ai-model" aria-label="AI model">
        <h2>AI model</h2>
        <p className="gf-ai-muted">{error ? "AI model settings are unavailable right now." : "Loading…"}</p>
      </section>
    );

  const cloud = view.settings.provider === "cloud" && view.key.present;
  const chosen = view.models.find(m => m.id === view.settings.model);
  const cloudLabel = `Cloud — ${chosen?.label ?? "Claude Haiku 5.5"} via OpenRouter`;

  return (
    <section className="gf-card gf-ai-model" aria-label="AI model">
      <h2>AI model</h2>
      <label className="gf-ai-field">
        <span>Speech recognition</span>
        <select
          aria-describedby={speechHelpId}
          value={view.settings.speech_provider ?? "local"}
          disabled={savingSpeech}
          onChange={event => void changeSpeech(event.target.value as "local" | "groq")}
        >
          <option value="local">Local — Whisper</option>
          <option value="groq" disabled={!view.groq_configured}>Cloud — Groq Whisper</option>
        </select>
      </label>
      <p id={speechHelpId} className="gf-ai-muted">
        {view.settings.speech_provider === "groq"
          ? "Cloud speech is selected. Audio from your footage is sent to Groq for transcription; the audio leaves your Mac."
          : "Local speech is selected. Transcription audio stays on this Mac and needs free memory. If you choose cloud speech, audio leaves your Mac and is sent to Groq for transcription."} This setting is separate from your text and clip-agent models.
      </p>
      <p className="gf-ai-muted">
        {view.groq_configured
          ? "Groq key configured in macOS Keychain."
          : <>Cloud speech needs a Groq API key configured in macOS Keychain. <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">Get a Groq key</a>; configure it in macOS Keychain before choosing cloud speech.</>}
      </p>
      <div className="gf-ai-choices" role="radiogroup" aria-label="Where the AI runs">
        <label className={`gf-ai-choice${!cloud ? " is-on" : ""}`}>
          <input
            type="radio"
            name="gf-ai-provider"
            checked={!cloud}
            onChange={() => void change({ provider: "local" })}
          />
          <span>
            <strong>Local</strong>
            <small>Free and private. Needs about 6 GB of free memory.</small>
          </span>
        </label>
        <label className={`gf-ai-choice${cloud ? " is-on" : ""}`}>
          <input
            type="radio"
            name="gf-ai-provider"
            checked={cloud}
            onChange={() => {
              if (!view.key.present) setEditingKey(true);
              void change({ provider: "cloud" });
            }}
          />
          <span>
            <strong>{cloudLabel}</strong>
            <small>Fast, works on any Mac. Well under a cent per brand read, on your OpenRouter account.</small>
          </span>
        </label>
      </div>

      <div className="gf-ai-key">
        {view.key.present ? (
          <>
            <span className="gf-ai-ok">Key saved in Keychain ✓</span>
            <button type="button" className="gf-button ghost" onClick={() => setEditingKey(v => !v)}>
              Replace key
            </button>
            <button type="button" className="gf-button ghost" onClick={() => void removeKey()}>
              Remove key
            </button>
          </>
        ) : (
          !editingKey && (
            <>
              <span className="gf-ai-muted">No OpenRouter key saved.</span>
              <button type="button" className="gf-button ghost" onClick={() => setEditingKey(true)}>
                Add key
              </button>
            </>
          )
        )}
        {view.key.error && <p className="gf-ai-error">{view.key.error}</p>}
      </div>
      {editingKey && (
        <KeyForm
          submitLabel={view.key.present ? "Replace key" : "Save key"}
          onCancel={() => setEditingKey(false)}
          onSaved={next => {
            setView(next);
            setEditingKey(false);
            setNote(next.check?.message ?? "Key saved in Keychain.");
          }}
        />
      )}

      {view.key.present && (
        <>
          <label className="gf-ai-field">
            <span>Model</span>
            <select
              value={view.settings.model}
              onChange={e => void change({ model: e.target.value })}
            >
              {view.models.map(m => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.tier}
                </option>
              ))}
            </select>
          </label>

          <label className="gf-ai-toggle">
            <input
              type="checkbox"
              checked={view.settings.cloud_agents}
              disabled={!cloud}
              onChange={e => void change({ cloud_agents: e.target.checked })}
            />
            <span>
              <strong>Use cloud model for clip agents too</strong>
              <small>
                Sends transcript text and frame descriptions to OpenRouter/Anthropic, without raw video or audio.
                Speech recognition uses the separate setting above.
                Costs a few cents per production run.
              </small>
            </span>
          </label>
          {view.settings.cloud_agents && (
            <label className="gf-ai-toggle gf-ai-sub">
              <input
                type="checkbox"
                checked={view.settings.cloud_agent_frames}
                disabled={!cloud}
                onChange={e => void change({ cloud_agent_frames: e.target.checked })}
              />
              <span>
                <strong>Also send still frames</strong>
                <small>Lets the agents look at a few stills from your footage. Off means text descriptions only.</small>
              </span>
            </label>
          )}
          <label className="gf-ai-toggle">
            <input
              type="checkbox"
              checked={view.settings.fallback_to_local}
              onChange={e => void change({ fallback_to_local: e.target.checked })}
            />
            <span>
              <strong>Fall back to local if the key fails</strong>
              <small>Off: you’ll see the error and choose.</small>
            </span>
          </label>
          <p className="gf-ai-muted">
            {cloud
              ? "Website reading, post captions, reference patterns and strategist ideas use the cloud model. They send your website text, clip hooks and short transcript snippets."
              : "Text and clip-agent models run on this Mac."}{" "}
            Cloud spend so far: {money(view.spend.cost_usd)} over {view.spend.calls} calls.
          </p>
        </>
      )}
      {note && <p className="gf-ai-muted" role="status">{note}</p>}
      {error && <p className="gf-ai-error" role="alert">{error}</p>}
    </section>
  );
}

/** The website step's hint when the local model is held for memory, or the cloud key failed. */
export function AiModelHint({
  kind,
  onRetry,
}: {
  kind: string | null | undefined;
  onRetry: () => void;
}) {
  const [view, setView] = useState<LlmView | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const relevant = kind === "held" || kind === "cloud_key";

  useEffect(() => {
    if (!relevant) return;
    let live = true;
    llmApi
      .view()
      .then(v => live && setView(v))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [relevant]);

  if (!relevant || !view) return null;

  async function useLocal() {
    try {
      await llmApi.settings({ provider: "local" });
      onRetry();
    } catch (e) {
      setError(message(e));
    }
  }

  if (kind === "cloud_key")
    return (
      <div className="gf-ai-hint">
        <div className="gf-ai-hint-actions">
          <button type="button" className="gf-button ghost" onClick={() => void useLocal()}>
            Use local model
          </button>
          <button type="button" className="gf-button ghost" onClick={() => setOpen(true)}>
            Fix key
          </button>
        </div>
        {open && <KeyForm submitLabel="Save and retry" onSaved={() => onRetry()} onCancel={() => setOpen(false)} />}
        {error && <p className="gf-ai-error">{error}</p>}
      </div>
    );

  if (view.key.present) return null; // held while a key exists: the creator chose Local on purpose
  return (
    <div className="gf-ai-hint">
      {!open ? (
        <button type="button" className="gf-ai-link" onClick={() => setOpen(true)}>
          Use cloud model instead
        </button>
      ) : (
        <>
          <p className="gf-ai-muted">
            Claude Haiku 5.5 via OpenRouter reads your public website text. Needs your OpenRouter key; well under a
            cent per read.
          </p>
          <KeyForm
            submitLabel="Save and retry"
            onCancel={() => setOpen(false)}
            onSaved={() => {
              void llmApi.settings({ provider: "cloud" }).finally(onRetry);
            }}
          />
        </>
      )}
    </div>
  );
}
