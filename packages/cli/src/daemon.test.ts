/**
 * Tests for the built-in `perch daemon` command group.
 *
 * These exercise the no-side-effect paths only: status against a dead socket,
 * the unknown-subcommand usage error, and that `perchd` resolves from
 * `@perch/core`'s bin. We do NOT spawn detached daemons or run
 * launchctl/systemctl here (install/uninstall are live-only).
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolvePerchd, runDaemonCommand } from "./daemon.js";

/** Capture stdout/stderr while running `fn`. */
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const origLog = console.log;
  const origError = console.error;
  let out = "";
  console.log = (...args: unknown[]) => {
    out += args.join(" ") + "\n";
  };
  console.error = (...args: unknown[]) => {
    out += args.join(" ") + "\n";
  };
  try {
    const code = await fn();
    return { code, out };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

test("daemon status against a dead socket reports not running, exit 1", async () => {
  // Isolate BOTH the socket and the pidfile in a temp dir (neither exists), so
  // the test never reads the real daemon's pidfile / socket on this machine.
  const dir = mkdtempSync(join(tmpdir(), "perch-daemon-test-"));
  const socket = join(dir, "perchd.sock");
  const pid = join(dir, "perchd.pid");
  const { code, out } = await capture(() => runDaemonCommand("status", { socket, pid }));
  assert.equal(code, 1);
  assert.match(out, /not running/);
});

test("unknown daemon subcommand prints usage and exits 1", async () => {
  const { code, out } = await capture(() => runDaemonCommand("bogus", {}));
  assert.equal(code, 1);
  assert.match(out, /unknown daemon command/);
  assert.match(out, /status\|start\|stop\|restart\|install\|uninstall/);
});

test("resolvePerchd resolves @perch/core's perchd bin", () => {
  const path = resolvePerchd();
  assert.ok(path.endsWith("bin.js"), path);
});
