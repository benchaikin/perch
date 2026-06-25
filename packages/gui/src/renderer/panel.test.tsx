/**
 * Behavioral tests for the React panel shell, rendered into a real jsdom DOM via
 * @testing-library/react against a fake `window.perch` bridge. They cover the
 * shell contract the old imperative `renderer.ts`/`tabs.ts` owned: seed-then-own
 * tab selection with the first-tab fallback, the active-pane switch, the refresh
 * spinner clearing on the next push, and the notice toast showing/hiding by state.
 */
import "./test-dom.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { App } from "./panel.js";
import { buildPanelState, SERVICES_TAB_ID, STACK_TAB_ID } from "../panel-state.js";
import type { PanelState } from "../panel-state.js";
import type { PerchBridge } from "../ipc.js";

/** The live set of panel-state listeners the store registers on the fake bridge. */
let stateListeners: Set<(state: PanelState) => void>;
/** Spies for the actions the shell drives. */
let refreshCount: number;
let setActiveTabCalls: string[];

// One stable bridge object (the store captures `window.perch` once, lazily); its
// methods read the per-test `let`s above so each test starts from a clean slate.
const bridge = {
  onState(handler: (state: PanelState) => void) {
    stateListeners.add(handler);
    return () => stateListeners.delete(handler);
  },
  refresh() {
    refreshCount += 1;
  },
  setActiveTab(id: string) {
    setActiveTabCalls.push(id);
  },
} as unknown as PerchBridge;

beforeEach(() => {
  stateListeners = new Set();
  refreshCount = 0;
  setActiveTabCalls = [];
  (globalThis as unknown as { window: { perch: PerchBridge } }).window.perch = bridge;
});

afterEach(() => cleanup());

/** Push a state to the store, flushing the resulting render under `act`. */
function emit(state: PanelState): void {
  act(() => {
    for (const listener of stateListeners) listener(state);
  });
}

/** A minimal pushed state (no PRs → an "empty" status with one PRs tab). */
function emptyState(notice?: PanelState["notice"]): PanelState {
  return buildPanelState({
    overview: { repos: [] },
    daemonUp: true,
    syncAvailable: false,
    notice,
  });
}

/** The rendered tab buttons, in display order. */
function tabButtons(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".tab")];
}

test("clicking a tab selects it, switches the pane, and persists the choice", () => {
  const base = emptyState();
  const prsTab = base.tabs.find((t) => t.id === STACK_TAB_ID)!;
  const servicesTab = { id: SERVICES_TAB_ID, label: "Services", icon: "gears" };
  const state: PanelState = { ...base, tabs: [prsTab, servicesTab] };

  const { container } = render(<App />);
  emit(state);

  // PRs is seeded active (first tab): its empty-state message shows through the body slot.
  const rows = container.querySelector("#rows")!;
  assert.match(rows.textContent ?? "", /No open PRs/);
  let [prsBtn, servicesBtn] = tabButtons(container);
  assert.ok(prsBtn!.classList.contains("tab-active"));
  assert.ok(!servicesBtn!.classList.contains("tab-active"));

  fireEvent.click(servicesBtn!);

  // The choice is persisted, the active styling moves, and the PRs pane is gone
  // (the hidden Services section renders nothing → an empty body).
  assert.deepEqual(setActiveTabCalls, [SERVICES_TAB_ID]);
  [prsBtn, servicesBtn] = tabButtons(container);
  assert.ok(servicesBtn!.classList.contains("tab-active"));
  assert.ok(!prsBtn!.classList.contains("tab-active"));
  assert.doesNotMatch(rows.textContent ?? "", /No open PRs/);
});

test("the active tab falls back to the first tab when the saved id is gone", () => {
  // A persisted tab id for a plugin that's no longer present.
  const state: PanelState = { ...emptyState(), savedActiveTab: "plugin.removed" };

  const { container } = render(<App />);
  emit(state);

  // The always-present Dashboard tab (leftmost) + PRs; the saved (now-gone) id
  // falls back to the first tab, Dashboard.
  const tabs = tabButtons(container);
  assert.equal(tabs.length, 2);
  assert.ok(tabs[0]!.classList.contains("tab-active"));
  assert.equal(tabs[0]!.getAttribute("aria-label"), "Dashboard");
  assert.ok(!tabs[1]!.classList.contains("tab-active"));
  assert.equal(tabs[1]!.getAttribute("aria-label"), "PRs");
});

test("refresh spins the icon until the next state push clears it", () => {
  const { container } = render(<App />);
  emit(emptyState());

  const icon = container.querySelector("#refresh i")!;
  assert.ok(!icon.classList.contains("fa-spin"));

  fireEvent.click(container.querySelector("#refresh")!);
  assert.equal(refreshCount, 1);
  assert.ok(icon.classList.contains("fa-spin"), "the icon spins while the refresh is in flight");

  // A fresh push (a new state reference) lands → the spinner clears.
  emit(emptyState());
  assert.ok(!icon.classList.contains("fa-spin"), "the next push clears the spinner");
});

test("the notice toast renders by tone and hides when absent", () => {
  const { container } = render(<App />);
  emit(emptyState({ tone: "ok", text: "Synced" }));

  let notice = container.querySelector("#notice")!;
  assert.equal(notice.className, "notice ok");
  assert.equal(notice.textContent, "Synced");
  assert.ok(!notice.hasAttribute("hidden"));

  emit(emptyState());
  notice = container.querySelector("#notice")!;
  assert.equal(notice.className, "notice");
  assert.ok(notice.hasAttribute("hidden"));
});
