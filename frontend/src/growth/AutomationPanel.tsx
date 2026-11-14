import { useEffect, useRef, useState } from "react";
import { api, post, put } from "../api";
import type { FactoryState } from "../useFactory";
import type { Clip } from "../types";
import type { Workspace } from "./useCampaignWorkspace";
import { reviewPreview } from "./workspaceApi";
import "./automation.css";

type Row = Record<string, unknown> & { id: string };
type Post = {
  media_id: string;
  published_at: string;
  caption_excerpt: string;
  permalink: string | null;
};
type State = {
  health?: { status: string; message: string };
  policies: Row[];
  publications: Row[];
  snapshots: Row[];
  work: Row[];
  experiments: Row[];
};
const empty: State = {
  policies: [],
  publications: [],
  snapshots: [],
  work: [],
  experiments: [],
};
function rows(value: unknown): Row[] {
  if (
    !Array.isArray(value) ||
    value.some((v) => !v || typeof v !== "object" || typeof v.id !== "string")
  )
    throw new Error(
      "Saved learning data was incomplete. Refresh before changing anything.",
    );
  return value;
}
export function parseAutomationState(value: unknown): State {
  if (!value || typeof value !== "object")
    throw new Error("Learning state unavailable.");
  const obj = value as Record<string, unknown>;
  const result = {
    policies: rows(obj.policies),
    publications: rows(obj.publications),
    snapshots: rows(obj.snapshots),
    work: rows(obj.work),
    experiments: rows(obj.experiments),
  };
  for (const row of result.policies) {
    if (
      ![row.campaign_id, row.profile_id, row.account_id].every(
        (v) => typeof v === "string" && !!v,
      ) ||
      ![3, 6].includes(Number(row.cadence_days)) ||
      typeof row.enabled !== "boolean" ||
      typeof row.auto_drafts !== "boolean"
    )
      throw new Error(
        "Saved learning policy is incomplete. Refresh before changing anything.",
      );
  }
  for (const row of [
    ...result.work,
    ...result.publications,
    ...result.snapshots,
    ...result.experiments,
  ])
    if (typeof row.policy_id !== "string" || !row.policy_id)
      throw new Error("Saved learning scope is incomplete.");
  const health = obj.health;
  if (
    health &&
    typeof health === "object" &&
    "status" in health &&
    typeof health.status === "string" &&
    "message" in health &&
    typeof health.message === "string"
  )
    return {
      ...result,
      health: { status: health.status, message: health.message },
    };
  return result;
}
const text = (value: unknown) => (typeof value === "string" ? value : "");
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

type MemoryExperiment = {
  id: string;
  variable: string;
  before: string;
  after: string;
  status: string;
  demoHours: number | null;
  demo: boolean;
  measured: boolean;
  proposedVersionId: string;
};
type MemoryComparison = {
  experimentId: string;
  variable: string;
  caveat: string;
  metrics: {
    name: string;
    parent: number | null;
    variant: number | null;
    difference: number | null;
  }[];
};
export type LearningMemory = {
  posts: number;
  baseline: { name: string; median: number | null; known: number }[];
  experiments: MemoryExperiment[];
  comparisons: MemoryComparison[];
  pending: { id: string; version: number | null; experimentId: string }[];
  truncated: boolean;
};
const shown = (value: unknown) =>
  typeof value === "number"
    ? `${value.toLocaleString()}s`
    : `“${text(value).slice(0, 120)}”`;
/** Accepts only the bounded digest shape; anything else means "unavailable". */
export function parseLearningMemory(value: unknown): LearningMemory | null {
  const digest = record(value);
  const baseline = record(digest?.baseline);
  const metrics = record(baseline?.metrics);
  if (
    !digest ||
    !baseline ||
    !metrics ||
    !Array.isArray(digest.experiments) ||
    !Array.isArray(digest.comparisons)
  )
    return null;
  return {
    posts: finite(baseline.posts) ?? 0,
    baseline: Object.entries(metrics)
      .slice(0, 12)
      .map(([name, raw]) => {
        const row = record(raw);
        return {
          name,
          median: finite(row?.median),
          known: finite(row?.known_posts) ?? 0,
        };
      }),
    experiments: digest.experiments
      .map(record)
      .filter((row): row is Record<string, unknown> => !!row && !!text(row.id))
      .slice(0, 6)
      .map((row) => ({
        id: text(row.id),
        variable: text(row.variable),
        before: shown(row.before),
        after: shown(row.after),
        status: text(row.status).replaceAll("_", " "),
        demo: row.trigger === "demo_override",
        demoHours: finite(row.real_elapsed_hours),
        measured: !!record(row.outcome),
        proposedVersionId: text(row.proposed_strategy_version_id),
      })),
    comparisons: digest.comparisons
      .map(record)
      .filter((row): row is Record<string, unknown> => !!row)
      .slice(0, 6)
      .map((row) => ({
        experimentId: text(row.experiment_id),
        variable: text(row.variable),
        caveat: text(row.caveat),
        metrics: Object.entries(record(row.metrics) ?? {})
          .slice(0, 12)
          .map(([name, raw]) => {
            const m = record(raw);
            return {
              name,
              parent: finite(m?.parent),
              variant: finite(m?.variant),
              difference: finite(m?.difference),
            };
          }),
      })),
    pending: (Array.isArray(digest.pending_rule_proposals)
      ? digest.pending_rule_proposals
      : []
    )
      .map(record)
      .filter((row): row is Record<string, unknown> => !!row && !!text(row.id))
      .slice(0, 5)
      .map((row) => ({
        id: text(row.id),
        version: finite(row.version),
        experimentId: text(row.experiment_id),
      })),
    truncated: digest.truncated === true,
  };
}
const number = (value: number | null) =>
  value === null ? "Unknown" : value.toLocaleString();
function DemoBadge({ row }: { row: Row }) {
  if (row.trigger !== "demo_override") return null;
  const hours = finite(row.real_elapsed_hours);
  return (
    <span className="gf-automation-badge">
      Demo override · measured{" "}
      {hours === null ? "before its window" : `${hours.toLocaleString()} h`}{" "}
      after posting, not {String(row.cadence_days ?? "3–6")} days
    </span>
  );
}

export function parseInstagramPosts(value: unknown, accountId: string): Post[] {
  if (!value || typeof value !== "object")
    throw new Error("Post list unavailable.");
  const result = value as Record<string, unknown>;
  if (
    result.connected_account_id !== accountId ||
    !Array.isArray(result.items) ||
    result.items.length > 6
  )
    throw new Error("Post list did not match the selected account.");
  const seen = new Set<string>();
  return result.items.map((item: unknown) => {
    if (!item || typeof item !== "object")
      throw new Error("Post data could not be verified.");
    const row = item as Record<string, unknown>;
    if (
      typeof row.media_id !== "string" ||
      !/^\d{1,100}$/.test(row.media_id) ||
      seen.has(row.media_id) ||
      typeof row.published_at !== "string" ||
      !Number.isFinite(Date.parse(row.published_at))
    )
      throw new Error("Post data could not be verified.");
    seen.add(row.media_id);
    let permalink = null;
    if (typeof row.permalink === "string") {
      try {
        const url = new URL(row.permalink);
        if (
          url.protocol === "https:" &&
          ["instagram.com", "www.instagram.com"].includes(url.hostname) &&
          !url.username &&
          !url.password &&
          !url.port &&
          /^\/(p|reel|tv)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
        )
          permalink = `${url.origin}${url.pathname}`;
      } catch {
        /* Display without an unverified optional link. */
      }
    }
    return {
      media_id: row.media_id,
      published_at: row.published_at,
      caption_excerpt: text(row.caption_excerpt).slice(0, 160),
      permalink,
    };
  });
}

export function AutomationPanel({
  w,
  factory,
  visible,
  onReview,
  onEditingRules,
}: {
  w: Workspace;
  factory: FactoryState;
  visible: boolean;
  onReview?: (clip: Clip) => void;
  onEditingRules?: () => void;
}) {
  const [state, setState] = useState<State>(empty),
    [accounts, setAccounts] = useState<Row[]>([]);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [memory, setMemory] = useState<LearningMemory | null>(null);
  const blocked = busy || !fresh;
  const [accountId, setAccountId] = useState(""),
    [cadence, setCadence] = useState<3 | 6>(3);
  const [authConfig, setAuthConfig] = useState(""),
    [key, setKey] = useState("");
  const [existingAccount, setExistingAccount] = useState("");
  const [configured, setConfigured] = useState(false);
  const [posts, setPosts] = useState<Post[]>([]),
    [postAccount, setPostAccount] = useState(""),
    [postLimits, setPostLimits] = useState("");
  const [link, setLink] = useState(""),
    [intent, setIntent] = useState("");
  const [clipId, setClipId] = useState(""),
    [mediaId, setMediaId] = useState(""),
    [confirmedMapping, setConfirmedMapping] = useState(false);
  const lock = useRef(false),
    alive = useRef(true);
  const refreshGeneration = useRef(0);
  const scoped = (row: Row) =>
    row.campaign_id === w.campaign?.id && row.profile_id === w.profileId;
  const policies = state.policies.filter(scoped),
    selectedAccounts = accounts.filter(
      (a) => a.profile_id === w.profileId && a.status === "active",
    );
  const policy = policies.find((p) => p.account_id === accountId);
  const clips = factory.data.clips.filter(
    (c) =>
      c.campaign_id === w.campaign?.id &&
      c.profile_id === w.profileId &&
      c.approved &&
      !!c.sha256,
  );
  const selectedClip = clips.find((c) => c.id === clipId);
  const policyIds = new Set(policies.map((p) => p.id));
  const work = state.work.filter((row) => policyIds.has(text(row.policy_id))),
    experiments = state.experiments.filter(scoped);
  const publications = state.publications.filter((row) =>
    policyIds.has(text(row.policy_id)),
  );
  const snapshots = state.snapshots.filter((row) =>
    policyIds.has(text(row.policy_id)),
  );

  useEffect(() => {
    setPosts([]);
    setPostAccount("");
    setMediaId("");
    setConfirmedMapping(false);
  }, [accountId, w.profileId]);

  async function refresh() {
    if (!alive.current) return;
    const generation = ++refreshGeneration.current;
    setFresh(false);
    const response = await Promise.all([
      api<unknown>("/api/automation/state"),
      api<unknown>("/api/automation/accounts"),
      api<Record<string, unknown>>("/api/automation/settings"),
    ]).catch((error) => {
      if (!alive.current || generation !== refreshGeneration.current)
        return null;
      throw error;
    });
    if (!response || !alive.current || generation !== refreshGeneration.current)
      return;
    const [next, linked, settings] = response;
    const parsed = parseAutomationState(next),
      checked = rows(linked);
    if (alive.current && generation === refreshGeneration.current) {
      setState(parsed);
      setAccounts(checked);
      setFresh(true);
      setConfigured(settings.configured === true);
      setAuthConfig((previous) => previous || text(settings.auth_config_id));
    }
    // Learning memory is supplementary: a failed read never blocks controls.
    if (!w.profileId) return;
    const query = new URLSearchParams({ profile_id: w.profileId });
    if (w.campaign?.id) query.set("campaign_id", w.campaign.id);
    const digest = await api<unknown>(
      `/api/automation/memory?${query.toString()}`,
    ).catch(() => null);
    if (alive.current && generation === refreshGeneration.current)
      setMemory(parseLearningMemory(digest));
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      refreshGeneration.current++;
    };
  }, []);
  useEffect(() => {
    if (!visible || reviewPreview) return;
    let current = true;
    const load = () => {
      if (current)
        void refresh().catch((e) => {
          if (current && alive.current)
            setError(e instanceof Error ? e.message : "Learning unavailable.");
        });
    };
    load();
    const timer = window.setInterval(load, 15000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [visible]);
  async function act(operation: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      await refresh();
    } catch (e) {
      const known =
        !!e &&
        typeof e === "object" &&
        "status" in e &&
        typeof e.status === "number" &&
        e.status >= 400 &&
        e.status < 500;
      if (alive.current)
        setError(
          (e instanceof Error ? e.message : "Request could not be confirmed.") +
            (known ? "" : " Refresh saved state before repeating a change."),
        );
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  if (reviewPreview)
    return (
      <section className="gf-automation">
        <span className="gf-kicker">The learning loop</span>
        <h2>Every result informs the next draft.</h2>
        <p>
          Connect accounts and collect real performance in the Mac app. This
          hosted design preview contains illustrative data.
        </p>
      </section>
    );
  return (
    <section className="gf-automation" aria-labelledby="automation-title">
      <div className="gf-automation-heading">
        <div>
          <span className="gf-kicker">The learning loop</span>
          <h2 id="automation-title">A better next draft. With receipts.</h2>
          <p>
            Real post metrics → one creative hypothesis → a new draft for your
            review.
          </p>
        </div>
        <span className="gf-automation-policy">
          Drafts run automatically · You approve publishing
        </span>
      </div>
      <ol className="gf-automation-steps">
        <li>
          <strong>Connect</strong>
          <span>Choose the exact Instagram account.</span>
        </li>
        <li>
          <strong>Observe</strong>
          <span>Check a post after 3 or 6 days.</span>
        </li>
        <li>
          <strong>Experiment</strong>
          <span>Change one opening or duration.</span>
        </li>
        <li>
          <strong>Review</strong>
          <span>Your new draft stays unpublished.</span>
        </li>
      </ol>
      {error && (
        <p role="alert" className="gf-automation-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {state.health?.status === "resource_hold" && (
        <p role="status" className="gf-automation-help">
          {state.health.message}
        </p>
      )}
      <div className="gf-automation-controls">
        <label>
          Instagram account
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            disabled={blocked}
          >
            <option value="">Choose a connected account</option>
            {selectedAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {text(a.display_name) || a.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Review performance after
          <select
            value={cadence}
            onChange={(e) => setCadence(Number(e.target.value) as 3 | 6)}
            disabled={blocked}
          >
            <option value={3}>3 days</option>
            <option value={6}>6 days</option>
          </select>
        </label>
        <button
          disabled={
            blocked ||
            !selectedAccounts.some((a) => a.id === accountId) ||
            !w.campaign
          }
          onClick={() =>
            void act(async () => {
              const body = {
                campaign_id: w.campaign!.id,
                profile_id: w.profileId,
                account_id: accountId,
                cadence_days: cadence,
                enabled: true,
                auto_drafts: true,
                allowed_changes: ["hook", "duration"],
              };
              if (policy)
                await put(
                  `/api/automation/policies/${encodeURIComponent(policy.id)}`,
                  body,
                );
              else await post("/api/automation/policies", body);
              setNotice(
                "Learning saved. It runs while the Mac app is open and catches up when you reopen it.",
              );
            })
          }
        >
          {policy?.enabled ? "Update learning" : "Start the loop"}
        </button>
        {policy?.enabled === true && (
          <button
            disabled={blocked}
            onClick={() =>
              void act(async () => {
                await put(
                  `/api/automation/policies/${encodeURIComponent(policy.id)}`,
                  {
                    campaign_id: policy.campaign_id,
                    profile_id: policy.profile_id,
                    account_id: policy.account_id,
                    cadence_days: policy.cadence_days,
                    allowed_changes: policy.allowed_changes,
                    auto_drafts: policy.auto_drafts,
                    enabled: false,
                  },
                );
                setNotice(
                  "Learning paused. Your evidence and drafts are saved.",
                );
              })
            }
          >
            Pause
          </button>
        )}
      </div>
      {!accountId && (
        <p className="gf-automation-help">
          {selectedAccounts.length
            ? "Choose your verified Instagram account to enable Start the loop."
            : "First save connection settings and verify an account below. Then Start the loop becomes available."}
        </p>
      )}
      <details open={selectedAccounts.length === 0 || undefined}>
        <summary>Connect an Instagram account</summary>
        <p>
          This is a one-time developer setup for the demo. Your API key stays in
          macOS Keychain. Once saved, choose a new sign-in or verify an account
          you already connected.
        </p>
        <div className="gf-automation-controls">
          <label>
            Auth Config ID (starts with ac_)
            <input
              value={authConfig}
              onChange={(e) => setAuthConfig(e.target.value)}
              placeholder="ac_…"
              autoComplete="off"
            />
          </label>
          <label>
            Composio project API key
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
            />
          </label>
          <button
            disabled={
              blocked || !authConfig.trim() || (!configured && !key.trim())
            }
            onClick={() =>
              void act(async () => {
                await put("/api/automation/settings", {
                  auth_config_id: authConfig.trim(),
                  ...(key ? { api_key: key } : {}),
                });
                setKey("");
                setConfigured(true);
                setNotice(
                  "Settings saved. Now verify an existing account below, or connect a new one.",
                );
              })
            }
          >
            Save connection settings
          </button>
          <button
            disabled={blocked || !configured || !w.profileId}
            onClick={() =>
              void act(async () => {
                const result = await post<Record<string, unknown>>(
                  "/api/automation/connections",
                  { profile_id: w.profileId },
                );
                const url = text(result.redirect_url);
                if (
                  !url.startsWith("https://") ||
                  !text(result.connected_account_id)
                )
                  throw new Error("Connection could not be verified.");
                setLink(url);
                setIntent(text(result.connected_account_id));
              })
            }
          >
            Connect this workspace
          </button>
        </div>
        {configured && (
          <p className="gf-automation-help">
            Connection settings are saved securely. You do not need to paste the
            API key again.
          </p>
        )}
        {!configured && (
          <p className="gf-automation-help">
            Save the Auth Config ID and project API key above before continuing.
          </p>
        )}
        <details>
          <summary>Already connected in Composio?</summary>
          <p>
            Paste the connected account ID (starts with ca_). We find the owner
            and verify the actual Instagram identity for you.
          </p>
          <div className="gf-automation-controls">
            <label>
              Connected account ID
              <input
                value={existingAccount}
                onChange={(e) => setExistingAccount(e.target.value)}
                placeholder="ca_…"
              />
            </label>
            <button
              disabled={blocked || !configured || !existingAccount.trim()}
              onClick={() =>
                void act(async () => {
                  const result = await post<Record<string, unknown>>(
                    "/api/automation/accounts/import",
                    {
                      profile_id: w.profileId,
                      connected_account_id: existingAccount.trim(),
                    },
                  );
                  if (result.id !== existingAccount.trim())
                    throw new Error(
                      "Account confirmation did not match your selection.",
                    );
                  setAccountId(text(result.id));
                  setNotice(
                    "Instagram account verified. Choose your review cadence and start the loop.",
                  );
                })
              }
            >
              Verify this Instagram account
            </button>
          </div>
        </details>
        {link && (
          <p>
            <a href={link} target="_blank" rel="noreferrer">
              Open secure Instagram sign-in ↗
            </a>{" "}
            <button
              disabled={blocked}
              onClick={() =>
                void act(async () => {
                  await post(
                    `/api/automation/connections/${encodeURIComponent(intent)}/verify`,
                  );
                  setLink("");
                  setIntent("");
                  setNotice(
                    "Account identity verified and connected to this workspace.",
                  );
                })
              }
            >
              I've signed in · Verify account
            </button>
          </p>
        )}
      </details>
      {!!selectedAccounts.length && (
        <details>
          <summary>Find a post from your Instagram account</summary>
          <p>
            Read your six most recent posts. These stay separate from learning
            evidence until you confirm a matching reviewed clip.
          </p>
          <button
            disabled={
              blocked || !selectedAccounts.some((a) => a.id === accountId)
            }
            onClick={() =>
              void act(async () => {
                const result = await api<Record<string, unknown>>(
                  `/api/automation/accounts/${encodeURIComponent(accountId)}/posts?profile_id=${encodeURIComponent(w.profileId)}`,
                );
                const items = parseInstagramPosts(result, accountId);
                if (!alive.current) return;
                setPosts(items);
                setPostAccount(accountId);
                setPostLimits(
                  "Only the most recent page is shown. No post has been mapped or analyzed yet.",
                );
                setNotice(
                  items.length
                    ? "Recent posts loaded. Open the post to confirm which footage it uses."
                    : "No usable recent posts were returned; older posts may still exist.",
                );
              })
            }
          >
            Find recent posts
          </button>
          {postAccount === accountId &&
            posts.map((item) => (
              <article className="gf-automation-post" key={item.media_id}>
                <strong>
                  {new Date(item.published_at).toLocaleDateString()}
                </strong>
                <p>{item.caption_excerpt || "Instagram post"}</p>
                {item.permalink && (
                  <a href={item.permalink} target="_blank" rel="noreferrer">
                    View on Instagram ↗
                  </a>
                )}{" "}
                <button
                  disabled={blocked}
                  onClick={() => {
                    setMediaId(item.media_id);
                    setConfirmedMapping(false);
                    setNotice(
                      "Post selected. Choose its matching approved clip below and confirm the mapping.",
                    );
                  }}
                >
                  Use this post
                </button>
              </article>
            ))}
          {postAccount === accountId && <p>{postLimits}</p>}
        </details>
      )}
      <details>
        <summary>Track an existing published clip</summary>
        <p>
          Choose an approved clip and its actual Instagram media ID. The
          collector verifies ownership and publication time. You confirm the
          clip mapping. This does not publish anything.
        </p>
        <div className="gf-automation-controls">
          <label>
            Approved clip
            <select
              value={clipId}
              onChange={(e) => {
                setClipId(e.target.value);
                setConfirmedMapping(false);
              }}
            >
              <option value="">Choose a reviewed clip</option>
              {clips.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.hook || c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Selected post ID
            <input
              inputMode="numeric"
              value={mediaId}
              onChange={(e) => {
                setMediaId(e.target.value);
                setConfirmedMapping(false);
              }}
            />
          </label>
          <label className="gf-automation-confirm">
            <input
              type="checkbox"
              checked={confirmedMapping}
              onChange={(e) => setConfirmedMapping(e.target.checked)}
            />
            This post uses this exact clip
          </label>
          <button
            disabled={
              blocked ||
              !policy ||
              !selectedClip ||
              !/^\d+$/.test(mediaId) ||
              !confirmedMapping
            }
            onClick={() =>
              void act(async () => {
                await post("/api/automation/publications", {
                  policy_id: policy!.id,
                  clip_id: selectedClip!.id,
                  account_id: accountId,
                  media_id: mediaId,
                  confirmed_clip_mapping: true,
                  sha256: selectedClip!.sha256,
                });
                setNotice(
                  "Post tracked. Its measurement window starts at the provider's publication time.",
                );
              })
            }
          >
            Track this post
          </button>
        </div>
      </details>
      <div className="gf-automation-ledger">
        <div>
          <h3>Upcoming checks</h3>
          {!publications.length && (
            <p>No published posts tracked for this workspace yet.</p>
          )}
          {publications.slice(0, 6).map((row) => {
            const due = Date.parse(text(row.next_due_at));
            const owner = policies.find((p) => p.id === row.policy_id);
            const override = record(row.demo_override);
            const busyHere = work.some(
              (item) =>
                item.publication_id === row.id &&
                ["running", "retry", "queued", "needs_reconciliation"].includes(
                  text(item.status),
                ),
            );
            return (
              <article key={row.id}>
                <strong>Post {text(row.media_id)}</strong>
                <span>
                  Next check: {new Date(text(row.next_due_at)).toLocaleString()}
                </span>
                {override && text(override.due_at) === text(row.next_due_at) && (
                  <span className="gf-automation-badge">
                    Demo measurement requested ·{" "}
                    {String(override.real_elapsed_hours)} h after posting
                  </span>
                )}
                {Number.isFinite(due) &&
                  due > Date.now() &&
                  owner?.enabled === true &&
                  !busyHere &&
                  !!text(row.mapping_source) && (
                    <button
                      disabled={blocked}
                      onClick={() =>
                        void act(async () => {
                          const result = await post<Record<string, unknown>>(
                            `/api/automation/publications/${encodeURIComponent(row.id)}/measure-now`,
                          );
                          const hours = finite(result.real_elapsed_hours);
                          setNotice(
                            result.status === "requested"
                              ? `Demo override: measuring ${hours ?? "?"} hours after posting instead of waiting for the ${String(owner.cadence_days)}-day window. Metrics are real provider reads and every result is labelled.`
                              : "This check was already due; it runs on its normal schedule.",
                          );
                        })
                      }
                    >
                      Measure now (demo — window not elapsed)
                    </button>
                  )}
              </article>
            );
          })}
          {work.slice(0, 6).map((row) => (
            <article key={row.id}>
              <strong>{text(row.status).replaceAll("_", " ")}</strong>
              <span>
                {text(row.due_at)
                  ? new Date(text(row.due_at)).toLocaleString()
                  : text(row.message) || "Saved measurement work"}
              </span>
              <small>{text(row.detail) || text(row.error)}</small>
              <DemoBadge row={{ ...row, cadence_days: policies.find((p) => p.id === row.policy_id)?.cadence_days }} />
            </article>
          ))}
        </div>
        <div>
          <h3>What the factory is testing</h3>
          {!experiments.length && (
            <p>
              No experiment yet. A quality score alone cannot establish audience
              growth.
            </p>
          )}
          {experiments.slice(0, 6).map((row) => (
            <article key={row.id}>
              <strong>
                {text(row.variable) || "Creative experiment"} ·{" "}
                {text(row.status).replaceAll("_", " ")}
              </strong>
              <DemoBadge row={{ ...row, cadence_days: policies.find((p) => p.id === row.policy_id)?.cadence_days }} />
              <p>{text(row.rationale)}</p>
              <small>{text(row.limitations)}</small>
              {record(row.strategy_proposal)?.status === "proposed" && (
                <span className="gf-automation-badge">
                  Editing rule proposed · waiting for your approval
                </span>
              )}
              <details>
                <summary>Evidence & execution receipt</summary>
                <pre>{JSON.stringify(row, null, 2)}</pre>
              </details>
            </article>
          ))}
        </div>
      </div>
      <section
        className="gf-automation-learned"
        aria-labelledby="automation-learned-title"
      >
        <h3 id="automation-learned-title">What we've learned</h3>
        {!memory && <p>Learning memory is unavailable right now.</p>}
        {memory &&
          !memory.posts &&
          !memory.experiments.length &&
          !memory.pending.length && (
            <p>
              Nothing measured yet. Track a published clip; its first real
              check builds the baseline.
            </p>
          )}
        {memory && memory.posts > 0 && (
          <div>
            <strong>
              Account baseline · median of {memory.posts} tracked post
              {memory.posts === 1 ? "" : "s"} (latest read each)
            </strong>
            <dl className="gf-automation-metrics">
              {memory.baseline.map((m) => (
                <div key={m.name}>
                  <dt>{m.name.replaceAll("_", " ")}</dt>
                  <dd>{number(m.median)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {memory?.experiments.map((e) => (
          <article key={e.id}>
            <strong>
              {e.variable} · {e.status}
            </strong>
            <span>
              {e.before} → {e.after}
            </span>
            {e.demo && (
              <span className="gf-automation-badge">
                Demo override ·{" "}
                {e.demoHours === null ? "early" : `${e.demoHours} h`} after
                posting
              </span>
            )}
            <small>
              {e.measured
                ? "Its draft was published and measured."
                : "Its draft has not been measured as a post yet."}
            </small>
          </article>
        ))}
        {memory?.comparisons.map((c) => (
          <article key={`comparison-${c.experimentId}`}>
            <strong>Observational comparison · {c.variable}</strong>
            <dl className="gf-automation-metrics">
              {c.metrics.map((m) => (
                <div key={m.name}>
                  <dt>{m.name.replaceAll("_", " ")}</dt>
                  <dd>
                    {number(m.parent)} → {number(m.variant)}
                    {m.difference !== null &&
                      ` (${m.difference > 0 ? "+" : ""}${m.difference.toLocaleString()})`}
                  </dd>
                </div>
              ))}
            </dl>
            <small>{c.caveat}</small>
          </article>
        ))}
        {memory?.pending.map((p) => (
          <p key={p.id} className="gf-automation-help">
            Proposed editing rule{p.version !== null ? ` v${p.version}` : ""} is
            waiting for your approval. Nothing changes until you approve it.{" "}
            {onEditingRules && (
              <button onClick={onEditingRules}>Review in Style rules</button>
            )}
          </p>
        ))}
        {memory?.truncated && (
          <small>Older learning is summarized; the full record is saved.</small>
        )}
      </section>
      {!!snapshots.length && (
        <details>
          <summary>
            Observed metrics · {snapshots.length} saved snapshots
          </summary>
          {snapshots.slice(0, 6).map((row) => (
            <article key={row.id}>
              <strong>{text(row.source)}</strong>
              <DemoBadge row={{ ...row, cadence_days: policies.find((p) => p.id === row.policy_id)?.cadence_days }} />
              <p>
                Collected {new Date(text(row.collected_at)).toLocaleString()} ·
                cumulative counts, never summed
              </p>
              <dl className="gf-automation-metrics">
                {row.metrics &&
                typeof row.metrics === "object" &&
                !Array.isArray(row.metrics) ? (
                  Object.entries(row.metrics).map(([metric, value]) => (
                    <div key={metric}>
                      <dt>{metric.replaceAll("_", " ")}</dt>
                      <dd>
                        {typeof value === "number" && Number.isFinite(value)
                          ? value.toLocaleString()
                          : "Unavailable"}
                      </dd>
                    </div>
                  ))
                ) : (
                  <p>Metric detail unavailable.</p>
                )}
              </dl>
            </article>
          ))}
        </details>
      )}
      {onReview &&
        experiments.some((row) => typeof row.clip_id === "string") && (
          <div className="gf-automation-drafts">
            {experiments.map((row) => {
              const clip = factory.data.clips.find(
                (c) =>
                  c.id === row.clip_id &&
                  c.campaign_id === w.campaign?.id &&
                  c.profile_id === w.profileId,
              );
              return clip ? (
                <button key={row.id} onClick={() => onReview(clip)}>
                  Review draft · {clip.hook || clip.name}
                </button>
              ) : null;
            })}
          </div>
        )}
      <div className="gf-automation-footer">
        <p>
          Observational evidence guides a test; it does not prove lift. Paid
          spending is off.
        </p>
        <button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await refresh();
              setNotice("Saved state refreshed.");
            })
          }
        >
          Refresh
        </button>
        <button
          disabled={blocked}
          onClick={() =>
            void act(async () => {
              await post("/api/automation/check");
              setNotice(
                "Checking work that is due. Future windows stay scheduled.",
              );
            })
          }
        >
          Check due work
        </button>
      </div>
    </section>
  );
}
