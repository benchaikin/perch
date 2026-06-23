/**
 * Regression tests for the bundled daemon's option-building. The bug these guard:
 * `bundledDaemonOptions` must forward the cross-plugin `global` block (notably
 * `global.repos`) to startDaemon. With `pluginDefs` set, startDaemon does NOT
 * re-read `global` from the config file — so dropping it here left `ctx.global`
 * empty, `reposOf()` saw no repos, and dex.spawn (plus stack/worktrees/dex) fell
 * back to the daemon's cwd, making "launch an agent from Perch" fail.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { PerchConfig } from "@perch/core";

import { bundledDaemonOptions, BUNDLED_PLUGINS } from "./perchd-options.js";

const paths = { socketPath: "/tmp/perchd.sock", configPath: "/tmp/perch.yaml" };

test("forwards global (repos + terminal) so ctx.global isn't empty", () => {
  const loaded: PerchConfig = {
    plugins: { dex: {}, stack: {} },
    global: { repos: ["/Users/me/perch", "/Users/me/work"], terminal: { terminalApp: "iTerm2" } },
  };
  const opts = bundledDaemonOptions(loaded, paths);
  assert.deepEqual(opts.global, {
    repos: ["/Users/me/perch", "/Users/me/work"],
    terminal: { terminalApp: "iTerm2" },
  });
});

test("derives per-plugin configs and carries the paths + real-daemon flags", () => {
  const loaded: PerchConfig = {
    plugins: { dex: { autoLand: false }, stack: {} },
    global: {},
  };
  const opts = bundledDaemonOptions(loaded, paths);
  assert.deepEqual(opts.configs, { dex: { autoLand: false }, stack: {} });
  assert.equal(opts.socketPath, "/tmp/perchd.sock");
  assert.equal(opts.configPath, "/tmp/perch.yaml");
  // `pluginDefs` flips these off by default; the bundled daemon re-enables them.
  assert.equal(opts.pidFile, true);
  assert.equal(opts.watch, true);
  assert.ok(opts.pluginDefs && opts.pluginDefs.length === BUNDLED_PLUGINS.length);
});

test("an absent global stays undefined without throwing", () => {
  const loaded: PerchConfig = { plugins: {} };
  const opts = bundledDaemonOptions(loaded, paths);
  assert.equal(opts.global, undefined);
});

test("loadPlugins resolves to the same statically-bundled plugins", async () => {
  const opts = bundledDaemonOptions({ plugins: {} }, paths);
  assert.ok(opts.loadPlugins);
  const reloaded = await opts.loadPlugins!(["stack", "dex"]);
  assert.deepEqual(reloaded, BUNDLED_PLUGINS);
});
