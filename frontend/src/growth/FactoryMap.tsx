import {
  useCallback,
  useEffect,
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
import { activeRulesId, type Workspace } from "./useCampaignWorkspace";
import { workspaceApi } from "./workspaceApi";
import { Icon } from "./Icon";
import "./factory-map.css";

const FAMILIES: Family[] = ["understand", "create", "judge", "ship", "learn"];
const STATE_LABEL: Record<StationState, string> = {
  active: "Working",
  done: "Done",
  waiting: "Needs you",
  idle: "Resting",
  empty: "Not started",
  failed: "Stopped",
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
  const working = (factory.data.factory?.sources ?? []).some((s) =>
    ["working", "queued"].includes(s.state),
  );
  const profileId = w.profileId;
  useEffect(() => {
    if (!active) return;
    let live = true;
    const load = async () => {
      const [r, state, accounts, view] = await Promise.all([
        workspaceApi.teamRuns().catch(() => null),
        api<unknown>("/api/automation/state").catch(() => null),
        api<unknown>("/api/automation/accounts").catch(() => null),
        profileId ? strategistApi.view(profileId).catch(() => null) : null,
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
  return { runs, automation, strategist };
}

type Point = { x: number; y: number };
type Box = { left: number; right: number; top: number; bottom: number; cx: number; cy: number };

/** Wire geometry from the measured station boxes (container coordinates). */
function wirePaths(boxes: Map<StationId, Box>) {
  const paths = new Map<string, string>();
  const order = STATIONS.map((s) => s.id);
  const familyOf = (id: StationId) => STATIONS.find((s) => s.id === id)!.family;
  for (let i = 0; i < order.length - 1; i++) {
    const a = boxes.get(order[i]),
      b = boxes.get(order[i + 1]);
    if (!a || !b) continue;
    let d: string;
    if (familyOf(order[i]) === familyOf(order[i + 1])) {
      d = `M ${a.cx} ${a.bottom} L ${b.cx} ${b.top}`;
    } else {
      const s: Point = { x: a.right, y: a.cy },
        e: Point = { x: b.left, y: b.cy };
      const k = Math.max(24, (e.x - s.x) / 2);
      d = `M ${s.x} ${s.y} C ${s.x + k} ${s.y} ${e.x - k} ${e.y} ${e.x} ${e.y}`;
    }
    paths.set(`${order[i]}>${order[i + 1]}`, d);
  }
  const rules = boxes.get("rules"),
    scout = boxes.get("scout");
  if (rules && scout) {
    const top = Math.min(...[...boxes.values()].map((b) => b.top)) - 30;
    const x1 = rules.right,
      y1 = rules.cy,
      out = x1 + 22;
    paths.set(
      "return",
      `M ${x1} ${y1} C ${out + 14} ${y1} ${out + 14} ${top} ${out - 16} ${top} L ${scout.cx + 18} ${top} C ${scout.cx} ${top} ${scout.cx} ${top} ${scout.cx} ${scout.top}`,
    );
  }
  return paths;
}

function useWires(
  canvas: React.RefObject<HTMLDivElement | null>,
  deps: unknown[],
) {
  const [paths, setPaths] = useState<Map<string, string>>(new Map());
  const [size, setSize] = useState({ w: 0, h: 0 });
  const measure = useCallback(() => {
    const root = canvas.current;
    if (!root) return;
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
    setPaths(wirePaths(boxes));
  }, [canvas]);
  useLayoutEffect(() => {
    measure();
    const root = canvas.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(root);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, ...deps]);
  return { paths, size };
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
  return (
    <button
      type="button"
      data-station={station.id}
      className={`gf-fmap-station fam-${station.family} is-${station.state}${pulse ? " is-pulse" : ""}${selected ? " is-selected" : ""}${station.dim ? " is-dim" : ""}`}
      aria-label={`${station.title}: ${STATE_LABEL[station.state]}. ${station.status}. Open details.`}
      aria-expanded={selected}
      onClick={onOpen}
    >
      <span className="gf-fmap-station-head">
        <span className="gf-fmap-dot" aria-hidden="true" />
        <strong>{station.title}</strong>
      </span>
      <span className="gf-fmap-agent-row">
        <span className="gf-fmap-agent">{station.agent}</span>
        <span className={`gf-fmap-badge is-${station.state}`}>
          {STATE_LABEL[station.state]}
        </span>
      </span>
      <span className="gf-fmap-status">{station.status}</span>
      {station.id === "scout" && station.lanes > 0 && (
        <span className="gf-fmap-lanes" aria-hidden="true">
          {Array.from({ length: station.lanes }, (_, i) => (
            <i key={i} style={{ animationDelay: `${(i * 137) % 900}ms` }} />
          ))}
        </span>
      )}
      {station.counts.length > 0 && (
        <span className="gf-fmap-counts">
          {station.counts.map((c) => (
            <span key={c.label}>
              <b>{c.value}</b> {c.label}
            </span>
          ))}
        </span>
      )}
      {station.last && <span className="gf-fmap-last">{station.last}</span>}
    </button>
  );
}

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
      className={`gf-fmap-sheet fam-${station.family}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby="gf-fmap-sheet-title"
    >
      <header>
        <div>
          <span className="gf-fmap-family">{FAMILY_LABEL[station.family]}</span>
          <h3 id="gf-fmap-sheet-title">{station.title}</h3>
          <p>
            {station.agent} · <span className={`gf-fmap-badge is-${station.state}`}>{STATE_LABEL[station.state]}</span>
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
      <p className="gf-fmap-sheet-status">{station.status}</p>
      {station.sheet.map((section) => (
        <section key={section.title}>
          <h4>{section.title}</h4>
          {!!section.rows?.length && (
            <dl>
              {section.rows.map((row, i) => (
                <div key={`${row.label}-${i}`}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
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
        <h3>Run ledger</h3>
        <p className="gf-fmap-note">
          No run recorded for this campaign yet. Produce clips from an episode
          and its timings, clips and approvals appear here.
        </p>
      </section>
    );
  const ledger = runLedger(run, clips, Date.now());
  const longest = Math.max(1, ...ledger.stages.map((s) => s.seconds));
  return (
    <section className="gf-fmap-ledger" aria-label="Run ledger">
      <header>
        <h3>Run ledger</h3>
        <label>
          <span className="gf-fmap-family">Run</span>
          <select value={run.id} onChange={(e) => setChosen(e.target.value)}>
            {ordered.map((r) => (
              <option key={r.id} value={r.id}>
                {new Date(r.created_at).toLocaleString()} · {r.status.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
      </header>
      <div className="gf-fmap-ledger-grid">
        <div>
          <h4>Time per stage · {clock(ledger.totalSeconds)} total</h4>
          {ledger.stages.length ? (
            <ul className="gf-fmap-bars">
              {ledger.stages.map((s) => (
                <li key={s.station} className={`fam-${STATIONS.find((x) => x.id === s.station)!.family}`}>
                  <span>{s.title}</span>
                  <i style={{ width: `${Math.max(3, (s.seconds / longest) * 100)}%` }} />
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
        <dl className="gf-fmap-ledger-stats">
          <div>
            <dt>Clips produced</dt>
            <dd>{ledger.produced}</dd>
          </div>
          <div>
            <dt>Kept (you approved)</dt>
            <dd>{ledger.kept}</dd>
          </div>
          <div>
            <dt>Below the bar</dt>
            <dd>{ledger.belowBar}</dd>
          </div>
          <div>
            <dt>Waiting for you</dt>
            <dd>{ledger.waiting}</dd>
          </div>
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
        </dl>
      </div>
      <p className="gf-fmap-note">
        {ledger.cost.note} Not counted: {ledger.cost.excluded.join("; ")}. Run{" "}
        <code>{ledger.runId}</code>.
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
  const canvas = useRef<HTMLDivElement>(null);
  const { paths, size } = useWires(canvas, [model.stations.map((s) => s.status).join("|")]);
  const closeSheet = useCallback(() => setOpen(null), []);
  const opened = model.stations.find((s) => s.id === open);
  const flowing = model.edges.filter((e) => e.flowing);

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
            Every agent on the line, from raw footage to what the next clips
            learn. Live from this Mac's records.
          </p>
        </div>
        <div className="gf-fmap-actions">
          <span className={`gf-fmap-live${model.live ? " is-on" : ""}`}>
            <i aria-hidden="true" />
            {replay.on ? "Replay" : model.live ? "Working now" : "Resting"}
          </span>
          <button
            type="button"
            className="gf-button secondary compact"
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
            <Icon name={replay.on ? "close" : "play"} size={14} />
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
            Run {replayRun.id} from {new Date(replayRun.created_at).toLocaleString()}.
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
      <ul className="gf-fmap-legend" aria-label="Stage families">
        {FAMILIES.map((f) => (
          <li key={f} className={`fam-${f}`}>
            <i aria-hidden="true" />
            {FAMILY_LABEL[f]}
          </li>
        ))}
      </ul>
      <div className="gf-fmap-canvas" ref={canvas}>
        <svg
          className="gf-fmap-wires"
          width={size.w}
          height={size.h}
          aria-hidden="true"
        >
          {model.edges.map((e) => {
            const d = paths.get(`${e.from}>${e.to}`);
            const fam = STATIONS.find((s) => s.id === e.to)!.family;
            return d ? (
              <path
                key={`${e.from}>${e.to}`}
                d={d}
                className={`gf-fmap-wire fam-${fam}${e.flowing ? " is-flowing" : ""}`}
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
            const fam = STATIONS.find((s) => s.id === e.to)!.family;
            return d
              ? [0, 1, 2].map((n) => (
                  <span
                    key={`${e.from}>${e.to}-${n}`}
                    className={`gf-fmap-token fam-${fam}`}
                    data-testid="flow-token"
                    style={{
                      offsetPath: `path('${d}')`,
                      animationDelay: `${n * 0.6}s`,
                    }}
                    aria-hidden="true"
                  />
                ))
              : null;
          })}
        <span className={`gf-fmap-return-label${model.returnArc.lit ? " is-lit" : ""}`}>
          {model.returnArc.label}
        </span>
        <div className="gf-fmap-grid">
          {FAMILIES.map((family) => (
            <div key={family} className={`gf-fmap-col fam-${family}`}>
              <span className="gf-fmap-family">{FAMILY_LABEL[family]}</span>
              {model.stations
                .filter((s) => s.family === family)
                .map((s) => (
                  <StationCard
                    key={s.id}
                    station={s}
                    pulse={pulses.has(s.id)}
                    selected={open === s.id}
                    onOpen={() => setOpen((cur) => (cur === s.id ? null : s.id))}
                  />
                ))}
            </div>
          ))}
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
            className={`fam-${s.family} is-${s.state}`}
            title={`${s.title}: ${s.status}`}
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
  return (
    <>
      <div className="gf-fmap-segment" role="tablist" aria-label="Factory view">
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
            aria-controls={`gf-factory-panel-${key}`}
            onClick={() => choose(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        id="gf-factory-panel-episodes"
        role="tabpanel"
        aria-labelledby="gf-factory-tab-episodes"
        hidden={tab !== "episodes"}
      >
        {children}
      </div>
      {tab === "map" && (
        <div
          id="gf-factory-panel-map"
          role="tabpanel"
          aria-labelledby="gf-factory-tab-map"
        >
          <FactoryMap w={w} factory={factory} active={active} />
        </div>
      )}
    </>
  );
}
