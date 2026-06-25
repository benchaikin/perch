/**
 * Unit tests for the `worktrees.resolve` action's pure helpers (prompt, title,
 * tab color, launch command). The terminal spawn itself is a seam exercised via
 * the plugin action elsewhere.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { dexTaskColorRgb } from "@perch/sdk";

import { resolveLaunchCommand, resolvePrompt, resolveTabColor, resolveTitle } from "./resolve.js";

test("the prompt names conflicts and forbids pushing/merging", () => {
  const prompt = resolvePrompt();
  assert.match(prompt, /merge conflicts/i);
  assert.match(prompt, /git status/);
  assert.match(prompt, /Do NOT push or merge/);
});

test("the title prefers the branch, falling back to the worktree basename", () => {
  assert.equal(
    resolveTitle({ path: "/wt/fix", branch: "dex/abc-fix" }),
    "resolve conflicts · dex/abc-fix",
  );
  assert.equal(resolveTitle({ path: "/some/where/fix-1" }), "resolve conflicts · fix-1");
});

test("the tab color keys off a dex branch's task id so it matches that task everywhere", () => {
  // `dex/abc-fix` → task id `abc` → the same hue as the dex task's other windows.
  assert.deepEqual(resolveTabColor({ path: "/wt", branch: "dex/abc-fix" }), dexTaskColorRgb("abc"));
});

test("a non-dex branch colors by the branch name, a branchless worktree by its path", () => {
  assert.deepEqual(resolveTabColor({ path: "/wt", branch: "feature" }), dexTaskColorRgb("feature"));
  assert.deepEqual(resolveTabColor({ path: "/wt/x" }), dexTaskColorRgb("/wt/x"));
});

test("the launch command cds into the worktree and execs claude with the prompt", () => {
  const cmd = resolveLaunchCommand({ path: "/wt/fix" });
  assert.match(cmd, /cd '\/wt\/fix'/);
  assert.match(cmd, /exec claude/);
});
