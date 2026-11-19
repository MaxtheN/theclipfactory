import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "./Icon";

export type QuickAction = {
  id: string;
  label: string;
  icon: string;
  group: "Clips" | "Brand" | "App";
  keywords?: string;
  disabled?: boolean;
  hint?: string;
  run: () => void;
};

const RECENT_KEY = "gf-quick-recent-v1";
function readRecent(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(value) ? value.filter((v) => typeof v === "string").slice(0, 3) : [];
  } catch {
    return [];
  }
}
function rememberRecent(id: string) {
  try {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([id, ...readRecent().filter((v) => v !== id)].slice(0, 3)),
    );
  } catch {
    /* convenience only */
  }
}
/** Spotlight-style ranking: prefix, word start, substring, keyword, then loose letters in order. */
export function matchScore(action: Pick<QuickAction, "label" | "keywords">, query: string) {
  if (!query) return 1;
  const label = action.label.toLocaleLowerCase();
  if (label.startsWith(query)) return 5;
  if (label.split(/\s+/).some((word) => word.startsWith(query))) return 4;
  if (label.includes(query)) return 3;
  if ((action.keywords || "").toLocaleLowerCase().includes(query)) return 2;
  if (query.length < 2) return 0;
  let at = 0;
  for (const char of label) if (char === query[at]) at++;
  return at === query.length ? 1 : 0;
}

export function QuickActions({
  open,
  onDismiss,
  actions,
}: {
  open: boolean;
  onDismiss: () => void;
  actions: QuickAction[];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const id = useId();
  const listId = `${id}-actions`;
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const normalized = query.trim().toLocaleLowerCase();
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const ranked = actions
    .map((action, index) => ({ action, index, score: matchScore(action, normalized) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.action);
  // With no query, the last few actions come first under "Recent".
  const recent = normalized
    ? []
    : recentIds
        .map((rid) => actions.find((action) => action.id === rid && !action.disabled))
        .filter((action): action is QuickAction => !!action);
  const filtered = ranked.filter((action) => !recent.includes(action));
  const sections: { label: string; items: QuickAction[] }[] = [
    { label: "Recent", items: recent },
    ...(["Clips", "Brand", "App"] as const).map((group) => ({
      label: group,
      items: filtered.filter((action) => action.group === group),
    })),
  ];
  const available = sections
    .flatMap((section) => section.items)
    .filter((action) => !action.disabled);
  const active =
    available.find((action) => action.id === selectedId) || available[0];
  const optionId = (action: QuickAction) => `${id}-action-${action.id}`;

  function restoreFocus() {
    const element = previousFocus.current;
    previousFocus.current = null;
    if (element?.isConnected) element.focus();
  }

  function closeAndRestore() {
    if (dialog.current?.open) dialog.current.close();
    restoreFocus();
  }

  function dismiss() {
    closeAndRestore();
    onDismiss();
  }

  function run(action: QuickAction) {
    if (action.disabled) return;
    // Restore the opener before navigation. A subsequent heading focus must
    // not be overwritten by the dialog's controlled-close effect.
    dismiss();
    rememberRecent(action.id);
    action.run();
  }

  useEffect(() => {
    if (open) {
      previousFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setQuery("");
      setSelectedId(null);
      setRecentIds(readRecent());
      if (!dialog.current?.open) dialog.current?.showModal();
      input.current?.focus();
    } else closeAndRestore();
  }, [open]);

  useEffect(() => {
    const element = dialog.current;
    return () => {
      if (element?.open) element.close();
      restoreFocus();
    };
  }, []);

  useEffect(() => {
    if (open && active)
      document
        .getElementById(optionId(active))
        ?.scrollIntoView?.({ block: "nearest" });
  }, [open, active?.id]);

  function navigate(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!available.length) return;
      const index = available.findIndex((action) => action.id === active?.id);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const next = (index + direction + available.length) % available.length;
      setSelectedId(available[next].id);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active) run(active);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="gf-command-dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div className="gf-command-panel">
        <h2 id={titleId} className="gf-command-sr-only">
          Quick actions
        </h2>
        <p id={descriptionId} className="gf-command-sr-only">
          Search for a page or action. Use arrow keys to
          choose and Enter to open.
        </p>
        <div className="gf-command-search">
          <Icon name="research" size={20} />
          <input
            ref={input}
            role="combobox"
            aria-label="Search quick actions"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={active ? optionId(active) : undefined}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Search actions…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedId(null);
            }}
            onKeyDown={navigate}
          />
          <button
            type="button"
            className="gf-command-close"
            aria-label="Close quick actions"
            onClick={dismiss}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        <div
          id={listId}
          role="listbox"
          aria-label="Quick actions"
          className="gf-command-list"
        >
          {sections.map(({ label: group, items: grouped }) => {
            if (!grouped.length) return null;
            return (
              <div
                key={group}
                role="group"
                aria-label={group}
                className="gf-command-group"
              >
                <div className="gf-command-group-label" aria-hidden="true">
                  {group}
                </div>
                {grouped.map((action) => (
                  <button
                    key={action.id}
                    id={optionId(action)}
                    type="button"
                    role="option"
                    aria-selected={active?.id === action.id}
                    aria-disabled={action.disabled || undefined}
                    disabled={action.disabled}
                    tabIndex={-1}
                    className={`gf-command-option${active?.id === action.id ? " selected" : ""}`}
                    onMouseEnter={() => {
                      if (!action.disabled) setSelectedId(action.id);
                    }}
                    onClick={() => run(action)}
                  >
                    <Icon name={action.icon} size={18} />
                    <span className="gf-command-option-copy">
                      <strong>{action.label}</strong>
                      {action.hint && <small>{action.hint}</small>}
                    </span>
                    {active?.id === action.id && (
                      <span className="gf-command-enter" aria-hidden="true">
                        ↵
                      </span>
                    )}
                  </button>
                ))}
              </div>
            );
          })}
          {!filtered.length && !recent.length && (
            <p role="status" className="gf-command-empty">
              No matching actions.
            </p>
          )}
        </div>
        <div className="gf-command-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
          <span className="gf-command-footer-spacer" />
          <span><kbd>⌘</kbd><kbd>K</kbd> toggle</span>
        </div>
      </div>
    </dialog>
  );
}
