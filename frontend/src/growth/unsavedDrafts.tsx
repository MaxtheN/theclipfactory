import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { PanelDialog } from "./PanelDialog";
import "./unsaved.css";

/** An edit the creator has made but not saved. Screens register one while it is dirty. */
export type UnsavedDraft = {
  /** Stable per screen and record, e.g. `brand-profile` or `post-caption`. */
  id: string;
  /** The stage that holds the draft. */
  screen: string;
  /** What the creator would lose, e.g. "Brand profile". */
  label: string;
  /** The record the draft belongs to, when the screen can show another one (a clip id). */
  record?: string;
  /** Saves the draft; resolves false when it was not saved. Absent when the draft cannot be saved on its own. */
  save?: () => Promise<boolean>;
  /** Drops the edits and returns the screen to its saved state. */
  discard: () => void;
};
export type DraftFilter = (draft: UnsavedDraft) => boolean;

type DraftApi = { set: (draft: UnsavedDraft) => void; clear: (id: string) => void };
const DraftContext = createContext<DraftApi | null>(null);

type Prompt = { reason: string; drafts: UnsavedDraft[]; resolve: (proceed: boolean) => void };

/**
 * The shell's Unsaved Draft registry. Moving between destinations keeps drafts, because their
 * screens stay mounted; `guard` asks before anything that would drop one (a campaign switch, leaving
 * a form that closes). Discard is the only way a draft is dropped.
 */
export function useDraftRegistry() {
  const [drafts, setDrafts] = useState<Map<string, UnsavedDraft>>(() => new Map());
  const latest = useRef(drafts);
  latest.current = drafts;
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState("");

  const api = useMemo<DraftApi>(
    () => ({
      set: (draft) =>
        setDrafts((old) => {
          const next = new Map(old);
          next.set(draft.id, draft);
          return next;
        }),
      clear: (id) =>
        setDrafts((old) => {
          if (!old.has(id)) return old;
          const next = new Map(old);
          next.delete(id);
          return next;
        }),
    }),
    [],
  );

  /**
   * True at once when no matching draft exists, so navigation stays synchronous. Otherwise asks, and
   * resolves true once the drafts were saved or discarded, false when the creator stays.
   */
  const guard = useCallback(
    (reason: string, filter: DraftFilter = () => true): true | Promise<boolean> => {
      const matched = [...latest.current.values()].filter(filter);
      if (!matched.length) return true;
      return new Promise<boolean>((resolve) => {
        setFailure("");
        setPrompt({ reason, drafts: matched, resolve });
      });
    },
    [],
  );

  // Closing the window warns while anything is unsaved.
  const dirty = drafts.size > 0;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function finish(proceed: boolean) {
    if (!prompt) return;
    prompt.resolve(proceed);
    setPrompt(null);
    setFailure("");
  }
  async function saveAll() {
    if (!prompt || saving) return;
    setSaving(true);
    setFailure("");
    const unsaved: string[] = [];
    for (const draft of prompt.drafts) {
      let ok = false;
      try {
        ok = !!(await draft.save?.());
      } catch {
        ok = false;
      }
      if (ok) api.clear(draft.id);
      else unsaved.push(draft.label);
    }
    setSaving(false);
    if (unsaved.length) setFailure(`Couldn't save ${unsaved.join(", ")}. Your edits are still here.`);
    else finish(true);
  }
  function discardAll() {
    if (!prompt) return;
    for (const draft of prompt.drafts) {
      draft.discard();
      api.clear(draft.id);
    }
    finish(true);
  }

  const canSave = !!prompt && prompt.drafts.every((d) => d.save);
  const dialog = (
    <PanelDialog
      open={!!prompt}
      onClose={() => !saving && finish(false)}
      title="Unsaved changes"
      description={prompt?.reason}
    >
      <div className="gf-unsaved-dialog">
        <p>These edits are not saved:</p>
        <ul aria-label="Unsaved drafts">
          {prompt?.drafts.map((d) => <li key={d.id}>{d.label}</li>)}
        </ul>
        {!canSave && <p className="gf-help">Some of these can't be saved on their own. Stay to finish them, or discard them.</p>}
        {failure && <p className="gf-inline-error" role="alert">{failure}</p>}
        <div className="gf-unsaved-actions">
          <button type="button" className="gf-button ghost compact" disabled={saving} onClick={() => finish(false)}>
            Stay
          </button>
          <button type="button" className="gf-button secondary compact" disabled={saving} onClick={discardAll}>
            Discard
          </button>
          {canSave && (
            <button type="button" className="gf-button compact" disabled={saving} onClick={() => void saveAll()}>
              {saving ? "Saving…" : "Save"}
            </button>
          )}
        </div>
      </div>
    </PanelDialog>
  );

  return { drafts: [...drafts.values()], api, guard, dialog };
}

export function UnsavedDraftProvider({ api, children }: { api: DraftApi; children: ReactNode }) {
  return <DraftContext.Provider value={api}>{children}</DraftContext.Provider>;
}

/** Registers `draft` while `dirty` is true. Outside the shell (tests, previews) it does nothing. */
export function useUnsavedDraft(dirty: boolean, draft: UnsavedDraft) {
  const api = useContext(DraftContext);
  const latest = useRef(draft);
  latest.current = draft;
  const { id, screen, label, record } = draft;
  const canSave = !!draft.save;
  useEffect(() => {
    if (!api || !dirty) return;
    api.set({
      id,
      screen,
      label,
      record,
      save: canSave ? () => latest.current.save?.() ?? Promise.resolve(false) : undefined,
      discard: () => latest.current.discard(),
    });
    return () => api.clear(id);
  }, [api, dirty, id, screen, label, record, canSave]);
}

/** The visible "Not saved" marker a screen shows while it holds an Unsaved Draft. */
export function UnsavedNote({ children = "Not saved" }: { children?: ReactNode }) {
  return (
    <span className="gf-unsaved-note">
      <span className="gf-unsaved-dot" aria-hidden="true" />
      {children}
    </span>
  );
}
