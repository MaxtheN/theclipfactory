import { useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import type { FactoryState } from "../useFactory";
const VIDEO_FILE = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
/** Drop or choose source videos. Shared by the Factory home and the Footage page. */
export function Dropzone({
  state,
  title,
  children,
  autopilot = false,
  aside,
}: {
  state: FactoryState;
  title: string;
  children: ReactNode;
  /** Only changes the confirmation wording; the service decides what starts. */
  autopilot?: boolean;
  aside?: ReactNode;
}) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  async function upload(files: FileList | File[]) {
    const all = Array.from(files);
    setError("");
    if (!all.length) return;
    if (
      all.some(
        (file) => !file.type.startsWith("video/") && !VIDEO_FILE.test(file.name),
      )
    ) {
      setError("Choose video files (MP4, MOV, M4V, WebM, MKV, or AVI).");
      return;
    }
    const count = `${all.length} video${all.length === 1 ? "" : "s"}`;
    await state.run(
      async () => {
        for (const file of all) {
          const form = new FormData();
          form.append("file", file);
          await api("/api/videos", { method: "POST", body: form });
        }
      },
      autopilot
        ? `${count} added. The factory is starting on ${all.length === 1 ? "it" : "them"}.`
        : `${count} added. Press Make clips when you are ready.`,
    );
    if (input.current) input.current.value = "";
  }
  return (
    <>
      <section
        className={`dropzone ${dragging ? "dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (!state.busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!state.busy) void upload(event.dataTransfer.files);
        }}
        aria-label="Video upload drop area"
        aria-busy={state.busy}
      >
        <span className="upload-symbol" aria-hidden="true">
          ↥
        </span>
        <div className="dropzone-copy">
          <h2>{title}</h2>
          <p>{children}</p>
          <small>MP4, MOV, M4V, WebM, MKV, AVI · Several at once is fine</small>
        </div>
        <div className="dropzone-actions">
          <button disabled={state.busy} onClick={() => input.current?.click()}>
            {state.busy ? "Working…" : "Choose videos"}
          </button>
          {aside}
        </div>
        <input
          ref={input}
          type="file"
          multiple
          accept="video/*,.mkv,.avi"
          className="visually-hidden"
          aria-label="Upload video files"
          disabled={state.busy}
          onChange={(event) => {
            if (event.target.files) void upload(event.target.files);
          }}
        />
      </section>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </>
  );
}
