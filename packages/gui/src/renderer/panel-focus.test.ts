/**
 * Unit tests for the focus/caret preservation that survives the renderer's full
 * DOM rebuild (the ~5s board poll). The renderer has no jsdom harness, so we
 * exercise {@link captureFieldFocus}/{@link restoreFieldFocus} against duck-typed
 * fakes that stand in for the active element and the rebuilt panel container.
 *
 * Regression target: a board poll mid-type used to recreate the focused field
 * (composer textarea, edit name/description) unfocused with the caret reset —
 * typing silently stopped until the user clicked back in.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { captureFieldFocus, restoreFieldFocus, FOCUS_KEY_ATTR } from "./panel-focus.js";

/** A minimal stand-in for an in-panel text field. */
class FakeField {
  focused = false;
  selectionStart: number | null;
  selectionEnd: number | null;
  constructor(
    private readonly key: string | null,
    start: number | null = 0,
    end: number | null = 0,
  ) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  getAttribute(name: string): string | null {
    return name === FOCUS_KEY_ATTR ? this.key : null;
  }
  focus(): void {
    this.focused = true;
  }
  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

/** A minimal stand-in for the rebuilt panel body (`rowsEl`). */
class FakeContainer {
  constructor(private readonly fields: FakeField[]) {}
  contains(node: unknown): boolean {
    return this.fields.includes(node as FakeField);
  }
  querySelector(selectors: string): Element | null {
    const key = selectors.match(/data-focus-key="(.+)"\]/)?.[1];
    return (this.fields.find((f) => f.getAttribute(FOCUS_KEY_ATTR) === key) ??
      null) as unknown as Element | null;
  }
}

const asActive = (f: FakeField): Element => f as unknown as Element;

test("focus + real caret are restored onto the rebuilt node", () => {
  // Typing mid-string: caret at [3, 5] when the poll fires.
  const before = new FakeField("dex-new-input", 3, 5);
  const captured = captureFieldFocus(asActive(before), new FakeContainer([before]));
  assert.deepEqual(captured, { key: "dex-new-input", start: 3, end: 5 });

  // The rebuild: a brand-new node with the same key and the caret reset to 0.
  const after = new FakeField("dex-new-input", 0, 0);
  restoreFieldFocus(captured, new FakeContainer([after]));

  assert.equal(after.focused, true, "rebuilt field should regain focus");
  assert.equal(after.selectionStart, 3, "caret start should be restored (not jumped to end)");
  assert.equal(after.selectionEnd, 5, "caret end should be restored");
});

test("focus is not stolen when the active element is outside the panel", () => {
  // A field focused elsewhere (e.g. another window/field) — not in the container.
  const outside = new FakeField("dex-new-input", 1, 2);
  const captured = captureFieldFocus(asActive(outside), new FakeContainer([]));
  assert.equal(captured, null);

  // Restoring a null capture must not focus the panel's field.
  const panelField = new FakeField("dex-new-input");
  restoreFieldFocus(captured, new FakeContainer([panelField]));
  assert.equal(panelField.focused, false);
});

test("a focused element without a focus key is ignored", () => {
  const button = new FakeField(null);
  assert.equal(captureFieldFocus(asActive(button), new FakeContainer([button])), null);
});

test("a null active element captures nothing", () => {
  assert.equal(captureFieldFocus(null, new FakeContainer([])), null);
});

test("restore is a no-op when the keyed field is gone after the rebuild", () => {
  const before = new FakeField("dex-edit-name", 4, 4);
  const captured = captureFieldFocus(asActive(before), new FakeContainer([before]));
  // The user navigated away: the rebuilt panel no longer has that field.
  assert.doesNotThrow(() => restoreFieldFocus(captured, new FakeContainer([])));
});
