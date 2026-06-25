/**
 * Unit tests for `worktreeAlerts` — the `worktrees.list` durable-alert hook.
 * Raises a `worktrees:<repo>:<branch>:conflict` alert while a worktree has
 * unresolved merge conflicts and clears it when the conflict resolves or the
 * worktree's row leaves the board. Unlike `notify`, it does NOT suppress the
 * first poll; and a still-conflicted worktree with an unchanged payload emits no
 * op (no `raisedAt` churn).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { conflictAlertId, worktreeAlerts, type ConflictAlertPayload } from "./alerts.js";
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

test("conflictAlertId is the documented, worktree-stable id", () => {
  assert.equal(
    conflictAlertId(wt({ name: "fix", branch: "dex/abc-fix", repo: "perch" })),
    "worktrees:perch:dex/abc-fix:conflict",
  );
});

test("alert id falls back to the worktree name on a detached HEAD", () => {
  const w = wt({ name: "detached", branch: undefined, detached: true, repo: "perch" });
  assert.equal(conflictAlertId(w), "worktrees:perch:detached:conflict");
});

test("alert id uses an empty repo segment for the cwd-default (untagged) repo", () => {
  const w = wt({ name: "x", branch: "feature", repo: undefined });
  assert.equal(conflictAlertId(w), "worktrees::feature:conflict");
});

test("a conflict alert id is stable across polls (so re-raise refreshes in place)", () => {
  const w = wt({ name: "fix", branch: "dex/abc-fix", repo: "perch" });
  assert.equal(conflictAlertId(w), conflictAlertId({ ...w, dirtyCount: 3 }));
});

test("first poll (no prev) raises a currently-conflicted worktree — durable, not suppressed", () => {
  const next = board(
    wt({ name: "clean" }),
    wt({ name: "fix", branch: "dex/abc-fix", repo: "perch", path: "/wt/fix", conflict: true }),
  );
  const ops = worktreeAlerts(undefined, next);
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0], {
    op: "raise",
    id: "worktrees:perch:dex/abc-fix:conflict",
    payload: {
      path: "/wt/fix",
      branch: "dex/abc-fix",
      repo: "perch",
      name: "fix",
    } satisfies ConflictAlertPayload,
  });
});

test("a worktree newly conflicted raises", () => {
  const prev = board(wt({ name: "fix", branch: "dex/abc-fix", repo: "perch" }));
  const next = board(wt({ name: "fix", branch: "dex/abc-fix", repo: "perch", conflict: true }));
  const ops = worktreeAlerts(prev, next);
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.op, "raise");
  assert.equal(ops[0]!.id, "worktrees:perch:dex/abc-fix:conflict");
});

test("a still-conflicted worktree with an unchanged payload emits nothing (no raisedAt churn)", () => {
  const prev = board(wt({ name: "fix", branch: "dex/abc-fix", repo: "perch", conflict: true }));
  const next = board(wt({ name: "fix", branch: "dex/abc-fix", repo: "perch", conflict: true }));
  assert.deepEqual(worktreeAlerts(prev, next), []);
});

test("a still-conflicted worktree whose payload changed re-raises (payload refresh)", () => {
  const prev = board(
    wt({ name: "fix", branch: "dex/abc-fix", repo: "perch", path: "/old", conflict: true }),
  );
  const next = board(
    wt({ name: "fix", branch: "dex/abc-fix", repo: "perch", path: "/new", conflict: true }),
  );
  const ops = worktreeAlerts(prev, next);
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.op, "raise");
  assert.equal((ops[0] as { payload: ConflictAlertPayload }).payload.path, "/new");
});

test("a worktree whose conflict resolves clears its alert", () => {
  const prev = board(wt({ name: "fix", branch: "dex/abc-fix", repo: "perch", conflict: true }));
  const next = board(wt({ name: "fix", branch: "dex/abc-fix", repo: "perch", conflict: false }));
  assert.deepEqual(worktreeAlerts(prev, next), [
    { op: "clear", id: "worktrees:perch:dex/abc-fix:conflict" },
  ]);
});

test("a conflicted worktree removed from the board entirely clears its alert", () => {
  const prev = board(wt({ name: "fix", branch: "dex/abc-fix", repo: "perch", conflict: true }));
  const next = board();
  assert.deepEqual(worktreeAlerts(prev, next), [
    { op: "clear", id: "worktrees:perch:dex/abc-fix:conflict" },
  ]);
});

test("independent worktrees raise/clear independently in one diff", () => {
  const prev = board(
    wt({ name: "a", branch: "a", repo: "perch", conflict: true }),
    wt({ name: "b", branch: "b", repo: "perch", conflict: false }),
  );
  const next = board(
    wt({ name: "a", branch: "a", repo: "perch", conflict: false }),
    wt({ name: "b", branch: "b", repo: "perch", conflict: true }),
  );
  const ops = worktreeAlerts(prev, next);
  assert.equal(ops.length, 2);
  assert.ok(ops.some((o) => o.op === "clear" && o.id === "worktrees:perch:a:conflict"));
  assert.ok(ops.some((o) => o.op === "raise" && o.id === "worktrees:perch:b:conflict"));
});

test("no conflicts and none prior is a no-op", () => {
  const prev = board(wt({ name: "a" }), wt({ name: "b" }));
  const next = board(wt({ name: "a" }), wt({ name: "b" }));
  assert.deepEqual(worktreeAlerts(prev, next), []);
});
