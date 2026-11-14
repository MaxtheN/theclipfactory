import { useEffect, useRef, useState } from "react";
import type { Clip } from "../types";
import { endpoint } from "../api";
import { Icon } from "./Icon";
import { formatTime } from "./parts";
import { clipMediaUrl } from "./productionApi";
import { reviewPreview } from "./workspaceApi";
import { ReelsActionRail } from "./PostPreview";

/**
 * A clip's cover tile. Pressing it plays the clip right there, with sound, in a
 * quick look over the page; review stays a separate, deliberate step.
 */
export function ClipPreview({
  clip,
  className,
  iconSize = 28,
  onReview,
  onDiscard,
  reviewLabel,
  discardLabel,
}: {
  clip: Clip;
  className: string;
  iconSize?: number;
  onReview?: () => void;
  reviewLabel?: string;
  discardLabel?: string;
  /** Deletes the clip file; offered in the quick look where the screen can free space. */
  onDiscard?: () => void;
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
          reviewLabel={reviewLabel}
          onDiscard={onDiscard}
          discardLabel={discardLabel}
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
  discardLabel = "Discard",
  onDiscard,
}: {
  clip: Clip;
  title: string;
  onClose: () => void;
  onReview?: () => void;
  onDiscard?: () => void;
  discardLabel?: string;
  /** The optional editing follow-up, separate from playback. */
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
      <div className="gf-quicklook-media"><video
        src={clipMediaUrl(clip.id)}
        poster={endpoint("clips", clip.id, "cover")}
        controls
        autoPlay
        playsInline
        aria-label={`Playing ${title}`}
        onError={() => setFailed(true)}
      /><ReelsActionRail /></div>
      {clip.made_without_speech && <p className="gf-inline-error">Older test draft · generated without speech. Inspect carefully before using this version.</p>}
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
        {onDiscard && (
          <button
            type="button"
            className="gf-button ghost compact"
            onClick={() => {
              onClose();
              onDiscard();
            }}
          >
            {discardLabel}
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
