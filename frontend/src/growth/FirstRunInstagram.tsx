import { useEffect, useState } from "react";
import { api } from "../api";
import { ConnectInstagram } from "./ConnectInstagram";
import { Icon } from "./Icon";

const skipKey = (profileId: string) => `gf-first-run-instagram:${profileId}`;

type Account = { id?: unknown; profile_id?: unknown; status?: unknown; display_name?: unknown };

/**
 * Optional first-run step on Factory: connect Instagram for this brand (it needs the
 * saved brand, so it follows onboarding). Skippable and remembered per brand.
 * The current read APIs return posts without view or like counts, so the baseline
 * is an honest empty state until clips are posted and measured.
 */
export function FirstRunInstagram({ profileId }: { profileId: string }) {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(skipKey(profileId)) === "1";
    } catch {
      return false;
    }
  });
  const [configured, setConfigured] = useState(false);
  const [handle, setHandle] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (hidden) return;
    let live = true;
    Promise.all([
      api<Record<string, unknown>>("/api/automation/settings").catch(() => null),
      api<unknown>("/api/automation/accounts").catch(() => null),
    ]).then(([settings, accounts]) => {
      if (!live) return;
      setConfigured(settings?.configured === true);
      const mine = Array.isArray(accounts)
        ? (accounts as Account[]).find(
            (a) => a.profile_id === profileId && a.status === "active",
          )
        : undefined;
      if (mine)
        setHandle(
          typeof mine.display_name === "string" && mine.display_name
            ? mine.display_name
            : String(mine.id ?? "connected"),
        );
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
    <section className="gf-first-instagram gf-card" aria-label="Connect Instagram">
      <div className="gf-first-instagram-head">
        <span className="gf-first-instagram-icon" aria-hidden="true">
          <Icon name="link" size={18} />
        </span>
        <div>
          <h2>Connect Instagram <small>Optional</small></h2>
          <p>So posting is one click and results flow back on their own.</p>
        </div>
        <button type="button" className="gf-button ghost compact" onClick={skip}>
          {handle ? "Done" : "Not now"}
        </button>
      </div>
      {handle ? (
        <p className="gf-first-instagram-baseline" role="status">
          <Icon name="check" size={14} />
          Connected @{handle}. Your typical post baseline appears after your
          first clips are posted and measured.
        </p>
      ) : (
        <ConnectInstagram
          profileId={profileId}
          ready={configured}
          disabled={false}
          onConnected={(id) => setHandle(id)}
        />
      )}
    </section>
  );
}
