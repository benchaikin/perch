/**
 * jsdom harness for renderer component tests. The renderer view code runs in a
 * browser context, so its tests need a DOM: importing this module (before any
 * `@testing-library/react` import) stands up a jsdom window and wires the
 * globals React + Testing Library reach for. Node's test runner isolates each
 * test file in its own process, so these globals don't leak between suites.
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

const g = globalThis as unknown as Record<string, unknown>;
const win = dom.window as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
// The DOM constructors/helpers React, Testing Library, and the tests' own
// `instanceof` checks reach for as bare globals (jsdom only hangs them off its
// window). Copy any that the runtime doesn't already define.
for (const key of [
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "CustomEvent",
  "getComputedStyle",
]) {
  if (g[key] === undefined) g[key] = win[key];
}
// jsdom doesn't implement ResizeObserver (the New-task dialog observes its own
// size to persist resizes). A no-op stub is enough — the resize-persistence
// behavior is exercised by manual launch, not these DOM tests.
if (g.ResizeObserver === undefined) {
  g.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

// React Testing Library reads this to know it's in an `act()`-aware
// environment and stay quiet about un-wrapped updates.
g.IS_REACT_ACT_ENVIRONMENT = true;
