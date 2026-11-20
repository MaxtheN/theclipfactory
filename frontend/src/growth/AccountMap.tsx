/**
 * Account Map: posted clips grouped by the account they went to, drawn as nodes linked to the
 * brand (after Supabase's schema visualizer, but laid out automatically: nothing to arrange).
 * Every number comes from real Publication Records and their readings; unknown never becomes zero.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FocusEvent } from "react";
import { Icon } from "./Icon";
import { platformLabel } from "./publishApi";
import {
  CLIP_PAGE_SIZE,
  clipPage,
  compactCount,
  sortClips,
  timesTypical,
  type AccountMapModel,
  type ClipSort,
  type MapAccount,
  type MapClip,
} from "./resultsModel";
import "./account-map.css";

/** Below this width the brand node sits above the accounts instead of beside them. */
const SIDE_BY_SIDE = 720;
/** The "connect another account" node at the end of the column. */
const GHOST = "connect-another-account";

type Wire = { key: string; d: string; from: [number, number]; to: [number, number]; ghost: boolean };
type Layout = { width: number; height: number; stacked: boolean; wires: Wire[] };

const day = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const initial = (name: string) => (name.replace(/^@/, "").trim()[0] ?? "?").toUpperCase();
const domKey = (key: string) => key.replace(/[^A-Za-z0-9_-]/g, "_");
const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;
const round = (v: number) => Math.round(v * 10) / 10;

/** A number the platform has not reported yet: a dash on screen, words for screen readers. */
function Unmeasured() {
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="gf-visually-hidden">not measured yet</span>
    </>
  );
}

function clipMeta(c: MapClip): string {
  return [
    c.row.postedAt !== null ? `Posted ${day(c.row.postedAt)}` : "",
    c.row.windowLabel,
    c.row.untitled && c.row.mediaId ? `post ID ${c.row.mediaId}` : "",
    c.row.demo ? "Demo override" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function AccountMap({
  model,
  untracked,
  onAccounts,
}: {
  model: AccountMapModel;
  /** Posted clips with no Publication Record: no account, so they stay off the map. */
  untracked: number;
  /** Opens Settings > Accounts and connections. */
  onAccounts: () => void;
}) {
  const uid = useId();
  const nodeId = useCallback((key: string) => `${uid}-node-${domKey(key)}`, [uid]);
  const clipId = useCallback((id: string) => `${uid}-clip-${domKey(id)}`, [uid]);
  const [sort, setSort] = useState<ClipSort>("newest");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [pages, setPages] = useState<Record<string, number>>({});
  const [active, setActive] = useState<string | null>(null);
  const [landing, setLanding] = useState<{ id: string; at: number } | null>(null);
  const single = model.accounts.length === 1;
  const sorted = useMemo(
    () => new Map(model.accounts.map((a) => [a.key, sortClips(a.clips, sort)])),
    [model, sort],
  );

  const resort = (next: ClipSort) => {
    if (next === sort) return;
    setSort(next);
    setPages({});
  };
  const toggle = (key: string) => setOpen((o) => ({ ...o, [key]: !(o[key] ?? single) }));
  const turn = (key: string, page: number) => setPages((p) => ({ ...p, [key]: page }));
  const goToNode = (key: string) => {
    const el = document.getElementById(nodeId(key));
    el?.focus({ preventScroll: true });
    el?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    setActive(key);
  };
  /** Follow a cross-post: open the other account at the page holding the clip, then focus it. */
  const follow = (key: string, id: string) => {
    const at = (sorted.get(key) ?? []).findIndex((c) => c.row.id === id);
    if (at < 0) return;
    setOpen((o) => ({ ...o, [key]: true }));
    setPages((p) => ({ ...p, [key]: Math.floor(at / CLIP_PAGE_SIZE) }));
    setActive(key);
    setLanding({ id, at: Date.now() });
  };
  useEffect(() => {
    if (!landing) return;
    const el = document.getElementById(clipId(landing.id));
    el?.focus({ preventScroll: true });
    el?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    const done = window.setTimeout(() => setLanding(null), 1800);
    return () => window.clearTimeout(done);
  }, [landing, clipId]);

  // Links are drawn from the real layout: brand entry → account header, or a rail when stacked.
  const canvas = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>({ width: 0, height: 0, stacked: false, wires: [] });
  const drawn = useRef("");
  const measure = useCallback(() => {
    const root = canvas.current;
    if (!root) return;
    const box = root.getBoundingClientRect();
    if (!box.width) return;
    const rel = (el: Element) => {
      const r = el.getBoundingClientRect();
      return {
        l: round(r.left - box.left),
        r: round(r.right - box.left),
        b: round(r.bottom - box.top),
        y: round((r.top + r.bottom) / 2 - box.top),
      };
    };
    const brandEl = root.querySelector("[data-amap-brand]");
    if (!brandEl) return;
    const brand = rel(brandEl);
    const stacked = box.width < SIDE_BY_SIDE;
    const entries = new Map<string, ReturnType<typeof rel>>();
    root
      .querySelectorAll<HTMLElement>("[data-amap-entry]")
      .forEach((el) => entries.set(el.dataset.amapEntry ?? "", rel(el)));
    const wires: Wire[] = [];
    root.querySelectorAll<HTMLElement>("[data-amap-node]").forEach((el) => {
      const key = el.dataset.amapNode ?? "";
      const node = rel(el);
      const head = rel(el.querySelector("[data-amap-anchor]") ?? el);
      const ghost = key === GHOST;
      if (stacked) {
        const x = round(brand.l + 14);
        const bend = Math.min(10, Math.max(0, head.y - brand.b));
        wires.push({
          key,
          ghost,
          from: [x, brand.b],
          to: [node.l, head.y],
          d: `M ${x} ${brand.b} V ${round(head.y - bend)} Q ${x} ${head.y} ${round(x + bend)} ${head.y} H ${node.l}`,
        });
        return;
      }
      const start = entries.get(key);
      const x1 = brand.r,
        y1 = start ? start.y : round(brand.b - 22),
        x2 = node.l,
        y2 = head.y,
        mid = round((x1 + x2) / 2);
      wires.push({
        key,
        ghost,
        from: [x1, y1],
        to: [x2, y2],
        d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`,
      });
    });
    const next = { width: Math.round(box.width), height: Math.round(root.scrollHeight), stacked, wires };
    const signature = JSON.stringify(next);
    if (signature === drawn.current) return;
    drawn.current = signature;
    setLayout(next);
  }, []);
  useLayoutEffect(() => measure());
  useEffect(() => {
    const root = canvas.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(root);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [measure]);

  const hover = (key: string) => ({
    onPointerEnter: () => setActive(key),
    onPointerLeave: () => setActive((now) => (now === key ? null : now)),
    onFocus: () => setActive(key),
    onBlur: (e: FocusEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null))
        setActive((now) => (now === key ? null : now));
    },
  });

  return (
    <div className={`gf-amap${layout.stacked ? " is-stacked" : ""}`}>
      <div className="gf-amap-toolbar">
        <p className="gf-amap-summary">
          {plural(model.accounts.length, "account")} · {plural(model.clips, "clip")}
        </p>
        <div className="gf-amap-sort" role="group" aria-label="Sort clips">
          {(
            [
              ["newest", "Newest"],
              ["views", "Most views"],
            ] as const
          ).map(([key, label]) => (
            <button key={key} type="button" aria-pressed={sort === key} onClick={() => resort(key)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="gf-amap-canvas" ref={canvas}>
        <svg
          className="gf-amap-wires"
          width={layout.width}
          height={layout.height}
          aria-hidden="true"
          focusable="false"
        >
          {layout.wires.map((w) => (
            <g
              key={w.key}
              className={`gf-amap-wire${w.ghost ? " is-ghost" : ""}${active === w.key ? " is-active" : ""}`}
            >
              <path d={w.d} />
              <circle cx={w.from[0]} cy={w.from[1]} r={3} />
              <circle cx={w.to[0]} cy={w.to[1]} r={3} />
            </g>
          ))}
        </svg>
        <section className="gf-amap-brand" data-amap-brand="" aria-labelledby={`${uid}-brand`}>
          <header className="gf-amap-node-head">
            <span className="gf-amap-avatar is-brand" aria-hidden="true">
              {initial(model.brand)}
            </span>
            <div className="gf-amap-node-name">
              <h3 id={`${uid}-brand`}>{model.brand}</h3>
              <p>Brand · {plural(model.accounts.length, "account")}</p>
            </div>
          </header>
          <dl className="gf-amap-stats is-pair">
            <div>
              <dt>Views</dt>
              <dd>{model.views === null ? <Unmeasured /> : compactCount(model.views)}</dd>
            </div>
            <div>
              <dt>Clips</dt>
              <dd>{model.clips}</dd>
            </div>
          </dl>
          <ul className="gf-amap-entries" aria-label="Go to an account">
            {model.accounts.map((a) => (
              <li key={a.key} data-amap-entry={a.key}>
                <button
                  type="button"
                  className={active === a.key ? "is-active" : undefined}
                  onClick={() => goToNode(a.key)}
                  {...hover(a.key)}
                >
                  <span className="gf-amap-entry-name">{a.name}</span>
                  <span className="gf-amap-entry-meta">
                    {a.connected ? platformLabel(a.platform) : "Not connected"}
                  </span>
                  <span className="gf-amap-entry-views">
                    {a.views === null ? <Unmeasured /> : compactCount(a.views)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <ul className="gf-amap-accounts" aria-label="Accounts">
          {model.accounts.map((a) => {
            const opened = open[a.key] ?? single;
            return (
              <li key={a.key}>
                <AccountNode
                  account={a}
                  clips={sorted.get(a.key) ?? a.clips}
                  page={pages[a.key] ?? 0}
                  opened={opened}
                  active={active === a.key}
                  landing={landing?.id ?? null}
                  id={nodeId(a.key)}
                  clipId={clipId}
                  onToggle={() => toggle(a.key)}
                  onTurn={(page) => turn(a.key, page)}
                  onFollow={follow}
                  hover={hover(a.key)}
                />
              </li>
            );
          })}
          <li>
            <div className="gf-amap-node is-ghost" data-amap-node={GHOST}>
              <div className="gf-amap-node-head" data-amap-anchor="">
                <span className="gf-amap-avatar is-ghost" aria-hidden="true">
                  <Icon name="plus" size={15} />
                </span>
                <div className="gf-amap-node-name">
                  <strong>Post this brand somewhere else</strong>
                  <p>Connect another account in Settings.</p>
                </div>
              </div>
              <button type="button" className="gf-button secondary compact" onClick={onAccounts}>
                Connect an account
              </button>
            </div>
          </li>
        </ul>
      </div>
      {untracked > 0 && (
        <p className="gf-amap-note">
          {untracked === 1
            ? "1 posted clip is not on the map because it is not tracked yet."
            : `${untracked} posted clips are not on the map because they are not tracked yet.`}
          <button type="button" className="gf-strategist-link" onClick={onAccounts}>
            Track to measure
          </button>
        </p>
      )}
    </div>
  );
}

function AccountNode({
  account: a,
  clips,
  page: wanted,
  opened,
  active,
  landing,
  id,
  clipId,
  onToggle,
  onTurn,
  onFollow,
  hover,
}: {
  account: MapAccount;
  clips: MapClip[];
  page: number;
  opened: boolean;
  active: boolean;
  landing: string | null;
  id: string;
  clipId: (id: string) => string;
  onToggle: () => void;
  onTurn: (page: number) => void;
  onFollow: (key: string, rowId: string) => void;
  hover: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    onFocus: () => void;
    onBlur: (e: FocusEvent<HTMLElement>) => void;
  };
}) {
  const page = clipPage(clips, wanted);
  const unmeasured = a.clips.length - a.measured;
  const best = a.best;
  return (
    <article
      id={id}
      className={`gf-amap-node${a.connected ? "" : " is-disconnected"}${active ? " is-active" : ""}`}
      data-amap-node={a.key}
      tabIndex={-1}
      aria-labelledby={`${id}-name`}
      {...hover}
    >
      <header className="gf-amap-node-head" data-amap-anchor="">
        <span className="gf-amap-avatar" aria-hidden="true">
          {initial(a.name)}
        </span>
        <div className="gf-amap-node-name">
          <h3 id={`${id}-name`}>{a.name}</h3>
          <p>
            {a.platform ? platformLabel(a.platform) : "Platform unknown"}
            {!a.connected && <span className="gf-amap-pill">Not connected</span>}
          </p>
        </div>
      </header>
      <dl className="gf-amap-stats">
        <div>
          <dt>Views</dt>
          <dd>{a.views === null ? <Unmeasured /> : compactCount(a.views)}</dd>
        </div>
        <div>
          <dt>Clips</dt>
          <dd>
            {a.clips.length}
            {unmeasured > 0 && <small>{unmeasured} not measured yet</small>}
          </dd>
        </div>
        <div>
          <dt>Best clip</dt>
          <dd>
            {best === null || best.views === null ? (
              <Unmeasured />
            ) : best.vsTypical.ratio === null ? (
              <>
                {compactCount(best.views)}
                <small>views · no typical yet</small>
              </>
            ) : (
              <>
                {(Math.round(best.vsTypical.ratio * 10) / 10).toFixed(1)}×<small>typical</small>
              </>
            )}
          </dd>
        </div>
      </dl>
      {a.clips.length === 0 ? (
        <p className="gf-amap-empty">Nothing posted to this account yet.</p>
      ) : (
        <>
          <button
            type="button"
            className="gf-amap-toggle"
            aria-expanded={opened}
            aria-controls={`${id}-clips`}
            onClick={onToggle}
          >
            <Icon name="down" size={15} />
            {plural(a.clips.length, "clip")}
          </button>
          <div className="gf-amap-list" id={`${id}-clips`} hidden={!opened}>
            <ol className="gf-amap-clips" aria-label={`Clips posted to ${a.name}`}>
              {page.items.map((c) => (
                <li
                  key={c.row.id}
                  id={clipId(c.row.id)}
                  tabIndex={-1}
                  className={`gf-amap-clip${landing === c.row.id ? " is-landing" : ""}`}
                >
                  <div className="gf-amap-clip-text">
                    <strong>{c.row.title}</strong>
                    <small>{clipMeta(c)}</small>
                  </div>
                  <div className="gf-amap-clip-views">
                    {c.views === null ? (
                      "Not measured yet"
                    ) : (
                      <>
                        <b>{c.views.toLocaleString("en-US")}</b> views
                      </>
                    )}
                  </div>
                  <span className="gf-amap-bar" aria-hidden="true">
                    <i style={{ width: `${Math.round(c.share * 100)}%` }} />
                  </span>
                  {c.views !== null && (
                    <span className={`gf-amap-ratio is-${c.vsTypical.tone}`}>{timesTypical(c.vsTypical)}</span>
                  )}
                  {c.alsoOn.length > 0 && (
                    <p className="gf-amap-also">
                      <span>Also on</span>
                      {c.alsoOn.map((o) => (
                        <button
                          key={o.key}
                          type="button"
                          aria-label={`Show this clip on ${o.name}`}
                          onClick={() => onFollow(o.key, o.rowId)}
                        >
                          <Icon name="link" size={12} />
                          {o.name}
                        </button>
                      ))}
                    </p>
                  )}
                </li>
              ))}
            </ol>
            {page.pages > 1 && (
              <div className="gf-amap-pager">
                <button
                  type="button"
                  aria-label={`Previous clips on ${a.name}`}
                  aria-disabled={page.page === 0}
                  onClick={() => page.page > 0 && onTurn(page.page - 1)}
                >
                  <Icon name="back" size={14} />
                </button>
                <span role="status">
                  <span className="gf-visually-hidden">Showing clips </span>
                  {page.from}–{page.to} of {page.total}
                </span>
                <button
                  type="button"
                  aria-label={`Next clips on ${a.name}`}
                  aria-disabled={page.page === page.pages - 1}
                  onClick={() => page.page < page.pages - 1 && onTurn(page.page + 1)}
                >
                  <Icon name="arrow" size={14} />
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </article>
  );
}
