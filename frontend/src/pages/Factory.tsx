import { useState } from "react";
import { endpoint, post } from "../api";
import type { Candidate, Video, Job, TeamRun } from "../types";
import { objectives } from "../types";
import type { FactoryState } from "../useFactory";
import { Badge, Empty, Field, Section, duration } from "../components/ui";
import { Jobs } from "../components/Jobs";
import { ClipReview } from "../components/ClipReview";
import { TeamLedger } from "../components/TeamLedger";
import { TeamComparisons } from "../components/TeamComparisons";
export function getCandidates(analysis: unknown): Candidate[] {
  let value = analysis;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (value && typeof value === "object" && "candidates" in value)
    value = value.candidates;
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (c): c is Candidate =>
        c &&
        typeof c === "object" &&
        Number.isFinite(c.start) &&
        Number.isFinite(c.end) &&
        c.start >= 0 &&
        c.end > c.start,
    )
    .map((c) => ({
      start: c.start,
      end: c.end,
      hook: typeof c.hook === "string" ? c.hook : "",
      caption: typeof c.caption === "string" ? c.caption : "",
      reason: typeof c.reason === "string" ? c.reason : "",
      objective: typeof c.objective === "string" ? c.objective : "discovery",
    }));
}
function Editor({ state, video, onProduction }: { state: FactoryState; video: Video; onProduction: () => void }) {
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState(
    typeof video.duration === "number"
      ? String(Math.min(30, video.duration))
      : "",
  );
  const [hook, setHook] = useState("");
  const [caption, setCaption] = useState("");
  const [objective, setObjective] = useState(
    state.data.settings?.objective || "discovery",
  );
  const [revisionBudget, setRevisionBudget] = useState(2);
  const strategy = state.data.settings?.production_strategy ?? "team";
  const [model, setModel] = useState("qwen-small");
  const [error, setError] = useState("");
  const installed = state.data.models.filter(
    (m) =>
      m.installed === true && (m.id.startsWith("qwen") || m.kind === "llm"),
  );
  const productionReady =
    !state.loading &&
    !state.errors.models &&
    !state.errors.settings &&
    !state.errors.videos &&
    !state.errors.system &&
    state.data.system?.model_runtime === true &&
    installed.some((m) => m.id === model);
  const analysisJob = state.data.jobs.find(
    (job) =>
      job.kind === "analyze" &&
      job.status === "completed" &&
      job.result?.video_id === video.id,
  );
  const candidates = getCandidates(video.analysis).length
    ? getCandidates(video.analysis)
    : getCandidates(analysisJob?.result);
  const pick = (candidate: Candidate) => {
    setStart(String(candidate.start));
    setEnd(String(candidate.end));
    setHook(candidate.hook || "");
    setCaption(candidate.caption || "");
    setObjective(
      objectives.includes(candidate.objective as (typeof objectives)[number])
        ? candidate.objective!
        : "discovery",
    );
    setError("");
  };
  async function render(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    const a = Number(start),
      b = Number(end);
    if (
      start.trim() === "" ||
      end.trim() === "" ||
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      a < 0 ||
      b <= a ||
      (typeof video.duration === "number" && b > video.duration)
    ) {
      setError(
        "Enter a valid range: start ≥ 0, end after start, and within the source duration.",
      );
      return;
    }
    await state.run(
      () =>
        post(endpoint("videos", video.id, "render"), {
          start: a,
          end: b,
          hook,
          caption,
          objective,
          subtitles: true,
          format: "vertical",
        }),
      "Vertical render queued with subtitles. Review the clip when the job finishes.",
    );
  }
  return (
    <div className="editor-grid">
      <Section
        title="Find the moment"
        detail="Use a local model, or select your own range"
      >
        <video
          key={video.id}
          controls
          preload="metadata"
          src={endpoint("videos", video.id, "media")}
          className="source-player"
          aria-label="Source editor preview"
        />
        <div className="actions">
          <Field label="Analysis model">
            <select
              value={model}
              onChange={(event) => setModel(event.target.value)}
            >
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
          <button
            disabled={
              state.busy ||
              !!state.errors.models ||
              !installed.some((m) => m.id === model)
            }
            onClick={() =>
              void state.run(
                () =>
                  post(endpoint("videos", video.id, "analyze"), {
                    model_id: model,
                  }),
                "Analysis queued. Candidates appear after the local model finishes.",
              )
            }
          >
            Analyze video
          </button>
          <button
            disabled={state.busy || !productionReady}
            onClick={() => {
              if (!productionReady) return;
              void state.run(
                () =>
                  post(endpoint("videos", video.id, "produce"), {
                    model_id: model,
                  }).then(onProduction),
                "Variant pipeline queued. It transcribes audio, analyzes moments, and renders up to 3 clips serially; review the job result and clips.",
              );
            }}
          >
            Produce variants ({strategy})
          </button>
          <Field label="Team revision budget" hint="Maximum correction cycles, 0–2. Default 2.">
            <select value={revisionBudget} onChange={(e) => setRevisionBudget(Number(e.target.value))}>
              {[0, 1, 2].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </Field>
          <button disabled={state.busy || !productionReady} onClick={() => {
            if (!productionReady) return;
            void state.run(async () => {
              await post<{ job: Job; run: TeamRun }>(endpoint("videos", video.id, "team"), { model_id: model, revision_budget: revisionBudget });
              onProduction();
            }, "Team run queued. Inspect the ledger and review outputs; nothing is approved or published automatically.");
          }}>Start team run</button>
          <button className="secondary" disabled={state.busy || !productionReady} onClick={() => {
            if (!productionReady) return;
            void state.run(async () => {
              await post<Job>(endpoint("videos", video.id, "baseline"), { model_id: model });
              onProduction();
            }, "Baseline queued for explicit comparison. The source must have no active task; load comparisons after production finishes.");
          }}>Run comparative baseline</button>
        </div>
        {!installed.length && (
          <p className="muted">
            No local analysis model installed. The manual range editor works
            without one.
          </p>
        )}
        <p className="muted">
          Produce variants follows the saved strategy ({strategy}) via the compatible produce route. Team mode adds bounded critique and revisions. The baseline pipeline will transcribe when audio
          is present, analyze, then render up to 3 variants. Requires an
          installed analysis model and ready runtime; audio transcription also
          requires Whisper. Clips still need your review.
        </p>
        {!productionReady && (
          <p className="muted">
            Set up the runtime and install the selected analysis model in Models
            to enable variant production.
          </p>
        )}
        <h3>Suggested moments</h3>
        {!candidates.length ? (
          <p className="muted">
            No candidates yet. Analyze the source or choose a range manually.
          </p>
        ) : (
          candidates.map((candidate, index) => (
            <button
              className="candidate"
              key={`${candidate.start}-${index}`}
              onClick={() => pick(candidate)}
            >
              <span className="row">
                <strong>{candidate.hook || `Moment ${index + 1}`}</strong>
                <Badge>
                  {duration(candidate.start)} — {duration(candidate.end)}
                </Badge>
              </span>
              <span>{candidate.reason || "Local model suggestion"}</span>
            </button>
          ))
        )}
      </Section>
      <Section
        title="Shape your clip"
        detail="Manual control · vertical format · subtitles enabled"
      >
        <form onSubmit={(event) => void render(event)}>
          <div className="form-grid">
            <Field label="Start (seconds)">
              <input
                required
                type="number"
                step="0.01"
                min="0"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
            <Field label="End (seconds)">
              <input
                required
                type="number"
                step="0.01"
                min="0"
                max={video.duration ?? undefined}
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Hook">
            <input
              value={hook}
              onChange={(e) => setHook(e.target.value)}
              placeholder="The reason to keep watching"
            />
          </Field>
          <Field label="Caption">
            <textarea
              rows={4}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Give the moment context"
            />
          </Field>
          <Field label="Clip objective">
            <select
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
            >
              {objectives.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </Field>
          <p className="muted">
            Source length: {duration(video.duration)}. Subtitle rendering uses
            the local transcript; transcribe the source first for spoken
            subtitles.
          </p>
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          <button type="submit" disabled={state.busy}>
            Queue subtitled render <span aria-hidden="true">→</span>
          </button>
        </form>
      </Section>
    </div>
  );
}
export function Factory({
  state,
  initialSource = "",
}: {
  state: FactoryState;
  initialSource?: string;
}) {
  const [selected, setSelected] = useState(initialSource);
  const [ledgerVersion, setLedgerVersion] = useState(0);
  const video =
    state.data.videos.find((v) => v.id === selected) || state.data.videos[0];
  return (
    <>
      {video ? (
        <>
          <Field label="Source video">
            <select
              value={video.id}
              onChange={(event) => setSelected(event.target.value)}
            >
              {state.data.videos.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </Field>
          <Editor key={video.id} state={state} video={video} onProduction={() => setLedgerVersion((v) => v + 1)} />
          <TeamComparisons key={video.id} videoId={video.id} />
        </>
      ) : (
        <Empty title="Start with a source video">
          Import footage in Library to analyze candidates or render a manual
          selection.
        </Empty>
      )}
      <TeamLedger videos={state.data.videos} sourceId={video?.id} refreshToken={ledgerVersion} />
      <Jobs state={state} />
      <Section
        title="Clip review"
        detail="Preview, edit captions, approve, and give feedback"
      >
        {!state.data.clips.length ? (
          <Empty title="Nothing to review yet">
            Rendered clips appear here after a successful job. No sample clips
            are added.
          </Empty>
        ) : (
          <div className="clip-grid">
            {state.data.clips.map((clip) => (
              <ClipReview key={clip.id} state={state} clip={clip} />
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
