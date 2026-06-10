import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverWorkspacePlugins, findWorkspaceRoot } from "./loader.js";

// These guard the plugin-resolution path that the daemon's dynamic import
// depends on — the gap an end-to-end boot revealed (bare-specifier import of an
// unreferenced workspace package is not resolvable; we resolve via plugins/).

test("findWorkspaceRoot locates the pnpm workspace root", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = findWorkspaceRoot(here);
  assert.ok(root, "expected to find a workspace root");
  assert.ok(/perch[^/]*$/.test(root), `unexpected workspace root: ${root}`);
});

test("discoverWorkspacePlugins maps @perch/plugin-stack to its built entry", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = findWorkspaceRoot(here)!;
  const plugins = discoverWorkspacePlugins(root);

  const entry = plugins.get("@perch/plugin-stack");
  assert.ok(entry, "stack plugin should be discovered under plugins/");
  assert.equal(entry, join(root, "plugins", "stack", "dist", "index.js"));
});

test("discoverWorkspacePlugins returns empty for a dir without plugins/", () => {
  assert.equal(discoverWorkspacePlugins("/nonexistent-xyz").size, 0);
});
