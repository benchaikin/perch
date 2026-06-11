import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig } from "./config.js";
import { getConfig, updateConfig, validateRepoPath } from "./config-store.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "perch-config-store-test-"));
}

function configFile(): string {
  return join(tempDir(), "perch.json");
}

test("getConfig: missing file yields defaults", async () => {
  const path = join(tempDir(), "nope", "perch.json");
  assert.deepEqual(await getConfig(path), defaultConfig());
});

test("getConfig: reads an existing file", async () => {
  const path = configFile();
  writeFileSync(path, JSON.stringify({ plugins: { stack: { repos: ["/r"] } } }), "utf8");
  assert.deepEqual(await getConfig(path), { plugins: { stack: { repos: ["/r"] } } });
});

test("updateConfig: deep-merges into nested objects, leaving siblings intact", async () => {
  const path = configFile();
  writeFileSync(
    path,
    JSON.stringify({ plugins: { stack: { repos: ["/a"] }, other: { keep: true } } }),
    "utf8",
  );

  const next = await updateConfig({ plugins: { stack: { repos: ["/a", "/b"] } } }, path);

  assert.deepEqual(next, {
    plugins: { stack: { repos: ["/a", "/b"] }, other: { keep: true } },
  });
  // Persisted to disk and re-readable.
  assert.deepEqual(await getConfig(path), next);
});

test("updateConfig: arrays replace wholesale (not element-merged)", async () => {
  const path = configFile();
  writeFileSync(
    path,
    JSON.stringify({ plugins: { stack: { repos: ["/a", "/b", "/c"] } } }),
    "utf8",
  );

  const next = await updateConfig({ plugins: { stack: { repos: ["/x"] } } }, path);
  assert.deepEqual(next.plugins, { stack: { repos: ["/x"] } });
});

test("updateConfig: null deletes a key", async () => {
  const path = configFile();
  writeFileSync(
    path,
    JSON.stringify({ plugins: { stack: { repos: ["/a"] } }, layout: { widgets: [] } }),
    "utf8",
  );

  const next = await updateConfig({ layout: null }, path);
  assert.deepEqual(next, { plugins: { stack: { repos: ["/a"] } } });
  assert.equal("layout" in next, false);
});

test("updateConfig: creates the file (and parent dir) when absent, with defaults as base", async () => {
  const path = join(tempDir(), "fresh", "perch.json");
  const next = await updateConfig({ plugins: { stack: { repos: ["/r"] } } }, path);
  assert.deepEqual(next, { plugins: { stack: { repos: ["/r"] } } });
  // File exists, is valid JSON, and round-trips.
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), next);
});

test("updateConfig: rejects a patch that violates the schema, without writing", async () => {
  const path = configFile();
  writeFileSync(path, JSON.stringify({ plugins: { stack: {} } }), "utf8");

  // `plugins` must be an object; an array fails the schema.
  await assert.rejects(updateConfig({ plugins: ["bad"] } as never, path), /invalid config/);
  // Original file untouched.
  assert.deepEqual(await getConfig(path), { plugins: { stack: {} } });
});

test("validateRepoPath: a directory with a .git marker is ok", async () => {
  const repo = tempDir();
  mkdirSync(join(repo, ".git"));
  assert.deepEqual(await validateRepoPath(repo), { ok: true });
});

test("validateRepoPath: a .git file (worktree/submodule style) is ok", async () => {
  const repo = tempDir();
  writeFileSync(join(repo, ".git"), "gitdir: /elsewhere", "utf8");
  assert.deepEqual(await validateRepoPath(repo), { ok: true });
});

test("validateRepoPath: a non-git directory is not ok", async () => {
  const dir = tempDir();
  const res = await validateRepoPath(dir);
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /not a git repository/);
});

test("validateRepoPath: a missing path is not ok", async () => {
  const res = await validateRepoPath(join(tempDir(), "does-not-exist"));
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /does not exist/);
});

test("validateRepoPath: a file (not a directory) is not ok", async () => {
  const file = join(tempDir(), "f.txt");
  writeFileSync(file, "x", "utf8");
  const res = await validateRepoPath(file);
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /not a directory/);
});
