import { useState } from "react";
import { ClipCard } from "../components/ClipCard";
import { Empty } from "../components/ui";
import type { Tab } from "../navigation";
import type { FactoryState } from "../useFactory";
import { newestFirst } from "./Home";

const filters = ["Needs review", "Approved", "All"] as const;
type Filter = (typeof filters)[number];
/** Every clip the factory made, with the review controls. */
export function Clips({
  state,
  navigate,
}: {
  state: FactoryState;
  navigate: (tab: Tab) => void;
}) {
  const [filter, setFilter] = useState<Filter>("Needs review");
  const [source, setSource] = useState("");
  const clips = newestFirst(state.data.clips).filter(
    (clip) => !source || clip.video_id === source,
  );
  const counts: Record<Filter, number> = {
    "Needs review": clips.filter((clip) => !clip.approved).length,
    Approved: clips.filter((clip) => clip.approved).length,
    All: clips.length,
  };
  const shown = clips.filter((clip) =>
    filter === "All" ? true : filter === "Approved" ? clip.approved : !clip.approved,
  );
  const sources = state.data.videos.filter((video) =>
    state.data.clips.some((clip) => clip.video_id === video.id),
  );
  if (!state.data.clips.length)
    return (
      <Empty
        title={
          state.errors.clips || state.loading ? "Clips are unavailable" : "No clips yet"
        }
      >
        {state.errors.clips || state.loading ? (
          "Reconnect to the local service to load your clips."
        ) : (
          <>
            Add footage on the Factory page and finished clips show up here.{" "}
            <button className="text-button" onClick={() => navigate("Factory")}>
              Go to Factory
            </button>
          </>
        )}
      </Empty>
    );
  return (
    <>
      <div className="filter-row">
        <div className="chips" role="group" aria-label="Filter clips">
          {filters.map((name) => (
            <button
              key={name}
              className={`chip-button ${filter === name ? "active" : ""}`}
              aria-pressed={filter === name}
              onClick={() => setFilter(name)}
            >
              {name} <span className="chip-count">{counts[name]}</span>
            </button>
          ))}
        </div>
        {sources.length > 1 && (
          <select
            aria-label="Filter by video"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            <option value="">All videos</option>
            {sources.map((video) => (
              <option key={video.id} value={video.id}>
                {video.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {!shown.length ? (
        <p className="muted">
          {filter === "Needs review"
            ? "Nothing is waiting for review."
            : filter === "Approved"
              ? "No approved clips yet."
              : "No clips from this video."}
        </p>
      ) : (
        <div className="clip-tiles">
          {shown.map((clip) => (
            <ClipCard key={clip.id} state={state} clip={clip} />
          ))}
        </div>
      )}
    </>
  );
}
