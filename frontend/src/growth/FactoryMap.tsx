import { SHOW_FACTORY_MAP } from "./appEvents";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { Clip, TeamRun } from "../types";
import type { FactoryState } from "../useFactory";
import { parseAutomationState } from "./AutomationPanel";
import {
  applyReplay,
  clock,
  deriveFactoryMap,
  FAMILY_LABEL,
  REPLAY_SPEED,
  replayableRun,
  replayDuration,
  replayEvents,
  replayFrame,
  runLedger,
  sortRuns,
  STATIONS,
  type AutomationSnapshot,
  type FactoryMapModel,
  type Family,
  type ReplayEvent,
  type Row,
  type Station,
  type StationId,
  type StationState,
  scopeAutomation,
} from "./flowEvents";
import { prefersReducedMotion } from "./StrategistPanel";
import { strategistApi, type StrategistView } from "./strategistApi";
import { factoryBuilderApi, type FactoryBuilderView } from "./factoryBuilderApi";
import { activeRulesId, type Workspace } from "./useCampaignWorkspace";
import { workspaceApi } from "./workspaceApi";
import { Icon } from "./Icon";
import "./factory-map.css";

const FAMILIES: Family[] = ["understand", "create", "judge", "ship", "learn"];
const STATE_LABEL: Record<StationState, string> = {
  active: "Working",
  done: "Done",
  waiting: "Needs you",
  idle: "Idle",
  empty: "Idle",
  failed: "Held",
};

/** Campaign-scoped inputs shared by the full map and the mini-map. */
function scope(w: Workspace, factory: FactoryState, runs: TeamRun[]) {
  const ids = new Set(w.campaign?.video_ids ?? []);
  return {
    sources: (factory.data.factory?.sources ?? []).filter((s) => ids.has(s.video_id)),
    clips: factory.data.clips.filter(
      (c) => c.campaign_id === w.campaign?.id && c.profile_id === w.profileId,
    ) as Clip[],
    runs: runs.filter((r) => ids.has(r.video_id)),
  };
}

function useMapData(w: Workspace, factory: FactoryState, active: boolean) {
  const [runs, setRuns] = useState<TeamRun[]>([]);
  const [automation, setAutomation] = useState<AutomationSnapshot | null>(null);
  const [strategist, setStrategist] = useState<StrategistView | null>(null);
  const [builder, setBuilder] = useState<FactoryBuilderView | null>(null);
  const working = (factory.data.factory?.sources ?? []).some((s) =>
    ["working", "queued"].includes(s.state),
  );
  const profileId = w.profileId;
  useEffect(() => {
    if (!active) return;
    let live = true;
    const load = async () => {
      const [r, state, accounts, view, upgrades] = await Promise.all([
        workspaceApi.teamRuns().catch(() => null),
        api<unknown>("/api/automation/state").catch(() => null),
        api<unknown>("/api/automation/accounts").catch(() => null),
        profileId ? strategistApi.view(profileId).catch(() => null) : null,
        factoryBuilderApi.view().catch(() => null),
      ]);
      if (!live) return;
      if (r) setRuns(r);
      try {
        const parsed = state ? parseAutomationState(state) : null;
        setAutomation(
          parsed
            ? {
                ...parsed,
                accounts: Array.isArray(accounts)
                  ? (accounts.filter(
                      (a) => a && typeof a === "object" && typeof a.id === "string",
                    ) as Row[])
                  : [],
              }
            : null,
        );
      } catch {
        setAutomation(null);
      }
      setStrategist(view);
      setBuilder(upgrades);
    };
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, working ? 3000 : 15000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [active, working, profileId]);
  return { runs, automation, strategist, builder };
}

type Point = { x: number; y: number };
type Box = { left: number; right: number; top: number; bottom: number; cx: number; cy: number };
interface Wires {
  paths: Map<string, string>;
  /** Where the learn → scout return line runs along the bottom (label anchor). */
  loop: Point | null;
}

/** A horizontal → vertical → horizontal connector with softly rounded corners. */
function elbow(s: Point, e: Point, gx: number): string {
  const dy = e.y - s.y;
  if (Math.abs(dy) < 1) return `M ${s.x} ${s.y} L ${e.x} ${e.y}`;
  const r = Math.max(0, Math.min(10, Math.abs(dy) / 2, gx - s.x, e.x - gx));
  const dir = Math.sign(dy);
  return (
    `M ${s.x} ${s.y} H ${gx - r} Q ${gx} ${s.y} ${gx} ${s.y + dir * r}` +
    ` V ${e.y - dir * r} Q ${gx} ${e.y} ${gx + r} ${e.y} H ${e.x}`
  );
}

/** Wire geometry from the measured station boxes (track coordinates). */
function wirePaths(boxes: Map<StationId, Box>): Wires {
  const paths = new Map<string, string>();
  const order = STATIONS.map((s) => s.id);
  const familyOf = (id: StationId) => STATIONS.find((s) => s.id === id)!.family;
  for (let i = 0; i < order.length - 1; i++) {
    const a = boxes.get(order[i]),
      b = boxes.get(order[i + 1]);
    if (!a || !b) continue;
    const d =
      familyOf(order[i]) === familyOf(order[i + 1])
        ? `M ${a.cx} ${a.bottom} L ${b.cx} ${b.top}`
        : elbow({ x: a.right, y: a.cy }, { x: b.left, y: b.cy }, (a.right + b.left) / 2);
    paths.set(`${order[i]}>${order[i + 1]}`, d);
  }
  const rules = boxes.get("rules"),
    scout = boxes.get("scout");
  let loop: Point | null = null;
  if (rules && scout) {
    // One quiet line beneath the whole line: out of Style rules, along the
    // bottom, and up the gutter into Scout's input.
    const r = 12;
    const floor = Math.max(...[...boxes.values()].map((b) => b.bottom)) + 30;
    const out = rules.right + 20;
    const gx = scout.left - 12;
    paths.set(
      "return",
      `M ${rules.right} ${rules.cy} H ${out - r} Q ${out} ${rules.cy} ${out} ${rules.cy + r}` +
        ` V ${floor - r} Q ${out} ${floor} ${out - r} ${floor} H ${gx + r}` +
        ` Q ${gx} ${floor} ${gx} ${floor - r} V ${scout.cy + 8}` +
        ` Q ${gx} ${scout.cy} ${gx + 8} ${scout.cy} H ${scout.left}`,
    );
    loop = { x: (out + gx) / 2, y: floor };
  }
  return { paths, loop };
}

function useWires(
  track: React.RefObject<HTMLDivElement | null>,
  deps: unknown[],
) {
  const [wires, setWires] = useState<Wires>({ paths: new Map(), loop: null });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const measure = useCallback(() => {
    const root = track.current;
    if (!root) return;
    // Measured against the scrolling track, so geometry survives horizontal scroll.
    const origin = root.getBoundingClientRect();
    const boxes = new Map<StationId, Box>();
    root.querySelectorAll<HTMLElement>("[data-station]").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      const left = r.left - origin.left,
        top = r.top - origin.top;
      boxes.set(el.dataset.station as StationId, {
        left,
        top,
        right: left + r.width,
        bottom: top + r.height,
        cx: left + r.width / 2,
        cy: top + r.height / 2,
      });
    });
    setSize({ w: origin.width, h: origin.height });
    setWires(wirePaths(boxes));
  }, [track]);
  useLayoutEffect(() => {
    measure();
    const root = track.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(root);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, ...deps]);
  return { ...wires, size };
}

/** Stations that just went from working to done pulse once. */
function usePulses(model: FactoryMapModel) {
  const previous = useRef(new Map<StationId, StationState>());
  const [pulses, setPulses] = useState<Set<StationId>>(new Set());
  useEffect(() => {
    const fresh: StationId[] = [];
    for (const s of model.stations) {
      if (previous.current.get(s.id) === "active" && s.state !== "active")
        fresh.push(s.id);
      previous.current.set(s.id, s.state);
    }
    if (!fresh.length) return;
    setPulses((old) => new Set([...old, ...fresh]));
    const timer = window.setTimeout(
      () => setPulses((old) => new Set([...old].filter((id) => !fresh.includes(id)))),
      1400,
    );
    return () => window.clearTimeout(timer);
  }, [model]);
  return pulses;
}

/** The one status pill: a fixed palette by state, never by stage family. */
function StatePill({ state }: { state: StationState }) {
  return (
    <span className={`gf-fmap-pill is-${state}`}>
      {state === "done" ? (
        <Icon name="check" size={11} />
      ) : (
        <i aria-hidden="true" />
      )}
      {STATE_LABEL[state]}
    </span>
  );
}

function StationCard({
  station,
  pulse,
  selected,
  onOpen,
}: {
  station: Station;
  pulse: boolean;
  selected: boolean;
  onOpen: () => void;
}) {
  const metric = station.counts[0];
  return (
    <button
      type="button"
      data-station={station.id}
      className={`gf-fmap-station is-${station.state}${pulse ? " is-pulse" : ""}${selected ? " is-selected" : ""}${station.dim ? " is-dim" : ""}`}
      aria-label={`${station.title}: ${STATE_LABEL[station.state]}. ${station.status}. Open details.`}
      aria-expanded={selected}
      title={station.status}
      onClick={onOpen}
    >
      <strong className="gf-fmap-title">{station.title}</strong>
      <span className="gf-fmap-status">{station.status}</span>
      <span className="gf-fmap-foot">
        {metric ? (
          <span className="gf-fmap-metric">
            <b>{metric.value}</b> {metric.label}
          </span>
        ) : (
          <span className="gf-fmap-metric" aria-hidden="true" />
        )}
        <StatePill state={station.state} />
      </span>
      {station.state === "active" && (
        <span className="gf-fmap-progress" aria-hidden="true">
          <i />
        </span>
      )}
    </button>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="gf-fmap-copy"
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      title={copied ? "Copied" : "Copy"}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => setCopied(true),
          () => undefined,
        );
      }}
    >
      {copied ? (
        <Icon name="check" size={12} />
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V6a2 2 0 0 1 2-2h8" />
        </svg>
      )}
    </button>
  );
}

/** Identifiers render in monospace with a copy button. */
const isIdLabel = (label: string) => /\bID\b/.test(label);

function StationSheet({
  station,
  onClose,
}: {
  station: Station;
  onClose: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [station.id, onClose]);
  return (
    <aside
      className="gf-fmap-sheet"
      role="dialog"
      aria-modal="false"
      aria-labelledby="gf-fmap-sheet-title"
    >
      <header>
        <div>
          <span className="gf-fmap-eyebrow">
            <i className={`gf-fmap-famdot fam-${station.family}`} aria-hidden="true" />
            {FAMILY_LABEL[station.family]}
          </span>
          <h3 id="gf-fmap-sheet-title">{station.title}</h3>
          <p>
            <span>{station.agent}</span>
            <StatePill state={station.state} />
          </p>
        </div>
        <button
          ref={close}
          type="button"
          className="gf-fmap-close"
          aria-label="Close details"
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <section className="gf-fmap-sheet-now">
        <p>{station.status}</p>
        {station.last && <p className="gf-fmap-note">Latest: {station.last}</p>}
      </section>
      {station.sheet.map((section) => (
        <section key={section.title}>
          <h4>{section.title}</h4>
          {!!section.rows?.length && (
            <dl>
              {section.rows.map((row, i) => (
                <div key={`${row.label}-${i}`}>
                  <dt>{row.label}</dt>
                  <dd>
                    {isIdLabel(row.label) ? (
                      <span className="gf-fmap-id">
                        <code>{row.value}</code>
                        <CopyButton value={row.value} label={row.label} />
                      </span>
                    ) : (
                      row.value
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {!!section.items?.length && (
            <ul>
              {section.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          )}
          {section.note && <p className="gf-fmap-note">{section.note}</p>}
        </section>
      ))}
    </aside>
  );
}

const sentence = (status: string) => {
  const text = status.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const shortWhen = (iso: string, now: number) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown time";
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
const fullWhen = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "Unknown time"
    : d.toLocaleString([], { dateStyle: "medium", timeStyle: "medium" });
};

/** Compact run selector: a short summary on the button, the full detail in the menu. */
function RunPicker({
  runs,
  value,
  onChange,
}: {
  runs: TeamRun[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, runs.findIndex((r) => r.id === value));
  const [cursor, setCursor] = useState(selectedIndex);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const [position, setPosition] = useState<{
    left: number; top: number; width: number; maxHeight: number;
  }>();
  const now = Date.now();
  const current = runs[selectedIndex];
  // The app and the ledger both have bounded scroll regions. Place the menu in
  // the viewport so neither region can clip it, including near the window edge.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = button.current?.getBoundingClientRect();
      if (!rect) return;
      const gutter = 12;
      const width = Math.min(380, window.innerWidth - gutter * 2);
      const below = window.innerHeight - rect.bottom - gutter - 6;
      const above = rect.top - gutter - 6;
      const height = Math.min(list.current?.scrollHeight || runs.length * 62 + 8, 360);
      const upward = below < height && above > below;
      const maxHeight = Math.max(40, Math.min(360, upward ? above : below));
      setPosition({
        left: Math.max(gutter, Math.min(rect.right - width, window.innerWidth - width - gutter)),
        top: upward ? Math.max(gutter, rect.top - Math.min(height, maxHeight) - 6) : rect.bottom + 6,
        width,
        maxHeight,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, runs.length]);
  useEffect(() => {
    if (!open) return;
    setCursor(selectedIndex);
    list.current?.focus();
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node) && !list.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open, selectedIndex]);
  useEffect(() => {
    if (open) document.getElementById(`${menuId}-option-${cursor}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, cursor, menuId]);
  const choose = (i: number) => {
    if (!runs[i]) return;
    onChange(runs[i].id);
    setOpen(false);
    button.current?.focus();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") setCursor((c) => Math.min(runs.length - 1, c + 1));
    else if (e.key === "ArrowUp") setCursor((c) => Math.max(0, c - 1));
    else if (e.key === "Home") setCursor(0);
    else if (e.key === "End") setCursor(runs.length - 1);
    else if (e.key === "Enter" || e.key === " ") choose(cursor);
    else if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
      button.current?.focus();
      return;
    } else return;
    e.preventDefault();
  };
  if (!current) return null;
  return (
    <div className="gf-fmap-picker" ref={root}>
      <button
        ref={button}
        type="button"
        className="gf-fmap-picker-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Run from ${fullWhen(current.created_at)}, ${sentence(current.status)}. Choose a run.`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="gf-fmap-picker-k">Run</span>
        <span className="gf-fmap-picker-v">{shortWhen(current.created_at, now)}</span>
        <span className={`gf-fmap-run-status is-${current.status}`}>{sentence(current.status)}</span>
        <Icon name="down" size={14} />
      </button>
      {open && createPortal(
        <ul
          id={menuId}
          ref={list}
          className="gf-fmap-picker-menu"
          style={position ? { ...position, visibility: "visible" } : { visibility: "hidden" }}
          role="listbox"
          tabIndex={-1}
          aria-label="Recent runs"
          aria-activedescendant={`${menuId}-option-${cursor}`}
          onKeyDown={onKey}
        >
          {runs.map((r, i) => (
            <li
              key={r.id}
              id={`${menuId}-option-${i}`}
              role="option"
              aria-selected={i === selectedIndex}
              className={i === cursor ? "is-cursor" : undefined}
              onMouseEnter={() => setCursor(i)}
              onClick={() => choose(i)}
            >
              <span className="gf-fmap-picker-when">{fullWhen(r.created_at)}</span>
              <span className={`gf-fmap-run-status is-${r.status}`}>{sentence(r.status)}</span>
              <code>{r.id}</code>
              {i === selectedIndex && <Icon name="check" size={14} />}
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </div>
  );
}

export function RunLedgerCard({
  runs,
  clips,
}: {
  runs: TeamRun[];
  clips: Clip[];
}) {
  const ordered = useMemo(() => sortRuns(runs).slice(0, 6), [runs]);
  const [chosen, setChosen] = useState("");
  const run = ordered.find((r) => r.id === chosen) ?? ordered[0];
  if (!run)
    return (
      <section className="gf-fmap-ledger" aria-label="Run ledger">
        <header>
          <h3>Run ledger</h3>
        </header>
        <p className="gf-fmap-note">
          No run recorded for this campaign yet. Produce clips from an episode
          and its timings, clips and approvals appear here.
        </p>
      </section>
    );
  const ledger = runLedger(run, clips, Date.now());
  const longest = Math.max(1, ...ledger.stages.map((s) => s.seconds));
  const stats: [string, number][] = [
    ["Clips produced", ledger.produced],
    ["Kept (you approved)", ledger.kept],
    ["Below the bar", ledger.belowBar],
    ["Waiting for you", ledger.waiting],
  ];
  return (
    <section className="gf-fmap-ledger" aria-label="Run ledger">
      <header>
        <div>
          <h3>Run ledger</h3>
          <p>What one run took, produced and cost.</p>
        </div>
        <RunPicker runs={ordered} value={run.id} onChange={setChosen} />
      </header>
      <dl className="gf-fmap-ledger-stats">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="gf-fmap-ledger-time">
        <h4>
          <span>Time per stage</span>
          <span className="gf-fmap-num">{clock(ledger.totalSeconds)} total</span>
        </h4>
        {ledger.stages.length ? (
          <ul className="gf-fmap-bars">
            {ledger.stages.map((s) => (
              <li key={s.station} className={s.running ? "is-running" : undefined}>
                <span>{s.title}</span>
                <span className="gf-fmap-bar" aria-hidden="true">
                  <i style={{ width: `${Math.max(2, (s.seconds / longest) * 100)}%` }} />
                </span>
                <b>
                  {clock(s.seconds)}
                  {s.running ? " · running" : ""}
                </b>
              </li>
            ))}
          </ul>
        ) : (
          <p className="gf-fmap-note">No stage timings were recorded on this run.</p>
        )}
      </div>
      <dl className="gf-fmap-ledger-meta">
        <div>
          <dt>Your actions</dt>
          <dd>
            {ledger.approvals} approval{ledger.approvals === 1 ? "" : "s"}
            {ledger.overrides ? ` · ${ledger.overrides} override${ledger.overrides === 1 ? "" : "s"}` : ""}
          </dd>
        </div>
        <div>
          <dt>Processing cost</dt>
          <dd>{ledger.cost.inference}</dd>
        </div>
        <div>
          <dt>Run ID</dt>
          <dd className="gf-fmap-id">
            <code>{ledger.runId}</code>
            <CopyButton value={ledger.runId} label="run ID" />
          </dd>
        </div>
      </dl>
      <p className="gf-fmap-note">
        {ledger.cost.note} Not counted: {ledger.cost.excluded.join("; ")}.
      </p>
    </section>
  );
}

function useReplay(events: ReplayEvent[], reduced: boolean) {
  const [on, setOn] = useState(false);
  const [recordedMs, setRecordedMs] = useState(0);
  const duration = replayDuration(events);
  useEffect(() => {
    if (!on) return;
    if (reduced) {
      setRecordedMs(duration);
      return;
    }
    const start = performance.now();
    let frame = 0,
      last = 0;
    const tick = (now: number) => {
      const t = Math.min(duration, (now - start) * REPLAY_SPEED);
      // ~12 updates a second is plenty: tokens animate in CSS between updates.
      if (now - last > 80 || t >= duration) {
        last = now;
        setRecordedMs(t);
      }
      if (t < duration) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [on, duration, reduced]);
  return {
    on,
    recordedMs,
    duration,
    toggle: () => {
      setRecordedMs(0);
      setOn((v) => !v);
    },
  };
}

export function FactoryMap({
  w,
  factory,
  active = true,
}: {
  w: Workspace;
  factory: FactoryState;
  active?: boolean;
}) {
  const data = useMapData(w, factory, active);
  const { sources, clips, runs } = scope(w, factory, data.runs);
  const reduced = useMemo(prefersReducedMotion, []);
  const now = Date.now();
  const real = useMemo(
    () =>
      deriveFactoryMap({
        sources,
        jobs: factory.data.jobs,
        clips,
        runs,
        campaign: w.campaign ?? null,
        versions: w.versions,
        activeRulesId: activeRulesId(w),
        automation: scopeAutomation(data.automation, w.campaign?.id, w.profileId),
        strategist: data.strategist,
        builder: data.builder,
        now,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [factory.data, data, w.campaign, w.versions, w.profileId],
  );
  const replayRun = useMemo(() => replayableRun(runs), [runs]);
  const events = useMemo(
    () => (replayRun ? replayEvents(replayRun, clips) : []),
    [replayRun, clips],
  );
  const replay = useReplay(events, reduced);
  const model =
    replay.on && replayRun
      ? applyReplay(real, replayFrame(events, replay.recordedMs), replayRun)
      : real;
  const pulses = usePulses(model);
  const [open, setOpen] = useState<StationId | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const { paths, loop, size } = useWires(track, [model.stations.map((s) => s.status).join("|")]);
  const closeSheet = useCallback(() => setOpen(null), []);
  const opened = model.stations.find((s) => s.id === open);
  const flowing = model.edges.filter((e) => e.flowing);
  const working = model.stations.filter((s) => s.state === "active").length;

  return (
    <section
      className={`gf-fmap${reduced ? " is-reduced" : ""}${replay.on ? " is-replay" : ""}`}
      aria-labelledby="gf-fmap-title"
      data-reduced={reduced ? "true" : "false"}
    >
      <header className="gf-fmap-head">
        <div>
          <h2 id="gf-fmap-title">Factory map</h2>
          <p>
            From source footage to the next creative decision. Select any station
            to see its work and recorded progress.
          </p>
        </div>
        <div className="gf-fmap-actions" role="toolbar" aria-label="Factory map controls">
          <span
            className={`gf-fmap-live${model.live ? " is-on" : ""}`}
            title={working ? `${working} station${working === 1 ? "" : "s"} working` : undefined}
          >
            <i aria-hidden="true" />
            {replay.on ? "Replay" : model.live ? "Working now" : "Resting"}
          </span>
          <span className="gf-fmap-actions-rule" aria-hidden="true" />
          <button
            type="button"
            className="gf-fmap-tool"
            aria-pressed={replay.on}
            disabled={!replayRun}
            title={
              replayRun
                ? `Replays run ${replayRun.id} from its recorded timestamps at ${REPLAY_SPEED}× speed`
                : "No finished run yet. Produce clips from an episode to record one."
            }
            aria-describedby="gf-fmap-replay-help"
            onClick={replay.toggle}
          >
            <Icon name={replay.on ? "close" : "play"} size={13} />
            {replay.on ? "Stop replay" : "Demo replay"}
          </button>
          <span id="gf-fmap-replay-help" className="gf-visually-hidden">
            {replayRun
              ? `Replays the most recent recorded run at ${REPLAY_SPEED} times speed. Recorded events only.`
              : "Demo replay is unavailable: no finished run has been recorded yet."}
          </span>
        </div>
      </header>
      {replay.on && replayRun && (
        <div className="gf-fmap-replay" role="status">
          <strong>Demo replay · recorded run, {REPLAY_SPEED}× speed</strong>
          <span>
            Run <code>{replayRun.id}</code> from {fullWhen(replayRun.created_at)}.
            Only its recorded timestamps are played back; nothing here is live.
          </span>
          <progress
            max={Math.max(1, replay.duration)}
            value={replay.recordedMs}
            aria-label="Replay progress"
          />
          <small>
            {clock(replay.recordedMs / 1000)} of {clock(replay.duration / 1000)} recorded
          </small>
        </div>
      )}
      <div
        className={`gf-fmap-canvas${scrolled ? " is-scrolled" : ""}`}
        tabIndex={-1}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
      >
        <div className="gf-fmap-track" ref={track}>
          <svg
            className="gf-fmap-wires"
            width={size.w}
            height={size.h}
            aria-hidden="true"
          >
            {model.edges.map((e) => {
              const d = paths.get(`${e.from}>${e.to}`);
              return d ? (
                <path
                  key={`${e.from}>${e.to}`}
                  d={d}
                  className={`gf-fmap-wire${e.flowing ? " is-flowing" : ""}`}
                />
              ) : null;
            })}
            {paths.get("return") && (
              <path
                d={paths.get("return")}
                className={`gf-fmap-wire is-return${model.returnArc.lit ? " is-lit" : ""}`}
              />
            )}
          </svg>
          {!reduced &&
            flowing.map((e) => {
              const d = paths.get(`${e.from}>${e.to}`);
              return d
                ? [0, 1].map((n) => (
                    <span
                      key={`${e.from}>${e.to}-${n}`}
                      className="gf-fmap-token"
                      data-testid="flow-token"
                      style={{
                        offsetPath: `path('${d}')`,
                        animationDelay: `${n * 1.1}s`,
                      }}
                      aria-hidden="true"
                    />
                  ))
                : null;
            })}
          <span
            className={`gf-fmap-return-label${model.returnArc.lit ? " is-lit" : ""}`}
            style={loop ? { left: loop.x, top: loop.y } : undefined}
            hidden={!loop}
          >
            <Icon name="refresh" size={11} />
            {model.returnArc.label}
          </span>
          <div className="gf-fmap-grid">
            {FAMILIES.map((family, index) => {
              const members = model.stations.filter((s) => s.family === family);
              const done = members.filter((s) => s.state === "done").length;
              return (
                <div key={family} className="gf-fmap-col" role="group" aria-label={FAMILY_LABEL[family]}>
                  <div className="gf-fmap-phase">
                    <span className="gf-fmap-phase-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                    <span>{FAMILY_LABEL[family]}</span>
                    <small className="gf-fmap-num" title={`${done} of ${members.length} done`}>
                      {done}/{members.length}
                    </small>
                  </div>
                  {members.map((s) => (
                    <StationCard
                      key={s.id}
                      station={s}
                      pulse={pulses.has(s.id)}
                      selected={open === s.id}
                      onOpen={() => setOpen((cur) => (cur === s.id ? null : s.id))}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <p className="gf-visually-hidden" role="status" aria-live="polite">
        {model.stations
          .filter((s) => s.state === "active")
          .map((s) => `${s.title}: ${s.status}`)
          .join(". ") || "No station is working right now."}
      </p>
      <RunLedgerCard runs={runs} clips={clips} />
      {opened &&
        createPortal(
          <StationSheet station={opened} onClose={closeSheet} />,
          document.body,
        )}
    </section>
  );
}

/** A compact strip of the production stations for Studio while a run is active. */
export function FactoryMiniMap({
  w,
  factory,
  runs,
}: {
  w: Workspace;
  factory: FactoryState;
  runs: TeamRun[];
}) {
  const { sources, clips, runs: scoped } = scope(w, factory, runs);
  const model = deriveFactoryMap({
    sources,
    jobs: factory.data.jobs,
    clips,
    runs: scoped,
    campaign: w.campaign ?? null,
    versions: w.versions,
    activeRulesId: activeRulesId(w),
    automation: null,
    strategist: null,
    now: Date.now(),
  });
  const shown = model.stations.slice(0, 8);
  const current = shown.find((s) => s.state === "active");
  return (
    <section className="gf-fmap-mini" aria-label="Factory map, production stations">
      <ol>
        {shown.map((s) => (
          <li
            key={s.id}
            className={`is-${s.state}`}
            title={`${s.title}: ${STATE_LABEL[s.state]}. ${s.status}`}
          >
            <i aria-hidden="true" />
            <span>{s.title}</span>
          </li>
        ))}
      </ol>
      <p role="status">
        {current ? (
          <>
            <strong>{current.title}</strong> · {current.status}
          </>
        ) : (
          "Waiting for the next station to start."
        )}
      </p>
    </section>
  );
}

const TAB_KEY = "growth-factory-tab-v1";
/** Factory: Episodes | Factory map. Episodes stay mounted so imports keep their state. */
export function FactoryTabs({
  w,
  factory,
  active,
  children,
}: {
  w: Workspace;
  factory: FactoryState;
  active: boolean;
  children: React.ReactNode;
}) {
  const [tab, setTab] = useState<"episodes" | "map">(() => {
    try {
      return localStorage.getItem(TAB_KEY) === "map" ? "map" : "episodes";
    } catch {
      return "episodes";
    }
  });
  const choose = (next: "episodes" | "map") => {
    setTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      /* A remembered tab is only a convenience. */
    }
  };
  // The first episode dropped on Factory opens the map so the stations can be watched.
  useEffect(() => {
    const show = () => choose("map");
    window.addEventListener(SHOW_FACTORY_MAP, show);
    return () => window.removeEventListener(SHOW_FACTORY_MAP, show);
  }, []);
  return (
    <>
      <div className="gf-fmap-segment" data-view={tab} role="tablist" aria-label="Factory view">
        <span className="gf-fmap-segment-selection" aria-hidden="true" />
        {(
          [
            ["episodes", "Episodes"],
            ["map", "Factory map"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`gf-factory-tab-${key}`}
            aria-selected={tab === key}
            tabIndex={tab === key ? 0 : -1}
            aria-controls={`gf-factory-panel-${key}`}
            onClick={() => choose(key)}
            onKeyDown={(event) => {
              const next = event.key === "ArrowRight" || event.key === "ArrowLeft"
                ? (tab === "episodes" ? "map" : "episodes")
                : event.key === "Home" ? "episodes" : event.key === "End" ? "map" : null;
              if (!next) return;
              event.preventDefault();
              choose(next);
              document.getElementById(`gf-factory-tab-${next}`)?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        id="gf-factory-panel-episodes"
        className="gf-fmap-view"
        role="tabpanel"
        aria-labelledby="gf-factory-tab-episodes"
        hidden={tab !== "episodes"}
      >
        {children}
      </div>
      {tab === "map" && (
        <div
          id="gf-factory-panel-map"
          className="gf-fmap-view"
          role="tabpanel"
          aria-labelledby="gf-factory-tab-map"
        >
          <FactoryMap w={w} factory={factory} active={active} />
        </div>
      )}
    </>
  );
}
