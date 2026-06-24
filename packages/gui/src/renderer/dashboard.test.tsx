/**
 * Behavioral tests for the Dashboard pane, rendered into jsdom against a fake
 * `window.perch` bridge. They cover the host contract: poll `alerts.list`, sort
 * newest-first, route each alert to its plugin's registered widget (with the
 * dismissable fallback for an unregistered plugin), wire `onDismiss` to the
 * `alerts.dismiss` IPC with optimistic removal, render a clean empty state, and
 * re-poll on the interval.
 */
import "./test-dom.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DashboardPane } from "./dashboard.js";
import { alertWidgets, type Alert } from "./alert-widgets.js";
import type { PerchBridge } from "../ipc.js";

// Register once for this file (distinct ids → no duplicate-guard throw). The pane
// resolves widgets from this shared singleton; each test process is isolated, so
// these registrations don't leak to other suites.
alertWidgets.register("services", ({ alert, onDismiss }) => (
  <div>
    <span>svc-payload:{String((alert.payload as { message?: string }).message)}</span>
    <button onClick={onDismiss}>Dismiss {alert.id}</button>
  </div>
));
alertWidgets.register("dex", ({ alert }) => <div>dex-widget:{alert.id}</div>);

/** The list the fake `alerts.list` returns; reassigned per test (and per poll). */
let listResult: Alert[];
/** Ids passed to the fake `alerts.dismiss`, in call order. */
let dismissCalls: string[];

const bridge = {
  alertsList() {
    return Promise.resolve(listResult);
  },
  alertsDismiss(id: string) {
    dismissCalls.push(id);
    return Promise.resolve();
  },
} as unknown as PerchBridge;

beforeEach(() => {
  listResult = [];
  dismissCalls = [];
  (globalThis as unknown as { window: { perch: PerchBridge } }).window.perch = bridge;
});

afterEach(() => cleanup());

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: "services:x",
    pluginId: "services",
    raisedAt: 1,
    payload: { message: "m" },
    ...overrides,
  };
}

test("shows the empty state when no alerts are active", async () => {
  listResult = [];
  render(<DashboardPane pollMs={100_000} />);
  assert.ok(await screen.findByText("No active alerts."));
});

test("routes each alert to its plugin widget, newest (raisedAt) first", async () => {
  listResult = [
    makeAlert({ id: "a", pluginId: "dex", raisedAt: 100 }),
    makeAlert({ id: "b", pluginId: "services", raisedAt: 300, payload: { message: "boom" } }),
    makeAlert({ id: "c", pluginId: "dex", raisedAt: 200 }),
  ];
  const { container } = render(<DashboardPane pollMs={100_000} />);

  // The services widget renders its opaque payload; the dex widget its id.
  await screen.findByText("svc-payload:boom");
  const text = container.textContent ?? "";
  const positions = [
    text.indexOf("svc-payload:boom"), // b, raisedAt 300
    text.indexOf("dex-widget:c"), // c, raisedAt 200
    text.indexOf("dex-widget:a"), // a, raisedAt 100
  ];
  assert.deepEqual(
    [...positions].sort((x, y) => x - y),
    positions,
    "alerts render newest-first",
  );
});

test("dismiss fires alerts.dismiss and removes the alert optimistically", async () => {
  listResult = [makeAlert({ id: "b", pluginId: "services", payload: { message: "boom" } })];
  render(<DashboardPane pollMs={100_000} />);

  fireEvent.click(await screen.findByText("Dismiss b"));
  assert.deepEqual(dismissCalls, ["b"]);
  // Optimistic removal: the widget is gone at once and the empty state shows,
  // without waiting for a re-poll.
  assert.equal(screen.queryByText("Dismiss b"), null);
  assert.ok(screen.getByText("No active alerts."));
});

test("an alert with no registered widget renders the dismissable fallback", async () => {
  listResult = [makeAlert({ id: "ghost:1", pluginId: "ghost", raisedAt: 5 })];
  render(<DashboardPane pollMs={100_000} />);

  // The fallback surfaces the id and the raising plugin — never the opaque payload.
  await screen.findByText("ghost:1");
  assert.ok(screen.getByText("ghost"));

  fireEvent.click(screen.getByLabelText("Dismiss ghost:1"));
  assert.deepEqual(dismissCalls, ["ghost:1"]);
});

test("re-polls on the interval and reflects a newly raised alert", async () => {
  listResult = [];
  render(<DashboardPane pollMs={20} />);
  await screen.findByText("No active alerts.");

  // A later poll picks up an alert raised after the first list.
  listResult = [makeAlert({ id: "b", pluginId: "services", payload: { message: "later" } })];
  assert.ok(await screen.findByText("svc-payload:later"));
});
