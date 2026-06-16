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
    blockedBy: [],
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

test("buildDexSection visibility tracks plugin presence, not board arrival", () => {
  // Plugin absent → hidden, regardless of board.
  assert.equal(buildDexSection(undefined, false).visible, false);
  assert.equal(buildDexSection({ tasks: [] }, false).visible, false);
  // Plugin present but no board yet (zero tasks, subscription seeded nothing) →
  // visible with an empty state, so the tab doesn't conflate "not installed"
  // with "installed, nothing open yet".
  const noBoard = buildDexSection(undefined, true);
  assert.equal(noBoard.visible, true);
  assert.equal(noBoard.rows.length, 0);
  assert.equal(noBoard.counts.total, 0);
  // Plugin present with an empty board (all tasks completed) → stays visible
  // with no rows, so finishing your tasks doesn't make the tab disappear.
  const empty = buildDexSection({ tasks: [] }, true);
  assert.equal(empty.visible, true);
  assert.equal(empty.rows.length, 0);
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
    true,
  );
  assert.equal(section.visible, true);
  assert.deepEqual(section.counts, { ready: 2, blocked: 1, inProgress: 1, done: 1, total: 5 });
  assert.equal(section.rows[1]!.health, "bad");
  assert.equal(section.rows[1]!.blockedByCount, 2);
});

test("buildDexSection carries the active blocker ids (edges) onto rows", () => {
  const section = buildDexSection(
    board(
      task({ id: "blkr", status: "ready" }),
      task({ id: "blocked", status: "blocked", blockedByCount: 1, blockedBy: ["blkr"] }),
    ),
    true,
  );
  assert.deepEqual(section.rows[0]!.blockedBy, []);
  assert.deepEqual(section.rows[1]!.blockedBy, ["blkr"]);
});

test("buildDexSection annotates rows from the worktree map (and only those)", () => {
  const section = buildDexSection(
    board(task({ id: "t1", status: "in-progress" }), task({ id: "t2", status: "ready" })),
    true,
    new Map([
      [
        "t1",
        {
          path: "/wt/a",
          branch: "a",
          repo: "alpha",
          dirty: true,
          dirtyCount: 2,
          ahead: 1,
          behind: 0,
        },
      ],
    ]),
  );
  assert.deepEqual(section.rows[0]!.worktree, {
    path: "/wt/a",
    branch: "a",
    repo: "alpha",
    dirty: true,
    dirtyCount: 2,
    ahead: 1,
    behind: 0,
  });
  // Unmatched tasks carry no worktree; an omitted map leaves every row bare.
  assert.equal(section.rows[1]!.worktree, undefined);
  assert.equal(
    buildDexSection(board(task({ id: "x", status: "ready" })), true).rows[0]!.worktree,
    undefined,
  );
});

test("buildDexSection threads the landable state onto rows (and only those)", () => {
  const section = buildDexSection(
    board(task({ id: "t1", status: "in-progress" }), task({ id: "t2", status: "in-progress" })),
    true,
    undefined,
    new Map([["t1", "ready" as const]]),
  );
  // The matched task carries its landable state; an unmatched one is bare.
  assert.equal(section.rows[0]!.landable, "ready");
  assert.equal(section.rows[1]!.landable, undefined);
  // An omitted landable map leaves every row bare.
  assert.equal(
    buildDexSection(board(task({ id: "x", status: "ready" })), true).rows[0]!.landable,
    undefined,
  );
});

test("worstDexHealth: blocked > ready > in-progress > muted", () => {
  // A blocked task dominates.
  assert.equal(
    worstDexHealth(
      buildDexSection(
        board(task({ id: "x", status: "in-progress" }), task({ id: "y", status: "blocked" })),
        true,
      ),
    ),
    "bad",
  );
  // Ready (pick-up-able) outranks in-progress.
  assert.equal(
    worstDexHealth(
      buildDexSection(
        board(task({ id: "x", status: "in-progress" }), task({ id: "y", status: "ready" })),
        true,
      ),
    ),
    "warn",
  );
  // Only in-progress → ok (all work claimed, nothing waiting).
  assert.equal(
    worstDexHealth(buildDexSection(board(task({ id: "x", status: "in-progress" })), true)),
    "ok",
  );
  // Present but empty → muted (nothing notable). Same as plugin absent.
  assert.equal(worstDexHealth(buildDexSection({ tasks: [] }, true)), "muted");
  assert.equal(worstDexHealth(buildDexSection(undefined, false)), "muted");
});

test("displayStatus rolls an epic up to in-progress when a descendant is active", () => {
  const section = buildDexSection(
    board(
      task({ id: "epic", status: "ready", isEpic: true, depth: 0 }),
      task({ id: "child", status: "in-progress", depth: 1, parentId: "epic" }),
    ),
    true,
  );
  // The epic's own status is untouched; only its display (icon) status rolls up.
  assert.equal(section.rows[0]!.status, "ready");
  assert.equal(section.rows[0]!.displayStatus, "in-progress");
  // Counts stay keyed off the real status — the rollup is display-only.
  assert.deepEqual(section.counts, { ready: 1, blocked: 0, inProgress: 1, done: 0, total: 2 });
});

test("displayStatus equals status when no descendant is in progress", () => {
  const section = buildDexSection(
    board(
      task({ id: "epic", status: "ready", isEpic: true, depth: 0 }),
      task({ id: "child", status: "done", depth: 1, parentId: "epic" }),
    ),
    true,
  );
  assert.equal(section.rows[0]!.displayStatus, "ready");
  assert.equal(section.rows[1]!.displayStatus, "done");
});

test("a blocked epic keeps reading as blocked even with an in-progress child", () => {
  const section = buildDexSection(
    board(
      task({ id: "epic", status: "blocked", isEpic: true, depth: 0 }),
      task({ id: "child", status: "in-progress", depth: 1, parentId: "epic" }),
    ),
    true,
  );
  // Blocked outranks the in-progress rollup (mirrors worstDexHealth precedence).
  assert.equal(section.rows[0]!.displayStatus, "blocked");
});

test("the rollup spans grandchildren, not just direct children", () => {
  const section = buildDexSection(
    board(
      task({ id: "epic", status: "ready", isEpic: true, depth: 0 }),
      task({ id: "mid", status: "ready", isEpic: true, depth: 1, parentId: "epic" }),
      task({ id: "leaf", status: "in-progress", depth: 2, parentId: "mid" }),
    ),
    true,
  );
  // Both ancestors of the active leaf roll up.
  assert.equal(section.rows[0]!.displayStatus, "in-progress");
  assert.equal(section.rows[1]!.displayStatus, "in-progress");
  assert.equal(section.rows[2]!.displayStatus, "in-progress");
});

test("a non-epic leaf never rolls up (only its own status drives display)", () => {
  const section = buildDexSection(board(task({ id: "leaf", status: "ready" })), true);
  assert.equal(section.rows[0]!.displayStatus, "ready");
});

test("rows preserve tree order, depth, and isEpic from the board", () => {
  const section = buildDexSection(
    board(
      task({ id: "epic", status: "ready", isEpic: true, depth: 0 }),
      task({ id: "child", status: "in-progress", depth: 1, parentId: "epic" }),
    ),
    true,
  );
  assert.deepEqual(
    section.rows.map((r) => r.id),
    ["epic", "child"],
  );
  assert.equal(section.rows[0]!.isEpic, true);
  assert.equal(section.rows[1]!.depth, 1);
});
