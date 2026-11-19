import { useState } from "react";
import type { Direction, StrategyVersion } from "../types";
import { AutoTextarea } from "../components/AutoTextarea";
import { Icon } from "./Icon";
import { activeRulesId, type Workspace } from "./useCampaignWorkspace";
import { initialDirection, workspaceApi } from "./workspaceApi";

/** The few choices a new creator makes about how clips look and open. */
export interface ClipStyle {
  length: 30 | 45 | 60;
  opening: "teaser" | "straight";
  captions: "bold" | "clean";
  framing: "follow" | "full";
  titleCard: boolean;
  notes: string;
}

export const DEFAULT_CLIP_STYLE: ClipStyle = {
  length: 30,
  opening: "teaser",
  captions: "bold",
  framing: "follow",
  titleCard: true,
  notes: "",
};

/** Maps the choices onto a complete Style-rules direction. */
export function directionFromStyle(style: ClipStyle): Direction {
  const base = initialDirection();
  const notes = style.notes.trim().slice(0, 1500);
  return {
    ...base,
    duration_seconds: style.length,
    hooks:
      style.opening === "teaser"
        ? ["Payoff teaser first", "Claim first"]
        : ["Straight in", "Claim first"],
    pacing:
      style.opening === "teaser"
        ? "Open with a short tease of the payoff, then play the moment. Preserve the speaker's meaning."
        : "Start straight at the moment, point before setup. Preserve the speaker's meaning.",
    framing: style.framing === "follow" ? "fill" : "fit",
    caption_style: style.captions === "bold" ? "high_contrast" : "standard",
    editing_preferences: [
      style.captions === "bold"
        ? "Bold word-by-word captions."
        : "Clean, readable captions.",
      style.titleCard
        ? "Show the hook as a title card at the start."
        : "No hook title card.",
      "Original audio. No invented speech.",
      notes && `Creator notes: ${notes}`,
    ]
      .filter(Boolean)
      .join(" "),
    limitations:
      "Creator-chosen starting style. No audience improvement established yet.",
  };
}

/**
 * The creator's explicit approval: saves the style as a draft through the normal
 * propose path, then approves that exact draft. The server's stale-parent and
 * coverage checks still apply; nothing here approves without the creator's click.
 */
export async function approveClipStyle(
  profileId: string,
  base: string | null,
  style: ClipStyle,
): Promise<StrategyVersion> {
  const draft = await workspaceApi.propose(
    profileId,
    base,
    directionFromStyle(style),
    "Creator picked this starting clip style.",
  );
  if (!draft?.id) throw new Error("The clip style draft could not be confirmed.");
  return workspaceApi.approve(profileId, draft.id);
}

const choices: {
  key: keyof Omit<ClipStyle, "notes">;
  label: string;
  options: { value: ClipStyle[keyof ClipStyle]; label: string }[];
}[] = [
  {
    key: "length",
    label: "Length",
    options: [
      { value: 30, label: "~30s" },
      { value: 45, label: "45s" },
      { value: 60, label: "60s" },
    ],
  },
  {
    key: "opening",
    label: "Opening",
    options: [
      { value: "teaser", label: "Hook first, tease the payoff" },
      { value: "straight", label: "Straight in" },
    ],
  },
  {
    key: "captions",
    label: "Captions",
    options: [
      { value: "bold", label: "Bold, word by word" },
      { value: "clean", label: "Clean" },
    ],
  },
  {
    key: "framing",
    label: "Framing",
    options: [
      { value: "follow", label: "Follow the speaker" },
      { value: "full", label: "Full frame" },
    ],
  },
  {
    key: "titleCard",
    label: "Hook title card",
    options: [
      { value: true, label: "On" },
      { value: false, label: "Off" },
    ],
  },
];

export function ClipStylePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: ClipStyle;
  onChange: (next: ClipStyle) => void;
  disabled?: boolean;
}) {
  return (
    <div className="gf-clip-style">
      {choices.map((choice) => (
        <div className="gf-clip-style-row" key={choice.key} role="group" aria-label={choice.label}>
          <span className="gf-clip-style-label">{choice.label}</span>
          <div className="gf-clip-style-options">
            {choice.options.map((option) => (
              <button
                type="button"
                key={String(option.value)}
                className="gf-clip-style-option"
                aria-pressed={value[choice.key] === option.value}
                disabled={disabled}
                onClick={() => onChange({ ...value, [choice.key]: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      <label className="gf-clip-style-notes">
        <span className="gf-clip-style-label">Anything to always or never do?</span>
        <AutoTextarea
          rows={1}
          maxLength={1500}
          value={value.notes}
          disabled={disabled}
          placeholder="e.g. Never cut mid-sentence. Always keep the guest's name on screen."
          onChange={(e) => onChange({ ...value, notes: e.target.value })}
        />
      </label>
    </div>
  );
}

/** Inline sheet for a brand without approved Style rules: pick, approve, keep going. */
export function ClipStyleSheet({
  w,
  onFullRules,
}: {
  w: Workspace;
  /** Opens the full Style rules page instead. */
  onFullRules?: () => void;
}) {
  const [style, setStyle] = useState<ClipStyle>(DEFAULT_CLIP_STYLE);
  const blocked = w.busy || w.loading || !w.profileId;
  return (
    <section className="gf-card gf-clip-style-sheet" aria-label="Pick your clip style">
      <header>
        <div>
          <h2>Pick your clip style</h2>
        </div>
      </header>
      <ClipStylePicker value={style} onChange={setStyle} disabled={blocked} />
      <footer>
        {onFullRules && (
          <button
            type="button"
            className="gf-button ghost compact"
            disabled={w.busy}
            onClick={onFullRules}
          >
            Edit full style rules
          </button>
        )}
        <button
          type="button"
          className="gf-button secondary"
          disabled={blocked}
          onClick={() =>
            void w.run(
              () => approveClipStyle(w.profileId, activeRulesId(w), style),
              "Clip style approved. Find clips is ready.",
            )
          }
        >
          <Icon name="check" size={15} />
          Looks good — use this style
        </button>
      </footer>
    </section>
  );
}
