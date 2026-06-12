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

/** Options for {@link spawnLogsTerminal}. */
export interface SpawnLogsOptions extends ServerTarget {
  /** The process name to tail. */
  name: string;
  /** The launcher template (`{cmd}` placeholder); defaults to {@link DEFAULT_LOG_TERMINAL}. */
  logTerminal?: string;
  /** Optional log sink. */
  log?: (message: string) => void;
  /** Injected spawn (tests stub it); defaults to `child_process.spawn`. */
  spawn?: typeof spawn;
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
  const launch = applyLogTerminalTemplate(options.logTerminal ?? DEFAULT_LOG_TERMINAL, inner);
  const spawnFn = options.spawn ?? spawn;
  try {
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
