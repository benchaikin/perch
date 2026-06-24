/**
 * Behavioral tests for the agents {@link AgentsAlertWidget}, rendered into a real
 * jsdom DOM against a fake `window.perch` bridge. They cover what the widget owns:
 * it renders the session id, the blocking message, and the linked dex task chip
 * (only when the alert is attributable to a task); its Respond button opens the
 * agent's worktree via `worktreeOpen(cwd)` (and is disabled when there's no cwd);
 * its Dismiss button fires `onDismiss`; and importing the module registers the
 * widget under `"agents"` in the shared registry.
 */
import "./test-dom.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { AgentsAlertWidget, AGENTS_PLUGIN_ID } from "./agents-alert-widget.js";
import { alertWidgets, type Alert } from "./alert-widgets.js";
import type { PerchBridge } from "../ipc.js";

/** Records the path of every worktree Respond asks to open. */
let worktreeOpenCalls: string[];

const bridge = {
  worktreeOpen(path: string) {
    worktreeOpenCalls.push(path);
  },
  copyText() {},
} as unknown as PerchBridge;

beforeEach(() => {
  worktreeOpenCalls = [];
  (globalThis as unknown as { window: { perch: PerchBridge } }).window.perch = bridge;
});

afterEach(() => cleanup());

/** A blocked-agent alert with sensible defaults; override the fields a test cares about. */
function makeAlert(payload: Record<string, unknown> = {}): Alert {
  return {
    id: "agents:sess-12345678:blocked",
    pluginId: "agents",
    raisedAt: 1_700_000_000_000,
    payload: {
      sessionId: "sess-12345678",
      taskId: "ab12cd34",
      branch: "dex/ab12cd34-x",
      cwd: "/wt/ab12",
      message: "Allow running `rm -rf build`?",
      ...payload,
    },
  };
}

test("renders the short session id and the blocking message", () => {
  const { getByText } = render(<AgentsAlertWidget alert={makeAlert()} onDismiss={() => {}} />);
  assert.ok(getByText("session sess-123"), "shows the truncated session id");
  assert.ok(getByText("Allow running `rm -rf build`?"), "shows the blocking message");
});

test("shows the linked dex task chip when attributable", () => {
  const { getByText } = render(<AgentsAlertWidget alert={makeAlert()} onDismiss={() => {}} />);
  assert.ok(getByText("ab12cd34"), "renders the dex task id chip");
});

test("omits the dex task chip when not attributable", () => {
  const { queryByText } = render(
    <AgentsAlertWidget alert={makeAlert({ taskId: undefined })} onDismiss={() => {}} />,
  );
  assert.equal(queryByText("ab12cd34"), null);
});

test("Respond opens the agent's worktree via worktreeOpen(cwd)", () => {
  const { getByText } = render(<AgentsAlertWidget alert={makeAlert()} onDismiss={() => {}} />);
  fireEvent.click(getByText("Respond"));
  assert.deepEqual(worktreeOpenCalls, ["/wt/ab12"]);
});

test("Respond is disabled when the alert carries no cwd", () => {
  const { getByText } = render(
    <AgentsAlertWidget alert={makeAlert({ cwd: undefined })} onDismiss={() => {}} />,
  );
  const respond = getByText("Respond").closest("button");
  assert.ok(respond?.disabled, "Respond is disabled without a worktree");
  fireEvent.click(respond!);
  assert.equal(worktreeOpenCalls.length, 0);
});

test("Dismiss fires onDismiss", () => {
  let dismissed = 0;
  const { getByText } = render(
    <AgentsAlertWidget alert={makeAlert()} onDismiss={() => (dismissed += 1)} />,
  );
  fireEvent.click(getByText("Dismiss"));
  assert.equal(dismissed, 1);
});

test("importing the module registers the widget under the agents plugin id", () => {
  assert.equal(AGENTS_PLUGIN_ID, "agents");
  assert.equal(alertWidgets.get("agents"), AgentsAlertWidget);
});
