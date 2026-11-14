import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "./Icon";

export type QuickAction = {
  id: string;
  label: string;
  icon: string;
  group: "Campaign" | "Workspace";
  keywords?: string;
  disabled?: boolean;
  hint?: string;
  run: () => void;
};

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
  const filtered = actions.filter((action) =>
    `${action.label} ${action.keywords || ""}`
      .toLocaleLowerCase()
      .includes(normalized),
  );
  const available = filtered.filter((action) => !action.disabled);
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
          Search for a workspace view or action. Use arrow keys to
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
          {(["Campaign", "Workspace"] as const).map((group) => {
            const grouped = filtered.filter((action) => action.group === group);
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
          {!filtered.length && (
            <p role="status" className="gf-command-empty">
              No matching actions.
            </p>
          )}
        </div>
        <div className="gf-command-footer" aria-hidden="true">
          <span>↑ ↓ to move</span>
          <span>↵ to open</span>
          <span>Esc to close</span>
        </div>
      </div>
    </dialog>
  );
}
