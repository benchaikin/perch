/**
 * Unit tests for the Electron-free Worktrees-section view-model derivation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildWorktreesSection,
  worstWorktreeHealth,
  type Worktree,
  type WorktreeList,
} from "./worktrees-state.js";

/** A worktree row with defaults; override per case. */
function wt(over: Partial<Worktree> & { name: string; health: Worktree["health"] }): Worktree {
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
    ...over,
  };
}

function list(...worktrees: Worktree[]): WorktreeList {
  return { worktrees };
}

test("buildWorktreesSection hides when no list / empty list", () => {
  assert.equal(buildWorktreesSection(undefined).visible, false);
  assert.equal(buildWorktreesSection({ worktrees: [] }).visible, false);
});

test("buildWorktreesSection tallies total / dirty / conflict and passes rows main-first", () => {
  const section = buildWorktreesSection(
    list(
      wt({ name: "main", main: true, health: "muted" }),
      wt({ name: "a", dirty: true, dirtyCount: 3, health: "muted" }),
      wt({ name: "b", conflict: true, dirty: true, dirtyCount: 1, health: "bad" }),
    ),
  );
  assert.equal(section.visible, true);
  assert.deepEqual(section.counts, { total: 3, dirty: 2, conflict: 1 });
  assert.equal(section.rows[0]!.main, true);
  assert.equal(section.rows[0]!.name, "main");
});

test("worstWorktreeHealth: bad > warn > muted", () => {
  // A conflict (bad) dominates.
  assert.equal(
    worstWorktreeHealth(buildWorktreesSection(list(wt({ name: "a", health: "muted" }), wt({ name: "b", health: "bad" })))),
    "bad",
  );
  // Diverged (warn) outranks plain muted.
  assert.equal(
    worstWorktreeHealth(buildWorktreesSection(list(wt({ name: "a", health: "muted" }), wt({ name: "b", health: "warn" })))),
    "warn",
  );
  // All neutral → muted.
  assert.equal(
    worstWorktreeHealth(buildWorktreesSection(list(wt({ name: "a", health: "muted" })))),
    "muted",
  );
  // Empty/hidden → muted.
  assert.equal(worstWorktreeHealth(buildWorktreesSection(undefined)), "muted");
});
