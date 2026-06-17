/**
 * Unit tests for {@link chipEl}'s actionable variant. The renderer has no jsdom
 * harness, so we stub a minimal `document`/`window` — just enough surface for
 * `chipEl` to build an element and for a synthesized click to reach the handler.
 *
 * Regression target: the "needs review" chip must be a focusable, click-to-open
 * button that opens the PR via `window.perch.openPr` and stops the click from
 * bubbling to the row's own open handler — while plain chips stay passive spans.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

/** A minimal stand-in for the DOM element `chipEl` builds. */
class FakeElement {
  className = "";
  title = "";
  textContent = "";
  readonly attrs: Record<string, string> = {};
  readonly listeners: Record<string, ((e: unknown) => void)[]> = {};
  constructor(readonly tagName: string) {}
  append(): void {}
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  addEventListener(type: string, cb: (e: unknown) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  /** Fire registered handlers for an event type with a test event. */
  fire(type: string, event: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(event);
  }
}

const opened: string[] = [];
// Stub the globals `chipEl` reaches for. Node's test runner isolates each test
// file in its own process, so these globals don't leak to other suites.
(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) => new FakeElement(tag),
};
(globalThis as unknown as { window: unknown }).window = {
  perch: { openPr: (url: string) => opened.push(url) },
};

// Imported after the globals are stubbed (the import itself runs no DOM code).
const { chipEl } = await import("./common.js");

test("a plain chip renders a passive span with no action wiring", () => {
  const el = chipEl({ label: "✓ CI", tone: "ok", hint: "CI passing" }) as unknown as FakeElement;
  assert.equal(el.tagName, "span");
  assert.equal(el.className, "chip ok");
  assert.equal(el.textContent, "✓ CI");
  assert.equal(el.attrs["aria-label"], undefined);
  assert.equal(el.listeners["click"], undefined);
});

test("an href chip renders a focusable, accessible action button", () => {
  const el = chipEl({
    label: "○ rev",
    tone: "warn",
    hint: "Open PR for review",
    href: "https://github.com/o/r/pull/7",
    actionLabel: "Open PR for review",
  }) as unknown as FakeElement;
  // A <button> is focusable + Enter/Space-activatable for free.
  assert.equal(el.tagName, "button");
  assert.equal(el.className, "chip warn action");
  assert.equal(el.attrs["aria-label"], "Open PR for review");
  assert.equal(el.title, "Open PR for review");
});

test("activating an href chip opens the PR and stops row propagation", () => {
  opened.length = 0;
  const el = chipEl({
    label: "○ rev",
    tone: "warn",
    hint: "Open PR for review",
    href: "https://github.com/o/r/pull/7",
    actionLabel: "Open PR for review",
  }) as unknown as FakeElement;

  let stopped = false;
  el.fire("click", { stopPropagation: () => (stopped = true) });

  assert.deepEqual(opened, ["https://github.com/o/r/pull/7"]);
  assert.equal(stopped, true, "click must not bubble to the row's open handler");
});
