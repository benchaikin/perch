/**
 * Unit tests for the shared terminal launcher: template resolution, {cmd}
 * substitution, shell quoting, ctx.global narrowing, and spawnInTerminal's
 * temp-script contract (with an injected spawn + writeScript).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appendTerminalColor,
  applyTemplate,
  DEFAULT_TERMINAL,
  resolveTerminalColorClause,
  resolveTerminalTemplate,
  shellQuote,
  spawnInTerminal,
  TERMINAL_APP_TEMPLATES,
  TERMINAL_COLOR_CLAUSES,
  terminalConfigOf,
} from "./terminal.js";

test("resolveTerminalTemplate: chosen app picks its preset", () => {
  assert.equal(resolveTerminalTemplate({ terminalApp: "iTerm2" }), TERMINAL_APP_TEMPLATES.iTerm2);
  assert.equal(resolveTerminalTemplate({ terminalApp: "kitty" }), TERMINAL_APP_TEMPLATES.kitty);
});

test("resolveTerminalTemplate: custom logTerminal overrides the app preset", () => {
  assert.equal(resolveTerminalTemplate({ terminalApp: "iTerm2", logTerminal: "MINE {cmd}" }), "MINE {cmd}");
});

test("resolveTerminalTemplate: empty / unknown / Custom → Terminal default", () => {
  assert.equal(resolveTerminalTemplate({}), DEFAULT_TERMINAL);
  assert.equal(resolveTerminalTemplate({ terminalApp: "Custom" }), DEFAULT_TERMINAL);
  assert.equal(resolveTerminalTemplate({ terminalApp: "nonsense" }), DEFAULT_TERMINAL);
});

test("applyTemplate substitutes every {cmd}", () => {
  assert.equal(applyTemplate("run {cmd} ; echo {cmd}", "tail -f x"), "run tail -f x ; echo tail -f x");
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
  assert.deepEqual(terminalConfigOf({ terminal: { terminalApp: "iTerm2" } }), { terminalApp: "iTerm2" });
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

test("resolveTerminalColorClause: AppleScript apps get a clause; others / custom none", () => {
  assert.equal(resolveTerminalColorClause({ terminalApp: "iTerm2" }), TERMINAL_COLOR_CLAUSES.iTerm2);
  assert.equal(resolveTerminalColorClause({ terminalApp: "Terminal" }), TERMINAL_COLOR_CLAUSES.Terminal);
  // No app → Terminal.app default → its clause.
  assert.equal(resolveTerminalColorClause({}), TERMINAL_COLOR_CLAUSES.Terminal);
  // Terminals without a color hook, and custom templates, get nothing.
  assert.equal(resolveTerminalColorClause({ terminalApp: "kitty" }), undefined);
  assert.equal(resolveTerminalColorClause({ terminalApp: "iTerm2", logTerminal: "MINE {cmd}" }), undefined);
});

test("appendTerminalColor: appends the clause with rgb scaled to 0–65535", () => {
  const out = appendTerminalColor("osascript -e 'x'", { terminalApp: "iTerm2" }, { r: 0, g: 128, b: 255 });
  assert.match(out, /^osascript -e 'x' /);
  // 0×257=0, 128×257=32896, 255×257=65535.
  assert.match(out, /set background color to \{0, 32896, 65535\}/);
});

test("appendTerminalColor: a colorless terminal leaves the launch unchanged", () => {
  const launch = "open -na kitty --args sh -c 'x'";
  assert.equal(appendTerminalColor(launch, { terminalApp: "kitty" }, { r: 1, g: 2, b: 3 }), launch);
});

test("spawnInTerminal: tabColor tints the window; omitting it leaves the launch bare", () => {
  const run = (tabColor?: { r: number; g: number; b: number }) => {
    let launched = "";
    spawnInTerminal({
      command: "true",
      terminal: { terminalApp: "iTerm2" },
      label: "x",
      tabColor,
      spawn: ((_cmd: string, args: string[]) => {
        launched = args[1]!;
        return { on() {}, unref() {} } as never;
      }) as never,
      writeScript: () => "/tmp/x.sh",
    });
    return launched;
  };
  assert.match(run({ r: 78, g: 121, b: 167 }), /set background color to \{/);
  assert.doesNotMatch(run(), /set background color/);
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
