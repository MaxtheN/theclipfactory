import { useId, useRef, useState } from "react";
import { Icon } from "./Icon";
import "./pill-field.css";

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Merge option lists, first occurrence wins, ignoring case and blanks. */
export function uniqueOptions(...lists: (readonly (string | null | undefined)[] | undefined)[]): string[] {
  const out: string[] = [];
  for (const list of lists)
    for (const raw of list ?? []) {
      const v = (raw ?? "").trim();
      if (v && !out.some((o) => same(o, v))) out.push(v);
    }
  return out;
}

/**
 * Picks are stored in the formats fields already use, so nothing downstream changes:
 * "lines" is one item per line (rules, notes); "comma" is a comma list (audience, tone).
 * Splitting and joining are symmetric, so an existing typed value round-trips unchanged.
 */
export type ListFormat = "lines" | "comma";
export function splitList(text: string | null | undefined, format: ListFormat): string[] {
  const parts = (text ?? "").split(format === "lines" ? /\r?\n/ : /,\s*/);
  return parts.map((p) => p.trim()).filter(Boolean);
}
export function joinList(values: readonly string[], format: ListFormat): string {
  return values.join(format === "lines" ? "\n" : ", ");
}

/**
 * Choose from pills instead of typing. Tap to pick (or unpick); "Add your own" opens a
 * short input and whatever is typed becomes a pill too. `single` keeps one pick.
 */
export function PillField({
  label,
  hint,
  options,
  suggested,
  values,
  onChange,
  single = false,
  max,
  maxLength = 200,
  addLabel = "Add your own",
  placeholder = "Type and press Enter",
  disabled = false,
  className = "",
  labels,
  format,
  labelledBy,
}: {
  label: string;
  hint?: string;
  /** Presets for this field. */
  options: readonly string[];
  /** Brand-specific picks (for example read from the website); shown first. */
  suggested?: readonly (string | null | undefined)[];
  values: readonly string[];
  onChange: (values: string[]) => void;
  single?: boolean;
  max?: number;
  maxLength?: number;
  addLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Display text for stored values (for example metric keys). */
  labels?: Readonly<Record<string, string>>;
  /** Storage format, exposed as data-format for tests and tooling. */
  format?: ListFormat;
  /** Use an existing label elsewhere on the page instead of rendering one. */
  labelledBy?: string;
}) {
  const labelId = useId();
  const inputId = useId();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const addButton = useRef<HTMLButtonElement>(null);
  const choices = uniqueOptions(suggested, options);
  // A stored value matches a choice by its key or by its display label.
  const is = (choice: string, v: string) => same(choice, v) || (!!labels?.[choice] && same(labels[choice], v));
  const custom = values.filter((v) => !choices.some((c) => is(c, v)));
  const picked = (v: string) => values.some((x) => is(v, x) || same(x, v));
  const full = !single && max !== undefined && values.length >= max;

  function toggle(v: string) {
    if (picked(v)) onChange(single ? [] : values.filter((x) => !is(v, x) && !same(x, v)));
    else if (single) onChange([v]);
    else if (!full) onChange([...values, v]);
  }
  function commit(keepOpen: boolean) {
    const v = draft.trim();
    setDraft("");
    if (v) {
      const match = choices.find((c) => is(c, v)) ?? values.find((x) => same(x, v)) ?? v;
      if (single) onChange([match]);
      else if (!picked(match) && !full) onChange([...values, match]);
    }
    if (!keepOpen || single) {
      setAdding(false);
      requestAnimationFrame(() => addButton.current?.focus());
    }
  }

  const pill = (v: string, isCustom: boolean) => {
    const on = picked(v);
    const text = labels?.[v] ?? v;
    return (
      <button
        key={`${isCustom ? "c" : "o"}:${v}`}
        type="button"
        className={`gf-pill-choice${isCustom ? " is-custom" : ""}`}
        aria-pressed={on}
        data-value={v}
        aria-label={isCustom ? `${text}, remove` : undefined}
        disabled={disabled || (!on && full)}
        onClick={() => toggle(v)}
      >
        {on && <Icon name={isCustom ? "close" : "check"} size={13} />}
        <span className="gf-pill-choice-text">{text}</span>
      </button>
    );
  };

  return (
    <div className={`gf-field gf-pill-field ${className}`.trim()} role="group" aria-labelledby={labelledBy ?? labelId} data-format={format ?? (single ? "single" : undefined)}>
      {!labelledBy && <label id={labelId} htmlFor={adding ? inputId : undefined}>{label}</label>}
      <div className="gf-pill-field-options">
        {choices.map((v) => pill(v, false))}
        {custom.map((v) => pill(v, true))}
        {adding ? (
          <input
            id={inputId}
            className="gf-pill-field-input"
            autoFocus
            value={draft}
            maxLength={maxLength}
            placeholder={placeholder}
            aria-label={`${addLabel}: ${label}`}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commit(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit(true);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setDraft("");
                setAdding(false);
                requestAnimationFrame(() => addButton.current?.focus());
              }
            }}
          />
        ) : (
          !full && (
            <button
              ref={addButton}
              type="button"
              className="gf-pill-choice is-add"
              disabled={disabled}
              onClick={() => setAdding(true)}
            >
              <Icon name="plus" size={13} />
              <span className="gf-pill-choice-text">{addLabel}</span>
            </button>
          )
        )}
      </div>
      {hint && <small>{hint}</small>}
    </div>
  );
}

/** One pick stored as a plain string ("" when nothing is picked). */
export function PillSelect({
  value,
  onChange,
  ...rest
}: Omit<Parameters<typeof PillField>[0], "values" | "onChange" | "single" | "max"> & {
  value: string;
  onChange: (value: string) => void;
}) {
  return <PillField {...rest} single values={value.trim() ? [value] : []} onChange={(v) => onChange(v[0] ?? "")} />;
}

/** Many picks stored as one string in an existing list format. */
export function PillList({
  value,
  onChange,
  format,
  ...rest
}: Omit<Parameters<typeof PillField>[0], "values" | "onChange" | "single"> & {
  value: string;
  onChange: (value: string) => void;
  format: ListFormat;
}) {
  return <PillField {...rest} format={format} values={splitList(value, format)} onChange={(v) => onChange(joinList(v, format))} />;
}
