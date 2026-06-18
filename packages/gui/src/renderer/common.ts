/**
 * Shared renderer primitives: the `byId` DOM lookup the React entry mounts onto,
 * and the health-icon maps the panes draw their status markers from. Pure, with
 * no panel-specific state.
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
