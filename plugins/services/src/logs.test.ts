/**
 * Jump-to-logs command-building + spawn tests (Dev services M3).
 *
 * Covers the pure builders — the inner `process-compose process logs` command
 * with the right connection flag (socket vs address), `{cmd}` substitution into
 * a launcher template, and shell quoting — plus `spawnLogsTerminal`'s contract
 * (returns `{ok}` and spawns the templated command via the injected spawn),
 * asserting the final spawned command/args without launching a real terminal.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyLogTerminalTemplate,
  buildLogsCommand,
  DEFAULT_LOG_TERMINAL,
  resolveLogTerminal,
  spawnLogsTerminal,
  TERMINAL_APP_TEMPLATES,
} from "./logs.js";

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

test("applyLogTerminalTemplate: substitutes every {cmd} placeholder", () => {
  const out = applyLogTerminalTemplate("run {cmd} ; echo {cmd}", "tail -f x");
  assert.equal(out, "run tail -f x ; echo tail -f x");
});

test("DEFAULT_LOG_TERMINAL embeds {cmd} inside the AppleScript do-script", () => {
  assert.match(DEFAULT_LOG_TERMINAL, /do script "\{cmd\}"/);
  const out = applyLogTerminalTemplate(
    DEFAULT_LOG_TERMINAL,
    "process-compose process logs 'api' -f",
  );
  assert.match(out, /do script "process-compose process logs 'api' -f"/);
});

test("TERMINAL_APP_TEMPLATES: Terminal preset is the default; every preset carries {cmd}", () => {
  assert.equal(TERMINAL_APP_TEMPLATES.Terminal, DEFAULT_LOG_TERMINAL);
  for (const [app, template] of Object.entries(TERMINAL_APP_TEMPLATES)) {
    assert.match(template, /\{cmd\}/, `${app} preset must contain {cmd}`);
  }
});

test("TERMINAL_APP_TEMPLATES: iTerm2 preset drives the iTerm AppleScript", () => {
  assert.match(TERMINAL_APP_TEMPLATES.iTerm2, /tell application "iTerm"/);
  assert.match(TERMINAL_APP_TEMPLATES.iTerm2, /create window with default profile/);
  assert.match(TERMINAL_APP_TEMPLATES.iTerm2, /write text "\{cmd\}"/);
});

test("resolveLogTerminal: a chosen terminalApp picks its preset", () => {
  assert.equal(resolveLogTerminal({ terminalApp: "iTerm2" }), TERMINAL_APP_TEMPLATES.iTerm2);
  assert.equal(resolveLogTerminal({ terminalApp: "kitty" }), TERMINAL_APP_TEMPLATES.kitty);
});

test("resolveLogTerminal: explicit logTerminal (Custom) overrides the app preset", () => {
  assert.equal(
    resolveLogTerminal({ terminalApp: "iTerm2", logTerminal: "MINE {cmd}" }),
    "MINE {cmd}",
  );
});

test("resolveLogTerminal: no app + no template, and unknown/Custom app → Terminal default", () => {
  assert.equal(resolveLogTerminal({}), DEFAULT_LOG_TERMINAL);
  assert.equal(resolveLogTerminal({ terminalApp: "Custom" }), DEFAULT_LOG_TERMINAL);
  assert.equal(resolveLogTerminal({ terminalApp: "nonsense" }), DEFAULT_LOG_TERMINAL);
});

test("spawnLogsTerminal: terminalApp selects the preset for the spawned command", () => {
  const { spawn, calls } = stubSpawn();
  spawnLogsTerminal({ name: "api", socket: "/s.sock", terminalApp: "iTerm2", spawn });
  const expected = applyLogTerminalTemplate(
    TERMINAL_APP_TEMPLATES.iTerm2,
    "process-compose process logs 'api' -f --use-uds --unix-socket '/s.sock'",
  );
  assert.deepEqual(calls[0]!.args, ["-c", expected]);
});

/** A spawn stub recording its calls; returns a child with `on`/`unref` no-ops. */
function stubSpawn(): {
  spawn: typeof import("node:child_process").spawn;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn = ((command: string, args: string[]) => {
    calls.push({ command, args });
    return { on: () => {}, unref: () => {} };
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, calls };
}

test("spawnLogsTerminal: returns ok and spawns the templated command via sh -c", () => {
  const { spawn, calls } = stubSpawn();
  const result = spawnLogsTerminal({
    name: "api",
    socket: "/tmp/pc.sock",
    logTerminal: "TERM {cmd}",
    spawn,
  });
  assert.deepEqual(result, { ok: true, message: "Opening logs for api…" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, "sh");
  assert.deepEqual(calls[0]!.args, [
    "-c",
    "TERM process-compose process logs 'api' -f --use-uds --unix-socket '/tmp/pc.sock'",
  ]);
});

test("spawnLogsTerminal: address target spawns the -a/-p logs command", () => {
  const { spawn, calls } = stubSpawn();
  spawnLogsTerminal({
    name: "web",
    address: "http://localhost:8080",
    logTerminal: "T {cmd}",
    spawn,
  });
  assert.deepEqual(calls[0]!.args, [
    "-c",
    "T process-compose process logs 'web' -f -a 'localhost' -p '8080'",
  ]);
});

test("spawnLogsTerminal: a spawn that throws → ok:false, never throws out", () => {
  const spawn = (() => {
    throw new Error("ENOENT");
  }) as unknown as typeof import("node:child_process").spawn;
  const result = spawnLogsTerminal({ name: "api", socket: "/s.sock", spawn });
  assert.equal(result.ok, false);
  assert.match(result.message, /Failed to open logs for api: ENOENT/);
});
