import { useEffect, useState } from "react";
import { ConnectedAccounts } from "./ConnectedAccounts";
import { Icon } from "./Icon";
import { postingApi, type PostingAccount } from "./publishApi";

// Kept from the Instagram-only step so a brand that already skipped it stays skipped.
const skipKey = (profileId: string) => `gf-first-run-instagram:${profileId}`;
const nameOf = (a: PostingAccount) => a.display_name || a.username || a.id;

/**
 * Optional first-run step on Factory: connect this brand's social accounts (it needs the saved
 * brand, so it follows onboarding). Skippable and remembered per brand. There is no baseline
 * until clips are posted and measured, so the connected state says so honestly.
 */
export function FirstRunAccounts({ profileId }: { profileId: string }) {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(skipKey(profileId)) === "1";
    } catch {
      return false;
    }
  });
  const [connected, setConnected] = useState<PostingAccount | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (hidden) return;
    let live = true;
    postingApi.accounts().catch(() => [] as PostingAccount[]).then((rows) => {
      if (!live) return;
      setConnected(rows.find((a) => a.profile_id === profileId && a.status === "active") ?? null);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [profileId, hidden]);

  if (hidden || !loaded) return null;
  function skip() {
    try {
      localStorage.setItem(skipKey(profileId), "1");
    } catch {
      /* preference only */
    }
    setHidden(true);
  }
  return (
    <section className="gf-first-instagram gf-card" aria-label="Connect your accounts">
      <div className="gf-first-instagram-head">
        <span className="gf-first-instagram-icon" aria-hidden="true">
          <Icon name="link" size={18} />
        </span>
        <div>
          <h2>Connect your accounts <small>Optional</small></h2>
          <p>So posting is one click and results flow back on their own.</p>
        </div>
        <button type="button" className="gf-button ghost compact" onClick={skip}>
          {connected ? "Done" : "Not now"}
        </button>
      </div>
      {connected ? (
        <p className="gf-first-instagram-baseline" role="status">
          <Icon name="check" size={14} />
          Connected {nameOf(connected)} on {connected.platform_label || connected.platform}. Allow posting
          for it in Settings when you are ready. Your typical post baseline appears after your first
          clips are posted and measured.
        </p>
      ) : (
        <ConnectedAccounts profileId={profileId} onConnected={(account) => setConnected(account)} />
      )}
    </section>
  );
}
