/**
 * Preserve keyboard focus + caret across the renderer's full DOM rebuild.
 *
 * The top-level `render()` rebuilds the panel body via `rowsEl.replaceChildren()`
 * on every state push — including the periodic (~5s) board poll — which throws
 * away the focused node mid-type. In-panel text fields (the Dex composer + the
 * edit-mode name/description inputs) tag themselves with a stable
 * {@link FOCUS_KEY_ATTR}; capturing the active field's key + selection BEFORE the
 * rebuild and restoring them AFTER keeps typing uninterrupted. Focus is restored
 * only when the panel already owned it (the active element is inside the rebuilt
 * container), so a refresh never steals focus from another window or field, and
 * the real caret/selection is carried over rather than jumping to the end.
 *
 * Lives in its own module — rather than inline in `renderer.ts` — so the logic is
 * unit-testable against duck-typed fakes (the renderer has no jsdom harness).
 */

/** The data attribute an in-panel field sets to opt into focus preservation. */
export const FOCUS_KEY_ATTR = "data-focus-key";

/** The minimal shape of a text field whose focus + caret we preserve. */
export interface PreservableField {
  selectionStart: number | null;
  selectionEnd: number | null;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
}

/** The minimal shape of the rebuilt container (the panel body). */
export interface FocusContainer {
  contains(node: Node | null): boolean;
  querySelector(selectors: string): Element | null;
}

/** A focus position captured just before a rebuild, keyed by a stable attribute. */
export interface CapturedFocus {
  /** The active field's `data-focus-key` — stable across the rebuild. */
  key: string;
  /** The selection start/end at capture time (null when unsupported). */
  start: number | null;
  end: number | null;
}

/**
 * Capture the focused in-panel field, if any. Returns `null` unless the active
 * element is inside `container` AND carries a {@link FOCUS_KEY_ATTR} — so focus
 * the panel doesn't already own is never restored.
 */
export function captureFieldFocus(
  active: Element | null,
  container: FocusContainer,
): CapturedFocus | null {
  if (!active || !container.contains(active)) return null;
  const key = active.getAttribute(FOCUS_KEY_ATTR);
  if (!key) return null;
  const field = active as unknown as PreservableField;
  return { key, start: field.selectionStart ?? null, end: field.selectionEnd ?? null };
}

/**
 * Restore a {@link captureFieldFocus} result onto the rebuilt DOM: re-focus the
 * new node carrying the same key and re-apply the saved selection. A no-op when
 * nothing was captured or the keyed field is gone (e.g. the user navigated away).
 */
export function restoreFieldFocus(captured: CapturedFocus | null, container: FocusContainer): void {
  if (!captured) return;
  const found = container.querySelector(`[${FOCUS_KEY_ATTR}="${captured.key}"]`);
  if (!found) return;
  const field = found as unknown as PreservableField;
  field.focus();
  if (captured.start !== null && captured.end !== null) {
    try {
      field.setSelectionRange(captured.start, captured.end);
    } catch {
      // Some field types reject setSelectionRange; focus alone is enough.
    }
  }
}
