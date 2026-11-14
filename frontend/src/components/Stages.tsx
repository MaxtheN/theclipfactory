import type { FactorySource, FactoryStage } from "../types";

const stageWords: Record<FactoryStage["status"], string> = {
  done: "done",
  active: "in progress",
  pending: "not started",
  skipped: "skipped",
  failed: "failed",
};

/** Where one source is on the production line, with the detail of the step it is on. */
export function Stages({ source }: { source: FactorySource }) {
  const stages = Array.isArray(source.stages) ? source.stages : [];
  const current = stages.find((stage) => stage.status === "failed" || stage.status === "active");
  if (!stages.length) return null;
  return (
    <>
      <ol className="stage-track" aria-label={`Progress for ${source.name}`}>
        {stages.map((stage) => (
          <li
            key={stage.key}
            data-status={stage.status}
            aria-current={stage.status === "active" ? "step" : undefined}
          >
            <span className="stage-dot" aria-hidden="true" />
            <span className="stage-label">{stage.label}</span>
            <span className="visually-hidden">, {stageWords[stage.status] ?? stage.status}</span>
          </li>
        ))}
      </ol>
      {current?.detail && (
        <p className={current.status === "failed" ? "stage-detail error-text" : "stage-detail"}>
          {current.detail}
        </p>
      )}
    </>
  );
}
