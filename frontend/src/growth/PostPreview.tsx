import { useState } from "react";
import "./post-preview.css";

/** Instagram shows about two lines (~125 characters) before "… more". */
export const FEED_PREVIEW_CHARS = 125;

export function truncateForFeed(caption: string, max = FEED_PREVIEW_CHARS): { text: string; truncated: boolean } {
  const text = caption.trim();
  const lines = text.split("\n");
  let cut = lines.slice(0, 2).join("\n");
  if (cut.length > max) cut = cut.slice(0, max).replace(/\s+\S*$/, "");
  const truncated = cut.length < text.length;
  return { text: truncated ? cut.trimEnd() : text, truncated };
}

/**
 * A neutral 9:16 phone mock of the post: the clip itself (captions are burned into the video)
 * playing muted over its cover, the account handle and avatar, the caption as the feed shows
 * it, and the grid cover. Not a copy of Instagram's interface; it shows what goes out.
 */
export function PostPreview({
  videoUrl,
  coverUrl,
  handle,
  caption,
  shareToFeed,
  when,
}: {
  videoUrl: string;
  coverUrl?: string | null;
  handle: string;
  caption: string;
  shareToFeed: boolean;
  when?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [playing, setPlaying] = useState(true);
  const { text, truncated } = truncateForFeed(caption);
  const name = handle.replace(/^@/, "") || "your_account";
  return <figure className="gf-post-preview" aria-label="Post preview">
    <div className="gf-phone">
      <div className="gf-phone-screen">
        <video
          key={videoUrl}
          className="gf-phone-video"
          src={videoUrl}
          poster={coverUrl || undefined}
          muted
          loop
          playsInline
          autoPlay={playing}
          aria-label="Clip with burned-in captions"
          onClick={e => { const v = e.currentTarget; if (v.paused) { void v.play().catch(() => undefined); setPlaying(true); } else { v.pause(); setPlaying(false); } }}
        />
        <div className="gf-phone-overlay">
          <div className="gf-phone-account">
            <span className="gf-phone-avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
            <strong>{name}</strong>
          </div>
          <p className="gf-phone-caption" data-testid="preview-caption">
            {expanded || !truncated ? caption.trim() : text}
            {truncated && !expanded && <>{"… "}<button type="button" className="gf-phone-more" onClick={() => setExpanded(true)}>more</button></>}
          </p>
        </div>
      </div>
    </div>
    <figcaption className="gf-post-preview-meta">
      <div className="gf-grid-cover">
        {coverUrl ? <img src={coverUrl} alt="Cover as it appears on your profile grid" /> : <span>Cover</span>}
      </div>
      <div>
        <strong>Cover</strong>
        <small>{shareToFeed ? "Shows in Reels and the main feed" : "Shows in Reels only"}</small>
        {when && <small>{when}</small>}
      </div>
    </figcaption>
  </figure>;
}
