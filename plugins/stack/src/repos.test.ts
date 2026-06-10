import assert from "node:assert/strict";
import { test } from "node:test";

import { reposResult, resolveRepoCwd, toRepoEntries } from "./repos.js";

const REPOS = ["/work/main", "/work/infra", "/src/perch"];

test("toRepoEntries names each repo by its path basename", () => {
  assert.deepEqual(toRepoEntries(REPOS), [
    { name: "main", path: "/work/main" },
    { name: "infra", path: "/work/infra" },
    { name: "perch", path: "/src/perch" },
  ]);
});

test("toRepoEntries returns [] for absent config", () => {
  assert.deepEqual(toRepoEntries(undefined), []);
  assert.deepEqual(toRepoEntries([]), []);
});

test("reposResult exposes the repos and the first as default", () => {
  assert.deepEqual(reposResult(REPOS), {
    repos: [
      { name: "main", path: "/work/main" },
      { name: "infra", path: "/work/infra" },
      { name: "perch", path: "/src/perch" },
    ],
    default: "main",
  });
});

test("reposResult has no default when no repos are configured", () => {
  assert.deepEqual(reposResult(undefined), { repos: [], default: undefined });
});

test("resolveRepoCwd: by name → that repo's path", () => {
  assert.equal(resolveRepoCwd(REPOS, "infra"), "/work/infra");
});

test("resolveRepoCwd: by path → that exact path", () => {
  assert.equal(resolveRepoCwd(REPOS, "/src/perch"), "/src/perch");
});

test("resolveRepoCwd: omitted request → the default (first) repo", () => {
  assert.equal(resolveRepoCwd(REPOS, undefined), "/work/main");
});

test("resolveRepoCwd: unknown name/path → the default (first) repo", () => {
  assert.equal(resolveRepoCwd(REPOS, "nope"), "/work/main");
});

test("resolveRepoCwd: no repos configured → undefined (cwd fallback)", () => {
  assert.equal(resolveRepoCwd(undefined, undefined), undefined);
  assert.equal(resolveRepoCwd([], "main"), undefined);
});
