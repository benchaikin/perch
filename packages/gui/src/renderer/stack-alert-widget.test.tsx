/**
 * Behavioral tests for the stack plugin's AlertWidget, rendered into a real jsdom
 * DOM via @testing-library/react against a fake `window.perch` bridge. They cover:
 * the widget self-registers under the `stack` plugin id; it renders the condition
 * label + branch from the opaque payload; the right action button shows per
 * condition (Sync for needs-rebase, Merge for ready-to-merge); each button fires
 * the matching bridge action and stops the row's open-PR click; and dismiss fires
 * the supplied `onDismiss`.
 */
import "./test-dom.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { StackAlertWidget } from "./stack-alert-widget.js";
import { alertWidgets, type Alert } from "./alert-widgets.js";
import type { StackAlertCondition, StackAlertPayload } from "../panel-state.js";
import type { PerchBridge } from "../ipc.js";

let openPrCalls: string[];
let syncCalls: string[];
let mergePrCalls: unknown[];

const bridge = {
  openPr(url: string) {
    openPrCalls.push(url);
  },
  sync(repo: string) {
    syncCalls.push(repo);
  },
  mergePr(req: unknown) {
    mergePrCalls.push(req);
    return Promise.resolve();
  },
} as unknown as PerchBridge;

beforeEach(() => {
  openPrCalls = [];
  syncCalls = [];
  mergePrCalls = [];
  (globalThis as unknown as { window: { perch: PerchBridge } }).window.perch = bridge;
});

afterEach(() => cleanup());

/** An alert carrying a stack payload for `condition`. */
function alertOf(condition: StackAlertCondition, over: Partial<StackAlertPayload> = {}): Alert {
  const payload: StackAlertPayload = {
    condition,
    repo: "perch",
    branch: "feat/auth",
    number: 12,
    title: "Add auth",
    url: "https://example.com/pr/12",
    ...over,
  };
  return { id: `stack:perch:feat/auth:${condition}`, pluginId: "stack", raisedAt: 1, payload };
}

test("the widget registers itself under the stack plugin id", () => {
  assert.equal(alertWidgets.get("stack"), StackAlertWidget);
});

test("renders the condition label and branch from the payload", () => {
  const { getByText } = render(
    <StackAlertWidget alert={alertOf("ci-failing")} onDismiss={() => {}} />,
  );
  assert.ok(getByText("CI failing"), "shows the condition label");
  assert.ok(getByText("feat/auth"), "shows the branch");
  assert.ok(getByText("#12"), "shows the PR number");
});

test("needs-rebase shows a Sync button that fires sync(repo) and stops the row click", () => {
  const { getByText } = render(
    <StackAlertWidget alert={alertOf("needs-rebase")} onDismiss={() => {}} />,
  );
  fireEvent.click(getByText("Sync"));
  assert.deepEqual(syncCalls, ["perch"]);
  // The action button stopped the row's open-PR handler.
  assert.deepEqual(openPrCalls, []);
});

test("ready-to-merge shows a Merge button that fires mergePr", () => {
  const { getByText, queryByText } = render(
    <StackAlertWidget alert={alertOf("ready-to-merge")} onDismiss={() => {}} />,
  );
  assert.equal(queryByText("Sync"), null, "no Sync button for ready-to-merge");
  fireEvent.click(getByText("Merge"));
  assert.deepEqual(mergePrCalls, [{ number: 12, repo: "perch", headRefName: "feat/auth" }]);
});

test("Open PR fires openPr(url); the row body opens the PR too", () => {
  const { getByText, container } = render(
    <StackAlertWidget alert={alertOf("review-comments")} onDismiss={() => {}} />,
  );
  fireEvent.click(getByText("Open PR"));
  assert.deepEqual(openPrCalls, ["https://example.com/pr/12"]);
  // Clicking the row body (not a button) opens the PR as well.
  fireEvent.click(container.querySelector(".alert-item")!);
  assert.equal(openPrCalls.length, 2);
});

test("dismiss fires onDismiss without opening the PR", () => {
  let dismissed = 0;
  const { getByLabelText } = render(
    <StackAlertWidget alert={alertOf("ci-failing")} onDismiss={() => (dismissed += 1)} />,
  );
  fireEvent.click(getByLabelText("Dismiss this alert"));
  assert.equal(dismissed, 1);
  assert.deepEqual(openPrCalls, []);
});
