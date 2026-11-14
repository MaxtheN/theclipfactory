import { Field } from "./parts";
import type { CraftRequest } from "./productionContracts";
import { ExtensionToggles } from "./FactoryUpgrades";

/** Editing-craft options for a manual render (backend: clip_factory/craft.py). One line each. */
export type CraftValues = Required<Pick<CraftRequest, "structure" | "jump_cuts" | "loudness" | "hook_format" | "caption_emphasis" | "punch_in" | "cover" | "crop_focus">> & { cta_text: string };
export type AbVariable = "" | "structure" | "hook_format" | "caption_style";
/** extensions: merged renderer extensions to draw; undefined until the person toggles one (revisions inherit). */
export interface CraftState { values: CraftValues; touched: (keyof CraftValues)[]; ab: AbVariable; extensions?: Record<string, Record<string, unknown>> }

export const CRAFT_DEFAULTS: CraftValues = {
  structure: "auto", jump_cuts: "silences", loudness: "normalize", hook_format: "title_card",
  caption_emphasis: "keywords", punch_in: "off", cover: "best_frame", crop_focus: "auto_face", cta_text: "",
};
// What plans saved before these options existed were rendered with.
const LEGACY: CraftValues = {
  structure: "linear", jump_cuts: "off", loudness: "off", hook_format: "overlay",
  caption_emphasis: "off", punch_in: "off", cover: "first_frame", crop_focus: "fixed", cta_text: "",
};
const AB_VALUES: Record<Exclude<AbVariable, "">, string[]> = {
  structure: ["hook_first", "linear"], hook_format: ["title_card", "overlay"], caption_style: ["pop", "standard"],
};

export const freshCraft = (): CraftState => ({ values: { ...CRAFT_DEFAULTS }, touched: [], ab: "" });

/** A revision starts from what its parent was rendered with; nothing is touched yet. */
export function craftFromPlan(plan: Record<string, unknown> | null | undefined): CraftState {
  const values = { ...LEGACY };
  for (const key of Object.keys(LEGACY) as (keyof CraftValues)[]) {
    const value = plan?.[key];
    if (typeof value === "string") (values as unknown as Record<string, string>)[key] = value;
  }
  return { values, touched: [], ab: "" };
}

/** Only options the person changed are sent, so revisions inherit the rest from their parent. */
export function craftPlan(state: CraftState): CraftRequest {
  const out: Record<string, unknown> = {};
  for (const key of state.touched) {
    if (key === "cta_text") {
      const text = state.values.cta_text.trim();
      out.cta_text = text;
      out.end_card = text ? "cta" : "none";
    } else out[key] = state.values[key];
  }
  if (state.ab) out.variants = { variable: state.ab, values: AB_VALUES[state.ab] };
  if (state.extensions) out.extensions = state.extensions;
  return out as CraftRequest;
}

export function CraftControls({ value, onChange }: { value: CraftState; onChange: (next: CraftState) => void }) {
  const set = <K extends keyof CraftValues>(key: K, next: CraftValues[K]) =>
    onChange({ ...value, values: { ...value.values, [key]: next }, touched: value.touched.includes(key) ? value.touched : [...value.touched, key] });
  const v = value.values;
  const toggle = (key: "loudness" | "caption_emphasis" | "punch_in" | "cover" | "crop_focus", on: string, off: string, label: string) =>
    <Field label={label}>{id => <input id={id} type="checkbox" checked={v[key] === on} onChange={e => set(key, (e.target.checked ? on : off) as never)} />}</Field>;
  return <>
    <Field label="Story structure">{id => <select id={id} value={v.structure} onChange={e => set("structure", e.target.value as CraftValues["structure"])}><option value="auto">Hook first when a payoff exists</option><option value="hook_first">Hook first (payoff teaser)</option><option value="linear">In order</option></select>}</Field>
    <Field label="Tighten pauses">{id => <select id={id} value={v.jump_cuts} onChange={e => set("jump_cuts", e.target.value as CraftValues["jump_cuts"])}><option value="silences">Cut long pauses</option><option value="silences_and_fillers">Cut pauses and um/uh</option><option value="off">Keep every pause</option></select>}</Field>
    <Field label="Hook look">{id => <select id={id} value={v.hook_format} onChange={e => set("hook_format", e.target.value as CraftValues["hook_format"])}><option value="title_card">Title card (2 s)</option><option value="overlay">Text strip (3 s)</option></select>}</Field>
    {toggle("caption_emphasis", "keywords", "off", "Emphasise key words")}
    {toggle("punch_in", "emphasis", "off", "Punch-in on key words")}
    {toggle("loudness", "normalize", "off", "Normalise loudness (−14 LUFS)")}
    {toggle("cover", "best_frame", "first_frame", "Pick the best cover frame")}
    {toggle("crop_focus", "auto_face", "fixed", "Follow the speaker's face (9:16 crop)")}
    <Field label="End card call to action">{id => <input id={id} type="text" maxLength={80} placeholder="None" value={v.cta_text} onChange={e => set("cta_text", e.target.value)} />}</Field>
    <ExtensionToggles value={value.extensions ?? {}} onChange={extensions => onChange({ ...value, extensions })} />
    <Field label="A/B variants">{id => <select id={id} value={value.ab} onChange={e => onChange({ ...value, ab: e.target.value as AbVariable })}><option value="">One version</option><option value="structure">Hook first vs in order</option><option value="hook_format">Title card vs text strip</option><option value="caption_style">Word-pop vs plain captions</option></select>}</Field>
  </>;
}
