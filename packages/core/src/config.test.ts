import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { defaultConfig, loadConfig, pluginsFromConfig } from "./config.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "perch-config-test-"));
}

function tempFile(name: string, contents: string): string {
  const path = join(tempDir(), name);
  writeFileSync(path, contents, "utf8");
  return path;
}

test("loadConfig: missing file yields defaults (no plugins, no error)", async () => {
  const path = join(tmpdir(), "perch-does-not-exist-xyz", "perch.yaml");
  const config = await loadConfig(path);
  assert.deepEqual(config, defaultConfig());
  assert.deepEqual(config.plugins, {});
});

test("loadConfig: valid YAML file parses plugins + per-plugin config + layout", async () => {
  const path = tempFile(
    "perch.yaml",
    stringify({
      plugins: { stack: { repos: ["o/r"] } },
      layout: { widgets: [{ id: "stack", x: 0, y: 0 }] },
    }),
  );
  const config = await loadConfig(path);
  assert.deepEqual(config.plugins, { stack: { repos: ["o/r"] } });
  // layout is passed through untouched (reserved in v1).
  assert.deepEqual(config.layout, { widgets: [{ id: "stack", x: 0, y: 0 }] });
});

test("loadConfig: YAML supports comments (JSON could not)", async () => {
  const path = tempFile("perch.yaml", "# my repos\nplugins:\n  stack:\n    repos:\n      - o/r\n");
  const config = await loadConfig(path);
  assert.deepEqual(config.plugins, { stack: { repos: ["o/r"] } });
});

test("loadConfig: a JSON body still parses (YAML is a JSON superset)", async () => {
  const path = tempFile("perch.yaml", JSON.stringify({ plugins: { stack: {} } }));
  const config = await loadConfig(path);
  assert.deepEqual(config.plugins, { stack: {} });
});

test("loadConfig: invalid YAML surfaces a clear error", async () => {
  const path = tempFile("perch.yaml", "{ not yaml");
  await assert.rejects(loadConfig(path), /invalid YAML in config/);
});

test("loadConfig: schema violation surfaces a clear error", async () => {
  // `plugins` must be an object, not an array.
  const path = tempFile("perch.yaml", stringify({ plugins: [1, 2, 3] }));
  await assert.rejects(loadConfig(path), /invalid config/);
});

test("loadConfig: falls back to a legacy sibling perch.json when perch.yaml is absent", async () => {
  const dir = tempDir();
  // Only the legacy JSON file exists; the YAML file is absent.
  writeFileSync(
    join(dir, "perch.json"),
    JSON.stringify({ plugins: { stack: { repos: ["o/r"] } } }),
    "utf8",
  );
  const config = await loadConfig(join(dir, "perch.yaml"));
  assert.deepEqual(config.plugins, { stack: { repos: ["o/r"] } });
});

test("pluginsFromConfig derives enabled ids and configs", () => {
  const { ids, configs } = pluginsFromConfig({
    plugins: { stack: { repos: ["o/r"] }, other: {} },
  });
  assert.deepEqual(ids.sort(), ["other", "stack"]);
  assert.deepEqual(configs, { stack: { repos: ["o/r"] }, other: {} });
});

test("pluginsFromConfig on empty/default config yields no plugins", () => {
  const { ids, configs } = pluginsFromConfig(defaultConfig());
  assert.deepEqual(ids, []);
  assert.deepEqual(configs, {});
});
