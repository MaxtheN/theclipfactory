import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, endpoint, localMediaUrl } from "../api";
import type { Storyboard as Board, StoryboardScene } from "../types";
import { Badge, duration } from "./ui";

type Load =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; board: Board };

const WIDTH = 1000;
const TRACK = 26;
const MAX_POINTS = 500;
/** Width of the label column beside the traces, in CSS pixels. */
const GUTTER = 64;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}
export function readable(value: unknown): Board | null {
  if (!value || typeof value !== "object") return null;
  const board = value as Board;
  if (!finite(board.duration) || board.duration <= 0) return null;
  if (!Array.isArray(board.scenes)) return null;
  const scenes = board.scenes.filter(
    (scene) =>
      scene &&
      typeof scene === "object" &&
      finite(scene.start) &&
      finite(scene.end) &&
      scene.end > scene.start,
  );
  const signals = board.signals;
  return {
    ...board,
    scenes,
    limitations: typeof board.limitations === "string" ? board.limitations : "",
    signals: {
      interval: finite(signals?.interval) && signals.interval > 0 ? signals.interval : 1,
      motion: Array.isArray(signals?.motion) ? signals.motion : [],
      loudness: Array.isArray(signals?.loudness) ? signals.loudness : [],
    },
  };
}
/** Average into at most MAX_POINTS buckets; a bucket with no reading stays null. */
function buckets(values: (number | null)[]): (number | null)[] {
  const size = Math.max(1, Math.ceil(values.length / MAX_POINTS));
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i += size) {
    const part = values.slice(i, i + size).filter(finite);
    out.push(part.length ? part.reduce((a, b) => a + b, 0) / part.length : null);
  }
  return out;
}
/** Line and area paths for one 0..1 trace; gaps (null) break the line. */
export function tracePaths(values: (number | null)[]) {
  const points = buckets(values);
  const step = points.length ? WIDTH / points.length : WIDTH;
  let line = "";
  let area = "";
  let run: string[] = [];
  let first = 0;
  const close = (end: number) => {
    if (!run.length) return;
    line += `M${run.join("L")}`;
    area += `M${first.toFixed(1)},${TRACK}L${run.join("L")}L${end.toFixed(1)},${TRACK}Z`;
    run = [];
  };
  points.forEach((value, index) => {
    const x = (index + 0.5) * step;
    if (value === null) {
      close((index - 0.5) * step);
      return;
    }
    if (!run.length) first = x;
    run.push(`${x.toFixed(1)},${(TRACK - 1 - clamp01(value) * (TRACK - 3)).toFixed(1)}`);
  });
  close((points.length - 0.5) * step);
  return { line, area };
}
function percent(value: number | null | undefined) {
  return finite(value) ? `${Math.round(clamp01(value) * 100)}%` : "–";
}
function at<T>(values: T[], interval: number, time: number): T | null {
  const value = values[Math.min(values.length - 1, Math.max(0, Math.floor(time / interval)))];
  return value === undefined ? null : value;
}
function range(scene: StoryboardScene) {
  return `${duration(scene.start)}–${duration(scene.end)}`;
}
function Level({ label, value }: { label: string; value: number | null }) {
  return (
    <span className="scene-level">
      <span>{label}</span>
      {value === null ? (
        <span className="muted">none</span>
      ) : (
        <>
          <meter min={0} max={1} value={clamp01(value)} aria-label={`${label} level`} />
          <strong>{percent(value)}</strong>
        </>
      )}
    </span>
  );
}
function SceneRow({
  scene,
  selected,
  onSelect,
  register,
}: {
  scene: StoryboardScene;
  selected: boolean;
  onSelect: () => void;
  register: (node: HTMLLIElement | null) => void;
}) {
  const frames = (Array.isArray(scene.frames) ? scene.frames : [])
    .map((frame) => ({ time: frame?.time, url: localMediaUrl(frame?.url) }))
    .filter((frame): frame is { time: number; url: string } => !!frame.url);
  const texts = (Array.isArray(scene.on_screen_text) ? scene.on_screen_text : []).filter(
    (text): text is string => typeof text === "string" && !!text.trim(),
  );
  const number = scene.index + 1;
  return (
    <li
      ref={register}
      className={`scene ${selected ? "selected" : ""} ${scene.usable === false ? "unusable" : ""}`}
    >
      {frames[0] ? (
        <img
          className="scene-thumb"
          src={frames[0].url}
          alt={`Frame from scene ${number}`}
          loading="lazy"
        />
      ) : (
        <span className="scene-thumb placeholder" aria-hidden="true">
          ▷
        </span>
      )}
      <div className="scene-body">
        <div className="scene-head">
          <button
            className="scene-toggle"
            aria-expanded={selected}
            onClick={onSelect}
          >
            Scene {number} · {range(scene)}
          </button>
          {scene.usable === false ? (
            <Badge tone="danger">Skipped: unusable footage</Badge>
          ) : (
            finite(scene.highlight) && <Badge>Highlight {scene.highlight}/10</Badge>
          )}
          {scene.action && scene.action !== "none" && scene.usable !== false && (
            <Badge>{scene.action} action</Badge>
          )}
        </div>
        {scene.visual && <p className="scene-visual">{scene.visual}</p>}
        {texts.length > 0 && (
          <p className="scene-texts" aria-label="Text on screen">
            {texts.slice(0, 8).map((text, index) => (
              <span className="chip" key={`${text}-${index}`}>
                {text}
              </span>
            ))}
          </p>
        )}
        {scene.speech && <blockquote className="scene-speech">{scene.speech}</blockquote>}
        <p className="scene-levels">
          <Level label="Motion" value={finite(scene.motion) ? scene.motion : null} />
          <Level label="Sound" value={finite(scene.loudness) ? scene.loudness : null} />
        </p>
        {selected && scene.highlight_reason && scene.usable !== false && (
          <p className="muted scene-reason">{scene.highlight_reason}</p>
        )}
        {selected && frames.length > 1 && (
          <div className="scene-frames">
            {frames.map((frame) => (
              <figure key={frame.url}>
                <img
                  src={frame.url}
                  alt={`Scene ${number} at ${duration(frame.time)}`}
                  loading="lazy"
                />
                <figcaption>{duration(frame.time)}</figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}
/** What the factory saw and heard in one source: motion, sound, and a description of every scene. */
export function Storyboard({
  videoId,
  version = "",
}: {
  videoId: string;
  /** Change this (for example to the storyboard's updated_at) to reload. */
  version?: string | number;
}) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [selected, setSelected] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const rows = useRef(new Map<number, HTMLLIElement>());
  useEffect(() => {
    let current = true;
    setLoad({ status: "loading" });
    setSelected(null);
    setHover(null);
    api<unknown>(endpoint("videos", videoId, "storyboard"))
      .then((value) => {
        if (!current) return;
        const board = readable(value);
        setLoad(
          board
            ? { status: "ready", board }
            : { status: "error", message: "The local service returned an unreadable storyboard." },
        );
      })
      .catch((error: unknown) => {
        if (!current) return;
        setLoad(
          error instanceof ApiError && error.status === 404
            ? { status: "missing" }
            : {
                status: "error",
                message: error instanceof Error ? error.message : "The storyboard could not be loaded.",
              },
        );
      });
    return () => {
      current = false;
    };
  }, [videoId, version]);
  const board = load.status === "ready" ? load.board : null;
  const traces = useMemo(
    () =>
      board
        ? {
            motion: tracePaths(board.signals.motion),
            loudness: tracePaths(board.signals.loudness),
            hasSound: board.signals.loudness.some(finite),
          }
        : null,
    [board],
  );
  if (load.status === "loading")
    return (
      <p className="muted" role="status">
        Loading what the factory saw…
      </p>
    );
  if (load.status === "missing")
    return (
      <p className="muted">
        Not watched yet. Happens on the first clip run.
      </p>
    );
  if (load.status === "error")
    return (
      <p className="error-text" role="alert">
        {load.message}
      </p>
    );
  const { scenes, signals } = load.board;
  const total = load.board.duration;
  const select = (index: number, scroll: boolean) => {
    setSelected((old) => (old === index && !scroll ? null : index));
    if (scroll) rows.current.get(index)?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  };
  const sceneAt = (time: number) =>
    scenes.find((scene) => time >= scene.start && time < scene.end) ?? null;
  const hovered = hover === null ? null : sceneAt(hover);
  const usable = scenes.filter((scene) => scene.usable !== false).length;
  return (
    <div className="storyboard">
      <p className="storyboard-caption">
        {load.board.vision
          ? `Watched by ${load.board.model_id || "the local model"}`
          : "No vision model: sound and motion only"}
        {" · "}
        {scenes.length} scene{scenes.length === 1 ? "" : "s"}
        {usable < scenes.length ? `, ${scenes.length - usable} skipped` : ""}
      </p>
      <div
        className="timeline"
        style={{ ["--timeline-gutter" as string]: `${GUTTER}px` }}
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const plot = box.width - GUTTER;
          if (plot > 0)
            setHover(clamp01((event.clientX - box.left - GUTTER) / plot) * total);
        }}
        onPointerLeave={() => setHover(null)}
      >
        <div className="timeline-track">
          <span className="timeline-label">Motion</span>
          <svg
            viewBox={`0 0 ${WIDTH} ${TRACK}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="Motion over the length of the video"
          >
            <path className="trace-area motion" d={traces!.motion.area} />
            <path className="trace-line motion" d={traces!.motion.line} />
          </svg>
        </div>
        <div className="timeline-track">
          <span className="timeline-label">Sound</span>
          {traces!.hasSound ? (
            <svg
              viewBox={`0 0 ${WIDTH} ${TRACK}`}
              preserveAspectRatio="none"
              role="img"
              aria-label="Sound level over the length of the video"
            >
              <path className="trace-area sound" d={traces!.loudness.area} />
              <path className="trace-line sound" d={traces!.loudness.line} />
            </svg>
          ) : (
            <span className="timeline-empty muted">No sound in this video</span>
          )}
        </div>
        <div className="timeline-track">
          <span className="timeline-label">Scenes</span>
          <div className="timeline-scenes" role="group" aria-label="Scenes">
            {scenes.map((scene) => (
              <button
                key={scene.index}
                className={`scene-seg ${selected === scene.index ? "selected" : ""} ${scene.usable === false ? "unusable" : ""}`}
                style={{
                  flexGrow: scene.end - scene.start,
                  ["--score" as string]: clamp01(finite(scene.score) ? scene.score : 0),
                }}
                aria-pressed={selected === scene.index}
                aria-label={`Scene ${scene.index + 1}, ${duration(scene.start)} to ${duration(scene.end)}${scene.usable === false ? ", skipped" : ""}`}
                onFocus={() => setHover((scene.start + scene.end) / 2)}
                onBlur={() => setHover(null)}
                onClick={() => select(scene.index, true)}
              />
            ))}
          </div>
        </div>
        {hover !== null && (
          <span
            className="timeline-cursor"
            style={{ left: `calc(var(--timeline-gutter) + (100% - var(--timeline-gutter)) * ${hover / total})` }}
            aria-hidden="true"
          />
        )}
      </div>
      <p className="timeline-readout" aria-live="off">
        {hover === null ? (
          <span className="muted">
            {duration(0)} to {duration(total)}. Point at the timeline, or pick a scene.
          </span>
        ) : (
          <>
            <strong>{duration(hover)}</strong>{" "}
            <span className="key motion" aria-hidden="true" />
            <strong>{percent(at(signals.motion, signals.interval, hover))}</strong> motion{" "}
            <span className="key sound" aria-hidden="true" />
            <strong>{percent(at(signals.loudness, signals.interval, hover))}</strong> sound{" "}
            {hovered && <span className="muted">Scene {hovered.index + 1}</span>}
          </>
        )}
      </p>
      <ol className="scene-list" aria-label="Scenes in order">
        {scenes.map((scene) => (
          <SceneRow
            key={scene.index}
            scene={scene}
            selected={selected === scene.index}
            onSelect={() => select(scene.index, false)}
            register={(node) => {
              if (node) rows.current.set(scene.index, node);
              else rows.current.delete(scene.index);
            }}
          />
        ))}
      </ol>
      {load.board.limitations && (
        <p className="muted storyboard-limits">{load.board.limitations}</p>
      )}
    </div>
  );
}
