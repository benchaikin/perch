import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { defaultConfig } from "./config.js";
import { getConfig, migrateLegacyConfig, updateConfig, validateRepoPath } from "./config-store.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "perch-config-store-test-"));
}

function configFile(): string {
  return join(tempDir(), "perch.yaml");
}

test("getConfig: missing file yields defaults", async () => {
  const path = join(tempDir(), "nope", "perch.yaml");
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
  const path = join(tempDir(), "fresh", "perch.yaml");
  const next = await updateConfig({ plugins: { stack: { repos: ["/r"] } } }, path);
  // defaultConfig() is the base, so the empty `global` section rides along.
  assert.deepEqual(next, { plugins: { stack: { repos: ["/r"] } }, global: {} });
  // File exists, is valid YAML, and round-trips.
  assert.deepEqual(parse(readFileSync(path, "utf8")), next);
});

test("updateConfig: rejects a patch that violates the schema, without writing", async () => {
  const path = configFile();
  writeFileSync(path, JSON.stringify({ plugins: { stack: {} } }), "utf8");

  // `plugins` must be an object; an array fails the schema.
  await assert.rejects(updateConfig({ plugins: ["bad"] } as never, path), /invalid config/);
  // Original file untouched.
  assert.deepEqual(await getConfig(path), { plugins: { stack: {} } });
});

test("updateConfig: writes canonical YAML (not JSON) to disk", async () => {
  const path = configFile();
  await updateConfig({ plugins: { stack: { repos: ["/a"] } } }, path);
  const text = readFileSync(path, "utf8");
  // Block YAML, not pretty-printed JSON: no wrapping braces, key uses `: `.
  assert.match(text, /^plugins:/m);
  assert.doesNotMatch(text.trimStart(), /^\{/);
  assert.equal(text.endsWith("\n"), true);
});

test("migrateLegacyConfig: rewrites a legacy perch.json as perch.yaml, leaving the original", async () => {
  const dir = tempDir();
  const yamlPath = join(dir, "perch.yaml");
  const jsonPath = join(dir, "perch.json");
  writeFileSync(jsonPath, JSON.stringify({ plugins: { stack: { repos: ["/a"] } } }), "utf8");

  const migrated = await migrateLegacyConfig(yamlPath);
  assert.equal(migrated, true);
  // perch.yaml now exists with the legacy config, in YAML form...
  assert.equal(existsSync(yamlPath), true);
  assert.deepEqual(parse(readFileSync(yamlPath, "utf8")), {
    plugins: { stack: { repos: ["/a"] } },
  });
  // ...and the legacy file is left untouched (just ignored going forward).
  assert.equal(existsSync(jsonPath), true);
});

test("migrateLegacyConfig: no-op when perch.yaml already exists", async () => {
  const dir = tempDir();
  const yamlPath = join(dir, "perch.yaml");
  writeFileSync(yamlPath, "plugins:\n  stack: {}\n", "utf8");
  writeFileSync(join(dir, "perch.json"), JSON.stringify({ plugins: { other: {} } }), "utf8");

  assert.equal(await migrateLegacyConfig(yamlPath), false);
  // Existing YAML left as-is (legacy JSON not merged in).
  assert.deepEqual(await getConfig(yamlPath), { plugins: { stack: {} } });
});

test("migrateLegacyConfig: no-op when there is nothing to migrate", async () => {
  assert.equal(await migrateLegacyConfig(join(tempDir(), "perch.yaml")), false);
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
