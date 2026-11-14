import { useState } from "react";
import "./post-preview.css";

/** Instagram shows about two lines (~125 characters) before "… more" in the feed. */
export const FEED_PREVIEW_CHARS = 125;
/** The Reels overlay is narrower: about two short lines before "… more". */
export const REELS_PREVIEW_CHARS = 48;

export function truncateForFeed(caption: string, max = FEED_PREVIEW_CHARS): { text: string; truncated: boolean } {
  const text = caption.trim();
  const lines = text.split("\n");
  let cut = lines.slice(0, 2).join("\n");
  if (cut.length > max) cut = cut.slice(0, max).replace(/\s+\S*$/, "");
  const truncated = cut.length < text.length;
  return { text: truncated ? cut.trimEnd() : text, truncated };
}

const reducedMotion = () => typeof window !== "undefined" && typeof window.matchMedia === "function"
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Neutral line glyphs (not any platform's marks) for the Reels-style chrome. */
const glyphs = {
  camera: <><rect x="3" y="7" width="18" height="13" rx="3" /><path d="M8.5 7 10 4.5h4L15.5 7" /><circle cx="12" cy="13.5" r="3.5" /></>,
  like: <path d="M12 20s-7.5-4.6-7.5-10A4.2 4.2 0 0 1 12 7.6 4.2 4.2 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10Z" />,
  comment: <path d="M20 12a8 8 0 1 1-3.2-6.4A8 8 0 0 1 20 12Zm0 0v8l-3.5-2.6" />,
  share: <path d="m21 4-9.5 9.5M21 4l-6 16-3.5-6.5L5 10Z" />,
  save: <path d="M6.5 4h11v16L12 15.5 6.5 20Z" />,
  more: <><circle cx="5.5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="18.5" cy="12" r="1" /></>,
  audio: <><path d="M9 18V6l10-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="16" r="2.5" /></>,
};
function Glyph({ name, size = 20 }: { name: keyof typeof glyphs; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{glyphs[name]}</svg>;
}

/** Visual preview chrome only: these never trigger platform actions or imply engagement. */
export function ReelsActionRail() {
  return <ul className="gf-reels-rail" aria-hidden="true">
    {(["like", "comment", "share", "save", "more"] as const).map(name => <li key={name}><Glyph name={name} /></li>)}
  </ul>;
}

/**
 * A neutral 9:16 phone mock of the post as a Reels screen: the clip itself (captions are burned
 * into the video) playing muted over its cover, the top bar, a decorative action rail,
 * the account handle with a Follow pill, the caption as the feed shows it, and the
 * audio line. Not a copy of Instagram's interface or marks; it shows what goes out.
 * With reduced motion the clip starts paused on its cover; a tap plays it.
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
  const [playing, setPlaying] = useState(() => !reducedMotion());
  const { text, truncated } = truncateForFeed(caption, REELS_PREVIEW_CHARS);
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
        <div className="gf-reels-top" aria-hidden="true"><strong>Reels</strong><Glyph name="camera" size={18} /></div>
        <ReelsActionRail />
        <div className="gf-phone-overlay">
          <div className="gf-phone-account">
            <span className="gf-phone-avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
            <strong>{name}</strong>
            <span className="gf-reels-follow" aria-hidden="true">Follow</span>
          </div>
          <p className="gf-phone-caption" data-testid="preview-caption">
            {expanded || !truncated ? caption.trim() : text}
            {truncated && !expanded && <>{"… "}<button type="button" className="gf-phone-more" onClick={() => setExpanded(true)}>more</button></>}
          </p>
          <p className="gf-reels-audio" aria-hidden="true"><Glyph name="audio" size={12} /><span>Original audio</span></p>
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
