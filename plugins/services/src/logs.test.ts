/**
 * Tests for the services-specific `buildLogsCommand` — the inner
 * `process-compose process logs <name> -f` command with the right connection
 * flag (socket vs address) and shell quoting. The terminal launcher it feeds
 * (template resolution, {cmd} substitution, spawn) is shared in `@perch/sdk` and
 * tested there (terminal.test.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildLogsCommand } from "./logs.js";

test("buildLogsCommand: socket target uses --use-uds --unix-socket", () => {
  const cmd = buildLogsCommand("api", { socket: "/tmp/pc.sock" });
  assert.equal(cmd, "process-compose process logs 'api' -f --use-uds --unix-socket '/tmp/pc.sock'");
});

test("buildLogsCommand: address target parses host + port into -a/-p", () => {
  const cmd = buildLogsCommand("web", { address: "http://127.0.0.1:9090" });
  assert.equal(cmd, "process-compose process logs 'web' -f -a '127.0.0.1' -p '9090'");
});

test("buildLogsCommand: default address (no socket/address) → localhost:8080", () => {
  const cmd = buildLogsCommand("db", {});
  assert.equal(cmd, "process-compose process logs 'db' -f -a 'localhost' -p '8080'");
});

test("buildLogsCommand: shell-quotes a name with spaces/quotes", () => {
  const cmd = buildLogsCommand("my svc's", { socket: "/s.sock" });
  assert.match(cmd, /process logs 'my svc'\\''s' -f/);
});
