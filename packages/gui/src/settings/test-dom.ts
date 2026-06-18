/**
 * jsdom test environment for the Settings window's React component tests. The
 * package's `node --test` runner has no DOM, so importing this module FIRST in a
 * test file installs a jsdom `window`/`document` (and the constructors React +
 * Testing Library reach for) onto the global scope. Test-only — never imported by
 * the renderer bundle.
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;

// Copy the window's own globals (HTMLElement, Event, getComputedStyle, …) onto
// globalThis where they're missing, so React DOM + Testing Library resolve them
// the same way they would in a browser. Skip anything already defined (e.g.
// Node's read-only `navigator`).
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in g) continue;
  g[key] = (dom.window as unknown as Record<string, unknown>)[key];
}

// React's act()/Testing Library need this flag to silence "not wrapped in act"
// warnings and run state updates synchronously under test.
g.IS_REACT_ACT_ENVIRONMENT = true;
