/**
 * Shared renderer primitives used across the per-panel modules: the `byId` DOM
 * lookup, the generic chip/badge builders, the centered message/loading
 * renderers, and the health-icon maps. Pure DOM building — no panel-specific
 * state — so a panel feature touches its own module, not this one.
 */
import type { Health } from "../panel-state.js";

/**
 * The health marker is a distinct Font Awesome *shape* per state (not just a
 * color), so it's legible without relying on the red/green hue a colorblind
 * viewer can't separate: a check, a warning triangle, and an x.
 */
export const HEALTH_ICON: Record<Health, string> = {
  ok: "circle-check",
  warn: "triangle-exclamation",
  bad: "circle-xmark",
};
export const HEALTH_LABEL: Record<Health, string> = {
  ok: "Clean",
  warn: "Review comments to address",
  bad: "Needs attention",
};

export function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

/** Build a status chip element, optionally led by a (spinning) Font Awesome icon. */
export function chipEl(chip: {
  label: string;
  tone: string;
  hint: string;
  icon?: string;
  spin?: boolean;
}): HTMLElement {
  const el = document.createElement("span");
  el.className = `chip ${chip.tone}`;
  el.title = chip.hint;
  if (chip.icon) {
    const i = document.createElement("i");
    i.className = `fa-solid fa-${chip.icon}${chip.spin ? " fa-spin" : ""}`;
    el.append(i, ` ${chip.label}`);
  } else {
    el.textContent = chip.label;
  }
  return el;
}

/** Build a badge element (needs-rebase / conflict). */
export function badgeEl(kind: "rebase" | "conflict", label: string, hint: string): HTMLElement {
  const el = document.createElement("span");
  el.className = `badge ${kind}`;
  el.textContent = label;
  el.title = hint;
  return el;
}

/** Render a centered message (empty / daemon-down / error). */
export function messageEl(text: string, isError: boolean): HTMLElement {
  const el = document.createElement("div");
  el.className = isError ? "message error" : "message";
  el.textContent = text;
  return el;
}

/** Render the initial loading state: a spinner alongside the message. */
export function loadingEl(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "message";
  const spinner = document.createElement("i");
  spinner.className = "fa-solid fa-circle-notch fa-spin";
  el.append(spinner, ` ${text}`);
  return el;
}
