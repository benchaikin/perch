/**
 * Unit tests for the Electron-free Dex-section view-model derivation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDexSection,
  dexHealth,
  worstDexHealth,
  type DexBoard,
  type DexTask,
} from "./dex-state.js";

/** A task row with defaults; override per case. */
function task(over: Partial<DexTask> & { id: string; status: DexTask["status"] }): DexTask {
  return {
    name: over.id,
    description: "",
    result: null,
    priority: 0,
    depth: 0,
    isEpic: false,
    blockedByCount: 0,
    ...over,
  };
}

function board(...tasks: DexTask[]): DexBoard {
  return { tasks };
}

test("dexHealth maps each status to a marker color", () => {
  assert.equal(dexHealth("blocked"), "bad");
  assert.equal(dexHealth("in-progress"), "warn");
  assert.equal(dexHealth("done"), "ok");
  assert.equal(dexHealth("ready"), "muted");
});

test("buildDexSection hides when no board / empty board", () => {
  assert.equal(buildDexSection(undefined).visible, false);
  assert.equal(buildDexSection({ tasks: [] }).visible, false);
});

test("buildDexSection tallies counts and maps row health", () => {
  const section = buildDexSection(
    board(
      task({ id: "a", status: "ready" }),
      task({ id: "b", status: "blocked", blockedByCount: 2 }),
      task({ id: "c", status: "in-progress" }),
      task({ id: "d", status: "done" }),
      task({ id: "e", status: "ready" }),
    ),
  );
  assert.equal(section.visible, true);
  assert.deepEqual(section.counts, { ready: 2, blocked: 1, inProgress: 1, done: 1, total: 5 });
  assert.equal(section.rows[1]!.health, "bad");
  assert.equal(section.rows[1]!.blockedByCount, 2);
});

test("worstDexHealth: blocked > ready > in-progress > muted", () => {
  // A blocked task dominates.
  assert.equal(
    worstDexHealth(buildDexSection(board(task({ id: "x", status: "in-progress" }), task({ id: "y", status: "blocked" })))),
    "bad",
  );
  // Ready (pick-up-able) outranks in-progress.
  assert.equal(
    worstDexHealth(buildDexSection(board(task({ id: "x", status: "in-progress" }), task({ id: "y", status: "ready" })))),
    "warn",
  );
  // Only in-progress → ok (all work claimed, nothing waiting).
  assert.equal(
    worstDexHealth(buildDexSection(board(task({ id: "x", status: "in-progress" })))),
    "ok",
  );
  // Empty/hidden → muted.
  assert.equal(worstDexHealth(buildDexSection(undefined)), "muted");
});

test("rows preserve tree order, depth, and isEpic from the board", () => {
  const section = buildDexSection(
    board(
      task({ id: "epic", status: "ready", isEpic: true, depth: 0 }),
      task({ id: "child", status: "in-progress", depth: 1, parentId: "epic" }),
    ),
  );
  assert.deepEqual(section.rows.map((r) => r.id), ["epic", "child"]);
  assert.equal(section.rows[0]!.isEpic, true);
  assert.equal(section.rows[1]!.depth, 1);
});
