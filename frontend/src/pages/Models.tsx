import { AutoTextarea } from "../components/AutoTextarea";
import { useState } from "react";
import { endpoint, post, remove } from "../api";
import type { FactoryState } from "../useFactory";
import {
  Badge,
  Empty,
  Field,
  Section,
  Unknown,
  ReadOnlyValue,
} from "../components/ui";
import { Jobs } from "../components/Jobs";
import { installedLlms, usableModel } from "../productionPreflight";
import { Narration } from "../components/Narration";
export function Models({ state }: { state: FactoryState }) {
  const [consent, setConsent] = useState<Record<string, boolean>>({});
  const [prompt, setPrompt] = useState("");
  const [picked, setModel] = useState("qwen-small");
  const installed = installedLlms(state.data.models);
  const model = usableModel(picked, installed);
  const ollama = state.errors.system ? null : state.data.system?.ollama;
  const inference = state.data.jobs.filter((j) => j.kind === "inference");
  return (
    <>
      <Section
        title="Local runtime"
        detail="Up to 3 model downloads run in parallel; runtime setup and inference use the heavy lane"
      >
        <div className="runtime-row">
          <div>
            <h3>Prepare this machine</h3>
            <p className="muted">
              Runtime setup installs the backend-supported local dependencies.
              Status is reported, never assumed from hardware.
            </p>
            <p>
              Runtime:{" "}
              <ReadOnlyValue
                value={
                  state.errors.system ? null : state.data.system?.model_runtime
                }
              />
            </p>
          </div>
          <button
            disabled={state.busy}
            onClick={() =>
              void state.run(
                () => post("/api/runtime/setup"),
                "Runtime setup queued. Watch the job output for errors.",
              )
            }
          >
            Set up runtime
          </button>
        </div>
      </Section>
      <Section
        title="Model shelf"
        detail="Read the license and storage requirement before installing"
      >
        <p className="muted" role="status">
          Ollama:{" "}
          {ollama === true
            ? "running — its local models appear below as ready-to-use language models (cloud models are never listed)."
            : ollama === false
              ? "not running. Open the Ollama app or run “ollama serve” to use models you already pulled."
              : "status unknown."}
        </p>
        {!state.data.models.length ? (
          <Empty title="Model catalog unavailable">
            The local service has not returned a model catalog. Refresh or check
            service errors above.
          </Empty>
        ) : (
          <div className="model-grid">
            {state.data.models.map((m) => (
              <article className="model-card" key={m.id}>
                <div className="row">
                  <Badge>{m.kind || "Model"}</Badge>
                  <Badge tone={m.installed === true ? "success" : ""}>
                    {m.status ||
                      (m.installed === true
                        ? "Installed"
                        : m.installed === false
                          ? "Not installed"
                          : "Unknown")}
                  </Badge>
                </div>
                <h3>{m.name}</h3>
                <p className="muted">{m.repo || "Repository unknown"}</p>
                <dl className="info-list">
                  <div>
                    <dt>Estimated storage</dt>
                    <dd>
                      <Unknown value={m.estimated_gb} suffix=" GB" />
                    </dd>
                  </div>
                  <div>
                    <dt>License</dt>
                    <dd>{m.license || "Unknown — check repository terms"}</dd>
                  </div>
                </dl>
                {m.source === "ollama" ? (
                  <p className="muted">
                    Managed by Ollama. Add or remove it with “ollama pull” /
                    “ollama rm”.
                    {m.vision === false &&
                      " Text-only: clip analysis needs a vision model."}
                  </p>
                ) : m.installed === true ? (
                  <button
                    className="danger-button"
                    disabled={state.busy}
                    onClick={() => {
                      if (window.confirm(`Remove installed model “${m.name}”?`))
                        void state.run(
                          () => remove(endpoint("models", m.id)),
                          "Model removal requested.",
                        );
                    }}
                  >
                    Remove model
                  </button>
                ) : (
                  <>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={!!consent[m.id]}
                        onChange={(e) =>
                          setConsent((old) => ({
                            ...old,
                            [m.id]: e.target.checked,
                          }))
                        }
                      />
                      I have reviewed and accept this model’s license.
                    </label>
                    <button
                      disabled={
                        state.busy || !consent[m.id] || !!state.errors.models
                      }
                      onClick={() =>
                        void state.run(
                          () =>
                            post(endpoint("models", m.id, "download"), {
                              accept_license: true,
                            }),
                          "Model download queued. Installation is complete only when the worker succeeds.",
                        )
                      }
                    >
                      Install model
                    </button>
                  </>
                )}
              </article>
            ))}
          </div>
        )}
      </Section>
      <Narration state={state} />
      <div className="two-col">
        <Section
          title="Inference playground"
          detail="Test a local language model without cloud requests"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void state.run(
                () => post("/api/inference", { prompt, model_id: model }),
                "Inference queued. Output appears after the job completes.",
              );
            }}
          >
            <Field label="Inference model">
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {!installed.some((m) => m.id === model) && (
                  <option value={model}>{model} (not installed)</option>
                )}
                {installed.map((m) => (
                  <option value={m.id} key={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Prompt">
              <AutoTextarea
                required
                rows={5}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Ask for a hook, a story angle, or a caption…"
              />
            </Field>
            <button
              disabled={
                state.busy ||
                !prompt.trim() ||
                !installed.some((m) => m.id === model) ||
                !!state.errors.models
              }
            >
              Run locally
            </button>
          </form>
          {inference.slice(0, 3).map((job) => (
            <div className="inference-output" key={job.id}>
              <Badge tone={job.status === "failed" ? "danger" : ""}>
                {job.status}
              </Badge>
              {job.error && (
                <p role="alert" className="error-text">
                  {job.error}
                </p>
              )}
              {job.result?.output !== undefined && (
                <ReadOnlyValue value={job.result.output} />
              )}
            </div>
          ))}
        </Section>
        <Jobs state={state} />
      </div>
    </>
  );
}
