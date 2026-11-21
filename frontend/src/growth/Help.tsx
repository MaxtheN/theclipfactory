import { CircleHelp } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { HELP_EVENT, guideLink, type GuidePage } from "./guideLinks";
import { helpApi } from "./helpApi";
import "./help.css";

type State = { status: "idle" | "opening" | "opened" } | { status: "link"; url: string };

/** Sidebar "Help": opens the user guide in the browser; when that is not possible, offers the link. */
export function HelpButton({ disabled = false }: { disabled?: boolean }) {
  const [state, setState] = useState<State>({ status: "idle" });

  const open = useCallback(async (page: GuidePage = "", anchor = "") => {
    setState({ status: "opening" });
    try {
      const link = await helpApi.open(page, anchor);
      setState(link.opened ? { status: "opened" } : { status: "link", url: link.url });
    } catch {
      setState({ status: "link", url: guideLink(page, anchor) });
    }
  }, []);

  useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ page?: GuidePage; anchor?: string }>).detail ?? {};
      void open(detail.page ?? "", detail.anchor ?? "");
    };
    window.addEventListener(HELP_EVENT, onRequest);
    return () => window.removeEventListener(HELP_EVENT, onRequest);
  }, [open]);

  useEffect(() => {
    if (state.status !== "opened") return;
    const timer = window.setTimeout(() => setState({ status: "idle" }), 4000);
    return () => window.clearTimeout(timer);
  }, [state.status]);

  return (
    <div className="gf-help">
      <button
        type="button"
        className="gf-channel-settings gf-help-button"
        title="Help · user guide"
        disabled={disabled || state.status === "opening"}
        onClick={() => void open()}
      >
        <CircleHelp size={17} strokeWidth={1.6} aria-hidden="true" />
        <span>Help</span>
      </button>
      {state.status === "opened" && (
        <p className="gf-help-note" role="status">The guide opened in your browser.</p>
      )}
      {state.status === "link" && (
        <p className="gf-help-note" role="status">
          Couldn’t open your browser. Open the guide at{" "}
          <a href={state.url} target="_blank" rel="noopener noreferrer">{state.url.replace(/^https?:\/\//, "")}</a>
          <button type="button" className="gf-help-dismiss" aria-label="Dismiss" onClick={() => setState({ status: "idle" })}>×</button>
        </p>
      )}
    </div>
  );
}
