/**
 * Shared Dex task identity primitives, reused by the Dex pane and the Worktrees
 * pane (T7) so a task and its linked worktree read as the same "team color" and
 * speak the same status vocabulary across the fleet.
 *
 * These are the two pieces both panes need: {@link DEX_STATUS_LABEL} (the plain
 * status → human label map) and {@link DexTaskDot} (the solid identity-color
 * dot). Extracted out of the Dex pane into their own module so neither pane has
 * to import the other — the foundation the Dex sub-epic (T8a–T8f) and the
 * Worktrees port build on. Kept className/structure-equivalent to the DOM
 * builders they replace so `renderer.css` keeps applying unchanged.
 */
import type { CSSProperties } from "react";
import type { DexStatus } from "../dex-state.js";
import { dexTaskColor } from "@perch/sdk/dex-color";

/** Status → human label, shown in row tooltips and the Worktrees task chip. */
export const DEX_STATUS_LABEL: Record<DexStatus, string> = {
  ready: "Ready",
  "in-progress": "In progress",
  blocked: "Blocked",
  done: "Done",
};

/**
 * A small SOLID dot in a dex task's stable identity color — the primary
 * at-a-glance cue that matches a task to its linked worktree / agent. Mirrors
 * the `.tab-dot` status dot's sizing, but tinted with the per-task
 * {@link dexTaskColor} (the same source the id chip's faint fill uses) so a task
 * row and its worktree row visibly share one "team color". Rendered only for
 * open tasks, where that identity color is meaningful.
 */
export function DexTaskDot({ id }: { id: string }): JSX.Element {
  const style: CSSProperties = { background: dexTaskColor(id).hex };
  return <span className="dex-task-dot" style={style} />;
}
