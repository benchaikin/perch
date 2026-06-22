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
import type { SettingsField, SettingsFieldOption } from "./index.js";

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
 * Raise-or-spawn launchers for the terminals we can drive via AppleScript
 * (Terminal.app, iTerm2). Where {@link TERMINAL_APP_TEMPLATES} *always* opens a
 * fresh window, these first scan the app's windows for a tab/session whose sticky
 * title equals `{title}` and, finding one, raise THAT window — so "jump to the
 * agent already running here" focuses the live session instead of spawning a new
 * shell that disconnects from it (and can step on the worktree). Only when no
 * marked window exists do they open a new one, *tagging* it with `{title}` (a
 * sticky `custom title` / session `name`, which terminal output can't clobber) so
 * the next jump finds it. Each carries both `{cmd}` and `{title}` placeholders.
 *
 * Limited to Terminal.app + iTerm2 (the AppleScript-scriptable apps Perch already
 * tints); kitty/WezTerm/Ghostty/tmux and custom templates have no entry here and
 * fall back to the plain (always-new-window) launcher.
 */
export const FOCUS_OR_SPAWN_TEMPLATES: Partial<Record<TerminalApp, string>> = {
  Terminal:
    `osascript ` +
    `-e 'tell application "Terminal"' ` +
    `-e 'activate' ` +
    `-e 'repeat with w in windows' ` +
    `-e 'repeat with t in tabs of w' ` +
    `-e 'try' ` +
    `-e 'if custom title of t is "{title}" then' ` +
    `-e 'set selected of t to true' ` +
    `-e 'set frontmost of w to true' ` +
    `-e 'return' ` +
    `-e 'end if' ` +
    `-e 'end try' ` +
    `-e 'end repeat' ` +
    `-e 'end repeat' ` +
    `-e 'set t to do script "{cmd}"' ` +
    `-e 'set custom title of t to "{title}"' ` +
    `-e 'end tell'`,
  iTerm2:
    `osascript ` +
    `-e 'tell application "iTerm"' ` +
    `-e 'activate' ` +
    `-e 'repeat with w in windows' ` +
    `-e 'repeat with t in tabs of w' ` +
    `-e 'repeat with s in sessions of t' ` +
    `-e 'if name of s is "{title}" then' ` +
    `-e 'select t' ` +
    `-e 'select w' ` +
    `-e 'return' ` +
    `-e 'end if' ` +
    `-e 'end repeat' ` +
    `-e 'end repeat' ` +
    `-e 'end repeat' ` +
    `-e 'set newWindow to (create window with default profile)' ` +
    `-e 'tell current session of newWindow' ` +
    `-e 'write text "{cmd}"' ` +
    `-e 'set name to "{title}"' ` +
    `-e 'end tell' ` +
    `-e 'end tell'`,
};

/**
 * Per-app shell snippet that tints only the window's tab/header bar (not the
 * whole background) to an identity color. Prepended to the inner command so it
 * runs inside the live session. iTerm2 exposes a tab color via its OSC 6 escape
 * (0–255 channels); Terminal.app has no tab-bar color hook — only a whole-window
 * background, which is exactly the overwhelming tint we're moving away from — so
 * it, like kitty/WezTerm/Ghostty/tmux and custom templates, gets none and
 * degrades to a neutral, uncolored window. This is how a spawned agent's tab
 * matches its dex task's color (see {@link dexTaskColorRgb}); callers without a
 * color leave the command untouched.
 */
export const TERMINAL_TAB_COLOR: Partial<Record<TerminalApp, (rgb: DexRgb) => string>> = {
  iTerm2: itermTabColorCommand,
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

/** The cross-plugin agent-spawn preference (lives at `global.agent`). */
export const GlobalAgentConfig = z.object({
  /** A {@link AGENT_MODEL_OPTIONS} value passed as `claude --model`; empty ⇒ inherit. */
  model: z.string().optional(),
  /** A {@link AGENT_PERMISSION_MODE_OPTIONS} value passed as `claude --permission-mode`. */
  permissionMode: z.string().optional(),
});
export type GlobalAgentConfig = z.infer<typeof GlobalAgentConfig>;

/**
 * The empty sentinel meaning "emit no `--model`" — the spawned `claude` inherits
 * whatever model the user's own Claude config defaults to. The default choice in
 * {@link AGENT_MODEL_OPTIONS} so today's behavior (no `--model`) is preserved.
 */
export const AGENT_MODEL_DEFAULT = "";

/**
 * The canonical model choices for a spawned agent — the documented `claude --model`
 * aliases (the CLI accepts these or a full model id; we offer the stable aliases).
 * Shared so Settings and the new-task dialog pick from the exact same list, and so
 * {@link buildAgentLaunchCommand} can whitelist against it. The empty sentinel
 * ({@link AGENT_MODEL_DEFAULT}) emits no flag.
 */
export const AGENT_MODEL_OPTIONS: SettingsFieldOption[] = [
  { value: AGENT_MODEL_DEFAULT, label: "Use default (inherit Claude config)" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
  { value: "fable", label: "Fable" },
];

/** The default permission mode — `auto`, preserving today's spawn behavior. */
export const AGENT_PERMISSION_MODE_DEFAULT = "auto";

/**
 * The canonical permission-mode choices for a spawned agent — the values
 * `claude --permission-mode` accepts. Shared + whitelisted the same way as
 * {@link AGENT_MODEL_OPTIONS}; defaults to {@link AGENT_PERMISSION_MODE_DEFAULT}.
 */
export const AGENT_PERMISSION_MODE_OPTIONS: SettingsFieldOption[] = [
  { value: "auto", label: "Auto" },
  { value: "default", label: "Default (prompt for permission)" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan" },
  { value: "dontAsk", label: "Don't ask" },
  { value: "bypassPermissions", label: "Bypass permissions" },
];

/**
 * The settings fields the "General" tab renders for the agent-spawn preference.
 * Shared so the descriptor and {@link buildAgentLaunchCommand} never drift. Keyed
 * under `agent.*` (the General tab writes to `global.agent`).
 */
export const AGENT_SETTINGS_FIELDS: SettingsField[] = [
  {
    key: "agent.model",
    type: "enum",
    label: "Agent model",
    description:
      "The model Perch passes to every agent it spawns (dex work-agents, the dex-new author, " +
      "and the stack agent sessions). Leave on the default to inherit your own Claude config.",
    default: AGENT_MODEL_DEFAULT,
    options: AGENT_MODEL_OPTIONS,
  },
  {
    key: "agent.permissionMode",
    type: "enum",
    label: "Agent permission mode",
    description:
      "The permission mode Perch starts every spawned agent in. Auto lets a freshly-spawned " +
      "agent act without first toggling its mode by hand.",
    default: AGENT_PERMISSION_MODE_DEFAULT,
    options: AGENT_PERMISSION_MODE_OPTIONS,
  },
];

/** Narrow `ctx.global` to the agent settings at `global.agent`; {} on miss. */
export function agentConfigOf(global: unknown): GlobalAgentConfig {
  const g = global && typeof global === "object" ? (global as Record<string, unknown>) : {};
  const parsed = GlobalAgentConfig.safeParse(g.agent ?? {});
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
 * The terminal app a raise-or-spawn launch targets, or `undefined` when the
 * chosen terminal can't be driven that way (so the caller spawns plainly).
 * Mirrors {@link resolveTerminalTemplate}'s precedence: a custom `logTerminal`
 * template is opaque to us → none; a terminal with a {@link FOCUS_OR_SPAWN_TEMPLATES}
 * entry (iTerm2) → itself; an unknown/unset/Custom app resolves to the Terminal.app
 * default (which is focusable); any other listed-but-unsupported app (kitty, …) → none.
 */
export function focusableApp(cfg: GlobalTerminalConfig): TerminalApp | undefined {
  if (cfg.logTerminal) return undefined;
  const app = cfg.terminalApp;
  if (app && app in FOCUS_OR_SPAWN_TEMPLATES) return app as TerminalApp;
  // Unset / unknown / "Custom" all fall back to Terminal.app, which is focusable.
  if (!app || !(app in TERMINAL_APP_TEMPLATES)) return "Terminal";
  return undefined;
}

/**
 * Resolve the launcher for a spawn: a raise-or-spawn template (with a `{title}`
 * placeholder) when a focus `marker` is given AND the chosen terminal supports it,
 * else the plain always-new-window template. `focusable` tells the caller whether
 * the `{title}` placeholder still needs substituting.
 */
export function resolveSpawnTemplate(
  cfg: GlobalTerminalConfig,
  marker?: string,
): { template: string; focusable: boolean } {
  if (marker !== undefined) {
    const app = focusableApp(cfg);
    const template = app && FOCUS_OR_SPAWN_TEMPLATES[app];
    if (template) return { template, focusable: true };
  }
  return { template: resolveTerminalTemplate(cfg), focusable: false };
}

/**
 * Escape a focus marker so it can be dropped into a `{title}` placeholder, which
 * sits inside an AppleScript `"…"` string nested inside a single-quoted `osascript
 * -e '…'` shell argument. Two layers: AppleScript (escape `\` then `"`), then the
 * shell single-quote (a literal `'` becomes the POSIX `'\''` dance) so a marker
 * with a quote can't break out of either. Pure + unit-testable.
 */
export function focusTitleLiteral(marker: string): string {
  const apple = marker.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return apple.replaceAll("'", `'\\''`);
}

/** Clamp a 0–255 RGB channel to an integer in range (iTerm2's OSC 6 uses 0–255). */
function channel8(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * iTerm2's OSC 6 tab-color escape, wrapped in a POSIX `printf` so it can be
 * written verbatim into the launch script and run inside the session. Each
 * channel is its own `…;bg;<color>;brightness;<0-255>` clause; ESC is `\033` and
 * the BEL terminator is `\a`, both interpreted by `printf`. The result colors
 * only the tab/header, leaving the window background at the profile default.
 */
function itermTabColorCommand(rgb: DexRgb): string {
  const clause = (color: string, value: number) =>
    `\\033]6;1;bg;${color};brightness;${channel8(value)}\\a`;
  return `printf '${clause("red", rgb.r)}${clause("green", rgb.g)}${clause("blue", rgb.b)}'`;
}

/**
 * Resolve the per-app tab-color command for the chosen terminal, mirroring
 * {@link resolveTerminalTemplate}'s precedence: a custom `logTerminal` template
 * is opaque to us, so it gets none (no-op); a known `terminalApp` gets its
 * builder (may be undefined); otherwise we default to Terminal.app's (none).
 * `undefined` means "this terminal has no tab-color hook" — coloring is skipped,
 * not forced.
 */
export function resolveTabColorCommand(cfg: GlobalTerminalConfig, rgb: DexRgb): string | undefined {
  if (cfg.logTerminal) return undefined;
  const app =
    cfg.terminalApp && cfg.terminalApp in TERMINAL_APP_TEMPLATES
      ? (cfg.terminalApp as TerminalApp)
      : "Terminal";
  return TERMINAL_TAB_COLOR[app]?.(rgb);
}

/**
 * The xterm OSC 0 title escape (`ESC ] 0 ; <title> BEL`), wrapped in a POSIX
 * `printf` so it can be written verbatim into the launch script and run inside
 * the session. Terminal.app, iTerm2, kitty, WezTerm and Ghostty all honor it.
 * The title is passed as a `printf` argument (shell-quoted) and rendered with
 * `%s`, so an arbitrary task name can never inject extra escapes.
 */
function oscTitleCommand(title: string): string {
  return `printf '\\033]0;%s\\007' ${shellQuote(title)}`;
}

/**
 * tmux names the window via its own `ESC k <title> ESC \` sequence rather than
 * OSC 0 (which tmux treats as the pane title, not the visible window name).
 * Same `printf`-with-`%s` shape as {@link oscTitleCommand} so the title is
 * injection-safe.
 */
function tmuxTitleCommand(title: string): string {
  return `printf '\\033k%s\\033\\\\' ${shellQuote(title)}`;
}

/**
 * Per-app shell snippet that sets the spawned window/tab TITLE. Prepended to the
 * inner command so it runs inside the live session, mirroring
 * {@link TERMINAL_TAB_COLOR}. Every supported terminal can set a title: the
 * xterm OSC 0 path covers Terminal.app/iTerm2/kitty/WezTerm/Ghostty, and tmux
 * gets its window-rename escape. (A long-running `claude` may later overwrite
 * the title with its own — this sets it at launch, which is enough to tell a row
 * of freshly-spawned agent windows apart.)
 */
export const TERMINAL_TITLE: Partial<Record<TerminalApp, (title: string) => string>> = {
  Terminal: oscTitleCommand,
  iTerm2: oscTitleCommand,
  kitty: oscTitleCommand,
  WezTerm: oscTitleCommand,
  Ghostty: oscTitleCommand,
  tmux: tmuxTitleCommand,
};

/**
 * Resolve the per-app title-set command for the chosen terminal, mirroring
 * {@link resolveTabColorCommand}'s precedence: a custom `logTerminal` template is
 * opaque to us, so it gets none (no-op); a known `terminalApp` gets its builder;
 * otherwise we default to Terminal.app's. An empty title also yields `undefined`
 * (nothing to set). `undefined` means "don't touch the title" — degrading
 * gracefully rather than emitting a stray escape.
 */
export function resolveTitleCommand(cfg: GlobalTerminalConfig, title: string): string | undefined {
  if (cfg.logTerminal || !title) return undefined;
  const app =
    cfg.terminalApp && cfg.terminalApp in TERMINAL_APP_TEMPLATES
      ? (cfg.terminalApp as TerminalApp)
      : "Terminal";
  return TERMINAL_TITLE[app]?.(title);
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
 * The inner command a spawned agent's terminal runs: `cd` into the worktree and
 * `exec` an interactive `claude` seeded with `prompt`. The path and prompt are
 * shell-quoted, and `exec` replaces the launcher's `sh` so Ctrl-C reaches
 * `claude` directly. `--permission-mode auto` lets a freshly-spawned agent act
 * without first toggling its mode by hand (the whole point of spawning it).
 *
 * When `prompt` is omitted or empty, no prompt arg is appended at all (not an
 * empty quoted string) — the agent drops into a live, agenda-free auto-mode
 * session waiting for the user (the `stack.open-agent` flow).
 *
 * Shared by every "spawn an agent in a worktree" flow (the dex spawn, the stack
 * resolve-conflicts action, the free-form open-agent action) so the launch
 * command stays identical across them.
 *
 * `options` carries the user-configured defaults (from {@link agentConfigOf}).
 * Both fields are WHITELISTED against the canonical option lists before they land
 * in the shell command — an out-of-list model is dropped (no `--model`), an
 * out-of-list/unset mode falls back to `auto`. With no options, the command is
 * byte-identical to today: `cd … && exec claude --permission-mode auto`.
 */
export function buildAgentLaunchCommand(
  worktreePath: string,
  prompt?: string,
  options?: GlobalAgentConfig,
): string {
  const model = whitelistAgentModel(options?.model);
  const permissionMode = whitelistAgentPermissionMode(options?.permissionMode);
  const flags = model
    ? `--model ${model} --permission-mode ${permissionMode}`
    : `--permission-mode ${permissionMode}`;
  const base = `cd ${shellQuote(worktreePath)} && exec claude ${flags}`;
  const seed = prompt?.trim();
  return seed ? `${base} ${shellQuote(seed)}` : base;
}

/**
 * The configured model if it's a known {@link AGENT_MODEL_OPTIONS} value (other
 * than the empty inherit-sentinel), else `undefined` — so a stale/free-text value
 * can never be interpolated into `claude --model <x>`; it just emits no flag.
 */
function whitelistAgentModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return AGENT_MODEL_OPTIONS.some((o) => o.value !== AGENT_MODEL_DEFAULT && o.value === model)
    ? model
    : undefined;
}

/**
 * The configured permission mode if it's a known {@link AGENT_PERMISSION_MODE_OPTIONS}
 * value, else {@link AGENT_PERMISSION_MODE_DEFAULT} (`auto`) — so an unset or
 * out-of-list mode can never reach `claude --permission-mode <y>`.
 */
function whitelistAgentPermissionMode(mode: string | undefined): string {
  return AGENT_PERMISSION_MODE_OPTIONS.some((o) => o.value === mode)
    ? (mode as string)
    : AGENT_PERMISSION_MODE_DEFAULT;
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
   * Optional identity color to tint the opened window's tab/header bar to (e.g.
   * a dex task's {@link dexTaskColorRgb}). Applied only on terminals with a
   * tab-color hook (iTerm2); a no-op elsewhere, leaving the background neutral.
   * Omit to launch uncolored.
   */
  tabColor?: DexRgb;
  /**
   * Optional window/tab title to set at launch (e.g. `dex abc12345 · Fix login`),
   * so a row of agent windows is identifiable at a glance. Applied via the
   * terminal's title escape on every supported terminal; a no-op for custom
   * templates or an empty title. A long-running process may later overwrite it.
   */
  title?: string;
  /**
   * Optional stable identity for this terminal (typically the worktree path).
   * When set on a focus-capable terminal (Terminal.app / iTerm2), the launch
   * becomes *raise-or-spawn*: it first raises an existing window already tagged
   * with this marker (so jumping to a running agent focuses its live session
   * instead of opening a new shell), and otherwise opens a new window tagged with
   * it. A no-op on terminals without an AppleScript focus hook — they spawn as
   * before. Omit to always open a new window.
   */
  focusMarker?: string;
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
  // A focus marker upgrades the launch to raise-or-spawn on the terminals that
  // can be driven via AppleScript; otherwise this is the plain new-window template.
  const { template, focusable } = resolveSpawnTemplate(opts.terminal, opts.focusMarker);
  const spawnFn = opts.spawn ?? nodeSpawn;
  const writeScript = opts.writeScript ?? defaultWriteScript;
  try {
    // Prepend the per-terminal escapes (each a no-op on terminals without the
    // hook) so they run inside the live session before the inner command: the
    // title (so the window is self-identifying — see {@link resolveTitleCommand})
    // and the tab-color tint (leaving the window background neutral — see
    // {@link resolveTabColorCommand}).
    const title = opts.title && resolveTitleCommand(opts.terminal, opts.title);
    const tabColor = opts.tabColor && resolveTabColorCommand(opts.terminal, opts.tabColor);
    const command = [title, tabColor, opts.command].filter(Boolean).join("\n");
    const scriptPath = writeScript(opts.label, command);
    let launch = applyTemplate(template, `sh ${scriptPath}`);
    // Substitute the (escaped) marker into the raise-or-spawn template's `{title}`.
    if (focusable && opts.focusMarker !== undefined) {
      launch = launch.split("{title}").join(focusTitleLiteral(opts.focusMarker));
    }
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
