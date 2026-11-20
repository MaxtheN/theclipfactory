import { useEffect, useState, useSyncExternalStore } from "react";
import { ApiError, PLAN_LIMIT_EVENT } from "../api";
import { CLOUD_CHANGED } from "./appEvents";
import {
  billingApi,
  type BillingInterval,
  type BillingLink,
  type BillingState,
  type Plan,
  type PlanId,
  type PlanLimitDetail,
  type PlanLimitName,
  type PlanLimits,
} from "./billingApi";
import { Icon } from "./Icon";
import { PanelDialog } from "./PanelDialog";
import "./plan-billing.css";

/* ------------------------------------------------------------------ shared plan state */
type PlanSnapshot = { data: BillingState | null; loading: boolean; error: string | null; awaitingReturn: boolean };
const EMPTY: PlanSnapshot = { data: null, loading: false, error: null, awaitingReturn: false };
let snapshot: PlanSnapshot = EMPTY;
let inflight: Promise<void> | null = null;
let returnTimer: ReturnType<typeof setInterval> | null = null;
let returnUntil = 0;
const listeners = new Set<() => void>();
/** While Checkout or the Billing Portal is open in the browser, check the plan this often. */
export const RETURN_POLL_MS = 15_000;
const RETURN_WINDOW_MS = 10 * 60_000;

function update(next: Partial<PlanSnapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}

/** Reads the plan (refresh: confirm with the cloud now). Concurrent plain reads share one request. */
export function loadPlan(refresh = false): Promise<void> {
  if (inflight && !refresh) return inflight;
  update({ loading: true });
  const request: Promise<void> = (refresh ? billingApi.refresh() : billingApi.get())
    .then((data) => update({ data, loading: false, error: null }))
    .catch((error: unknown) =>
      update({ loading: false, error: error instanceof Error ? error.message : "The plan could not be read." }),
    )
    .finally(() => {
      if (inflight === request) inflight = null;
    });
  inflight = request;
  return request;
}

function stopAwaiting() {
  if (returnTimer) clearInterval(returnTimer);
  returnTimer = null;
  if (snapshot.awaitingReturn) update({ awaitingReturn: false });
}

/** After opening Checkout or the portal: confirm on return (focus) and every 15 s for ten minutes. */
function awaitReturn() {
  returnUntil = Date.now() + RETURN_WINDOW_MS;
  update({ awaitingReturn: true });
  if (returnTimer) clearInterval(returnTimer);
  returnTimer = setInterval(() => {
    if (Date.now() > returnUntil) return stopAwaiting();
    void loadPlan(true);
  }, RETURN_POLL_MS);
}

function onReturn() {
  if (document.visibilityState === "hidden") return;
  if (!snapshot.data && !snapshot.error) return;
  void loadPlan(snapshot.awaitingReturn);
}
const onCloudChange = () => void loadPlan(true);
const onLimit = () => void loadPlan();

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener(CLOUD_CHANGED, onCloudChange);
    window.addEventListener(PLAN_LIMIT_EVENT, onLimit);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener(CLOUD_CHANGED, onCloudChange);
      window.removeEventListener(PLAN_LIMIT_EVENT, onLimit);
    }
  };
}

const read = () => snapshot;
export function usePlan(): PlanSnapshot {
  const current = useSyncExternalStore(subscribe, read, read);
  useEffect(() => {
    if (!snapshot.data && !inflight) void loadPlan();
  }, []);
  return current;
}

/** Tests only. */
export function resetPlanStore() {
  if (returnTimer) clearInterval(returnTimer);
  returnTimer = null;
  snapshot = EMPTY;
  inflight = null;
}

/* ------------------------------------------------------------------ wording */
export const LIMIT_LABELS: Record<PlanLimitName, string> = {
  brands: "Brands",
  clips_per_month: "Clips this month",
  posting: "Posting from the app",
  connected_accounts: "Connected accounts",
  factory_builder: "Factory builder",
};

const dollars = (amount: number) => `$${amount.toLocaleString("en-US")}`;
export function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function priceLine(plan: Plan, interval: BillingInterval) {
  if (plan.price.month === 0) return { main: "$0", sub: "Free forever" };
  return interval === "month"
    ? { main: dollars(plan.price.month), sub: "per month" }
    : { main: dollars(plan.price.year), sub: `per month, ${dollars(plan.price.year * 12)} billed yearly` };
}

function limitRows(limits: PlanLimits): [string, string][] {
  return [
    ["Brands", String(limits.brands)],
    ["Clips per month", limits.clips_per_month === null ? "Unlimited" : String(limits.clips_per_month)],
    ["Posting from the app", limits.posting ? "Included" : "Export only"],
    ["Connected accounts", limits.posting ? String(limits.connected_accounts) : "None"],
    ["Factory builder", limits.factory_builder ? "Included" : "Not included"],
  ];
}

/* ------------------------------------------------------------------ Plan and Billing Section */
type Busy = "checkout" | "portal" | null;
type PaidPlan = Exclude<PlanId, "free">;

export function PlanBillingSection({ onSignIn }: { onSignIn: () => void }) {
  const { data, loading, error, awaitingReturn } = usePlan();
  const [billing, setBilling] = useState<BillingInterval>("month");
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [link, setLink] = useState<BillingLink | null>(null);

  async function open(kind: "checkout" | "portal", plan?: PaidPlan) {
    setBusy(kind);
    setFailure(null);
    setLink(null);
    try {
      const result = kind === "checkout" && plan ? await billingApi.checkout(plan, billing) : await billingApi.portal();
      setLink(result);
      awaitReturn();
    } catch (problem) {
      // The plan is unchanged; say why (sign-in needed, not on sale yet, cloud unreachable...).
      setFailure(problem instanceof ApiError || problem instanceof Error ? problem.message : "Billing could not be opened.");
    } finally {
      setBusy(null);
    }
  }

  if (!data)
    return (
      <>
        <PlanHeader />
        {error ? (
          <div className="gf-plan-notice gf-plan-warning" role="alert">
            <span>{error}</span>
            <button type="button" className="gf-button secondary compact" onClick={() => void loadPlan(true)}>
              <Icon name="refresh" size={14} />
              Try again
            </button>
          </div>
        ) : (
          <p className="gf-help" role="status">Checking your plan…</p>
        )}
      </>
    );

  const { entitlement: e, usage, plans, signed_in } = data;
  const paid = e.plan !== "free";
  const ends = formatDate(e.current_period_end);
  const choose = (plan: PaidPlan) => {
    if (!signed_in) return onSignIn();
    // One subscription per account: changes go through the Billing Portal.
    if (e.has_subscription) return void open("portal");
    void open("checkout", plan);
  };
  const meters: { id: PlanLimitName; used: number; max: number | null; hidden?: boolean }[] = [
    { id: "brands", used: usage.brands, max: e.limits.brands },
    { id: "clips_per_month", used: usage.clips_this_month, max: e.limits.clips_per_month },
    {
      id: "connected_accounts",
      used: usage.connected_accounts,
      max: e.limits.connected_accounts,
      hidden: !e.limits.posting && usage.connected_accounts === 0,
    },
  ];

  return (
    <>
      <PlanHeader />
      <section className="gf-settings-block gf-plan-current" aria-label="Current plan" aria-busy={loading || undefined}>
        <div className="gf-plan-current-head">
          <div>
            <h3>{e.name} plan</h3>
            <p className="gf-plan-terms">
              {paid && e.interval && <span>{e.interval === "year" ? "Billed yearly" : "Billed monthly"}</span>}
              {paid && ends && <span>{e.cancel_at_period_end ? `Ends on ${ends}` : `Renews on ${ends}`}</span>}
              {!paid && <span>No subscription</span>}
            </p>
          </div>
          <div className="gf-plan-current-actions">
            {loading && (
              <span className="gf-plan-checking" role="status">
                Confirming plan…
              </span>
            )}
            {e.has_subscription && (
              <button
                type="button"
                className="gf-button secondary compact"
                disabled={busy !== null}
                onClick={() => void open("portal")}
              >
                Manage billing
                <Icon name="arrow" size={14} />
              </button>
            )}
          </div>
        </div>
        {e.cancel_at_period_end && paid && ends && (
          <p className="gf-plan-notice">
            Your {e.name} plan is cancelled. Its limits stay until {ends}, then the Free plan applies. Nothing you made is
            deleted.
          </p>
        )}
        {e.payment_problem && (
          <div className="gf-plan-notice gf-plan-warning" role="alert">
            <span>
              <strong>Your last payment failed.</strong> Your plan stays active while the card is retried. Update the
              payment method to keep it.
            </span>
            <button type="button" className="gf-button compact" disabled={busy !== null} onClick={() => void open("portal")}>
              Fix payment
            </button>
          </div>
        )}
        {e.state === "signed_out" && (
          <div className="gf-plan-notice">
            <span>Sign in to Growth Factory cloud to upgrade. The Free plan applies while you are signed out.</span>
            <button type="button" className="gf-button secondary compact" onClick={onSignIn}>
              Sign in
            </button>
          </div>
        )}
        {e.state === "offline" && (
          <p className="gf-plan-notice">
            Offline. Showing the plan confirmed on {formatDate(e.confirmed_at)}. It keeps working until{" "}
            {formatDate(e.grace_ends_at)}.
          </p>
        )}
        {(e.state === "expired" || e.state === "not_configured") && e.message && (
          <p className="gf-plan-notice">{e.message}</p>
        )}
        <ul className="gf-plan-usage" aria-label="Usage">
          {meters
            .filter((m) => !m.hidden)
            .map((m) => {
              const reached = m.max !== null && m.used >= m.max;
              const ratio = m.max ? Math.min(1, m.used / m.max) : 0;
              return (
                <li key={m.id} className={reached ? "is-reached" : undefined}>
                  <span className="gf-plan-usage-label">{LIMIT_LABELS[m.id]}</span>
                  <span className="gf-plan-usage-value">
                    {m.max === null ? `${m.used} · Unlimited` : `${m.used} of ${m.max}`}
                    {reached && <strong className="gf-plan-reached"> · Limit reached</strong>}
                  </span>
                  {m.max !== null && (
                    <span className="gf-plan-meter" aria-hidden="true">
                      <span style={{ width: `${ratio * 100}%` }} />
                    </span>
                  )}
                </li>
              );
            })}
          <li>
            <span className="gf-plan-usage-label">Posting from the app</span>
            <span className="gf-plan-usage-value">{e.limits.posting ? "Included" : "Not included · export to post"}</span>
          </li>
          <li>
            <span className="gf-plan-usage-label">Factory builder</span>
            <span className="gf-plan-usage-value">{e.limits.factory_builder ? "Included" : "Not included"}</span>
          </li>
        </ul>
        {e.limits.clips_per_month !== null && usage.resets_at && (
          <p className="gf-help">Clip allowance resets on {formatDate(usage.resets_at)}.</p>
        )}
      </section>
      {failure && (
        <p className="gf-plan-notice gf-plan-warning" role="alert">
          {failure}
        </p>
      )}
      {link && (
        <p className="gf-plan-notice" role="status">
          {link.opened ? (
            "Finish in your browser. Your plan updates here when you come back."
          ) : (
            <>
              Your browser did not open. Open this page to continue: <span className="gf-plan-link">{link.url}</span>
            </>
          )}
        </p>
      )}
      {awaitingReturn && !link && (
        <p className="gf-help" role="status">
          Checking for plan changes…
        </p>
      )}
      <PlanComparison
        plans={plans}
        current={e.plan}
        interval={billing}
        onInterval={setBilling}
        signedIn={signed_in}
        available={data.available}
        hasSubscription={e.has_subscription}
        busy={busy !== null}
        onChoose={choose}
      />
    </>
  );
}

function PlanHeader() {
  return (
    <header>
      <h2>Plan and billing</h2>
      <p>Your plan, what it includes and how much of it you have used. Payment happens on secure Stripe pages.</p>
    </header>
  );
}

export function PlanComparison({
  plans,
  current,
  interval,
  onInterval,
  signedIn,
  available,
  hasSubscription,
  busy,
  onChoose,
}: {
  plans: Plan[];
  current: PlanId;
  interval: BillingInterval;
  onInterval: (value: BillingInterval) => void;
  signedIn: boolean;
  available: boolean;
  hasSubscription: boolean;
  busy: boolean;
  onChoose: (plan: PaidPlan) => void;
}) {
  return (
    <section className="gf-settings-block gf-plan-compare" aria-label="Compare plans" id="gf-plan-compare">
      <div className="gf-plan-compare-head">
        <h3>Compare plans</h3>
        <div className="gf-plan-interval" role="group" aria-label="Billing interval">
          {(["month", "year"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={interval === value} onClick={() => onInterval(value)}>
              {value === "month" ? "Monthly" : "Yearly"}
              {value === "year" && <span className="gf-plan-save"> · save 20%</span>}
            </button>
          ))}
        </div>
      </div>
      <ul className="gf-plan-cards">
        {plans.map((plan) => {
          const price = priceLine(plan, interval);
          const isCurrent = plan.id === current;
          return (
            <li key={plan.id} className={isCurrent ? "is-current" : undefined} aria-label={`${plan.name} plan`}>
              <div className="gf-plan-card-head">
                <h4>{plan.name}</h4>
                {isCurrent && <span className="gf-plan-current-tag">Current plan</span>}
              </div>
              <p className="gf-plan-price">
                <strong>{price.main}</strong> <span>{price.sub}</span>
              </p>
              <dl className="gf-plan-limits">
                {limitRows(plan.limits).map(([name, value]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              {plan.id !== "free" && !isCurrent && (
                <button
                  type="button"
                  className="gf-button compact"
                  disabled={busy || !available}
                  onClick={() => onChoose(plan.id as PaidPlan)}
                >
                  {!signedIn
                    ? `Sign in to choose ${plan.name}`
                    : hasSubscription
                      ? `Switch to ${plan.name}`
                      : `Upgrade to ${plan.name}`}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {!available && <p className="gf-help">Plans cannot be bought in this build.</p>}
      {hasSubscription && (
        <p className="gf-help">Plan changes, invoices and cancellation open in the Stripe billing portal.</p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ Upgrade Prompt */
function isLimit(value: unknown): value is PlanLimitDetail {
  return !!value && typeof value === "object" && (value as { code?: unknown }).code === "plan_limit";
}

/** Shown for any 402 plan_limit reply. Dismissing it leaves the blocked action unrun and loses nothing. */
export function UpgradePrompt({ onCompare }: { onCompare: () => void }) {
  const [detail, setDetail] = useState<PlanLimitDetail | null>(null);
  useEffect(() => {
    const show = (event: Event) => {
      const value: unknown = (event as CustomEvent).detail;
      if (isLimit(value)) setDetail(value);
    };
    window.addEventListener(PLAN_LIMIT_EVENT, show);
    return () => window.removeEventListener(PLAN_LIMIT_EVENT, show);
  }, []);
  const label = detail ? (LIMIT_LABELS[detail.limit] ?? "Plan limit") : "";
  const counted = detail != null && detail.usage != null && detail.max != null;
  return (
    <PanelDialog
      open={detail !== null}
      onClose={() => setDetail(null)}
      title="Plan limit reached"
      description={detail ? `${label} on your current plan` : undefined}
    >
      {detail && (
        <div className="gf-upgrade-prompt">
          <p>{detail.message}</p>
          {counted && (
            <p className="gf-upgrade-usage">
              <strong>{label}:</strong> {detail.usage} of {detail.max} used
            </p>
          )}
          <p className="gf-help">Nothing was changed and nothing you made is lost.</p>
          <div className="gf-upgrade-actions">
            <button type="button" className="gf-button secondary" onClick={() => setDetail(null)}>
              Not now
            </button>
            <button
              type="button"
              className="gf-button"
              onClick={() => {
                setDetail(null);
                onCompare();
              }}
            >
              Compare plans
              <Icon name="arrow" size={14} />
            </button>
          </div>
        </div>
      )}
    </PanelDialog>
  );
}

/* ------------------------------------------------------------------ sidebar badge */
export function PlanBadge({ onOpen, disabled }: { onOpen: () => void; disabled?: boolean }) {
  const { data } = usePlan();
  if (!data) return null;
  const e = data.entitlement;
  const warn = e.payment_problem || e.state === "expired";
  return (
    <button
      type="button"
      className={`gf-plan-badge${warn ? " is-warning" : ""}`}
      title={warn ? `${e.name} plan · needs attention` : `${e.name} plan · Plan and billing`}
      aria-label={`${e.name} plan${warn ? ", needs attention" : ""}. Open plan and billing`}
      disabled={disabled}
      onClick={onOpen}
    >
      <span aria-hidden="true" className="gf-plan-badge-dot" />
      <span>{e.name}</span>
    </button>
  );
}
