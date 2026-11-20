import { createElement, Profiler, type ComponentType, type ProfilerOnRenderCallback } from "react";

/** Commits and render time per profiled subtree since the last reset. */
export type Sample = { commits: number; ms: number };
export const samples = new Map<string, Sample>();

export const onRender: ProfilerOnRenderCallback = (id, _phase, actualDuration) => {
  const row = samples.get(id) ?? { commits: 0, ms: 0 };
  row.commits += 1;
  row.ms += actualDuration;
  samples.set(id, row);
};

export function resetSamples() {
  samples.clear();
}

/**
 * Replace the named exports of a module with the same component inside a React Profiler, so a
 * benchmark can see which screens re-render on a poll tick or keystroke. Names that are not
 * functions (types, constants) are left alone.
 */
export function profiled<M extends Record<string, unknown>>(mod: M, names: string[]): M {
  const out: Record<string, unknown> = { ...mod };
  for (const name of names) {
    const Component = mod[name];
    if (typeof Component !== "function") continue;
    const Wrapped = (props: Record<string, unknown>) =>
      createElement(Profiler, { id: name, onRender }, createElement(Component as ComponentType, props));
    Wrapped.displayName = `Profiled(${name})`;
    out[name] = Wrapped;
  }
  return out as M;
}
