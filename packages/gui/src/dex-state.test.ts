/**
 * Unit tests for the Electron-free Dex-section view-model derivation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDexSection,
  deriveDexGraph,
  dexHealth,
  isOpenDexTask,
  worstDexHealth,
  type DexBoard,
  type DexGraphNode,
  type DexRow,
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

/** A board carrying an explicit configured-projects list (config order). */
function boardWithProjects(projects: string[], ...tasks: DexTask[]): DexBoard {
  return { tasks, projects };
}

test("dexHealth maps each status to a marker color", () => {
  assert.equal(dexHealth("blocked"), "bad");
  assert.equal(dexHealth("in-progress"), "warn");
  assert.equal(dexHealth("done"), "ok");
  assert.equal(dexHealth("ready"), "muted");
});

test("isOpenDexTask: unblocked and not done is open; blocked or done is not", () => {
  assert.equal(isOpenDexTask({ status: "ready", blockedByCount: 0 }), true);
  assert.equal(isOpenDexTask({ status: "in-progress", blockedByCount: 0 }), true);
  // Done → not open even when unblocked.
  assert.equal(isOpenDexTask({ status: "done", blockedByCount: 0 }), false);
  // Active blockers → not open even for an otherwise-workable status.
  assert.equal(isOpenDexTask({ status: "ready", blockedByCount: 2 }), false);
  assert.equal(isOpenDexTask({ status: "blocked", blockedByCount: 1 }), false);
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

test("buildDexSection: a single-repo board (no project) is not multiRepo", () => {
  const section = buildDexSection(
    board(task({ id: "a", status: "ready" }), task({ id: "b", status: "ready" })),
    true,
  );
  assert.equal(section.multiRepo, false);
  assert.deepEqual(section.repoGroups, []);
});

test("buildDexSection: rows tagged with one project are not multiRepo either", () => {
  // A single configured repo still tags its tasks with a project, but one distinct
  // project isn't "multi-repo" — the flat list stays.
  const section = buildDexSection(
    board(
      task({ id: "a", status: "ready", project: "alpha" }),
      task({ id: "b", status: "ready", project: "alpha" }),
    ),
    true,
  );
  assert.equal(section.multiRepo, false);
  assert.deepEqual(section.repoGroups, []);
});

test("buildDexSection: rows spanning >1 project group into repoGroups (first-appearance order)", () => {
  const section = buildDexSection(
    board(
      task({ id: "a1", status: "ready", project: "alpha" }),
      task({ id: "b1", status: "ready", project: "beta" }),
      task({ id: "a2", status: "in-progress", project: "alpha" }),
    ),
    true,
  );
  assert.equal(section.multiRepo, true);
  assert.equal(section.repoGroups.length, 2);
  // Groups in order of first appearance: alpha (a1) before beta (b1).
  assert.deepEqual(
    section.repoGroups.map((g) => g.project),
    ["alpha", "beta"],
  );
  // Each group's rows preserve the board's pre-order within the project.
  assert.deepEqual(
    section.repoGroups[0]!.rows.map((r) => r.id),
    ["a1", "a2"],
  );
  assert.deepEqual(
    section.repoGroups[1]!.rows.map((r) => r.id),
    ["b1"],
  );
  // The grouped rows are the same row objects as the flat `rows` (no recompute).
  assert.equal(section.repoGroups[0]!.rows[0], section.rows[0]);
});

test("buildDexSection: grouping is driven by configured projects, not task count", () => {
  // Two configured repos but only one has a task → still a multi-repo board, with
  // the empty repo rendered as an empty group (so it gets a header + New "+").
  const section = buildDexSection(
    boardWithProjects(["alpha", "beta"], task({ id: "a1", status: "ready", project: "alpha" })),
    true,
  );
  assert.equal(section.multiRepo, true);
  assert.deepEqual(
    section.repoGroups.map((g) => g.project),
    ["alpha", "beta"],
  );
  assert.deepEqual(
    section.repoGroups.map((g) => g.rows.map((r) => r.id)),
    [["a1"], []],
  );
});

test("buildDexSection: two configured repos with ZERO tasks still group (empty headers)", () => {
  const section = buildDexSection(boardWithProjects(["alpha", "beta"]), true);
  assert.equal(section.multiRepo, true);
  assert.deepEqual(
    section.repoGroups.map((g) => g.project),
    ["alpha", "beta"],
  );
  assert.deepEqual(
    section.repoGroups.map((g) => g.rows.length),
    [0, 0],
  );
  assert.equal(section.rows.length, 0);
});

test("buildDexSection: a single configured repo stays flat even with tasks", () => {
  const section = buildDexSection(
    boardWithProjects(
      ["alpha"],
      task({ id: "a1", status: "ready", project: "alpha" }),
      task({ id: "a2", status: "ready", project: "alpha" }),
    ),
    true,
  );
  assert.equal(section.multiRepo, false);
  assert.deepEqual(section.repoGroups, []);
});

test("buildDexSection: groups follow config order, not first-task order", () => {
  // The first task is beta's, but config order (alpha, beta) wins.
  const section = buildDexSection(
    boardWithProjects(
      ["alpha", "beta"],
      task({ id: "b1", status: "ready", project: "beta" }),
      task({ id: "a1", status: "ready", project: "alpha" }),
    ),
    true,
  );
  assert.deepEqual(
    section.repoGroups.map((g) => g.project),
    ["alpha", "beta"],
  );
});

test("buildDexSection: a repo with tasks but dropped from config still groups (appended)", () => {
  // `gamma` isn't in the configured list but still holds a task — it's unioned in
  // after the configured repos so its tasks aren't lost.
  const section = buildDexSection(
    boardWithProjects(
      ["alpha"],
      task({ id: "a1", status: "ready", project: "alpha" }),
      task({ id: "g1", status: "ready", project: "gamma" }),
    ),
    true,
  );
  assert.equal(section.multiRepo, true);
  assert.deepEqual(
    section.repoGroups.map((g) => g.project),
    ["alpha", "gamma"],
  );
});

test("buildDexSection: an older board without `projects` falls back to task projects", () => {
  // No `projects` field (a pre-this-change daemon) → grouping derives from the
  // projects seen on tasks, the original behavior.
  const section = buildDexSection(
    board(
      task({ id: "a1", status: "ready", project: "alpha" }),
      task({ id: "b1", status: "ready", project: "beta" }),
    ),
    true,
  );
  assert.equal(section.multiRepo, true);
  assert.deepEqual(
    section.repoGroups.map((g) => g.project),
    ["alpha", "beta"],
  );
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

test("buildDexSection threads the live agent onto rows (and only those)", () => {
  const agent = {
    sessionId: "s1",
    state: "running" as const,
    cwd: "/wt/a",
    lastActivity: 1,
  };
  const section = buildDexSection(
    board(task({ id: "t1", status: "in-progress" }), task({ id: "t2", status: "in-progress" })),
    true,
    undefined,
    undefined,
    new Map([["t1", agent]]),
  );
  // The matched task carries its agent summary; an unmatched one is bare.
  assert.deepEqual(section.rows[0]!.agent, agent);
  assert.equal(section.rows[1]!.agent, undefined);
  // An omitted agent map leaves every row bare.
  assert.equal(
    buildDexSection(board(task({ id: "x", status: "ready" })), true).rows[0]!.agent,
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

// --- deriveDexGraph (dependency-graph view) ------------------------------------

/** Build the rows the graph view consumes from a set of task overrides. */
function graphRows(...tasks: DexTask[]): DexRow[] {
  return buildDexSection(board(...tasks), true).rows;
}

/** A node's row id + its children's ids, for compact tree assertions. */
function shape(node: DexGraphNode): { id: string; children: ReturnType<typeof shape>[] } {
  return { id: node.row.id, children: node.children.map(shape) };
}

test("deriveDexGraph: roots are the unblocked tasks", () => {
  const roots = deriveDexGraph(
    graphRows(
      task({ id: "a", status: "ready" }),
      task({ id: "b", status: "blocked", blockedByCount: 1, blockedBy: ["a"] }),
      task({ id: "c", status: "ready" }),
    ),
  );
  // a and c are unblocked → roots; b nests under a, so it's not a root itself.
  assert.deepEqual(
    roots.map((r) => r.row.id),
    ["a", "c"],
  );
});

test("deriveDexGraph: a blocked task nests under its blocker", () => {
  const roots = deriveDexGraph(
    graphRows(
      task({ id: "a", status: "ready" }),
      task({ id: "b", status: "blocked", blockedByCount: 1, blockedBy: ["a"] }),
    ),
  );
  assert.deepEqual(roots.map(shape), [{ id: "a", children: [{ id: "b", children: [] }] }]);
  // The nested node keeps its blocked health, distinguishing it from the root.
  assert.equal(roots[0]!.children[0]!.row.health, "bad");
});

test("deriveDexGraph: a task with multiple blockers appears under each", () => {
  // Rule: nest under EVERY blocker, so all the edges a task waits on are visible.
  const roots = deriveDexGraph(
    graphRows(
      task({ id: "a", status: "ready" }),
      task({ id: "b", status: "ready" }),
      task({ id: "c", status: "blocked", blockedByCount: 2, blockedBy: ["a", "b"] }),
    ),
  );
  assert.deepEqual(roots.map(shape), [
    { id: "a", children: [{ id: "c", children: [] }] },
    { id: "b", children: [{ id: "c", children: [] }] },
  ]);
});

test("deriveDexGraph: a cycle terminates instead of looping forever", () => {
  // a blocks b, b blocks a. Neither is "unblocked", so there's no root from the
  // blocker edges — the forest is empty, but the call returns rather than hangs.
  const roots = deriveDexGraph(
    graphRows(
      task({ id: "a", status: "blocked", blockedByCount: 1, blockedBy: ["b"] }),
      task({ id: "b", status: "blocked", blockedByCount: 1, blockedBy: ["a"] }),
    ),
  );
  assert.deepEqual(roots, []);
});

test("deriveDexGraph: a cycle reachable from a root expands once, not forever", () => {
  // root → a → b → a(cycle). The second visit to `a` is cut, so b has no child.
  const roots = deriveDexGraph(
    graphRows(
      task({ id: "root", status: "ready" }),
      task({ id: "a", status: "blocked", blockedByCount: 2, blockedBy: ["root", "b"] }),
      task({ id: "b", status: "blocked", blockedByCount: 1, blockedBy: ["a"] }),
    ),
  );
  assert.deepEqual(roots.map(shape), [
    {
      id: "root",
      children: [{ id: "a", children: [{ id: "b", children: [] }] }],
    },
  ]);
});

test("deriveDexGraph: standalone tasks (no edges) are childless roots", () => {
  const roots = deriveDexGraph(
    graphRows(task({ id: "a", status: "ready" }), task({ id: "b", status: "in-progress" })),
  );
  assert.deepEqual(roots.map(shape), [
    { id: "a", children: [] },
    { id: "b", children: [] },
  ]);
});

test("deriveDexGraph: a blocker id not in the set is ignored (task becomes a root)", () => {
  const roots = deriveDexGraph(
    graphRows(task({ id: "b", status: "blocked", blockedByCount: 1, blockedBy: ["missing"] })),
  );
  // The only blocker isn't present, so b can't nest under it → b is a root.
  assert.deepEqual(roots.map(shape), [{ id: "b", children: [] }]);
});

test("deriveDexGraph: a task with one known and one unknown blocker still nests", () => {
  const roots = deriveDexGraph(
    graphRows(
      task({ id: "a", status: "ready" }),
      task({ id: "b", status: "blocked", blockedByCount: 2, blockedBy: ["a", "missing"] }),
    ),
  );
  // The known blocker `a` parents b; the unknown id is simply dropped, and the
  // present blocker keeps b out of the root set.
  assert.deepEqual(roots.map(shape), [{ id: "a", children: [{ id: "b", children: [] }] }]);
});

test("deriveDexGraph: empty input yields an empty forest", () => {
  assert.deepEqual(deriveDexGraph([]), []);
});
