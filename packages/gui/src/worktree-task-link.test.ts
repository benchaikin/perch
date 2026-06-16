/**
 * Unit tests for the Electron-free worktree ↔ dex-task join.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { DexBoard, DexTask } from "./dex-state.js";
import type { Worktree, WorktreeList } from "./worktrees-state.js";
import { linkWorktreesAndTasks } from "./worktree-task-link.js";

/** A worktree with defaults; override per case. */
function wt(over: Partial<Worktree> & { name: string }): Worktree {
  return {
    path: `/repo-${over.name}`,
    branch: over.name,
    detached: false,
    main: false,
    dirty: false,
    dirtyCount: 0,
    conflict: false,
    locked: false,
    prunable: false,
    health: "muted",
    ...over,
  };
}

/** A dex task with defaults; override per case. */
function task(over: Partial<DexTask> & { id: string }): DexTask {
  return {
    name: over.id,
    description: "",
    result: null,
    status: "ready",
    priority: 0,
    depth: 0,
    isEpic: false,
    blockedByCount: 0,
    blockedBy: [],
    ...over,
  };
}

function wlist(...worktrees: Worktree[]): WorktreeList {
  return { worktrees };
}

function board(...tasks: DexTask[]): DexBoard {
  return { tasks };
}

test("matches a worktree's taskId to a dex task in both directions", () => {
  const link = linkWorktreesAndTasks(
    wlist(wt({ name: "a", path: "/wt/a", taskId: "t1", dirty: true, dirtyCount: 2 })),
    board(task({ id: "t1", name: "Build the thing", status: "in-progress" })),
  );
  assert.deepEqual(link.taskByWorktreePath.get("/wt/a"), {
    id: "t1",
    name: "Build the thing",
    status: "in-progress",
  });
  assert.deepEqual(link.worktreeByTaskId.get("t1"), {
    path: "/wt/a",
    branch: "a",
    repo: undefined,
    dirty: true,
    dirtyCount: 2,
    ahead: undefined,
    behind: undefined,
  });
});

test("carries repo / ahead / behind onto the task→worktree summary", () => {
  const link = linkWorktreesAndTasks(
    wlist(wt({ name: "a", path: "/wt/a", taskId: "t1", repo: "alpha", ahead: 3, behind: 1 })),
    board(task({ id: "t1" })),
  );
  const summary = link.worktreeByTaskId.get("t1");
  assert.equal(summary?.repo, "alpha");
  assert.equal(summary?.ahead, 3);
  assert.equal(summary?.behind, 1);
});

test("no match when a worktree's taskId has no corresponding task", () => {
  const link = linkWorktreesAndTasks(
    wlist(wt({ name: "a", path: "/wt/a", taskId: "missing" })),
    board(task({ id: "t1" })),
  );
  assert.equal(link.taskByWorktreePath.size, 0);
  assert.equal(link.worktreeByTaskId.size, 0);
});

test("a worktree without a taskId is never matched", () => {
  const link = linkWorktreesAndTasks(
    wlist(wt({ name: "a", path: "/wt/a" })),
    board(task({ id: "t1" })),
  );
  assert.equal(link.taskByWorktreePath.size, 0);
  assert.equal(link.worktreeByTaskId.size, 0);
});

test("a task with no live worktree is simply absent from the worktree map", () => {
  const link = linkWorktreesAndTasks(
    wlist(wt({ name: "a", path: "/wt/a", taskId: "t1" })),
    board(task({ id: "t1" }), task({ id: "t2" })),
  );
  // t1 has a worktree; t2 does not.
  assert.ok(link.worktreeByTaskId.has("t1"));
  assert.equal(link.worktreeByTaskId.has("t2"), false);
});

test("multiple worktrees for one task: prefer non-main, then first path", () => {
  // Order deliberately scrambled to prove the pick isn't array-order dependent.
  const link = linkWorktreesAndTasks(
    wlist(
      wt({ name: "main", path: "/wt/main", taskId: "t1", main: true }),
      wt({ name: "z", path: "/wt/z", taskId: "t1" }),
      wt({ name: "a", path: "/wt/a", taskId: "t1" }),
    ),
    board(task({ id: "t1" })),
  );
  // task→worktree picks the non-main worktree with the smallest path.
  assert.equal(link.worktreeByTaskId.get("t1")?.path, "/wt/a");
  // worktree→task still annotates every matched worktree, main included.
  assert.equal(link.taskByWorktreePath.size, 3);
  assert.equal(link.taskByWorktreePath.get("/wt/main")?.id, "t1");
});

test("falls back to the main worktree when it's the only match", () => {
  const link = linkWorktreesAndTasks(
    wlist(wt({ name: "main", path: "/wt/main", taskId: "t1", main: true })),
    board(task({ id: "t1" })),
  );
  assert.equal(link.worktreeByTaskId.get("t1")?.path, "/wt/main");
});

test("missing worktrees board → empty maps, no throw", () => {
  const link = linkWorktreesAndTasks(undefined, board(task({ id: "t1" })));
  assert.equal(link.taskByWorktreePath.size, 0);
  assert.equal(link.worktreeByTaskId.size, 0);
});

test("missing dex board → empty maps, no throw", () => {
  const link = linkWorktreesAndTasks(
    wlist(wt({ name: "a", path: "/wt/a", taskId: "t1" })),
    undefined,
  );
  assert.equal(link.taskByWorktreePath.size, 0);
  assert.equal(link.worktreeByTaskId.size, 0);
});

test("both boards missing → empty maps", () => {
  const link = linkWorktreesAndTasks(undefined, undefined);
  assert.equal(link.taskByWorktreePath.size, 0);
  assert.equal(link.worktreeByTaskId.size, 0);
});
