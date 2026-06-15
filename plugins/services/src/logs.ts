/**
 * Jump-to-logs: build the `process-compose process logs <name> -f` command and
 * spawn it inside the user's terminal via a configurable launcher template
 * (Dev services M3).
 *
 * The terminal launch has to run on the user's machine, so the daemon (which
 * holds `plugins.services`) does it from the `services.logs` action. This module
 * keeps the **command building** — the inner process-compose command, its
 * connection flags (socket vs address), and substitution into the `{cmd}`
 * placeholder of the launcher template — as pure, unit-testable functions, with
 * a thin `spawnLogsTerminal` that wraps them around an injectable `spawn`.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_ADDRESS, type ServerTarget } from "./provider.js";

/**
 * The default macOS launcher template. `{cmd}` is replaced with the
 * process-compose logs command; the AppleScript opens a new Terminal.app window
 * running it and brings Terminal to the front. Override via
 * `plugins.services.logTerminal` to target iTerm/kitty/WezTerm/tmux/etc.
 */
export const DEFAULT_LOG_TERMINAL =
  `osascript -e 'tell application "Terminal" to do script "{cmd}"' ` +
  `-e 'tell application "Terminal" to activate'`;

/**
 * Built-in launcher presets keyed by terminal app, so the user can just pick
 * their terminal in Settings instead of hand-authoring an osascript/CLI
 * invocation. Each carries the same `{cmd}` placeholder. The AppleScript apps
 * (Terminal.app, iTerm2) open a new window and run the logs command; the CLI
 * apps launch a fresh OS window via `open -na` / their own CLI. `Custom` is not
 * here — it's the {@link SpawnLogsOptions.logTerminal} free-text escape hatch.
 */
export const TERMINAL_APP_TEMPLATES = {
  Terminal: DEFAULT_LOG_TERMINAL,
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
 * Resolve the launcher template from the two config knobs, in precedence order:
 * an explicit `logTerminal` (the **Custom** escape hatch) wins; otherwise the
 * chosen `terminalApp` preset; otherwise the Terminal.app default. An unknown
 * `terminalApp` (e.g. `"Custom"` with no `logTerminal`) falls back to default.
 */
export function resolveLogTerminal(opts: { terminalApp?: string; logTerminal?: string }): string {
  if (opts.logTerminal) return opts.logTerminal;
  if (opts.terminalApp && opts.terminalApp in TERMINAL_APP_TEMPLATES) {
    return TERMINAL_APP_TEMPLATES[opts.terminalApp as TerminalApp];
  }
  return DEFAULT_LOG_TERMINAL;
}

/** The `{cmd}` placeholder substituted with the inner logs command. */
const CMD_PLACEHOLDER = "{cmd}";

/**
 * Single-quote a shell word so the inner logs command can carry arbitrary
 * process names safely. Wraps in `'…'` and escapes embedded single quotes the
 * POSIX way (`'\''`).
 */
function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * Build the inner `process-compose process logs <name> -f` command, including
 * the connection flag the M1 provider uses: `--use-uds --unix-socket <socket>`
 * when a socket is configured, else `-a <host> -p <port>` parsed from the HTTP
 * address (default `http://localhost:8080`). The process name is shell-quoted so
 * spaces/quotes in it don't break the command.
 */
export function buildLogsCommand(name: string, target: ServerTarget): string {
  const parts = ["process-compose", "process", "logs", shellQuote(name), "-f"];
  if (target.socket) {
    parts.push("--use-uds", "--unix-socket", shellQuote(target.socket));
  } else {
    const url = new URL(target.address ?? DEFAULT_ADDRESS);
    const host = url.hostname || "localhost";
    const port = url.port || "8080";
    parts.push("-a", shellQuote(host), "-p", shellQuote(port));
  }
  return parts.join(" ");
}

/**
 * Substitute `cmd` into every `{cmd}` placeholder of `template`. The inner
 * command contains spaces and quotes, so this is a literal text replacement —
 * the template author is responsible for the surrounding quoting (the macOS
 * default wraps `{cmd}` in the AppleScript `do script "…"` string).
 */
export function applyLogTerminalTemplate(template: string, cmd: string): string {
  return template.replaceAll(CMD_PLACEHOLDER, cmd);
}

/**
 * Persist the inner logs command to a small shell script in a Perch temp dir and
 * return its path. The launcher template then interpolates only a **quote-free**
 * `sh <path>`, so the inner command's single-quoted args (the process name and
 * socket path) live INSIDE the script instead of being nested into the launcher.
 *
 * This is the fix for the nested-quote collision: the AppleScript presets embed
 * `{cmd}` inside `osascript -e '…'` (single-quoted) — the inner command's own
 * single quotes would otherwise close that `-e` arg and mangle the whole launch.
 * A generated temp path contains no quote characters, so it survives every preset
 * (AppleScript single-quoted, `sh -c "…"` double-quoted, and tmux). `exec` so the
 * terminal's shell becomes process-compose (clean Ctrl-C). One file per process
 * name (sanitized), overwritten on each open so they don't accumulate.
 */
function defaultWriteLogsScript(name: string, command: string): string {
  const dir = join(tmpdir(), "perch-logs");
  mkdirSync(dir, { recursive: true });
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_") || "service";
  const path = join(dir, `${safe}.sh`);
  writeFileSync(path, `#!/bin/sh\nexec ${command}\n`);
  return path;
}

/** Options for {@link spawnLogsTerminal}. */
export interface SpawnLogsOptions extends ServerTarget {
  /** The process name to tail. */
  name: string;
  /**
   * Chosen terminal app, picking a {@link TERMINAL_APP_TEMPLATES} preset. Lower
   * precedence than an explicit {@link logTerminal} (the Custom escape hatch).
   */
  terminalApp?: string;
  /**
   * An explicit launcher template (`{cmd}` placeholder) — the Custom escape
   * hatch that overrides {@link terminalApp}. Defaults (when both are unset) to
   * {@link DEFAULT_LOG_TERMINAL}.
   */
  logTerminal?: string;
  /** Optional log sink. */
  log?: (message: string) => void;
  /** Injected spawn (tests stub it); defaults to `child_process.spawn`. */
  spawn?: typeof spawn;
  /**
   * Injected script writer (tests stub it to avoid disk I/O); defaults to
   * {@link defaultWriteLogsScript}. Returns the path the launcher runs as
   * `sh <path>`.
   */
  writeScript?: (name: string, command: string) => string;
}

/**
 * Build the logs command, substitute it into the launcher template, and spawn
 * the result through a shell — detached + best-effort. Never throws: a missing
 * binary or any spawn error is logged and reported as `ok: false` so the action
 * capability can surface "couldn't open the terminal" without crashing.
 *
 * The full launcher command runs via `sh -c` so a template like the AppleScript
 * default (with its own quoting) is interpreted as written.
 */
export function spawnLogsTerminal(options: SpawnLogsOptions): { ok: boolean; message: string } {
  const target: ServerTarget = options.socket
    ? { socket: options.socket }
    : { address: options.address ?? DEFAULT_ADDRESS };
  const inner = buildLogsCommand(options.name, target);
  const template = resolveLogTerminal({
    terminalApp: options.terminalApp,
    logTerminal: options.logTerminal,
  });
  const spawnFn = options.spawn ?? spawn;
  const writeScript = options.writeScript ?? defaultWriteLogsScript;
  try {
    // Route the inner command through a temp script so the template only ever
    // interpolates a quote-free `sh <path>` — see defaultWriteLogsScript. Writing
    // it here (inside the try) means a write failure surfaces as ok:false rather
    // than throwing.
    const scriptPath = writeScript(options.name, inner);
    const launch = applyLogTerminalTemplate(template, `sh ${scriptPath}`);
    const child = spawnFn("sh", ["-c", launch], { detached: true, stdio: "ignore" });
    child.on("error", (err: Error) => {
      options.log?.(`services.logs launch failed: ${err.message}`);
    });
    child.unref();
    options.log?.(`services.logs opened terminal for ${options.name}`);
    return { ok: true, message: `Opening logs for ${options.name}…` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.log?.(`services.logs launch failed: ${message}`);
    return { ok: false, message: `Failed to open logs for ${options.name}: ${message}` };
  }
}
