// Test helpers for PillField: drive pickers the way a person would (unpick, add your own).
import { fireEvent, screen, within } from "@testing-library/react";

type Scope = Pick<typeof screen, "getByRole">;

export function pillGroup(name: string | RegExp, scope: Scope = screen): HTMLElement {
  return scope.getByRole("group", { name });
}

function pressed(group: HTMLElement) {
  return [...group.querySelectorAll<HTMLButtonElement>('button[aria-pressed="true"]')];
}

/** The stored string, in the field's own format (comma list, lines or a single value). */
export function pillValue(name: string | RegExp, scope: Scope = screen): string {
  const group = pillGroup(name, scope);
  const values = pressed(group).map((b) => b.dataset.value ?? "");
  return values.join(group.dataset.format === "lines" ? "\n" : ", ");
}

/** Pick a preset by its visible text. */
export function pickPill(name: string | RegExp, option: string | RegExp, scope: Scope = screen) {
  fireEvent.click(within(pillGroup(name, scope)).getByRole("button", { name: option }));
}

/**
 * Replace the picks with typed values via "Add your own" ("" just clears). Line-format
 * fields get one pill per line, as a person would add them.
 */
export function setPills(name: string | RegExp, value: string, scope: Scope = screen) {
  const group = pillGroup(name, scope);
  for (let on = pressed(group)[0]; on; on = pressed(group)[0]) fireEvent.click(on);
  const items = group.dataset.format === "lines" ? value.split("\n").filter((v) => v.trim()) : value ? [value] : [];
  if (!items.length) return;
  const add = group.querySelector<HTMLButtonElement>("button.is-add");
  if (!add) throw new Error(`No "Add your own" on ${String(name)}`);
  fireEvent.click(add);
  for (const item of items) {
    const input = group.querySelector<HTMLInputElement>("input.gf-pill-field-input");
    if (!input) break;
    fireEvent.change(input, { target: { value: item } });
    fireEvent.keyDown(input, { key: "Enter" });
  }
  const open = group.querySelector<HTMLInputElement>("input.gf-pill-field-input");
  if (open) fireEvent.blur(open);
}

/** Every control in the picker is disabled. */
export function pillsDisabled(name: string | RegExp, scope: Scope = screen): boolean {
  const buttons = [...pillGroup(name, scope).querySelectorAll("button")];
  return buttons.length > 0 && buttons.every((b) => b.disabled);
}

/** Add one typed value to the existing picks via "Add your own". */
export function addPill(name: string | RegExp, value: string, scope: Scope = screen) {
  const group = pillGroup(name, scope);
  const add = group.querySelector<HTMLButtonElement>("button.is-add");
  if (!add) throw new Error(`No "Add your own" on ${String(name)}`);
  fireEvent.click(add);
  const input = group.querySelector<HTMLInputElement>("input.gf-pill-field-input")!;
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
  const open = group.querySelector<HTMLInputElement>("input.gf-pill-field-input");
  if (open) fireEvent.blur(open);
}
