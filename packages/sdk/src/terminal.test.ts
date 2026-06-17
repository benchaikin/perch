/**
 * Unit tests for the shared terminal launcher: template resolution, {cmd}
 * substitution, shell quoting, ctx.global narrowing, and spawnInTerminal's
 * temp-script contract (with an injected spawn + writeScript).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyTemplate,
  DEFAULT_TERMINAL,
  resolveTabColorCommand,
  resolveTerminalTemplate,
  shellQuote,
  spawnInTerminal,
  TERMINAL_APP_TEMPLATES,
  terminalConfigOf,
} from "./terminal.js";

test("resolveTerminalTemplate: chosen app picks its preset", () => {
  assert.equal(resolveTerminalTemplate({ terminalApp: "iTerm2" }), TERMINAL_APP_TEMPLATES.iTerm2);
  assert.equal(resolveTerminalTemplate({ terminalApp: "kitty" }), TERMINAL_APP_TEMPLATES.kitty);
});

test("resolveTerminalTemplate: custom logTerminal overrides the app preset", () => {
  assert.equal(
    resolveTerminalTemplate({ terminalApp: "iTerm2", logTerminal: "MINE {cmd}" }),
    "MINE {cmd}",
  );
});

test("resolveTerminalTemplate: empty / unknown / Custom → Terminal default", () => {
  assert.equal(resolveTerminalTemplate({}), DEFAULT_TERMINAL);
  assert.equal(resolveTerminalTemplate({ terminalApp: "Custom" }), DEFAULT_TERMINAL);
  assert.equal(resolveTerminalTemplate({ terminalApp: "nonsense" }), DEFAULT_TERMINAL);
});

test("applyTemplate substitutes every {cmd}", () => {
  assert.equal(
    applyTemplate("run {cmd} ; echo {cmd}", "tail -f x"),
    "run tail -f x ; echo tail -f x",
  );
});

test("TERMINAL_APP_TEMPLATES: Terminal is the default; every preset carries {cmd}", () => {
  assert.equal(TERMINAL_APP_TEMPLATES.Terminal, DEFAULT_TERMINAL);
  for (const template of Object.values(TERMINAL_APP_TEMPLATES)) assert.match(template, /\{cmd\}/);
});

test("shellQuote wraps + escapes single quotes the POSIX way", () => {
  assert.equal(shellQuote("/a/b"), "'/a/b'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test("terminalConfigOf narrows ctx.global.terminal; {} on miss", () => {
  assert.deepEqual(terminalConfigOf({ terminal: { terminalApp: "iTerm2" } }), {
    terminalApp: "iTerm2",
  });
  assert.deepEqual(terminalConfigOf({}), {});
  assert.deepEqual(terminalConfigOf(undefined), {});
  assert.deepEqual(terminalConfigOf({ terminal: "bad" }), {});
});

test("spawnInTerminal: routes the command through a temp script and spawns sh -c", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let scripted: { label: string; command: string } | undefined;
  const fakeSpawn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return { on() {}, unref() {} } as never;
  }) as never;
  const res = spawnInTerminal({
    command: "cd '/the/dir' && exec $SHELL",
    terminal: { terminalApp: "iTerm2" },
    label: "worktree-x",
    spawn: fakeSpawn,
    writeScript: (label, command) => {
      scripted = { label, command };
      return "/tmp/perch-terminal/worktree-x.sh";
    },
  });
  assert.equal(res.ok, true);
  // The inner command went to the script (not nested into the launcher)...
  assert.deepEqual(scripted, { label: "worktree-x", command: "cd '/the/dir' && exec $SHELL" });
  // ...and the launcher only interpolates a quote-free `sh <path>`.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.cmd, "sh");
  assert.match(calls[0]!.args[1]!, /sh \/tmp\/perch-terminal\/worktree-x\.sh/);
  assert.match(calls[0]!.args[1]!, /tell application "iTerm"/);
});

test("resolveTabColorCommand: iTerm2 gets an OSC 6 tab-color printf; others / custom none", () => {
  const cmd = resolveTabColorCommand({ terminalApp: "iTerm2" }, { r: 78, g: 121, b: 167 });
  assert.match(cmd!, /^printf '/);
  assert.match(cmd!, /\]6;1;bg;red;brightness;78\\a/);
  assert.match(cmd!, /\]6;1;bg;green;brightness;121\\a/);
  assert.match(cmd!, /\]6;1;bg;blue;brightness;167\\a/);
  // Terminal.app has only a whole-window background, no tab-bar hook → none,
  // both when chosen explicitly and as the no-app default.
  assert.equal(
    resolveTabColorCommand({ terminalApp: "Terminal" }, { r: 1, g: 2, b: 3 }),
    undefined,
  );
  assert.equal(resolveTabColorCommand({}, { r: 1, g: 2, b: 3 }), undefined);
  // Terminals without a hook, and custom templates, get nothing.
  assert.equal(resolveTabColorCommand({ terminalApp: "kitty" }, { r: 1, g: 2, b: 3 }), undefined);
  assert.equal(
    resolveTabColorCommand(
      { terminalApp: "iTerm2", logTerminal: "MINE {cmd}" },
      { r: 1, g: 2, b: 3 },
    ),
    undefined,
  );
});

test("resolveTabColorCommand: channels clamp + round to 0–255", () => {
  const cmd = resolveTabColorCommand({ terminalApp: "iTerm2" }, { r: -5, g: 127.6, b: 999 });
  assert.match(cmd!, /red;brightness;0\\a/);
  assert.match(cmd!, /green;brightness;128\\a/);
  assert.match(cmd!, /blue;brightness;255\\a/);
});

test("spawnInTerminal: tabColor prepends the tab-color escape to the command; omitting it leaves it bare", () => {
  const run = (tabColor?: { r: number; g: number; b: number }) => {
    let scripted = "";
    spawnInTerminal({
      command: "exec claude",
      terminal: { terminalApp: "iTerm2" },
      label: "x",
      tabColor,
      spawn: (() => ({ on() {}, unref() {} }) as never) as never,
      writeScript: (_label, command) => {
        scripted = command;
        return "/tmp/x.sh";
      },
    });
    return scripted;
  };
  const colored = run({ r: 78, g: 121, b: 167 });
  assert.match(colored, /^printf '\\033\]6;1;bg;red;brightness;78/);
  // The original command stays intact, on its own line after the escape.
  assert.match(colored, /\nexec claude$/);
  // No color → the command is untouched (background stays neutral).
  assert.equal(run(), "exec claude");
});

test("spawnInTerminal: a spawn throw is caught and reported ok:false", () => {
  const res = spawnInTerminal({
    command: "true",
    terminal: {},
    label: "x",
    spawn: (() => {
      throw new Error("boom");
    }) as never,
    writeScript: () => "/tmp/x.sh",
  });
  assert.equal(res.ok, false);
  assert.match(res.message, /boom/);
});
