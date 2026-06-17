/**
 * The renderer's re-render hook. The panels own their own interaction state
 * (collapsed ids, in-flight spawns, the selected task, …) and need to redraw
 * from the last pushed state when that state changes — e.g. a chevron click.
 *
 * Rather than import the top-level `render` (which would import every panel
 * back, a cycle), the entry registers it here once via {@link setRenderer} and
 * records each rendered state via {@link setLastState}; panels then call
 * {@link requestRender} — the module-split stand-in for the old
 * `if (lastState) render(lastState)`.
 */
import type { PanelState } from "../panel-state.js";

/** The last rendered state, replayed when a panel requests a re-render (a click). */
let lastState: PanelState | undefined;
/** The top-level render fn, registered by the entry to break the panel→entry cycle. */
let renderFn: ((state: PanelState) => void) | undefined;

/** Register the top-level render (called once by the renderer entry). */
export function setRenderer(fn: (state: PanelState) => void): void {
  renderFn = fn;
}

/** Record the state just rendered, so a later {@link requestRender} can replay it. */
export function setLastState(state: PanelState): void {
  lastState = state;
}

/** Re-render from the last state — the panels' "something I own changed" hook. */
export function requestRender(): void {
  if (lastState && renderFn) renderFn(lastState);
}
