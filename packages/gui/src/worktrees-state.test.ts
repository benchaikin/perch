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

test("buildWorktreesSection sets multiRepo only when rows span >1 repo", () => {
  // No repo tags (single, unlabeled repo) → not multi-repo.
  assert.equal(buildWorktreesSection(list(wt({ name: "a", health: "muted" }))).multiRepo, false);
  // One distinct repo tag → still a single repo.
  assert.equal(
    buildWorktreesSection(list(wt({ name: "a", repo: "alpha", health: "muted" }))).multiRepo,
    false,
  );
  // Two distinct repos → multi-repo (renderer draws per-repo headers).
  assert.equal(
    buildWorktreesSection(
      list(
        wt({ name: "a", repo: "alpha", health: "muted" }),
        wt({ name: "b", repo: "beta", health: "muted" }),
      ),
    ).multiRepo,
    true,
  );
});

test("buildWorktreesSection annotates rows from the task map (and only those)", () => {
  const section = buildWorktreesSection(
    list(
      wt({ name: "a", path: "/wt/a", health: "muted" }),
      wt({ name: "b", path: "/wt/b", health: "muted" }),
    ),
    new Map([["/wt/a", { id: "t1", name: "Task one", status: "in-progress" }]]),
  );
  assert.deepEqual(section.rows[0]!.task, { id: "t1", name: "Task one", status: "in-progress" });
  // Unmatched rows carry no task; an omitted map leaves every row bare.
  assert.equal(section.rows[1]!.task, undefined);
  assert.equal(buildWorktreesSection(list(wt({ name: "a", health: "muted" }))).rows[0]!.task, undefined);
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

test("buildWorktreesSection creates repoGroups with aggregates when multiRepo=true", () => {
  const section = buildWorktreesSection(
    list(
      wt({ name: "a", repo: "alpha", health: "ok" }),
      wt({ name: "b", repo: "alpha", dirty: true, dirtyCount: 2, health: "warn" }),
      wt({ name: "c", repo: "beta", health: "muted" }),
      wt({ name: "d", repo: "beta", conflict: true, health: "bad" }),
    ),
  );

  // multiRepo is true (2 repos).
  assert.equal(section.multiRepo, true);

  // repoGroups has one entry per repo, in order of first appearance.
  assert.equal(section.repoGroups.length, 2);
  assert.equal(section.repoGroups[0]!.repo, "alpha");
  assert.equal(section.repoGroups[1]!.repo, "beta");

  // Alpha group: 2 rows, health=worst(ok,warn)=warn, dirtyCount=2.
  const alphaGroup = section.repoGroups[0]!;
  assert.equal(alphaGroup.count, 2);
  assert.equal(alphaGroup.health, "warn");
  assert.equal(alphaGroup.dirtyCount, 2);
  assert.equal(alphaGroup.hasConflict, false);

  // Beta group: 2 rows, health=worst(muted,bad)=bad, dirtyCount=0, hasConflict=true.
  const betaGroup = section.repoGroups[1]!;
  assert.equal(betaGroup.count, 2);
  assert.equal(betaGroup.health, "bad");
  assert.equal(betaGroup.dirtyCount, 0);
  assert.equal(betaGroup.hasConflict, true);
});

test("buildWorktreesSection has empty repoGroups when multiRepo=false", () => {
  const section = buildWorktreesSection(list(wt({ name: "a", health: "muted" })));

  // Single repo → multiRepo=false, repoGroups=empty.
  assert.equal(section.multiRepo, false);
  assert.equal(section.repoGroups.length, 0);
});

test("repoGroups rows are independent of main-first ordering (already maintained by input)", () => {
  const section = buildWorktreesSection(
    list(
      wt({ name: "a", repo: "r", main: true, health: "muted" }),
      wt({ name: "b", repo: "r", main: false, health: "muted" }),
    ),
  );

  // Rows in group preserve order from buildWorktreesSection input (main first).
  assert.equal(section.repoGroups[0]!.rows[0]!.main, true);
  assert.equal(section.repoGroups[0]!.rows[1]!.main, false);
});
