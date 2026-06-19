/**
 * Unit tests for the monitored-roots precedence: `plugins.dex.dirs` overrides the
 * shared `global.repos`, which in turn overrides the cwd-resolved default store.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { autoSpawnRepos, effectiveDirs, tasksForProject } from "./index.js";

test("effectiveDirs: dirs override global.repos when set and non-empty", () => {
  assert.deepEqual(effectiveDirs(["/a", "/b"], { repos: ["/x", "/y"] }), ["/a", "/b"]);
});

test("effectiveDirs: falls back to global.repos when dirs is empty", () => {
  assert.deepEqual(effectiveDirs([], { repos: ["/x", "/y"] }), ["/x", "/y"]);
});

test("effectiveDirs: global.repos is cleaned (trim / drop blanks / de-dupe)", () => {
  assert.deepEqual(effectiveDirs([], { repos: ["  /x  ", "", "/y", "/x"] }), ["/x", "/y"]);
});

test("effectiveDirs: [] (cwd default) when both dirs and global.repos are empty", () => {
  assert.deepEqual(effectiveDirs([], {}), []);
  assert.deepEqual(effectiveDirs([], undefined), []);
  assert.deepEqual(effectiveDirs([], { repos: [] }), []);
});

const PROJECT_TASKS = [
  { id: "a1", project: "alpha" },
  { id: "b1", project: "beta" },
  { id: "a2", project: "alpha" },
  { id: "x1", project: undefined },
];

test("tasksForProject: an undefined project is the no-filter path (every task)", () => {
  // Mirrors today's unscoped spawn-all + the single-store board (tasks carry no
  // project) — every task is launched.
  assert.deepEqual(
    tasksForProject(PROJECT_TASKS, undefined).map((t) => t.id),
    ["a1", "b1", "a2", "x1"],
  );
});

test("tasksForProject: a project filters to that store's tasks (preserving order)", () => {
  assert.deepEqual(
    tasksForProject(PROJECT_TASKS, "alpha").map((t) => t.id),
    ["a1", "a2"],
  );
  assert.deepEqual(
    tasksForProject(PROJECT_TASKS, "beta").map((t) => t.id),
    ["b1"],
  );
});

test("tasksForProject: an unknown project yields nothing (no accidental launch)", () => {
  assert.deepEqual(tasksForProject(PROJECT_TASKS, "gamma"), []);
});

test("autoSpawnRepos: an undefined map auto-spawns nothing (default config is inert)", () => {
  assert.deepEqual(autoSpawnRepos(["/repos/alpha", "/repos/beta"], undefined), []);
});

test("autoSpawnRepos: empty map auto-spawns nothing", () => {
  assert.deepEqual(autoSpawnRepos(["/repos/alpha", "/repos/beta"], {}), []);
});

test("autoSpawnRepos: only repos keyed true (by basename) are Auto; false/absent are Manual", () => {
  assert.deepEqual(
    autoSpawnRepos(["/repos/alpha", "/repos/beta", "/repos/gamma"], {
      alpha: true,
      beta: false,
    }),
    ["/repos/alpha"],
  );
});

test("autoSpawnRepos: selection follows dirs order (deterministic spawn loop)", () => {
  assert.deepEqual(autoSpawnRepos(["/repos/beta", "/repos/alpha"], { alpha: true, beta: true }), [
    "/repos/beta",
    "/repos/alpha",
  ]);
});
