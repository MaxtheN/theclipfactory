import { Icon } from "./Icon";

const steps = [
  { icon: "upload", title: "Add your footage", detail: "Start with the original story." },
  { icon: "studio", title: "Produce & review", detail: "Agents shape clips. You approve." },
  { icon: "results", title: "Learn & refine", detail: "Use feedback to guide the next edit." },
];

/** An explanation, not a progress indicator or a claim about completed work. */
export function FactoryWorkflow({ compact = false }: { compact?: boolean }) {
  return (
    <ol className={`gf-factory-workflow${compact ? " is-compact" : ""}`} aria-label="Factory workflow">
      {steps.map((step, index) => (
        <li key={step.title}>
          <span className="gf-workflow-icon"><Icon name={step.icon} size={20} /></span>
          <div>
            <span className="gf-workflow-number">0{index + 1}</span>
            <strong>{step.title}</strong>
            <p>{step.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
