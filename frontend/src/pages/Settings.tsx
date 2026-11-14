import { useEffect, useState } from "react";
import { put } from "../api";
import { objectives, type Settings } from "../types";
import type { FactoryState } from "../useFactory";
import { Empty, Field, Section, ReadOnlyValue } from "../components/ui";
import { installedLlms } from "../productionPreflight";
export const CLIP_COUNTS = [1, 2, 3, 4, 5, 6];
// Send only the contract's editable fields, never server-added capabilities.
export function editableSettings(s: Settings): Settings {
  const count = Math.round(Number(s.clip_count ?? 3));
  return {
    default_model: typeof s.default_model === "string" ? s.default_model : "",
    clip_count: CLIP_COUNTS.includes(count) ? count : 3,
    brand: s.brand ?? "",
    production_strategy:
      s.production_strategy === "baseline" ? "baseline" : "team",
    objective: s.objective ?? "discovery",
    language: s.language ?? "en",
    autonomy: s.autonomy ?? "auto",
    publishing_enabled: s.publishing_enabled === true,
    ads_enabled: s.ads_enabled === true,
    daily_budget: s.daily_budget ?? 0,
    total_budget: s.total_budget ?? 0,
    graph_version: s.graph_version ?? "v22.0",
    ...(s.custom_event !== undefined ? { custom_event: s.custom_event } : {}),
  };
}
export function SettingsPage({ state }: { state: FactoryState }) {
  const [draft, setDraft] = useState<Settings | null>(
    state.data.settings ? editableSettings(state.data.settings) : null,
  );
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!dirty && state.data.settings)
      setDraft(editableSettings(state.data.settings));
  }, [state.data.settings, dirty]);
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setDraft((old) => (old ? { ...old, [key]: value } : old));
    setDirty(true);
  };
  if (!draft)
    return (
      <Empty title="Settings unavailable">
        Connect to the local service to load settings. Defaults will not be
        saved over unknown configuration.
      </Empty>
    );
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!draft) return;
    if (
      !Number.isFinite(draft.daily_budget) ||
      !Number.isFinite(draft.total_budget) ||
      draft.daily_budget < 0 ||
      draft.total_budget < 0
    ) {
      setError("Budgets must be finite, non-negative numbers.");
      return;
    }
    if (draft.objective === "custom" && !draft.custom_event?.trim()) {
      setError("Describe the custom objective event.");
      return;
    }
    if (
      await state.run(
        () => put("/api/settings", editableSettings(draft)),
        "Studio settings saved. Opt-ins do not create campaigns or imply integration readiness.",
      )
    )
      setDirty(false);
  }
  const llms = installedLlms(state.data.models);
  const chosen = draft.default_model ?? "";
  return (
    <form onSubmit={(e) => void save(e)}>
      <Section
        title="How the factory runs"
        detail="What happens when you add footage"
      >
        <label className="check optin">
          <input
            type="checkbox"
            checked={draft.autonomy === "auto"}
            onChange={(e) =>
              update("autonomy", e.target.checked ? "auto" : "review")
            }
          />
          <span>
            <strong>Autopilot</strong>
            <small>
              New footage starts production by itself. Clips still wait for your
              approval, and nothing is published without you.
            </small>
          </span>
        </label>
        <div className="form-grid">
          <Field
            label="Default model"
            hint="Automatic picks an installed model that can see video frames."
          >
            <select
              value={chosen}
              onChange={(e) => update("default_model", e.target.value)}
            >
              <option value="">Automatic</option>
              {chosen && !llms.some((m) => m.id === chosen) && (
                <option value={chosen}>{chosen} (not installed)</option>
              )}
              {llms.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.vision === false ? " (text only)" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Clips per source"
            hint="How many clips the factory aims to make from each video."
          >
            <select
              value={draft.clip_count ?? 3}
              onChange={(e) => update("clip_count", Number(e.target.value))}
            >
              {CLIP_COUNTS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Section>
      <Section
        title="Creative direction"
        detail="A clear intent guides every new clip"
      >
        <div className="form-grid">
          <Field label="Brand or studio name">
            <input
              value={draft.brand}
              onChange={(e) => update("brand", e.target.value)}
              placeholder="Your studio"
            />
          </Field>
          <Field label="Default objective">
            <select
              value={draft.objective}
              onChange={(e) => update("objective", e.target.value)}
            >
              {!objectives.includes(
                draft.objective as (typeof objectives)[number],
              ) && (
                <option value={draft.objective}>
                  {draft.objective} (reported)
                </option>
              )}
              {objectives.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Production strategy"
            hint="Team adds a self-check and revisions. Studio buttons can override this for one run."
          >
            <select
              value={draft.production_strategy ?? "team"}
              onChange={(e) =>
                update(
                  "production_strategy",
                  e.target.value as "team" | "baseline",
                )
              }
            >
              <option value="team">Team — bounded collaborative review</option>
              <option value="baseline">
                Baseline — existing variant pipeline
              </option>
            </select>
          </Field>
          <Field
            label="Language"
            hint="Language code used by the local pipeline (for example en)."
          >
            <input
              required
              value={draft.language}
              onChange={(e) => update("language", e.target.value)}
            />
          </Field>
          {draft.objective === "custom" && (
            <Field label="Custom objective event">
              <input
                required
                value={draft.custom_event || ""}
                onChange={(e) => update("custom_event", e.target.value)}
              />
            </Field>
          )}
        </div>
        <p className="muted">
          Discovery is the default objective. No performance assumptions are
          inferred from this setting.
        </p>
      </Section>
      <Section
        title="Permissions & guardrails"
        detail="Both publishing and ads are disabled by default"
      >
        <label className="check optin">
          <input
            type="checkbox"
            checked={draft.publishing_enabled}
            onChange={(e) => update("publishing_enabled", e.target.checked)}
          />
          <span>
            <strong>Allow Instagram publishing</strong>
            <small>
              Still requires a verified account, approved clip, public HTTPS
              asset, and explicit publish action.
            </small>
          </span>
        </label>
        <label className="check optin">
          <input
            type="checkbox"
            checked={draft.ads_enabled}
            onChange={(e) => update("ads_enabled", e.target.checked)}
          />
          <span>
            <strong>Opt in to ads capability</strong>
            <small>
              No unattended launch. This setting does not configure a Meta ad
              account or create a campaign.
            </small>
          </span>
        </label>
        <div className="form-grid">
          <Field label="Daily budget (USD)">
            <input
              required
              type="number"
              min="0"
              step="0.01"
              value={
                Number.isFinite(draft.daily_budget) ? draft.daily_budget : ""
              }
              onChange={(e) =>
                update(
                  "daily_budget",
                  e.target.value === "" ? NaN : Number(e.target.value),
                )
              }
            />
          </Field>
          <Field label="Total budget (USD)">
            <input
              required
              type="number"
              min="0"
              step="0.01"
              value={
                Number.isFinite(draft.total_budget) ? draft.total_budget : ""
              }
              onChange={(e) =>
                update(
                  "total_budget",
                  e.target.value === "" ? NaN : Number(e.target.value),
                )
              }
            />
          </Field>
          <Field label="Meta Graph version">
            <input
              required
              value={draft.graph_version}
              onChange={(e) => update("graph_version", e.target.value)}
            />
          </Field>
        </div>
      </Section>
      <Section
        title="Local workspace"
        detail="Read-only backend capabilities and paths"
      >
        <dl className="info-list">
          {Object.entries(state.data.system || {}).map(([key, value]) => (
            <div key={key}>
              <dt>{key.replaceAll("_", " ")}</dt>
              <dd>
                <ReadOnlyValue value={value} />
              </dd>
            </div>
          ))}
        </dl>
        <p className="muted">
          Only navigation preferences are stored in this browser. Account
          credentials are never written to browser storage.
        </p>
      </Section>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <div className="sticky-save">
        <span>{dirty ? "Unsaved changes" : "Settings up to date"}</span>
        <button disabled={state.busy || !dirty || !!state.errors.settings}>
          Save studio settings
        </button>
      </div>
    </form>
  );
}
