import { useCallback, useEffect, useState } from "react";
import {
  factoryBuilderApi,
  SOURCE_LABEL,
  STATUS_LABEL,
  type CapabilityRequest,
  type FactoryBuild,
  type FactoryBuilderView,
  type PrPlan,
} from "./factoryBuilderApi";
import "./factory-upgrades.css";

/**
 * "Factory upgrades": craft the renderer lacks, detected from saved evidence, turned into a work
 * order and, on an explicit click, a reviewed code change on its own branch. Nothing here files,
 * builds, pushes or merges without a click; merged extensions appear after a restart.
 */
export function FactoryUpgrades({ compact = false }: { compact?: boolean }) {
  const [view, setView] = useState<FactoryBuilderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await factoryBuilderApi.view());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Factory upgrades are unavailable.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const building = view?.summary.building ?? 0;
  useEffect(() => {
    if (!building) return;
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [building, load]);

  const act = async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await run();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work. Nothing was changed.");
    } finally {
      setBusy(null);
    }
  };

  if (!view)
    return (
      <section className="gf-upgrades" aria-label="Factory upgrades">
        <h3>Factory upgrades</h3>
        <p className="gf-upgrades-muted" role={error ? "alert" : undefined}>
          {error ?? "Reading upgrade ideas…"}
        </p>
      </section>
    );

  const requests = view.requests.filter((r) => r.status !== "rejected");
  return (
    <section className={`gf-upgrades${compact ? " is-compact" : ""}`} aria-label="Factory upgrades">
      <header className="gf-upgrades-head">
        <div>
          <span className="gf-upgrades-overline">The factory that improves itself</span>
          <h3>Factory upgrades</h3>
          <p className="gf-upgrades-muted">
            Craft the renderer can't do yet. Build turns one into a reviewed code change.
          </p>
        </div>
        <button type="button" className="gf-button secondary compact" disabled={!!busy}
          onClick={() => act("scan", factoryBuilderApi.scan)}>
          {busy === "scan" ? "Looking…" : "Look for gaps"}
        </button>
      </header>
      {error && <p className="gf-upgrades-error" role="alert">{error}</p>}
      {!requests.length ? (
        <div className="gf-upgrades-empty">
          <p>
            No upgrade ideas yet.
          </p>
          <button type="button" className="gf-button secondary compact" disabled={!!busy}
            onClick={() => act("demo", factoryBuilderApi.demo)}>
            Try with a demo request
          </button>
          <span className="gf-upgrades-muted">Creates a progress-bar request labelled “demo”, not real demand.</span>
        </div>
      ) : (
        <ul className="gf-upgrades-list">
          {requests.map((r) => (
            <RequestRow key={r.id} request={r} view={view} busy={busy} open={open === r.id}
              onToggle={() => setOpen((cur) => (cur === r.id ? null : r.id))} act={act} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RequestRow({
  request: r,
  view,
  busy,
  open,
  onToggle,
  act,
}: {
  request: CapabilityRequest;
  view: FactoryBuilderView;
  busy: string | null;
  open: boolean;
  onToggle: () => void;
  act: (key: string, run: () => Promise<unknown>) => Promise<void>;
}) {
  const build = view.builds.find((b) => b.id === r.build_id) ?? null;
  const [issue, setIssue] = useState<string | null>(null);
  return (
    <li className={`gf-upgrade is-${r.status}`}>
      <button type="button" className="gf-upgrade-summary" aria-expanded={open} onClick={onToggle}>
        <strong>{r.label}</strong>
        {r.demo && <span className="gf-upgrade-chip is-demo">Demo</span>}
        <span className={`gf-upgrade-status is-${r.status}`}>{STATUS_LABEL[r.status]}</span>
        <span className="gf-upgrades-muted">
          {r.demand_count} signal{r.demand_count === 1 ? "" : "s"}
        </span>
      </button>
      <ul className="gf-upgrade-evidence" aria-label="Evidence">
        {r.evidence.slice(0, open ? 10 : 3).map((e) => (
          <li key={`${e.source}:${e.id}`} className="gf-upgrade-chip" title={e.quote}>
            <b>{SOURCE_LABEL[e.source] ?? e.source}</b> “{e.quote.slice(0, open ? 240 : 70)}
            {!open && e.quote.length > 70 ? "…" : ""}”
          </li>
        ))}
      </ul>
      {open && (
        <div className="gf-upgrade-body">
          {!r.buildable && (
            <p className="gf-upgrades-muted">
              Needs more than a video overlay.
            </p>
          )}
          <div className="gf-upgrade-actions">
            <button type="button" className="gf-button secondary compact" disabled={!!busy}
              onClick={() => act(`wo-${r.id}`, () => factoryBuilderApi.workOrder(r.id))}>
              {r.work_order ? "Rewrite work order" : "Write work order"}
            </button>
            {r.work_order && (
              <>
                <button type="button" className="gf-button secondary compact"
                  onClick={() => void navigator.clipboard?.writeText(r.work_order!.markdown)}>
                  Copy as Markdown
                </button>
                <button type="button" className="gf-button secondary compact" disabled={!!busy}
                  onClick={() => act(`issue-${r.id}`, async () => {
                    const out = await factoryBuilderApi.fileIssue(r.id);
                    setIssue(out.filed ? `Filed: ${out.url ?? "issue created"}` : `Not filed: ${out.reason}. Copy the Markdown instead.`);
                  })}>
                  File as GitHub issue
                </button>
              </>
            )}
            {r.buildable && view.can_build && ["detected", "work_order"].includes(r.status) && (
              <button type="button" className="gf-button primary compact" disabled={!!busy}
                onClick={() => act(`build-${r.id}`, () => factoryBuilderApi.build(r.id))}>
                Build it
              </button>
            )}
            {["detected", "work_order"].includes(r.status) && (
              <button type="button" className="gf-button ghost compact" disabled={!!busy}
                onClick={() => act(`reject-${r.id}`, () => factoryBuilderApi.reject(r.id))}>
                Not now
              </button>
            )}
          </div>
          {issue && <p className="gf-upgrades-muted" role="status">{issue}</p>}
          {!view.can_build && (
            <p className="gf-upgrades-muted">This copy of the app isn't a Git checkout, so it can't build branches.</p>
          )}
          {r.work_order && (
            <details className="gf-upgrade-order">
              <summary>Work order: {r.work_order.title}</summary>
              <pre>{r.work_order.markdown}</pre>
            </details>
          )}
          {build && <BuildReview build={build} busy={busy} act={act} />}
        </div>
      )}
    </li>
  );
}

function BuildReview({
  build,
  busy,
  act,
}: {
  build: FactoryBuild;
  busy: string | null;
  act: (key: string, run: () => Promise<unknown>) => Promise<void>;
}) {
  const [detail, setDetail] = useState<FactoryBuild | null>(null);
  const [plan, setPlan] = useState<PrPlan | null>(null);
  useEffect(() => {
    if (build.status === "building") return;
    let live = true;
    factoryBuilderApi.detail(build.id).then((d) => live && setDetail(d)).catch(() => null);
    if (build.status === "ready_for_review")
      factoryBuilderApi.prPlan(build.id).then((p) => live && setPlan(p)).catch(() => null);
    return () => {
      live = false;
    };
  }, [build.id, build.status, build.updated_at]);
  const last = build.attempts[build.attempts.length - 1];
  return (
    <div className={`gf-upgrade-build is-${build.status}`} aria-label="Builder result">
      <p>
        <b>{build.status === "building" ? "Building" : build.status === "ready_for_review" ? "Ready for review" : build.status === "failed" ? "Build failed" : "Discarded"}</b>{" "}
        on <code>{build.branch}</code> from <code>{build.base_branch}</code>
        {build.attempts.length > 0 && ` · ${build.attempts.length} attempt${build.attempts.length === 1 ? "" : "s"}`}
        {build.usage && ` · ${build.usage.calls} model call${build.usage.calls === 1 ? "" : "s"}, $${build.usage.cost_usd.toFixed(4)}`}
        {build.demo && " · demo trigger"}
      </p>
      {build.error && <p className="gf-upgrades-error">{build.error}</p>}
      {last && (
        <ul className="gf-upgrade-steps" aria-label="Checks">
          {last.steps.map((s) => (
            <li key={s.name} className={s.ok ? "is-ok" : "is-fail"}>
              {s.ok ? "✓" : "✕"} {s.name}
            </li>
          ))}
        </ul>
      )}
      {build.isolation && (
        <p className={build.isolation.network_denied ? "gf-upgrades-muted" : "gf-upgrades-warning"}>
          Checks ran with {build.isolation.label}.
          {!build.isolation.network_denied && " The generated code could reach the network while its checks ran; read the diff before merging."}
        </p>
      )}
      {build.status === "ready_for_review" && build.sample_path && (
        <video className="gf-upgrade-sample" src={factoryBuilderApi.sampleUrl(build.id)} controls muted loop playsInline
          aria-label="Sample render with the new extension" />
      )}
      {detail?.diff && (
        <details className="gf-upgrade-order">
          <summary>Code change ({detail.commit?.slice(0, 8)})</summary>
          <pre>{detail.diff}</pre>
        </details>
      )}
      {detail?.test_log && (
        <details className="gf-upgrade-order">
          <summary>Test log</summary>
          <pre>{detail.test_log}</pre>
        </details>
      )}
      {build.status === "ready_for_review" && (
        <div className="gf-upgrade-review">
          <p className="gf-upgrades-muted">
            Nothing is pushed until you click. Merge the branch into <code>{build.base_branch}</code> and restart; the
            extension then appears in Fine-tune and as a Strategist variable.
          </p>
          {plan && (
            <pre className="gf-upgrade-commands" aria-label="Exact commands">{plan.commands.join("\n")}</pre>
          )}
          {build.pr_url ? (
            <p>Draft PR: <a href={build.pr_url} target="_blank" rel="noreferrer">{build.pr_url}</a></p>
          ) : (
            <div className="gf-upgrade-actions">
              <button type="button" className="gf-button primary compact"
                disabled={!!busy || !plan || !!plan.blocked || !plan.gh.authenticated}
                title={plan?.blocked ?? plan?.gh.reason ?? undefined}
                onClick={() => act(`push-${build.id}`, () => factoryBuilderApi.push(build.id))}>
                Push &amp; open draft PR
              </button>
              <button type="button" className="gf-button ghost compact" disabled={!!busy}
                onClick={() => act(`discard-${build.id}`, () => factoryBuilderApi.discard(build.id))}>
                Discard
              </button>
            </div>
          )}
          {plan?.blocked && <p className="gf-upgrades-error">{plan.blocked}</p>}
        </div>
      )}
      {build.status === "failed" && (
        <div className="gf-upgrade-actions">
          <button type="button" className="gf-button ghost compact" disabled={!!busy}
            onClick={() => act(`discard-${build.id}`, () => factoryBuilderApi.discard(build.id))}>
            Discard branch
          </button>
        </div>
      )}
    </div>
  );
}

interface MergedExtension {
  capability: string;
  label: string;
  description: string;
  provenance: string;
}

/**
 * Fine-tune toggles for merged renderer extensions (off by default). Renders nothing until an
 * extension has been reviewed, merged into this checkout and the app restarted.
 */
export function ExtensionToggles({
  value,
  onChange,
}: {
  value: Record<string, Record<string, unknown>>;
  onChange: (next: Record<string, Record<string, unknown>>) => void;
}) {
  const [items, setItems] = useState<MergedExtension[]>([]);
  useEffect(() => {
    let live = true;
    factoryBuilderApi
      .extensions()
      .then((out) => live && setItems(out.extensions))
      .catch(() => null);
    return () => {
      live = false;
    };
  }, []);
  if (!items.length) return null;
  return (
    <>
      {items.map((e) => (
        <label key={e.capability} className="gf-upgrade-toggle" title={`${e.description} (${e.provenance})`}>
          <input
            type="checkbox"
            checked={e.capability in value}
            onChange={(ev) => {
              const next = { ...value };
              if (ev.target.checked) next[e.capability] = {};
              else delete next[e.capability];
              onChange(next);
            }}
          />{" "}
          {e.label} <span className="gf-upgrades-muted">· added by the Factory builder</span>
        </label>
      ))}
    </>
  );
}
