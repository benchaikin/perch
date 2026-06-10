import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig, loadConfig, pluginsFromConfig } from "./config.js";

function tempFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "perch-config-test-"));
  const path = join(dir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

test("loadConfig: missing file yields defaults (no plugins, no error)", async () => {
  const path = join(tmpdir(), "perch-does-not-exist-xyz", "perch.json");
  const config = await loadConfig(path);
  assert.deepEqual(config, defaultConfig());
  assert.deepEqual(config.plugins, {});
});

test("loadConfig: valid file parses plugins + per-plugin config + layout", async () => {
  const path = tempFile(
    "perch.json",
    JSON.stringify({
      plugins: { stack: { repos: ["o/r"] } },
      layout: { widgets: [{ id: "stack", x: 0, y: 0 }] },
    }),
  );
  const config = await loadConfig(path);
  assert.deepEqual(config.plugins, { stack: { repos: ["o/r"] } });
  // layout is passed through untouched (reserved in v1).
  assert.deepEqual(config.layout, { widgets: [{ id: "stack", x: 0, y: 0 }] });
});

test("loadConfig: invalid JSON surfaces a clear error", async () => {
  const path = tempFile("perch.json", "{ not json");
  await assert.rejects(loadConfig(path), /invalid JSON in config/);
});

test("loadConfig: schema violation surfaces a clear error", async () => {
  // `plugins` must be an object, not an array.
  const path = tempFile("perch.json", JSON.stringify({ plugins: [1, 2, 3] }));
  await assert.rejects(loadConfig(path), /invalid config/);
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
