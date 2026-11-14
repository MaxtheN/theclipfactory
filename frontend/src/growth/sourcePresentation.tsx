import type { Video } from "../types";
import { Disclosure, formatTime } from "./parts";

export function sourceLabel(id: string, sourceIds: readonly string[]) {
  const index = sourceIds.indexOf(id);
  return index < 0 ? "Unattached source" : `Podcast ${index + 1}`;
}

export function SourceDetails({ source, disabled = false, onRebuild, onDelete }: { source: Video; disabled?: boolean; onRebuild?: () => void; onDelete?: () => void }) {
  return (
    <div className="gf-source-details">
      <Disclosure title="Source details" icon="info">
        <dl>
          <dt>Original filename</dt>
          <dd>{source.name}</dd>
          <dt>Source ID</dt>
          <dd>{source.id}</dd>
          <dt>Duration</dt>
          <dd>{formatTime(source.duration)}</dd>
        </dl>
        {(onRebuild || onDelete) && <div className="gf-episode-actions">
          {onRebuild && <button type="button" className="gf-button secondary compact" disabled={disabled} onClick={onRebuild}>Rebuild storyboard</button>}
          {onDelete && <button type="button" className="gf-button ghost compact" disabled={disabled} onClick={onDelete}>Delete source</button>}
        </div>}
      </Disclosure>
    </div>
  );
}
