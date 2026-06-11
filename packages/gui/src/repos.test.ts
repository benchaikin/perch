/**
 * Unit tests for the Electron-free repo-list logic. The Settings window's
 * Electron wiring (window, folder picker, IPC, config RPCs) needs a display +
 * a daemon and is verified by manual launch; the pure array transforms here are
 * the testable part.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addRepo,
  removeRepo,
  reposFromConfig,
  setDefault,
  toEntries,
  type RepoEntry,
} from "./repos.js";

test("reposFromConfig reads plugins.stack.repos, ignoring non-strings", () => {
  const config = { plugins: { stack: { repos: ["/a", 42, "/b", null] } } };
  assert.deepEqual(reposFromConfig(config), ["/a", "/b"]);
});

test("reposFromConfig returns [] when stack/repos is absent or wrong-typed", () => {
  assert.deepEqual(reposFromConfig({}), []);
  assert.deepEqual(reposFromConfig({ plugins: {} }), []);
  assert.deepEqual(reposFromConfig({ plugins: { stack: {} } }), []);
  assert.deepEqual(reposFromConfig({ plugins: { stack: { repos: "/a" } } }), []);
});

test("reposFromConfig normalizes (trims, drops empties, de-dupes)", () => {
  const config = { plugins: { stack: { repos: [" /a ", "/a", "", "/b"] } } };
  assert.deepEqual(reposFromConfig(config), ["/a", "/b"]);
});

test("toEntries derives basename + marks the first as default", () => {
  const entries = toEntries(["/Users/me/repo-one", "/work/repo-two"]);
  assert.deepEqual(entries, [
    { path: "/Users/me/repo-one", name: "repo-one", isDefault: true },
    { path: "/work/repo-two", name: "repo-two", isDefault: false },
  ] satisfies RepoEntry[]);
});

test("toEntries on an empty array yields no rows", () => {
  assert.deepEqual(toEntries([]), []);
});

test("addRepo appends a new path to the end", () => {
  assert.deepEqual(addRepo(["/a"], "/b"), ["/a", "/b"]);
});

test("addRepo de-dupes an already-present path (no duplicate, order kept)", () => {
  assert.deepEqual(addRepo(["/a", "/b"], "/a"), ["/a", "/b"]);
});

test("addRepo trims the path and ignores a blank one", () => {
  assert.deepEqual(addRepo(["/a"], "  /b  "), ["/a", "/b"]);
  assert.deepEqual(addRepo(["/a"], "   "), ["/a"]);
});

test("removeRepo drops the matching path", () => {
  assert.deepEqual(removeRepo(["/a", "/b", "/c"], "/b"), ["/a", "/c"]);
});

test("removeRepo is a no-op when the path is not found", () => {
  assert.deepEqual(removeRepo(["/a", "/b"], "/z"), ["/a", "/b"]);
});

test("removeRepo can empty the list", () => {
  assert.deepEqual(removeRepo(["/a"], "/a"), []);
});

test("setDefault moves the path to the front", () => {
  assert.deepEqual(setDefault(["/a", "/b", "/c"], "/c"), ["/c", "/a", "/b"]);
});

test("setDefault on the already-default path keeps order", () => {
  assert.deepEqual(setDefault(["/a", "/b"], "/a"), ["/a", "/b"]);
});

test("setDefault is a no-op when the path is not found", () => {
  assert.deepEqual(setDefault(["/a", "/b"], "/z"), ["/a", "/b"]);
});
