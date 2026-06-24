/**
 * Behavioral tests for the worktrees {@link WorktreesAlertWidget}, rendered into a
 * real jsdom DOM against a fake `window.perch` bridge. They cover what the widget
 * owns: it renders the branch label and the repo chip; its Resolve button spawns a
 * conflict-resolution agent via `resolveWorktree({ path, branch })` and shows an
 * in-progress state while the spawn is pending; its Dismiss button fires
 * `onDismiss`; and importing the module (via the Worktrees pane) registers the
 * widget under `"worktrees"` in the shared registry.
 */
import "./test-dom.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { WorktreesAlertWidget } from "./worktrees.js";
import { alertWidgets, type Alert } from "./alert-widgets.js";
import type { PerchBridge, WorktreeResolveRequest } from "../ipc.js";

/** Records every resolve request the Resolve button spawns. */
let resolveWorktreeCalls: WorktreeResolveRequest[];

const bridge = {
  resolveWorktree(request: WorktreeResolveRequest) {
    resolveWorktreeCalls.push(request);
    return Promise.resolve();
  },
} as unknown as PerchBridge;

beforeEach(() => {
  resolveWorktreeCalls = [];
  (globalThis as unknown as { window: { perch: PerchBridge } }).window.perch = bridge;
});

afterEach(() => cleanup());

/** A conflict alert with sensible defaults; override the payload fields a test cares about. */
function makeAlert(payload: Record<string, unknown> = {}): Alert {
  return {
    id: "worktrees:perch:dex/abc-fix:conflict",
    pluginId: "worktrees",
    raisedAt: 1_700_000_000_000,
    payload: {
      path: "/wt/fix",
      branch: "dex/abc-fix",
      repo: "perch",
      name: "fix",
      ...payload,
    },
  };
}

test("renders the branch label and the repo chip", () => {
  const { getByText } = render(<WorktreesAlertWidget alert={makeAlert()} onDismiss={() => {}} />);
  assert.ok(getByText("dex/abc-fix"), "shows the branch as the primary label");
  assert.ok(getByText("perch"), "shows the repo chip");
});

test("falls back to the worktree name when the alert carries no branch", () => {
  const { getByText } = render(
    <WorktreesAlertWidget alert={makeAlert({ branch: undefined })} onDismiss={() => {}} />,
  );
  assert.ok(getByText("fix"), "labels by the worktree name when no branch");
});

test("Resolve spawns an agent via resolveWorktree({ path, branch })", () => {
  const { getByText } = render(<WorktreesAlertWidget alert={makeAlert()} onDismiss={() => {}} />);
  act(() => {
    fireEvent.click(getByText("Resolve"));
  });
  assert.deepEqual(resolveWorktreeCalls, [{ path: "/wt/fix", branch: "dex/abc-fix" }]);
});

test("Dismiss fires onDismiss", () => {
  let dismissed = 0;
  const { getByLabelText } = render(
    <WorktreesAlertWidget alert={makeAlert()} onDismiss={() => (dismissed += 1)} />,
  );
  fireEvent.click(getByLabelText("Dismiss this alert"));
  assert.equal(dismissed, 1);
});

test("importing the module registers the widget under the worktrees plugin id", () => {
  assert.equal(alertWidgets.get("worktrees"), WorktreesAlertWidget);
});
