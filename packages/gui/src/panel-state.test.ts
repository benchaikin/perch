/**
 * Unit tests for the Electron-free panel-state derivation. This is the bulk of
 * the GUI's testable logic; the Electron wiring (tray/window/IPC) is verified by
 * manual launch (see README).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPanelState,
  ciChip,
  mergeableChip,
  reviewChip,
  toLayerRow,
  type StackGraph,
} from "./panel-state.js";

test("ciChip maps each status to a tone", () => {
  assert.equal(ciChip("pass").tone, "ok");
  assert.equal(ciChip("fail").tone, "bad");
  assert.equal(ciChip("pending").tone, "warn");
  assert.equal(ciChip("none").tone, "muted");
});

test("reviewChip maps decisions and omits when absent", () => {
  assert.equal(reviewChip("APPROVED")?.tone, "ok");
  assert.equal(reviewChip("CHANGES_REQUESTED")?.tone, "bad");
  assert.equal(reviewChip("REVIEW_REQUIRED")?.tone, "warn");
  assert.equal(reviewChip(undefined), undefined);
});

test("mergeableChip only chips conflicting/unknown, not clean", () => {
  assert.equal(mergeableChip("CONFLICTING")?.tone, "bad");
  assert.equal(mergeableChip("UNKNOWN")?.tone, "muted");
  assert.equal(mergeableChip("MERGEABLE"), undefined);
  assert.equal(mergeableChip(undefined), undefined);
});

test("toLayerRow always includes a CI chip and applies defaults", () => {
  const row = toLayerRow({ branch: "fix-types" });
  assert.equal(row.branch, "fix-types");
  assert.equal(row.needsRebase, false);
  assert.equal(row.conflict, false);
  assert.equal(row.chips.length, 1);
  assert.equal(row.chips[0]?.label, "· CI");
});

test("toLayerRow accumulates review + mergeable chips", () => {
  const row = toLayerRow({
    branch: "add-api",
    prNumber: 102,
    ciStatus: "pass",
    reviewDecision: "REVIEW_REQUIRED",
    mergeable: "CONFLICTING",
    needsRebase: true,
    conflict: true,
  });
  assert.equal(row.prNumber, 102);
  assert.equal(row.needsRebase, true);
  assert.equal(row.conflict, true);
  // CI + review + mergeable.
  assert.equal(row.chips.length, 3);
  assert.deepEqual(
    row.chips.map((c) => c.tone),
    ["ok", "warn", "bad"],
  );
});

test("buildPanelState surfaces a daemon-down state without crashing", () => {
  const state = buildPanelState({ daemonUp: false, syncAvailable: false });
  assert.equal(state.status, "daemon-down");
  assert.match(state.message ?? "", /perchd not running/);
  assert.equal(state.rows.length, 0);
  assert.equal(state.syncAvailable, false);
});

test("buildPanelState shows a loading/empty state before data arrives", () => {
  const state = buildPanelState({ daemonUp: true, syncAvailable: true });
  assert.equal(state.status, "empty");
  assert.match(state.message ?? "", /Loading/);
});

test("buildPanelState reports an empty stack distinctly", () => {
  const graph: StackGraph = { repo: "ashby/main", layers: [] };
  const state = buildPanelState({ graph, daemonUp: true, syncAvailable: true });
  assert.equal(state.status, "empty");
  assert.equal(state.repo, "ashby/main");
  assert.match(state.message ?? "", /No stack/);
});

test("buildPanelState renders rows tip-first (reversed)", () => {
  const graph: StackGraph = {
    repo: "ashby/main",
    layers: [
      { branch: "fix-types", ciStatus: "pass" },
      { branch: "add-api", ciStatus: "pending" },
      { branch: "ui-polish", ciStatus: "none" },
    ],
  };
  const state = buildPanelState({ graph, daemonUp: true, syncAvailable: true });
  assert.equal(state.status, "ok");
  assert.equal(state.repo, "ashby/main");
  // Tip (last layer) renders first.
  assert.deepEqual(
    state.rows.map((r) => r.branch),
    ["ui-polish", "add-api", "fix-types"],
  );
  assert.equal(state.syncAvailable, true);
});

test("buildPanelState propagates a transient error over data", () => {
  const state = buildPanelState({ daemonUp: true, syncAvailable: true, error: "boom" });
  assert.equal(state.status, "error");
  assert.equal(state.message, "boom");
});

test("buildPanelState threads the repo list + selection through to the renderer", () => {
  const graph: StackGraph = { layers: [{ branch: "feat-a", ciStatus: "pass" }] };
  const state = buildPanelState({
    graph,
    daemonUp: true,
    syncAvailable: true,
    repos: [
      { name: "main", path: "/work/main" },
      { name: "infra", path: "/work/infra" },
    ],
    selectedRepo: "infra",
  });
  assert.deepEqual(state.repos, ["main", "infra"]);
  assert.equal(state.selectedRepo, "infra");
});

test("buildPanelState defaults repos to [] and rides the switcher on every status", () => {
  // No repos input → empty list (renderer hides the dropdown).
  const down = buildPanelState({ daemonUp: false, syncAvailable: false });
  assert.deepEqual(down.repos, []);
  assert.equal(down.selectedRepo, undefined);

  // The switcher fields are present even on the daemon-down / error states so
  // the dropdown doesn't flicker away when the stack fails to load.
  const err = buildPanelState({
    daemonUp: true,
    syncAvailable: true,
    error: "boom",
    repos: [
      { name: "main", path: "/work/main" },
      { name: "infra", path: "/work/infra" },
    ],
    selectedRepo: "main",
  });
  assert.equal(err.status, "error");
  assert.deepEqual(err.repos, ["main", "infra"]);
  assert.equal(err.selectedRepo, "main");
});
