/**
 * Unit tests for the pure dex board normalization (status derivation, tree
 * ordering, blocker resolution, multi-store aggregation).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDexBoard, parseRawTasks, type RawDexTask } from "./normalize.js";

/** A raw task with sensible defaults; override per case. */
function task(over: Partial<RawDexTask> & { id: string; name: string }): RawDexTask {
  return { completed: false, ...over };
}

function byId(board: ReturnType<typeof buildDexBoard>) {
  return new Map(board.tasks.map((t) => [t.id, t]));
}

test("derives status: done / in-progress / blocked / ready", () => {
  const tasks: RawDexTask[] = [
    task({ id: "epic", name: "Epic" }),
    task({ id: "ready", name: "Ready", parent_id: "epic" }),
    task({ id: "wip", name: "WIP", parent_id: "epic", started_at: "2026-06-15T00:00:00Z" }),
    task({ id: "done", name: "Done", parent_id: "epic", completed: true }),
    task({ id: "blkr", name: "Blocker", parent_id: "epic" }),
    task({ id: "blocked", name: "Blocked", parent_id: "epic", blockedBy: ["blkr"] }),
  ];
  const m = byId(buildDexBoard([{ tasks }]));
  assert.equal(m.get("ready")!.status, "ready");
  assert.equal(m.get("wip")!.status, "in-progress");
  assert.equal(m.get("done")!.status, "done");
  assert.equal(m.get("blocked")!.status, "blocked");
  assert.equal(m.get("blocked")!.blockedByCount, 1);
});

test("a completed blocker no longer blocks (not in the active set)", () => {
  const tasks: RawDexTask[] = [
    task({ id: "blkr", name: "Done blocker", completed: true }),
    task({ id: "t", name: "Was blocked", blockedBy: ["blkr"], started_at: "2026-06-15T00:00:00Z" }),
  ];
  const m = byId(buildDexBoard([{ tasks }]));
  // Blocker is completed → not active → does not block; started → in-progress.
  assert.equal(m.get("t")!.status, "in-progress");
  assert.equal(m.get("t")!.blockedByCount, 0);
});

test("exposes only the active blocker ids (completed blockers filtered out)", () => {
  const tasks: RawDexTask[] = [
    task({ id: "open1", name: "Open blocker 1" }),
    task({ id: "open2", name: "Open blocker 2" }),
    task({ id: "doneBlkr", name: "Completed blocker", completed: true }),
    task({ id: "t", name: "Blocked", blockedBy: ["open1", "doneBlkr", "open2"] }),
  ];
  const t = byId(buildDexBoard([{ tasks }])).get("t")!;
  // Only the still-active blockers survive; the completed one is dropped.
  assert.deepEqual(t.blockedBy, ["open1", "open2"]);
  // `blockedByCount` stays in lockstep with the active-id list.
  assert.equal(t.blockedByCount, 2);
});

test("blocked outranks in-progress (a started+blocked task reads blocked)", () => {
  const tasks: RawDexTask[] = [
    task({ id: "b", name: "Blocker" }),
    task({ id: "t", name: "Started but blocked", started_at: "2026-06-15T00:00:00Z", blockedBy: ["b"] }),
  ];
  assert.equal(byId(buildDexBoard([{ tasks }])).get("t")!.status, "blocked");
});

test("tolerates blocker objects ({ id }) as well as id strings", () => {
  const tasks: RawDexTask[] = [
    task({ id: "b", name: "Blocker" }),
    task({ id: "t", name: "Obj blocker", blockedBy: [{ id: "b" }] }),
  ];
  assert.equal(byId(buildDexBoard([{ tasks }])).get("t")!.status, "blocked");
});

test("builds a pre-ordered tree with depth + isEpic", () => {
  const tasks: RawDexTask[] = [
    task({ id: "epic", name: "Epic", priority: 1 }),
    task({ id: "c2", name: "Child 2", parent_id: "epic", priority: 2 }),
    task({ id: "c1", name: "Child 1", parent_id: "epic", priority: 1 }),
    task({ id: "g1", name: "Grandchild", parent_id: "c1" }),
  ];
  const board = buildDexBoard([{ tasks }]);
  // Pre-order, children sorted by priority: epic, c1, g1, c2.
  assert.deepEqual(
    board.tasks.map((t) => t.id),
    ["epic", "c1", "g1", "c2"],
  );
  const m = byId(board);
  assert.equal(m.get("epic")!.depth, 0);
  assert.equal(m.get("epic")!.isEpic, true);
  assert.equal(m.get("c1")!.depth, 1);
  assert.equal(m.get("c1")!.isEpic, true);
  assert.equal(m.get("g1")!.depth, 2);
  assert.equal(m.get("g1")!.isEpic, false);
});

test("a task whose parent is absent is treated as a root", () => {
  const tasks: RawDexTask[] = [
    task({ id: "orphan", name: "Orphan", parent_id: "missing-epic" }),
  ];
  const board = buildDexBoard([{ tasks }]);
  assert.equal(board.tasks.length, 1);
  assert.equal(board.tasks[0]!.depth, 0);
});

test("aggregates multiple stores and tags each row with its project", () => {
  const board = buildDexBoard([
    { project: "repo-a", tasks: [task({ id: "a1", name: "A1" })] },
    { project: "repo-b", tasks: [task({ id: "b1", name: "B1" })] },
  ]);
  const m = byId(board);
  assert.equal(m.get("a1")!.project, "repo-a");
  assert.equal(m.get("b1")!.project, "repo-b");
  assert.equal(board.tasks.length, 2);
});

test("carries every group's project in config order, including empty ones", () => {
  // A configured-but-empty repo (no tasks) still surfaces in `projects`, so the
  // GUI can render its header + New "+". Order follows the input (config) order.
  const board = buildDexBoard([
    { project: "repo-a", tasks: [task({ id: "a1", name: "A1" })] },
    { project: "repo-empty", tasks: [] },
    { project: "repo-b", tasks: [task({ id: "b1", name: "B1" })] },
  ]);
  assert.deepEqual(board.projects, ["repo-a", "repo-empty", "repo-b"]);
  // The empty repo contributes no rows.
  assert.equal(board.tasks.length, 2);
});

test("an all-empty configured board still lists its projects (zero tasks)", () => {
  const board = buildDexBoard([
    { project: "repo-a", tasks: [] },
    { project: "repo-b", tasks: [] },
  ]);
  assert.deepEqual(board.projects, ["repo-a", "repo-b"]);
  assert.equal(board.tasks.length, 0);
});

test("a single cwd store (no project) yields no projects", () => {
  const board = buildDexBoard([{ tasks: [task({ id: "x", name: "X" })] }]);
  assert.deepEqual(board.projects, []);
});

test("parseRawTasks tolerates extra fields and rejects non-arrays", () => {
  const ok = parseRawTasks([{ id: "x", name: "X", surprise: 42 }]);
  assert.equal(ok.length, 1);
  assert.equal(ok[0]!.id, "x");
  // Malformed payloads degrade to [] rather than throwing.
  assert.deepEqual(parseRawTasks({ not: "an array" }), []);
  assert.deepEqual(parseRawTasks(null), []);
});
