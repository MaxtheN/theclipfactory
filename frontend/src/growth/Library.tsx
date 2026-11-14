import { Clips } from "../pages/Clips";
import { useState } from "react";
import type { Clip } from "../types";
import type { Workspace } from "./useCampaignWorkspace";
import type { FactoryState } from "../useFactory";
import { reviewPreview } from "./workspaceApi";
import { Icon } from "./Icon";
import { Pill, formatTime } from "./parts";
import type { OpenProduction } from "./FactoryHome";
import { SourceDetails, sourceLabel } from "./sourcePresentation";

export function Library({
  w,
  factory,
  onReview,
  onProduce,
  onFactory,
}: {
  w: Workspace;
  factory: FactoryState;
  onReview: (clip: Clip) => void;
  onProduce: OpenProduction;
  onFactory: () => void;
}) {
  const [tab, setTab] = useState<"edits" | "wall" | "footage">("edits");
  const [query, setQuery] = useState("");
  const ids = w.campaign?.video_ids || [];
  const sources = factory.data.videos.filter((v) => ids.includes(v.id));
  const clips = factory.data.clips.filter(
    (c) =>
      c.campaign_id === w.campaign?.id &&
      c.profile_id === w.profileId &&
      ids.includes(c.video_id),
  );
  const normalized = query.trim().toLocaleLowerCase();
  const edits = clips.filter((c) =>
    `${c.name} ${c.hook} ${sourceLabel(c.video_id, ids)} ${sources.find((s) => s.id === c.video_id)?.name || ""}`
      .toLocaleLowerCase()
      .includes(normalized),
  );
  const footage = sources.filter((v) =>
    `${sourceLabel(v.id, ids)} ${v.name}`
      .toLocaleLowerCase()
      .includes(normalized),
  );
  return (
    <section className="gf-library" aria-label="Workspace library">
      <div className="gf-library-toolbar">
        <div className="gf-library-tabs" role="group" aria-label="Library view">
          <button
            type="button"
            aria-pressed={tab === "edits"}
            onClick={() => setTab("edits")}
          >
            Edits<span>{clips.length}</span>
          </button>
          <button
            type="button"
            aria-pressed={tab === "wall"}
            onClick={() => setTab("wall")}
          >
            Review wall<span>{clips.filter((c) => !c.approved).length}</span>
          </button>
          <button
            type="button"
            aria-pressed={tab === "footage"}
            onClick={() => setTab("footage")}
          >
            Footage<span>{sources.length}</span>
          </button>
        </div>
        <label className="gf-library-filter">
          <Icon name="research" size={16} />
          <input
            type="search"
            aria-label="Filter library"
            placeholder="Filter by name…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <p className="gf-library-scope">
        {tab === "edits"
          ? "Edits for the selected workspace and profile. Every version keeps its own review state."
          : tab === "wall"
            ? "Every edit side by side: play, filter by hypothesis, and approve or discard in place."
            : "Original footage attached to this workspace. Source files stay on this Mac."}
      </p>
      {tab === "wall" ? (
        <div className="gf-review-wall">
          <Clips
            state={factory}
            navigate={onFactory}
            scope={(clip) =>
              clip.campaign_id === w.campaign?.id &&
              clip.profile_id === w.profileId &&
              ids.includes(clip.video_id)
            }
          />
        </div>
      ) : tab === "edits" ? (
        <>
          {edits.length ? (
            <div className="gf-library-edits">
              {edits.map((clip) => (
                <button
                  type="button"
                  className="gf-library-edit"
                  key={clip.id}
                  onClick={() => onReview(clip)}
                  aria-label={`Review ${clip.name}`}
                >
                  <span className="gf-library-edit-art">
                    <Icon name="play" size={24} />
                    <small>
                      {reviewPreview ||
                      clip.provenance_mode === "preview_fixture"
                        ? "Illustrative edit"
                        : formatTime(clip.end - clip.start)}
                    </small>
                  </span>
                  <span className="gf-library-edit-copy">
                    <strong>{clip.name}</strong>
                    <span>{clip.hook || "Source-grounded edit"}</span>
                    <small>
                      {formatTime(clip.start)}–{formatTime(clip.end)} ·{" "}
                      {sourceLabel(clip.video_id, ids)}
                    </small>
                  </span>
                  <Pill tone={clip.approved ? "approved" : ""}>
                    {clip.approved ? "Approved" : "Needs review"}
                  </Pill>
                  <Icon name="arrow" size={16} />
                </button>
              ))}
            </div>
          ) : (
            <div className="gf-flow-empty">
              <Icon name="studio" size={26} />
              <h2>
                {normalized ? "No matching edits" : "Your edits will live here"}
              </h2>
              <p>
                {normalized
                  ? "Try a different name or opening."
                  : "Add footage in Factory, produce a few options, then review the exact versions you want to keep."}
              </p>
              {!normalized && (
                <button
                  type="button"
                  className="gf-button secondary"
                  onClick={onFactory}
                >
                  Go to Factory
                  <Icon name="arrow" size={15} />
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          {footage.length ? (
            <div className="gf-footage-list">
              {footage.map((source) => (
                <div className="gf-library-source" key={source.id}>
                  <div className="gf-footage-row">
                    <span className="gf-footage-icon">
                      <Icon name="studio" size={22} />
                    </span>
                    <div className="gf-footage-copy">
                      <strong>{sourceLabel(source.id, ids)}</strong>
                      <span>
                        {reviewPreview
                          ? "Illustrative source"
                          : formatTime(source.duration)}
                        {source.has_audio === true && source.transcript == null
                          ? " · Transcript not available"
                          : ""}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="gf-button secondary compact"
                      disabled={w.busy || w.loading}
                      onClick={() => onProduce(source.id, "agent")}
                    >
                      Find clips
                      <Icon name="arrow" size={15} />
                    </button>
                  </div>
                  <SourceDetails source={source} />
                </div>
              ))}
            </div>
          ) : (
            <div className="gf-flow-empty">
              <Icon name="folder" size={26} />
              <h2>
                {normalized
                  ? "No matching footage"
                  : "No footage in this workspace yet"}
              </h2>
              <p>
                {normalized
                  ? "Try another source name."
                  : "Upload a video in Factory to start building your library."}
              </p>
              {!normalized && (
                <button
                  type="button"
                  className="gf-button secondary"
                  onClick={onFactory}
                >
                  Go to Factory
                  <Icon name="arrow" size={15} />
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
