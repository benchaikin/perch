/**
 * Unit tests for worktree appear/conflict notifications.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { worktreeNotifications } from "./notify.js";
import type { Worktree, Worktrees } from "./parse.js";

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

const board = (...w: Worktree[]): Worktrees => ({ worktrees: w });

test("no notifications on the first poll (no prev)", () => {
  assert.deepEqual(worktreeNotifications(undefined, board(wt({ name: "a" }))), []);
});

test("announces a newly-appeared worktree", () => {
  const notes = worktreeNotifications(board(wt({ name: "a" })), board(wt({ name: "a" }), wt({ name: "b" })));
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.title, "New worktree");
  assert.equal(notes[0]!.dedupeKey, "worktree:/repo-b:new");
});

test("announces a worktree that newly entered conflict", () => {
  const notes = worktreeNotifications(
    board(wt({ name: "a", conflict: false })),
    board(wt({ name: "a", conflict: true, health: "bad" })),
  );
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.title, "Worktree conflict");
  assert.equal(notes[0]!.level, "warning");
});

test("no repeat when conflict persists / nothing changed", () => {
  const conflicted = board(wt({ name: "a", conflict: true, health: "bad" }));
  assert.deepEqual(worktreeNotifications(conflicted, conflicted), []);
  const clean = board(wt({ name: "a" }));
  assert.deepEqual(worktreeNotifications(clean, clean), []);
});
