import { useEffect, useState } from "react";
import { api, post } from "../api";
import type {
  AdAccount,
  AdAccounts,
  AdInsights,
  Clip,
  InstagramStatus,
  Job,
  Settings,
} from "../types";
import type { FactoryState } from "../useFactory";
import { isPublicHttps } from "../urlSafety";
import { Badge, Empty, Field, ReadOnlyValue, Section, Unknown } from "./ui";
export function connectedAccountId(
  status: InstagramStatus | null,
): string | null {
  const account = status?.account;
  return status?.connected === true &&
    account &&
    typeof account === "object" &&
    "id" in account &&
    typeof account.id === "string" &&
    account.id
    ? account.id
    : null;
}
export function ownedPublishedReel(
  clip: Clip,
  status: InstagramStatus | null,
): boolean {
  const account = connectedAccountId(status);
  return (
    !!account &&
    clip.status === "published" &&
    !!clip.instagram_media_id &&
    clip.instagram_account_id === account
  );
}
export function adsPreflightGate(
  clip: Clip | undefined,
  account: AdAccount | undefined,
  settings: Settings | null,
  status: InstagramStatus | null,
  stale = false,
): string[] {
  const reasons: string[] = [];
  if (stale)
    reasons.push("Refresh connection, clips, and settings before preflight.");
  if (!clip || !ownedPublishedReel(clip, status))
    reasons.push(
      "Choose a published Reel owned by the connected Instagram account.",
    );
  if (!account)
    reasons.push("Fetch accessible ad accounts and choose an account.");
  else if (account.currency !== "USD")
    reasons.push(
      "USD budget preflight requires an account reporting currency USD.",
    );
  if (settings?.ads_enabled !== true)
    reasons.push("Explicitly enable the ads opt-in in Settings for preflight.");
  if (
    typeof settings?.total_budget !== "number" ||
    !Number.isFinite(settings.total_budget) ||
    settings.total_budget <= 0
  )
    reasons.push("Set a positive total budget (USD) in Settings.");
  return reasons;
}
export function validatePreflightBudget(
  amount: string,
  days: string,
  total: number,
): string | null {
  if (
    !/^\d+$/.test(amount) ||
    !Number.isSafeInteger(Number(amount)) ||
    Number(amount) <= 0
  )
    return "Lifetime budget must be a positive whole number of USD cents.";
  if (!Number.isFinite(total) || total <= 0 || Number(amount) / 100 > total)
    return "Lifetime budget exceeds the total budget configured in Settings.";
  if (
    !/^\d+$/.test(days) ||
    !Number.isSafeInteger(Number(days)) ||
    Number(days) < 1
  )
    return "Duration must be a positive whole number of days.";
  return null;
}
export function PaidInsights({ insights }: { insights: AdInsights }) {
  const objectRows = insights.rows.filter(
    (row): row is Record<string, unknown> =>
      !!row && typeof row === "object" && !Array.isArray(row),
  );
  const columns = Array.from(
    new Set(objectRows.flatMap((row) => Object.keys(row))),
  );
  return (
    <>
      <dl className="info-list">
        <div>
          <dt>Source</dt>
          <dd>
            <ReadOnlyValue value={insights.source} />
          </dd>
        </div>
        <div>
          <dt>Attribution</dt>
          <dd>
            <ReadOnlyValue value={insights.attribution} />
          </dd>
        </div>
      </dl>
      {insights.note && <p className="muted">{insights.note}</p>}
      <p className="muted">
        Paid ad-account observations are shown separately. Ad IDs are never
        guessed to correspond to local clips; these rows are not merged into
        media insights.
      </p>
      {!insights.rows.length ? (
        <Empty title="No paid insight rows reported">
          No zeroes or campaign performance are inferred from an empty response.
        </Empty>
      ) : objectRows.length === insights.rows.length && columns.length ? (
        <div className="paid-table-wrap">
          <table className="paid-table">
            <caption className="visually-hidden">
              Reported paid ad-account insights, without clip attribution
            </caption>
            <thead>
              <tr>
                {columns.map((key) => (
                  <th key={key} scope="col">
                    {key.replaceAll("_", " ")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {objectRows.map((row, index) => (
                <tr key={index}>
                  {columns.map((key) => (
                    <td key={key}>
                      {typeof row[key] === "number" ? (
                        <Unknown value={row[key]} />
                      ) : (
                        <ReadOnlyValue value={row[key]} />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ReadOnlyValue value={insights.rows} />
      )}
    </>
  );
}
export function PaidSetup({ state }: { state: FactoryState }) {
  const [accounts, setAccounts] = useState<AdAccounts | null>(null);
  const [accountsFor, setAccountsFor] = useState<string | null>(null);
  const [accountId, setAccountId] = useState("");
  const [insights, setInsights] = useState<AdInsights | null>(null);
  const [insightsFor, setInsightsFor] = useState("");
  const [clipId, setClipId] = useState("");
  const [destination, setDestination] = useState("");
  const [budget, setBudget] = useState("");
  const [days, setDays] = useState("7");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [syncJobId, setSyncJobId] = useState("");
  const [preflightJobId, setPreflightJobId] = useState("");
  const ownerId = connectedAccountId(state.data.instagram);
  useEffect(() => {
    setAccounts(null);
    setAccountsFor(null);
    setAccountId("");
    setInsights(null);
    setInsightsFor("");
    setClipId("");
    setSyncJobId("");
    setPreflightJobId("");
  }, [ownerId]);
  const currentAccounts = accountsFor === ownerId ? accounts : null;
  const selectedAccount = currentAccounts?.accounts.find(
    (account) => account.id === accountId,
  );
  const selectedClip = state.data.clips.find((clip) => clip.id === clipId);
  const eligibleClips = state.data.clips.filter((clip) =>
    ownedPublishedReel(clip, state.data.instagram),
  );
  const readReady = !!ownerId && !state.errors.instagram;
  const gate = adsPreflightGate(
    selectedClip,
    selectedAccount,
    state.data.settings,
    state.data.instagram,
    !!(state.errors.instagram || state.errors.clips || state.errors.settings),
  );
  const syncJob = state.data.jobs.find((job) => job.id === syncJobId);
  const preflightJob = state.data.jobs.find((job) => job.id === preflightJobId);
  const currentInsights =
    insightsFor === `${ownerId}:${accountId}` ? insights : null;
  async function fetchAccounts() {
    setAccounts(null);
    setAccountId("");
    setInsights(null);
    await state.run(async () => {
      const response = await api<AdAccounts>("/api/ads/accounts");
      if (
        !response ||
        !Array.isArray(response.accounts) ||
        response.accounts.some(
          (account) =>
            !account ||
            typeof account !== "object" ||
            typeof account.id !== "string",
        )
      )
        throw new Error("Invalid accessible ad accounts response.");
      setAccounts(response);
      setAccountsFor(ownerId);
    }, "Accessible ad accounts fetched. This is a read-only request; no campaigns are created.");
  }
  async function refreshInsights() {
    setInsights(null);
    await state.run(async () => {
      const response = await api<AdInsights>("/api/ads/insights");
      if (!response || !Array.isArray(response.rows))
        throw new Error("Invalid paid insights response.");
      setInsights(response);
      setInsightsFor(`${ownerId}:${accountId}`);
    }, "Stored paid insight rows refreshed. No live Meta polling or clip attribution was performed.");
  }
  async function preflight(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (gate.length) return;
    const budgetError = validatePreflightBudget(
      budget,
      days,
      state.data.settings?.total_budget ?? NaN,
    );
    if (budgetError) {
      setError(budgetError);
      return;
    }
    if (!isPublicHttps(destination)) {
      setError("Use a publicly reachable HTTPS destination URL.");
      return;
    }
    if (!name.trim()) {
      setError("Enter a preflight name.");
      return;
    }
    await state.run(async () => {
      const job = await post<Job>("/api/ads/preflight", {
        clip_id: clipId,
        ad_account_id: accountId,
        destination_url: destination.trim(),
        lifetime_budget_minor: Number(budget),
        duration_days: Number(days),
        name: name.trim(),
      });
      setPreflightJobId(job.id);
    }, "Validation-only ads preflight queued. It cannot create or activate ads and does not spend money.");
  }
  return (
    <>
      <Section
        title="Paid setup · read-only"
        detail="Additional ads_read permission and actual ad-account access are required"
      >
        <div className="banner">
          <strong>
            Ad creation/activation unavailable; manage campaigns in Meta Ads
            Manager.
          </strong>
        </div>
        <p className="muted">
          Connecting Instagram alone does not grant ads_read. Fetch accounts
          deliberately, select an accessible account, and request a real
          read-only sync. Meta ads endpoints are never polled automatically.
        </p>
        <button
          disabled={state.busy || !readReady}
          onClick={() => void fetchAccounts()}
        >
          Fetch accessible ad accounts
        </button>
        {currentAccounts && (
          <>
            <p className="muted narration-empty">
              {currentAccounts.note ||
                "No additional account capability note was reported."}
            </p>
            <p className="muted">
              Reported support flag:{" "}
              <ReadOnlyValue value={currentAccounts.supported} />. This does not
              enable creation or activation.
            </p>
            {!currentAccounts.accounts.length ? (
              <Empty title="No accessible ad accounts reported">
                Check ads_read permissions and account access in Meta.
              </Empty>
            ) : (
              <Field label="Accessible ad account">
                <select
                  value={accountId}
                  onChange={(event) => {
                    setAccountId(event.target.value);
                    setInsights(null);
                    setPreflightJobId("");
                  }}
                >
                  <option value="">Choose an accessible account</option>
                  {currentAccounts.accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name || account.id} ·{" "}
                      {account.currency || "Unknown currency"} · {account.id}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </>
        )}
        {selectedAccount && (
          <details>
            <summary>Reported account details (read-only)</summary>
            <ReadOnlyValue value={selectedAccount} />
          </details>
        )}
        <div className="actions">
          <button
            className="secondary"
            disabled={state.busy || !readReady || !selectedAccount}
            onClick={() =>
              void state.run(async () => {
                const job = await post<Job>("/api/ads/sync", {
                  ad_account_id: accountId,
                });
                setSyncJobId(job.id);
              }, "Read-only paid insights sync queued. Refresh stored rows explicitly after the job completes.")
            }
          >
            Sync paid insights
          </button>
          <button
            className="secondary"
            disabled={state.busy || !readReady || !selectedAccount}
            onClick={() => void refreshInsights()}
          >
            Refresh stored paid insights
          </button>
        </div>
        {syncJob && (
          <div className="inference-output">
            <Badge tone={syncJob.status === "failed" ? "danger" : ""}>
              {syncJob.status}
            </Badge>
            {syncJob.error && (
              <p role="alert" className="error-text">
                {syncJob.error}
              </p>
            )}
            {syncJob.result && <ReadOnlyValue value={syncJob.result} />}
          </div>
        )}
        {currentInsights && <PaidInsights insights={currentInsights} />}
      </Section>
      <Section
        title="Optional ads preflight · validation only"
        detail="Published owned Reel · explicit opt-in · budget guardrails · no spend"
      >
        <form onSubmit={(event) => void preflight(event)}>
          <div className="form-grid">
            <Field label="Published owned Reel">
              <select
                value={clipId}
                onChange={(event) => setClipId(event.target.value)}
              >
                <option value="">Choose a published owned Reel</option>
                {eligibleClips.map((clip) => (
                  <option key={clip.id} value={clip.id}>
                    {clip.name} · {clip.instagram_media_id}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Preflight name">
              <input
                required
                maxLength={200}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="Destination HTTPS URL">
              <input
                required
                type="url"
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
              />
            </Field>
            <Field
              label="Lifetime budget (USD cents)"
              hint="Whole cents: 100 = USD $1.00. Cannot exceed the total budget in Settings, which is expressed in USD."
            >
              <input
                required
                type="number"
                min="1"
                step="1"
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
              />
            </Field>
            <Field label="Duration (days)">
              <input
                required
                type="number"
                min="1"
                step="1"
                value={days}
                onChange={(event) => setDays(event.target.value)}
              />
            </Field>
          </div>
          <p className="muted">
            Configured total budget:{" "}
            <Unknown value={state.data.settings?.total_budget} suffix=" USD" />.
            Preflight validates only; it cannot create or activate ads
            (can_create: false).
          </p>
          {gate.length > 0 && (
            <ul className="gate-list">
              {gate.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          <button disabled={state.busy || gate.length > 0}>
            Validate ads preflight (no spend)
          </button>
        </form>
        {preflightJob && (
          <div className="inference-output">
            <Badge tone={preflightJob.status === "failed" ? "danger" : ""}>
              {preflightJob.status}
            </Badge>
            {preflightJob.error && (
              <p className="error-text" role="alert">
                {preflightJob.error}
              </p>
            )}
            {preflightJob.result && (
              <>
                <p className="muted">
                  Reported validation result — not a campaign or spend
                  confirmation.
                </p>
                <ReadOnlyValue value={preflightJob.result} />
                {preflightJob.result.can_create !== false && (
                  <p role="alert" className="error-text">
                    Unexpected creation capability in the response. Ad
                    creation/activation remains unavailable in this app.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </Section>
    </>
  );
}
