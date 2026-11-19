import { AutoTextarea } from "./AutoTextarea";
import { useState } from "react";
import { post } from "../api";
import type { FactoryState } from "../useFactory";
import { Badge, Field, Section } from "./ui";
// Require a root-relative API path, with no encoded traversal or origin switches.
export function narrationDownloadUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/api/narrations/"))
    return null;
  if (!/^\/api\/narrations\/[a-zA-Z0-9_-]+\/download$/.test(value)) return null;
  return value;
}
export function Narration({ state }: { state: FactoryState }) {
  const [text, setText] = useState("");
  const ready =
    !state.errors.models &&
    !state.errors.system &&
    state.data.system?.model_runtime === true &&
    state.data.models.some((m) => m.id === "kokoro" && m.installed === true);
  const jobs = state.data.jobs.filter((job) => job.kind === "narration");
  return (
    <Section
      title="Kokoro narration"
      detail="Generate a local audio file · separate from clip rendering"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || !text.trim()) return;
          void state.run(
            () => post("/api/narrations", { text: text.trim() }),
            "Narration queued. Audio is available only after the worker completes.",
          );
        }}
      >
        <Field label="Narration text">
          <AutoTextarea
            required
            rows={4}
            maxLength={5000}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Write the voiceover you want to hear…"
          />
        </Field>
        {!ready && (
          <p className="muted">
            Install Kokoro and set up the local runtime before generating
            narration.
          </p>
        )}
        <button disabled={state.busy || !ready || !text.trim()}>
          Generate narration
        </button>
      </form>
      {!jobs.length && (
        <p className="muted narration-empty">
          No narration yet.
        </p>
      )}
      {jobs.map((job) => {
        const url = narrationDownloadUrl(job.result?.download_url);
        return (
          <article className="inference-output" key={job.id}>
            <Badge tone={job.status === "failed" ? "danger" : ""}>
              {job.status}
            </Badge>
            {job.error && (
              <p role="alert" className="error-text">
                {job.error}
              </p>
            )}
            {job.status === "completed" &&
              (url ? (
                <div className="narration-output">
                  <audio
                    controls
                    preload="metadata"
                    src={url}
                    aria-label="Narration playback"
                  />
                  <a className="button secondary small" href={url} download>
                    Download narration
                  </a>
                </div>
              ) : (
                <p className="error-text" role="alert">
                  Narration finished without a valid same-origin download URL.
                </p>
              ))}
          </article>
        );
      })}
    </Section>
  );
}
