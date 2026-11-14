import type {
  BeliefEvidence,
  BeliefStatus,
  StrategistLayer,
} from "./strategistApi";

export interface LedgerBelief {
  id: string;
  layer: StrategistLayer;
  statement: string;
  variable: string;
  value: string;
  direction: "increase" | "decrease";
  confidence: number;
  status: BeliefStatus;
  matching: number;
  evidence?: BeliefEvidence[];
  origin?: "model" | "pattern_scan";
  rationale?: string;
}

export const LANES: { layer: StrategistLayer; title: string; note: string }[] =
  [
    {
      layer: "craft",
      title: "Craft",
      note: "How a clip is made: hook, length, opening, captions, framing.",
    },
    {
      layer: "selection",
      title: "Selection",
      note: "Which moments the scouts should pick.",
    },
    {
      layer: "campaign",
      title: "Posting plan",
      note: "When to post.",
    },
  ];

const STATUS_LABEL: Record<BeliefStatus, string> = {
  proposed: "Proposed",
  testing: "Testing",
  supported: "Supported",
  weakened: "Weakened",
  retired: "Retired",
};

function shortId(id: string) {
  return id.replace(/^[a-z_]+_/, "").slice(-6);
}

export function EvidenceChip({ item }: { item: BeliefEvidence }) {
  const ratio =
    item.ratio === null ? "baseline 0" : `${item.ratio.toFixed(2)}× median`;
  return (
    <li
      className={`gf-strategist-chip is-${item.outcome}`}
      title={`Measured ${item.metric} ${item.value} vs account median ${item.baseline}${item.trigger === "demo_override" ? " (measured early by request)" : ""}`}
    >
      <span>post {shortId(item.publication_id)}</span>
      <span>
        {item.metric} {ratio}
      </span>
    </li>
  );
}

export function BeliefCard({
  belief,
  onRetire,
}: {
  belief: LedgerBelief;
  onRetire?: (id: string) => void;
}) {
  const percent = Math.round(Math.min(1, Math.max(0, belief.confidence)) * 100);
  return (
    <article
      className={`gf-strategist-belief is-${belief.status}`}
      data-testid="belief-card"
    >
      <header>
        <span className={`gf-strategist-pill is-${belief.status}`}>
          {STATUS_LABEL[belief.status]}
        </span>
        {belief.origin === "model" && (
          <span className="gf-strategist-origin">Suggested by local model</span>
        )}
      </header>
      <p className="gf-strategist-statement">{belief.statement}</p>
      <div
        className="gf-strategist-meter"
        role="meter"
        aria-label="Confidence"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}% confidence over ${belief.matching} measured post${belief.matching === 1 ? "" : "s"}`}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <small>
        {percent}% confidence · {belief.matching} measured post
        {belief.matching === 1 ? "" : "s"}
      </small>
      {belief.rationale && belief.origin === "model" && (
        <p className="gf-strategist-rationale">{belief.rationale}</p>
      )}
      {!!belief.evidence?.length && (
        <ul className="gf-strategist-chips" aria-label="Evidence">
          {belief.evidence.slice(-4).map((item) => (
            <EvidenceChip key={item.snapshot_id} item={item} />
          ))}
        </ul>
      )}
      {onRetire && belief.status !== "retired" && (
        <button
          type="button"
          className="gf-strategist-link"
          onClick={() => onRetire(belief.id)}
        >
          Retire belief
        </button>
      )}
    </article>
  );
}

export function BeliefLedger({
  beliefs,
  onRetire,
}: {
  beliefs: LedgerBelief[];
  onRetire?: (id: string) => void;
}) {
  return (
    <div className="gf-strategist-lanes">
      {LANES.map((lane) => {
        const rows = beliefs.filter((b) => b.layer === lane.layer);
        return (
          <section
            key={lane.layer}
            className={`gf-strategist-lane is-${lane.layer}`}
            aria-label={`${lane.title} beliefs`}
          >
            <h3>{lane.title}</h3>
            <p className="gf-strategist-note">{lane.note}</p>
            {rows.length ? (
              rows.map((belief) => (
                <BeliefCard
                  key={belief.id}
                  belief={belief}
                  onRetire={onRetire}
                />
              ))
            ) : (
              <p className="gf-strategist-empty">Nothing learned here yet.</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
