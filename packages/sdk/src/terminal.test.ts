/**
 * Unit tests for the shared terminal launcher: template resolution, {cmd}
 * substitution, shell quoting, ctx.global narrowing, and spawnInTerminal's
 * temp-script contract (with an injected spawn + writeScript).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { dexTaskColorRgb } from "./dex-color.js";
import {
  applyTemplate,
  DEFAULT_TERMINAL,
  resolveTabColorCommand,
  resolveTerminalTemplate,
  resolveTitleCommand,
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

test("resolveTabColorCommand: terminal tab uses the SAME shared color as the GUI for a task id", () => {
  // Cross-surface lock: the terminal tab must tint to exactly the channels the
  // dex/worktrees GUI renders for the same task id — both go through the one
  // shared `dexTaskColor` source. A future change that gives the terminal its
  // own color derivation (or drifts the GUI's) breaks this.
  for (const id of ["8ovqrfk8", "rlzkjoz5", "2b7x2x9r", "task-001", ""]) {
    const { r, g, b } = dexTaskColorRgb(id);
    const cmd = resolveTabColorCommand({ terminalApp: "iTerm2" }, dexTaskColorRgb(id));
    assert.match(cmd!, new RegExp(`red;brightness;${r}\\\\a`), `red for ${JSON.stringify(id)}`);
    assert.match(cmd!, new RegExp(`green;brightness;${g}\\\\a`), `green for ${JSON.stringify(id)}`);
    assert.match(cmd!, new RegExp(`blue;brightness;${b}\\\\a`), `blue for ${JSON.stringify(id)}`);
  }
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

test("resolveTitleCommand: OSC 0 printf for xterm-family terminals + the default", () => {
  // Terminal.app/iTerm2/kitty/WezTerm/Ghostty all share the xterm OSC 0 path,
  // with the title passed as a shell-quoted %s argument (injection-safe).
  for (const terminalApp of ["Terminal", "iTerm2", "kitty", "WezTerm", "Ghostty"] as const) {
    const cmd = resolveTitleCommand({ terminalApp }, "dex abc123 · Fix login");
    assert.equal(cmd, `printf '\\033]0;%s\\007' 'dex abc123 · Fix login'`, terminalApp);
  }
  // No app chosen → defaults to Terminal.app's OSC 0.
  assert.equal(resolveTitleCommand({}, "dex abc123"), `printf '\\033]0;%s\\007' 'dex abc123'`);
});

test("resolveTitleCommand: tmux uses its window-rename escape, not OSC 0", () => {
  assert.equal(
    resolveTitleCommand({ terminalApp: "tmux" }, "dex abc123"),
    `printf '\\033k%s\\033\\\\' 'dex abc123'`,
  );
});

test("resolveTitleCommand: custom template, empty title, and unknown app degrade to none", () => {
  // A custom logTerminal template is opaque, so we don't touch the title.
  assert.equal(
    resolveTitleCommand({ terminalApp: "iTerm2", logTerminal: "MINE {cmd}" }, "dex abc123"),
    undefined,
  );
  // Nothing to set for an empty title.
  assert.equal(resolveTitleCommand({ terminalApp: "iTerm2" }, ""), undefined);
  // An unknown app falls back to the Terminal default (which does have a title).
  assert.equal(
    resolveTitleCommand({ terminalApp: "nonsense" }, "dex abc123"),
    `printf '\\033]0;%s\\007' 'dex abc123'`,
  );
});

test("resolveTitleCommand: a title with single quotes is escaped the POSIX way", () => {
  assert.equal(
    resolveTitleCommand({ terminalApp: "iTerm2" }, "dex abc123 · it's broken"),
    `printf '\\033]0;%s\\007' 'dex abc123 · it'\\''s broken'`,
  );
});

test("spawnInTerminal: title + tabColor both prepend, title first, command last", () => {
  let scripted = "";
  spawnInTerminal({
    command: "exec claude",
    terminal: { terminalApp: "iTerm2" },
    label: "x",
    title: "dex abc123",
    tabColor: { r: 78, g: 121, b: 167 },
    spawn: (() => ({ on() {}, unref() {} }) as never) as never,
    writeScript: (_label, command) => {
      scripted = command;
      return "/tmp/x.sh";
    },
  });
  // Ordering: title line, then tab-color line, then the original command. (The
  // tab-color clauses themselves are exercised in detail above.)
  const lines = scripted.split("\n");
  assert.match(lines[0]!, /^printf '\\033\]0;%s\\007' 'dex abc123'$/);
  assert.match(lines[1]!, /^printf '\\033\]6;1;bg;red;brightness;78/);
  assert.equal(lines[2], "exec claude");
});

test("spawnInTerminal: title alone prepends just the title line", () => {
  let scripted = "";
  spawnInTerminal({
    command: "exec claude",
    terminal: { terminalApp: "iTerm2" },
    label: "x",
    title: "dex abc123",
    spawn: (() => ({ on() {}, unref() {} }) as never) as never,
    writeScript: (_label, command) => {
      scripted = command;
      return "/tmp/x.sh";
    },
  });
  assert.equal(scripted, `printf '\\033]0;%s\\007' 'dex abc123'\nexec claude`);
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
