/**
 * Shared terminal launcher — the user's terminal-of-choice, used by any plugin
 * that needs to open a window running a command (the services log viewer, the
 * worktrees "open here" action). Lives in the SDK so every plugin authors
 * against one launcher + one config shape, instead of each rolling its own.
 *
 * The config is the cross-plugin global setting `global.terminal` ({ terminalApp,
 * logTerminal }); read it from `ctx.global` via {@link terminalConfigOf}. The
 * command-building bits are pure + unit-testable; {@link spawnInTerminal} wraps
 * them around an injectable `spawn`, routing the inner command through a temp
 * script so the launcher template only ever interpolates a quote-free `sh <path>`
 * (the fix for nested-quote collisions across the AppleScript/CLI presets).
 */
import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { DexRgb } from "./dex-color.js";
import type { SettingsField } from "./index.js";

/**
 * The default macOS launcher template. `{cmd}` is replaced with the command to
 * run; the AppleScript opens a new Terminal.app window running it and brings
 * Terminal to the front.
 */
export const DEFAULT_TERMINAL =
  `osascript -e 'tell application "Terminal" to do script "{cmd}"' ` +
  `-e 'tell application "Terminal" to activate'`;

/**
 * Built-in launcher presets keyed by terminal app, so the user just picks their
 * terminal in Settings. Each carries the same `{cmd}` placeholder. `Custom` is
 * not here — it's the free-text {@link GlobalTerminalConfig.logTerminal} escape hatch.
 */
export const TERMINAL_APP_TEMPLATES = {
  Terminal: DEFAULT_TERMINAL,
  iTerm2:
    `osascript ` +
    `-e 'tell application "iTerm" to create window with default profile' ` +
    `-e 'tell application "iTerm" to tell current session of current window to write text "{cmd}"' ` +
    `-e 'tell application "iTerm" to activate'`,
  kitty: `open -na kitty --args sh -c "{cmd}"`,
  WezTerm: `open -na WezTerm --args start -- sh -c "{cmd}"`,
  Ghostty: `open -na Ghostty --args -e sh -c "{cmd}"`,
  tmux: `tmux new-window "{cmd}"`,
} as const;

/** A known terminal app name (a key of {@link TERMINAL_APP_TEMPLATES}). */
export type TerminalApp = keyof typeof TERMINAL_APP_TEMPLATES;

/**
 * Per-app AppleScript clause that tints the just-opened window to an identity
 * color — appended after the launch template (so it runs once the window
 * exists). `{rgb}` is replaced with an AppleScript `{r, g, b}` list in 0–65535
 * channels. Only the AppleScript terminals (Terminal.app, iTerm2) get a clause;
 * the others (kitty/WezTerm/Ghostty/tmux) and custom templates have none, so
 * coloring is a graceful no-op there rather than a broken command. This is how a
 * spawned agent's window matches its dex task's color (see
 * {@link dexTaskColorRgb}); callers without a color leave the launch untouched.
 */
export const TERMINAL_COLOR_CLAUSES: Partial<Record<TerminalApp, string>> = {
  Terminal: `-e 'tell application "Terminal" to set background color of front window to {rgb}'`,
  iTerm2:
    `-e 'tell application "iTerm" to tell current session of current window ` +
    `to set background color to {rgb}'`,
};

/** The cross-plugin terminal preference (lives at `global.terminal`). */
export const GlobalTerminalConfig = z.object({
  /** Chosen terminal app (a {@link TERMINAL_APP_TEMPLATES} key), e.g. "iTerm2". */
  terminalApp: z.string().optional(),
  /** Custom launcher template ({cmd} placeholder) — overrides terminalApp. */
  logTerminal: z.string().optional(),
});
export type GlobalTerminalConfig = z.infer<typeof GlobalTerminalConfig>;

/**
 * The settings fields the "General" tab renders for the terminal preference.
 * Shared so the descriptor and the launcher never drift. Keyed under
 * `terminal.*` (the General tab writes to `global.terminal`).
 */
export const TERMINAL_SETTINGS_FIELDS: SettingsField[] = [
  {
    key: "terminal.terminalApp",
    type: "enum",
    label: "Terminal",
    description:
      "Which terminal app Perch opens for service logs and for opening a worktree. " +
      "Choose Custom and set the command below for anything not listed.",
    default: "Terminal",
    options: [
      { value: "Terminal", label: "Terminal.app" },
      { value: "iTerm2", label: "iTerm2" },
      { value: "kitty", label: "kitty" },
      { value: "WezTerm", label: "WezTerm" },
      { value: "Ghostty", label: "Ghostty" },
      { value: "tmux", label: "tmux" },
      { value: "Custom", label: "Custom (use the command below)" },
    ],
  },
  {
    key: "terminal.logTerminal",
    type: "string",
    label: "Custom terminal command",
    description:
      "Only used when Terminal is Custom: a command template. Use {cmd} where the command to run should go.",
    default: DEFAULT_TERMINAL,
    showWhen: { key: "terminal.terminalApp", equals: "Custom" },
  },
];

/** Narrow `ctx.global` to the terminal settings at `global.terminal`; {} on miss. */
export function terminalConfigOf(global: unknown): GlobalTerminalConfig {
  const g = global && typeof global === "object" ? (global as Record<string, unknown>) : {};
  const parsed = GlobalTerminalConfig.safeParse(g.terminal ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * Resolve the launcher template, in precedence order: an explicit `logTerminal`
 * (Custom escape hatch) wins; else the chosen `terminalApp` preset; else the
 * Terminal.app default. An unknown `terminalApp` (e.g. "Custom" with no
 * `logTerminal`) falls back to the default.
 */
export function resolveTerminalTemplate(cfg: GlobalTerminalConfig): string {
  if (cfg.logTerminal) return cfg.logTerminal;
  if (cfg.terminalApp && cfg.terminalApp in TERMINAL_APP_TEMPLATES) {
    return TERMINAL_APP_TEMPLATES[cfg.terminalApp as TerminalApp];
  }
  return DEFAULT_TERMINAL;
}

/**
 * Resolve the per-app color clause for the chosen terminal, mirroring
 * {@link resolveTerminalTemplate}'s precedence: a custom `logTerminal` template
 * is opaque to us, so it gets no clause (no-op); a known `terminalApp` gets its
 * clause (may be undefined); otherwise we default to Terminal.app's. `undefined`
 * means "this terminal has no color hook" — color is skipped, not forced.
 */
export function resolveTerminalColorClause(cfg: GlobalTerminalConfig): string | undefined {
  if (cfg.logTerminal) return undefined;
  if (cfg.terminalApp && cfg.terminalApp in TERMINAL_APP_TEMPLATES) {
    return TERMINAL_COLOR_CLAUSES[cfg.terminalApp as TerminalApp];
  }
  return TERMINAL_COLOR_CLAUSES.Terminal;
}

const RGB_PLACEHOLDER = "{rgb}";

/** Scale a 0–255 RGB channel to AppleScript's 0–65535 range (×257), clamped. */
function to16Bit(channel: number): number {
  const c = Math.max(0, Math.min(255, Math.round(channel)));
  return c * 257;
}

/**
 * Append the terminal's color clause (with `rgb` filled in) to a resolved launch
 * command, tinting the window to the task's identity color. When the terminal
 * has no color hook (see {@link resolveTerminalColorClause}) the launch is
 * returned unchanged — a clean degrade for kitty/WezTerm/Ghostty/tmux/custom.
 */
export function appendTerminalColor(
  launch: string,
  cfg: GlobalTerminalConfig,
  rgb: DexRgb,
): string {
  const clause = resolveTerminalColorClause(cfg);
  if (!clause) return launch;
  const list = `{${to16Bit(rgb.r)}, ${to16Bit(rgb.g)}, ${to16Bit(rgb.b)}}`;
  return `${launch} ${clause.split(RGB_PLACEHOLDER).join(list)}`;
}

const CMD_PLACEHOLDER = "{cmd}";

/** Substitute `cmd` into every `{cmd}` placeholder of `template` (literal replace). */
export function applyTemplate(template: string, cmd: string): string {
  return template.split(CMD_PLACEHOLDER).join(cmd);
}

/**
 * Single-quote a shell word (wraps in `'…'`, escapes embedded single quotes the
 * POSIX way) so callers can build inner commands with arbitrary paths/names.
 */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * Persist `command` to a small shell script in a Perch temp dir and return its
 * path. The launcher then interpolates only a quote-free `sh <path>`, so the
 * inner command's quoting lives in the script rather than nested into the
 * launcher template (which survives every preset). The command is written
 * verbatim — the caller controls `exec` (a single program prefixes `exec …` for
 * clean Ctrl-C; a compound like `cd … && exec "$SHELL"` can't be exec'd whole).
 * One file per label (sanitized), overwritten each time.
 */
function defaultWriteScript(label: string, command: string): string {
  const dir = join(tmpdir(), "perch-terminal");
  mkdirSync(dir, { recursive: true });
  const safe = label.replace(/[^A-Za-z0-9._-]/g, "_") || "perch";
  const path = join(dir, `${safe}.sh`);
  writeFileSync(path, `#!/bin/sh\n${command}\n`);
  return path;
}

/** Options for {@link spawnInTerminal}. */
export interface SpawnInTerminalOptions {
  /** The inner command to run in the terminal (callers shell-quote their args). */
  command: string;
  /** The terminal preference (from {@link terminalConfigOf}). */
  terminal: GlobalTerminalConfig;
  /** A short label for the temp-script filename, log lines, and result message. */
  label: string;
  /**
   * Optional identity color to tint the opened window to (e.g. a dex task's
   * {@link dexTaskColorRgb}). Applied only on terminals with a color hook
   * (Terminal.app / iTerm2); a no-op elsewhere. Omit to launch uncolored.
   */
  tabColor?: DexRgb;
  /** Optional log sink. */
  log?: (message: string) => void;
  /** Injected spawn (tests stub it); defaults to `child_process.spawn`. */
  spawn?: typeof nodeSpawn;
  /** Injected script writer (tests stub it to avoid disk I/O). */
  writeScript?: (label: string, command: string) => string;
}

/**
 * Open the configured terminal running `command`, detached + best-effort. Never
 * throws: a missing binary or spawn error is logged and reported as `ok:false`
 * so the calling action can surface "couldn't open the terminal" without
 * crashing. The full launcher runs via `sh -c` so AppleScript/CLI templates are
 * interpreted as written.
 */
export function spawnInTerminal(opts: SpawnInTerminalOptions): { ok: boolean; message: string } {
  const template = resolveTerminalTemplate(opts.terminal);
  const spawnFn = opts.spawn ?? nodeSpawn;
  const writeScript = opts.writeScript ?? defaultWriteScript;
  try {
    const scriptPath = writeScript(opts.label, opts.command);
    const base = applyTemplate(template, `sh ${scriptPath}`);
    const launch = opts.tabColor ? appendTerminalColor(base, opts.terminal, opts.tabColor) : base;
    const child = spawnFn("sh", ["-c", launch], { detached: true, stdio: "ignore" });
    child.on("error", (err: Error) => opts.log?.(`terminal launch failed: ${err.message}`));
    child.unref();
    opts.log?.(`opened terminal: ${opts.label}`);
    return { ok: true, message: `Opening ${opts.label}…` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.log?.(`terminal launch failed: ${message}`);
    return { ok: false, message: `Failed to open ${opts.label}: ${message}` };
  }
}
