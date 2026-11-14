import { useState } from "react";
import { endpoint, post, remove } from "../api";
import { Dropzone } from "../components/Dropzone";
import { Storyboard } from "../components/Storyboard";
import { Badge, Empty, ReadOnlyValue, Section, duration } from "../components/ui";
import { sourceHasActiveJob, sourceHasTranscript } from "../productionPreflight";
import type { FactorySource, SourceState, Video } from "../types";
import type { FactoryState } from "../useFactory";

export function Transcript({ value }: { value: unknown }) {
  if (value === undefined || value === null || value === "")
    return <p className="muted">No transcript yet.</p>;
  if (typeof value === "string") return <p className="transcript">{value}</p>;
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    "text" in value &&
    typeof value.text === "string"
  )
    return value.text.trim() ? (
      <p className="transcript">{value.text}</p>
    ) : (
      <p className="muted">No speech was found in this video.</p>
    );
  return <ReadOnlyValue value={value} />;
}
const stateWords: Record<SourceState, string> = {
  idle: "",
  queued: "Waiting",
  working: "Working",
  needs_review: "Clips to review",
  done: "Done",
  failed: "Needs attention",
  cancelled: "Stopped",
};
function status(video: Video, source?: FactorySource) {
  const words = source ? stateWords[source.state] : "";
  if (words) return words;
  return (source?.storyboard ?? video.storyboard) ? "Watched" : "New";
}
/** Source videos, and what the factory saw in each one. */
export function Footage({
  state,
  onEdit,
}: {
  state: FactoryState;
  onEdit: (id: string) => void;
}) {
  const [selected, setSelected] = useState("");
  const video =
    state.data.videos.find((v) => v.id === selected) || state.data.videos[0];
  const line = Array.isArray(state.data.factory?.sources) ? state.data.factory.sources : [];
  const source = line.find((item) => item.video_id === video?.id);
  const board = video ? (source?.storyboard ?? video.storyboard ?? null) : null;
  const busy = video ? sourceHasActiveJob(state.data.jobs, video.id) : false;
  const canProduce = !busy && (source ? source.can_produce : true);
  return (
    <>
      <Dropzone
        state={state}
        title="Add footage"
        autopilot={state.data.settings?.autonomy === "auto"}
      >
        Drop videos here, or choose them from this Mac. The originals stay on
        this machine.
      </Dropzone>
      {!state.data.videos.length ? (
        <Empty title="No footage yet">
          Add a video to see what the factory finds in it.
        </Empty>
      ) : (
        <div className="library-layout">
          <Section
            title="Your footage"
            detail={`${state.data.videos.length} video${state.data.videos.length === 1 ? "" : "s"}`}
          >
            <div className="source-list">
              {state.data.videos.map((item) => (
                <button
                  key={item.id}
                  className={`source-item ${video?.id === item.id ? "selected" : ""}`}
                  aria-pressed={video?.id === item.id}
                  onClick={() => setSelected(item.id)}
                >
                  <span className="source-thumbnail" aria-hidden="true">
                    ▷
                  </span>
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {duration(item.duration)} ·{" "}
                      {typeof item.size === "number"
                        ? `${(item.size / 1024 / 1024).toFixed(1)} MB`
                        : "Unknown size"}
                    </small>
                  </span>
                  <Badge>
                    {status(
                      item,
                      line.find((entry) => entry.video_id === item.id),
                    )}
                  </Badge>
                </button>
              ))}
            </div>
          </Section>
          {video && (
            <Section title={video.name} detail="Original video">
              <video
                key={video.id}
                controls
                preload="metadata"
                src={endpoint("videos", video.id, "media")}
                className="source-player"
                aria-label={`Preview ${video.name}`}
              />
              <div className="row metadata">
                <span>{duration(video.duration)}</span>
                <span>
                  {typeof video.width === "number" &&
                  typeof video.height === "number"
                    ? `${video.width} × ${video.height}`
                    : "Unknown resolution"}
                </span>
              </div>
              <div className="actions">
                <button
                  disabled={state.busy || !canProduce}
                  onClick={() =>
                    void state.run(
                      () => post(endpoint("videos", video.id, "produce"), {}),
                      "Started. Finished clips show up on the Factory page.",
                    )
                  }
                >
                  Make clips
                </button>
                <button
                  className="secondary"
                  disabled={state.busy || busy}
                  onClick={() =>
                    void state.run(
                      () => post(endpoint("videos", video.id, "storyboard"), {}),
                      "The factory is watching this video. The storyboard updates when it finishes.",
                    )
                  }
                >
                  {board ? "Watch again" : "Watch footage"}
                </button>
                <button className="secondary" onClick={() => onEdit(video.id)}>
                  Edit by hand
                </button>
                <button
                  className="danger-button"
                  disabled={state.busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete “${video.name}”? This cannot be undone.`,
                      )
                    )
                      void state.run(
                        () => remove(endpoint("videos", video.id)),
                        "Video deleted.",
                      );
                  }}
                >
                  Delete
                </button>
              </div>
              {busy && (
                <p className="muted">The factory is working on this video.</p>
              )}
              {!busy && source && !source.can_produce && source.blocked_reason && (
                <p className="muted">{source.blocked_reason}</p>
              )}
              <h3>What the factory saw</h3>
              {board ? (
                <Storyboard key={video.id} videoId={video.id} version={board.updated_at} />
              ) : (
                <p className="muted">
                  The factory has not watched this video yet. It does that the
                  first time it makes clips, or when you press Watch footage.
                </p>
              )}
              <details>
                <summary>
                  Transcript
                  {video.has_audio === false ? " · no audio" : ""}
                </summary>
                <Transcript value={video.transcript} />
                {video.has_audio !== false && (
                  <button
                    className="secondary small"
                    disabled={state.busy || busy}
                    onClick={() =>
                      void state.run(
                        () => post(endpoint("videos", video.id, "transcribe")),
                        "Transcription started.",
                      )
                    }
                  >
                    {sourceHasTranscript(video) ? "Transcribe again" : "Transcribe"}
                  </button>
                )}
              </details>
            </Section>
          )}
        </div>
      )}
    </>
  );
}
