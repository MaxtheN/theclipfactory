import { useEffect, useRef, useState } from "react";
import type { Clip } from "../types";
import { endpoint } from "../api";
import { Icon } from "./Icon";
import { formatTime } from "./parts";
import { clipMediaUrl } from "./productionApi";
import { reviewPreview } from "./workspaceApi";

/**
 * A clip's cover tile. Pressing it plays the clip right there, with sound, in a
 * quick look over the page; review stays a separate, deliberate step.
 */
export function ClipPreview({
  clip,
  className,
  iconSize = 28,
  onReview,
}: {
  clip: Clip;
  className: string;
  iconSize?: number;
  onReview?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const title = clip.hook || clip.name;
  if (reviewPreview || clip.provenance_mode === "preview_fixture")
    return (
      <span className={className}>
        <Icon name="play" size={iconSize} />
        <span>Illustrative edit</span>
      </span>
    );
  return (
    <>
      <button
        type="button"
        className={className}
        style={{
          backgroundImage: `url(${endpoint("clips", clip.id, "cover")})`,
        }}
        aria-label={`Play ${title}`}
        onClick={() => setOpen(true)}
      >
        <Icon name="play" size={iconSize} />
        <span>{formatTime(clip.end - clip.start)}</span>
      </button>
      {open && (
        <QuickLook
          clip={clip}
          title={title}
          onClose={() => setOpen(false)}
          onReview={onReview}
        />
      )}
    </>
  );
}

export function QuickLook({
  clip,
  title,
  onClose,
  onReview,
  reviewLabel = "Review",
}: {
  clip: Clip;
  title: string;
  onClose: () => void;
  onReview?: () => void;
  /** What the follow-up step is called; undirected clips are approved here rather than reviewed in the Studio. */
  reviewLabel?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    // Closing through the element hands focus back to the tile that opened it.
    return () => {
      if (element?.open) element.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="gf-quicklook"
      aria-label={`Preview of ${title}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <video
        src={clipMediaUrl(clip.id)}
        poster={endpoint("clips", clip.id, "cover")}
        controls
        autoPlay
        playsInline
        aria-label={`Playing ${title}`}
        onError={() => setFailed(true)}
      />
      {failed && (
        <p className="gf-inline-error" role="alert">
          This clip could not be played. Its file may have been removed from
          this Mac.
        </p>
      )}
      <div className="gf-quicklook-bar">
        <strong>{title}</strong>
        {onReview && (
          <button
            type="button"
            className="gf-button secondary compact"
            onClick={() => {
              onClose();
              onReview();
            }}
          >
            {reviewLabel}
            <Icon name="arrow" size={14} />
          </button>
        )}
        <button
          type="button"
          className="gf-button ghost compact"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </dialog>
  );
}
