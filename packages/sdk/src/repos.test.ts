/**
 * Unit tests for the shared repo list reader: ctx.global narrowing plus the
 * trim / drop-blanks / de-dupe cleaning consumers rely on.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { reposOf } from "./repos.js";

test("reposOf: undefined / {} / non-object global → []", () => {
  assert.deepEqual(reposOf(undefined), []);
  assert.deepEqual(reposOf({}), []);
  assert.deepEqual(reposOf("nope"), []);
  assert.deepEqual(reposOf(42), []);
});

test("reposOf: a valid list passes through unchanged", () => {
  assert.deepEqual(reposOf({ repos: ["/a/one", "/b/two"] }), ["/a/one", "/b/two"]);
});

test("reposOf: blank / whitespace-only entries are dropped (and entries trimmed)", () => {
  assert.deepEqual(reposOf({ repos: ["  /a/one  ", "", "   ", "/b/two"] }), ["/a/one", "/b/two"]);
});

test("reposOf: duplicates removed, first-seen order preserved", () => {
  assert.deepEqual(reposOf({ repos: ["/a", "/b", "/a", "/c", "/b"] }), ["/a", "/b", "/c"]);
  // Trimming happens before de-dupe, so "/a " and "/a" collapse.
  assert.deepEqual(reposOf({ repos: ["/a", "/a "] }), ["/a"]);
});

test("reposOf: repos present but not an array → []", () => {
  assert.deepEqual(reposOf({ repos: "bad" }), []);
  assert.deepEqual(reposOf({ repos: { 0: "/a" } }), []);
});
