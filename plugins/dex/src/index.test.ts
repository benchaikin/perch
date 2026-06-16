/**
 * Unit tests for the monitored-roots precedence: `plugins.dex.dirs` overrides the
 * shared `global.repos`, which in turn overrides the cwd-resolved default store.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { effectiveDirs } from "./index.js";

test("effectiveDirs: dirs override global.repos when set and non-empty", () => {
  assert.deepEqual(
    effectiveDirs(["/a", "/b"], { repos: ["/x", "/y"] }),
    ["/a", "/b"],
  );
});

test("effectiveDirs: falls back to global.repos when dirs is empty", () => {
  assert.deepEqual(effectiveDirs([], { repos: ["/x", "/y"] }), ["/x", "/y"]);
});

test("effectiveDirs: global.repos is cleaned (trim / drop blanks / de-dupe)", () => {
  assert.deepEqual(
    effectiveDirs([], { repos: ["  /x  ", "", "/y", "/x"] }),
    ["/x", "/y"],
  );
});

test("effectiveDirs: [] (cwd default) when both dirs and global.repos are empty", () => {
  assert.deepEqual(effectiveDirs([], {}), []);
  assert.deepEqual(effectiveDirs([], undefined), []);
  assert.deepEqual(effectiveDirs([], { repos: [] }), []);
});
