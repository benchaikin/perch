/**
 * Tests for the built-in `perch config` command group.
 *
 * These drive {@link runConfigCommand} against a real daemon started with an
 * injected plugin def + temp `configPath` and `watch:false`, so the assertions
 * never depend on the fs-watch reload (an RPC write returns the new config
 * directly, and a subsequent `config get` reads the written file). We exercise
 * `repo add` (validates a real git repo + persists, rejects a non-repo without
 * writing), `repo remove`, `repo list`, `set-default` reordering, and the
 * unknown-subcommand usage error.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon, type RunningDaemon } from "@perch/core";
import { definePlugin } from "@perch/sdk";
import { runConfigCommand, type ConfigOptions } from "./config.js";

const empty = definePlugin({ id: "noop", capabilities: {} });

/** Capture stdout + console output while running `fn`. */
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const origLog = console.log;
  const origError = console.error;
  const origWrite = process.stdout.write.bind(process.stdout);
  let out = "";
  console.log = (...args: unknown[]) => {
    out += args.join(" ") + "\n";
  };
  console.error = (...args: unknown[]) => {
    out += args.join(" ") + "\n";
  };
  process.stdout.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await fn();
    return { code, out };
  } finally {
    console.log = origLog;
    console.error = origError;
    process.stdout.write = origWrite;
  }
}

/** Boot a daemon over a temp configPath seeded with `initial` repos. */
async function boot(
  initial: string[],
): Promise<{ daemon: RunningDaemon; opts: ConfigOptions; dir: string; configPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), "perch-config-cli-test-"));
  const socketPath = join(dir, "perchd.sock");
  const configPath = join(dir, "perch.json");
  writeFileSync(configPath, JSON.stringify({ plugins: { stack: { repos: initial } } }), "utf8");

  const daemon = await startDaemon({
    pluginDefs: [empty],
    socketPath,
    configPath,
    watch: false,
  });
  return { daemon, opts: { socket: socketPath, json: false }, dir, configPath };
}

/** Create a fake git repo directory (a `.git` entry is enough for validation). */
function gitRepo(dir: string, name: string): string {
  const repo = join(dir, name);
  mkdirSync(join(repo, ".git"), { recursive: true });
  return repo;
}

test("repo add validates a real git repo and persists it", async (t) => {
  const { daemon, opts, dir, configPath } = await boot([]);
  t.after(() => daemon.stop());

  const repo = gitRepo(dir, "main");
  const { code, out } = await capture(() =>
    runConfigCommand(["config", "repo", "add", repo], opts),
  );
  assert.equal(code, 0);
  assert.match(out, /added main/);

  // Persisted to the file and visible via config get.
  const written = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(written.plugins.stack.repos, [repo]);

  const get = await capture(() => runConfigCommand(["config", "get"], opts));
  assert.match(get.out, new RegExp(repo.replace(/[/\\]/g, "\\$&")));
});

test("repo add rejects a non-git path without writing", async (t) => {
  const { daemon, opts, dir, configPath } = await boot([]);
  t.after(() => daemon.stop());

  const notRepo = join(dir, "plain-dir");
  mkdirSync(notRepo, { recursive: true });
  const { code, out } = await capture(() =>
    runConfigCommand(["config", "repo", "add", notRepo], opts),
  );
  assert.equal(code, 1);
  assert.match(out, /not a usable git repo/);

  const written = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(written.plugins.stack.repos, []);
});

test("repo add is a no-op when the repo is already configured", async (t) => {
  const dir0 = mkdtempSync(join(tmpdir(), "perch-config-cli-seed-"));
  const repo = gitRepo(dir0, "main");
  const { daemon, opts } = await boot([repo]);
  t.after(() => daemon.stop());

  const { code, out } = await capture(() =>
    runConfigCommand(["config", "repo", "add", repo], opts),
  );
  assert.equal(code, 0);
  assert.match(out, /already configured/);
});

test("repo list marks the first entry as the default", async (t) => {
  const { daemon, opts } = await boot(["/repos/alpha", "/repos/beta"]);
  t.after(() => daemon.stop());

  const { code, out } = await capture(() => runConfigCommand(["config", "repos"], opts));
  assert.equal(code, 0);
  assert.match(out, /alpha\s+\/repos\/alpha \(default\)/);
  assert.match(out, /beta\s+\/repos\/beta$/m);
  assert.doesNotMatch(out, /beta.*\(default\)/);
});

test("repo list --json emits structured entries", async (t) => {
  const { daemon, opts: base } = await boot(["/repos/alpha", "/repos/beta"]);
  const opts: ConfigOptions = { ...base, json: true };
  t.after(() => daemon.stop());

  const { code, out } = await capture(() => runConfigCommand(["config", "repo", "list"], opts));
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out), [
    { name: "alpha", path: "/repos/alpha", default: true },
    { name: "beta", path: "/repos/beta", default: false },
  ]);
});

test("repo remove drops a repo by basename and persists", async (t) => {
  const { daemon, opts, configPath } = await boot(["/repos/alpha", "/repos/beta"]);
  t.after(() => daemon.stop());

  const { code, out } = await capture(() =>
    runConfigCommand(["config", "repo", "remove", "beta"], opts),
  );
  assert.equal(code, 0);
  assert.match(out, /removed beta/);

  const written = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(written.plugins.stack.repos, ["/repos/alpha"]);
});

test("repo remove errors when nothing matches", async (t) => {
  const { daemon, opts } = await boot(["/repos/alpha"]);
  t.after(() => daemon.stop());

  const { code, out } = await capture(() =>
    runConfigCommand(["config", "repo", "remove", "nope"], opts),
  );
  assert.equal(code, 1);
  assert.match(out, /no configured repo matching/);
});

test("repo set-default moves the match to the front", async (t) => {
  const { daemon, opts, configPath } = await boot(["/repos/alpha", "/repos/beta", "/repos/gamma"]);
  t.after(() => daemon.stop());

  const { code, out } = await capture(() =>
    runConfigCommand(["config", "repo", "set-default", "gamma"], opts),
  );
  assert.equal(code, 0);
  assert.match(out, /default repo is now gamma/);

  const written = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(written.plugins.stack.repos, ["/repos/gamma", "/repos/alpha", "/repos/beta"]);
});

test("unknown config subcommand prints usage and exits 1", async (t) => {
  const { daemon, opts } = await boot([]);
  t.after(() => daemon.stop());

  const { code, out } = await capture(() => runConfigCommand(["config", "repo", "bogus"], opts));
  assert.equal(code, 1);
  assert.match(out, /unknown config repo command/);
  assert.match(out, /list\|add\|remove\|set-default/);
});
