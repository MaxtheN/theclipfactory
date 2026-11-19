import { useEffect, useRef, useState } from "react";
import { AutoTextarea } from "../components/AutoTextarea";
import { sourceHasActiveJob } from "../productionPreflight";
import type { Video } from "../types";
import type { FactoryState } from "../useFactory";
import { Disclosure, Field, Pill, PrimaryAction } from "./parts";
import { productionApi } from "./productionApi";
import { object } from "./productionState";
import type { Workspace } from "./useCampaignWorkspace";
import { reviewPreview } from "./workspaceApi";

const LIMIT = 2_000_000;
type Format = "srt" | "vtt" | "json";
interface Draft {
  content: string;
  format: Format;
  language: string;
  filename: string;
  error: string;
}
const emptyDraft = (): Draft => ({
  content: "",
  format: "srt",
  language: "",
  filename: "",
  error: "",
});

function readText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("This transcript could not be read as text."));
    reader.onerror = () =>
      reject(new Error("This transcript could not be read."));
    reader.readAsText(file);
  });
}

export function SourceTranscript({
  source,
  factory,
  run,
  disabled = false,
}: {
  source: Video;
  factory: FactoryState;
  run: Workspace["run"];
  disabled?: boolean;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [reading, setReading] = useState(false);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  const fileRequest = useRef(0);
  const actionLock = useRef(false);
  const draft = drafts[source.id] || emptyDraft();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      fileRequest.current++;
    };
  }, []);
  function update(patch: Partial<Draft>, id = source.id) {
    if (mounted.current)
      setDrafts((old) => ({
        ...old,
        [id]: { ...(old[id] || emptyDraft()), ...patch },
      }));
  }

  const transcript = object(source.transcript);
  const segments = Array.isArray(transcript?.segments)
    ? transcript.segments
    : [];
  const cues = segments.filter((cue) => {
    const item = object(cue);
    return (
      item &&
      typeof item.start === "number" &&
      Number.isFinite(item.start) &&
      typeof item.end === "number" &&
      Number.isFinite(item.end) &&
      item.start >= 0 &&
      item.end > item.start &&
      typeof item.text === "string"
    );
  }).length;
  const provenance = (source as Video & { transcript_origin?: unknown })
    .transcript_origin;
  const origin =
    provenance === "imported"
      ? "Imported transcript"
      : provenance === "generated"
        ? "Generated locally"
        : source.transcript == null
          ? "No transcript"
          : "Origin not recorded";
  const stale =
    factory.loading || !!factory.errors.videos || !!factory.errors.jobs;
  const sourceBusy = sourceHasActiveJob(factory.data.jobs, source.id);
  const blocked =
    disabled ||
    factory.busy ||
    stale ||
    sourceBusy ||
    reading ||
    pending ||
    reviewPreview;
  const runtimeReady =
    !factory.errors.system &&
    !factory.errors.models &&
    factory.data.system?.model_runtime === true &&
    factory.data.models.some(
      (model) => model.id === "whisper-turbo" && model.installed === true,
    );
  const transcribeReady =
    !blocked &&
    runtimeReady &&
    factory.data.system?.ffmpeg === true &&
    source.has_audio === true;
  const language = draft.language.trim();
  const languageValid = !language || /^[A-Za-z-]{2,12}$/.test(language);
  const contentValid =
    !!draft.content.trim() &&
    draft.content.length <= LIMIT &&
    new TextEncoder().encode(draft.content).byteLength <= LIMIT;

  async function chooseFile(file: File) {
    if (blocked || actionLock.current) return;
    const id = source.id;
    const format = file.name.split(".").pop()?.toLowerCase();
    if (!["srt", "vtt", "json"].includes(format || "")) {
      update(
        {
          error:
            "Choose an SRT, VTT or JSON transcript file. Your draft is unchanged.",
        },
        id,
      );
      return;
    }
    if (file.size > LIMIT) {
      update(
        {
          error: "Keep transcript files within 2 MB. Your draft is unchanged.",
        },
        id,
      );
      return;
    }
    const request = ++fileRequest.current;
    setReading(true);
    try {
      const content = await readText(file);
      if (!mounted.current || request !== fileRequest.current) return;
      if (
        !content.trim() ||
        content.length > LIMIT ||
        new TextEncoder().encode(content).byteLength > LIMIT
      )
        throw new Error(
          "Supply a nonempty transcript within 2 MB. Your draft is unchanged.",
        );
      update(
        { content, format: format as Format, filename: file.name, error: "" },
        id,
      );
    } catch (error) {
      if (request === fileRequest.current)
        update(
          {
            error:
              error instanceof Error
                ? error.message
                : "The transcript could not be read. Your draft is unchanged.",
          },
          id,
        );
    } finally {
      if (mounted.current && request === fileRequest.current) setReading(false);
    }
  }

  async function perform(kind: "import" | "transcribe") {
    if (
      blocked ||
      actionLock.current ||
      (kind === "import" ? !contentValid || !languageValid : !transcribeReady)
    )
      return;
    actionLock.current = true;
    setPending(true);
    const id = source.id;
    update({ error: "" }, id);
    try {
      const ok = await run(
        kind === "import"
          ? () =>
              productionApi.importTranscript(id, {
                format: draft.format,
                content: draft.content,
                ...(language ? { language } : {}),
              })
          : () => productionApi.transcribe(id),
        kind === "import"
          ? "Timed transcript imported on this source. Existing rendered versions are unchanged."
          : "Local transcription queued. The source updates only after the worker completes.",
      );
      if (!ok)
        update(
          {
            error:
              "The operation was not confirmed. Your draft is still here; refresh source state before retrying.",
          },
          id,
        );
    } catch (error) {
      update(
        {
          error:
            error instanceof Error
              ? error.message
              : "The operation failed. Your draft is still here.",
        },
        id,
      );
    } finally {
      actionLock.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return (
    <section aria-label={`Transcript for ${source.name}`}>
      <p className="gf-small-note">
        <Pill tone="quiet">
          {reviewPreview ? "Preview · native tools only" : origin}
        </Pill>
        {!reviewPreview && (
          <span>
            {cues
              ? `${cues} valid timed cue${cues === 1 ? "" : "s"}`
              : "No timed cues recorded"}
          </span>
        )}
      </p>
      <Disclosure title="Transcript & captions" icon="file">
        {reviewPreview ? (
          <p>
            Available in the Mac app.
          </p>
        ) : (
          <>
            <p>
              Import a timed transcript or generate one locally.
            </p>
            {sourceBusy && (
              <p className="gf-help">
                This source already has queued or running work. Finish or cancel
                it before replacing its transcript.
              </p>
            )}
            {stale && (
              <p className="gf-help">
                Refresh source and queue data before changing this transcript.
              </p>
            )}
            <Field
              label="Transcript file"
              hint={
                draft.filename
                  ? `Selected: ${draft.filename}`
                  : "SRT, VTT or JSON · up to 2 MB"
              }
            >
              {(id) => (
                <input
                  id={id}
                  type="file"
                  accept=".srt,.vtt,.json"
                  disabled={blocked}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void chooseFile(file);
                    event.target.value = "";
                  }}
                />
              )}
            </Field>
            <Field label="Transcript format">
              {(id) => (
                <select
                  id={id}
                  value={draft.format}
                  disabled={blocked}
                  onChange={(event) =>
                    update({ format: event.target.value as Format, error: "" })
                  }
                >
                  <option value="srt">SRT</option>
                  <option value="vtt">VTT</option>
                  <option value="json">JSON</option>
                </select>
              )}
            </Field>
            <Field
              label="Timed transcript"
              hint="Check text and timestamps first."
            >
              {(id) => (
                <AutoTextarea
                  id={id}
                  rows={3}
                  value={draft.content}
                  disabled={blocked}
                  maxLength={LIMIT}
                  onChange={(event) =>
                    update({ content: event.target.value, error: "" })
                  }
                  placeholder="Choose a transcript file or paste its timed contents."
                />
              )}
            </Field>
            <Field
              label="Transcript language"
              hint="Optional, e.g. en or fr."
            >
              {(id) => (
                <input
                  id={id}
                  value={draft.language}
                  disabled={blocked}
                  maxLength={12}
                  placeholder="Use default language"
                  onChange={(event) =>
                    update({ language: event.target.value, error: "" })
                  }
                />
              )}
            </Field>
            {!languageValid && (
              <p className="gf-help">
                Use a language code of 2–12 letters or hyphens.
              </p>
            )}
            {draft.error && (
              <p className="gf-inline-error" role="alert">
                {draft.error}
              </p>
            )}
            <PrimaryAction
              label={
                pending
                  ? "Working…"
                  : reading
                    ? "Reading transcript…"
                    : "Import transcript"
              }
              disabled={blocked || !contentValid || !languageValid}
              intent="advance"
              onClick={() => void perform("import")}
            />
            <p className="gf-help">
              {source.has_audio !== true
                ? "Local transcription needs a source with an audio track."
                : !runtimeReady
                  ? "Local transcription needs the installed Whisper model and ready native runtime. Importing a transcript does not."
                  : factory.data.system?.ffmpeg !== true
                    ? "Local transcription also needs FFmpeg to extract the source audio."
                    : "Whisper runs locally. A queued job is not a finished transcript."}
            </p>
            <PrimaryAction
              label="Transcribe locally"
              disabled={!transcribeReady}
              intent="produce"
              onClick={() => void perform("transcribe")}
            />
          </>
        )}
      </Disclosure>
    </section>
  );
}
