/**
 * `perch daemon` lifecycle commands — built-in, NOT registry-driven.
 *
 * These manage the daemon process itself, so they're handled before the CLI
 * connects to the registry:
 *
 * - `status`    — running? (pidfile present + process alive + socket answers).
 * - `start`     — spawn `perchd` detached; wait for the socket to accept.
 * - `stop`      — SIGTERM the pid; wait for the socket to disappear.
 * - `restart`   — stop (if up) then start.
 * - `install`   — write + load the platform autostart unit (launchd/systemd).
 * - `uninstall` — unload + remove the autostart unit.
 *
 * The `perchd` program is resolved from `@perch/core`'s `bin.perchd`, never a
 * hard-coded path.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { connect } from "node:net";
import {
  installAutostart,
  isProcessAlive,
  launchdPlistPath,
  readPidFile,
  socketPath as defaultSocketPath,
  systemdUnitPath,
  uninstallAutostart,
} from "@perch/core";
import { DaemonUnavailableError, PerchClient } from "./client.js";

/** Options shared by the daemon subcommands. */
export interface DaemonOptions {
  /** Override the socket path (defaults to the platform paths shim). */
  socket?: string;
}

/** Outcome of a daemon command: exit code + nothing else (it prints itself). */
export interface DaemonRunResult {
  exitCode: number;
}

/** Resolve the absolute path to the `perchd` entry from `@perch/core`'s bin. */
export function resolvePerchd(): string {
  const require = createRequire(import.meta.url);
  // @perch/core's package.json `bin.perchd` points at dist/bin.js.
  return require.resolve("@perch/core/dist/bin.js");
}

/** Whether the socket at `path` currently accepts a connection. */
function socketAccepts(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(path);
    const done = (ok: boolean): void => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** Sleep helper for polling loops. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `predicate` until it returns true or `timeoutMs` elapses. */
async function pollUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await delay(intervalMs);
  }
}

/** True if a daemon appears to be live: socket answers a `registry.list`. */
async function isRunning(socket: string): Promise<{ up: boolean; capCount?: number }> {
  let client: PerchClient;
  try {
    client = await PerchClient.connect(socket);
  } catch (err) {
    if (err instanceof DaemonUnavailableError) return { up: false };
    throw err;
  }
  try {
    const caps = await client.registryList();
    return { up: true, capCount: caps.length };
  } finally {
    client.close();
  }
}

/** `perch daemon status`. */
export async function daemonStatus(opts: DaemonOptions): Promise<DaemonRunResult> {
  const socket = opts.socket ?? defaultSocketPath();
  const pid = await readPidFile();
  const { up, capCount } = await isRunning(socket);

  if (up) {
    const pidNote = pid !== undefined ? ` (pid ${pid})` : "";
    console.log(`perchd is running${pidNote}`);
    console.log(`  socket: ${socket}`);
    console.log(`  capabilities: ${capCount ?? 0}`);
    return { exitCode: 0 };
  }

  if (pid !== undefined && isProcessAlive(pid)) {
    console.log(`perchd process is alive (pid ${pid}) but not answering on ${socket}`);
    return { exitCode: 1 };
  }
  console.log("perchd is not running");
  return { exitCode: 1 };
}

/** `perch daemon start`. */
export async function daemonStart(opts: DaemonOptions): Promise<DaemonRunResult> {
  const socket = opts.socket ?? defaultSocketPath();
  if ((await isRunning(socket)).up) {
    console.log("perchd is already running");
    return { exitCode: 0 };
  }

  const perchd = resolvePerchd();
  const child = spawn(process.execPath, [perchd], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const ready = await pollUntil(() => socketAccepts(socket), 10_000);
  if (!ready) {
    console.error(`perch: perchd did not start within 10s (socket ${socket})`);
    return { exitCode: 1 };
  }
  console.log(`perchd started (pid ${child.pid ?? "?"}), listening on ${socket}`);
  return { exitCode: 0 };
}

/** `perch daemon stop`. */
export async function daemonStop(opts: DaemonOptions): Promise<DaemonRunResult> {
  const socket = opts.socket ?? defaultSocketPath();
  const pid = await readPidFile();

  if (pid === undefined || !isProcessAlive(pid)) {
    console.log("perchd is not running");
    return { exitCode: 0 };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    console.error(`perch: failed to signal pid ${pid}: ${errorMessage(err)}`);
    return { exitCode: 1 };
  }

  // Graceful shutdown unlinks the socket; wait for it to stop accepting.
  const stopped = await pollUntil(async () => !(await socketAccepts(socket)), 10_000);
  if (!stopped) {
    console.error(`perch: perchd (pid ${pid}) did not stop within 10s`);
    return { exitCode: 1 };
  }
  console.log(`perchd stopped (pid ${pid})`);
  return { exitCode: 0 };
}

/** `perch daemon restart`. */
export async function daemonRestart(opts: DaemonOptions): Promise<DaemonRunResult> {
  const socket = opts.socket ?? defaultSocketPath();
  if ((await isRunning(socket)).up || (await readPidFile()) !== undefined) {
    const stop = await daemonStop(opts);
    if (stop.exitCode !== 0) return stop;
  }
  return daemonStart(opts);
}

/** `perch daemon install` — write + load the platform autostart unit. */
export async function daemonInstall(): Promise<DaemonRunResult> {
  const result = await installAutostart();
  console.log(`autostart installed (${result.platform}): ${result.unitPath}`);
  return { exitCode: 0 };
}

/** `perch daemon uninstall` — unload + remove the autostart unit. */
export async function daemonUninstall(): Promise<DaemonRunResult> {
  const result = await uninstallAutostart();
  console.log(`autostart removed (${result.platform}): ${result.unitPath}`);
  return { exitCode: 0 };
}

/** Path the install command would write, for `--help`-style messaging. */
export function autostartUnitPath(): string {
  return process.platform === "darwin" ? launchdPlistPath() : systemdUnitPath();
}

/** Known daemon subcommand names. */
const SUBCOMMANDS = new Set(["status", "start", "stop", "restart", "install", "uninstall"]);

/** Whether `name` is a daemon subcommand (for dispatch in `run`). */
export function isDaemonSubcommand(name: string | undefined): boolean {
  return name !== undefined && SUBCOMMANDS.has(name);
}

/**
 * Dispatch a `perch daemon <sub>` command. Returns the exit code. Unknown
 * subcommands print usage and return 1.
 */
export async function runDaemonCommand(
  sub: string | undefined,
  opts: DaemonOptions,
): Promise<number> {
  switch (sub) {
    case "status":
      return (await daemonStatus(opts)).exitCode;
    case "start":
      return (await daemonStart(opts)).exitCode;
    case "stop":
      return (await daemonStop(opts)).exitCode;
    case "restart":
      return (await daemonRestart(opts)).exitCode;
    case "install":
      return (await daemonInstall()).exitCode;
    case "uninstall":
      return (await daemonUninstall()).exitCode;
    default:
      console.error(
        `perch: unknown daemon command ${JSON.stringify(sub ?? "")}\n` +
          "usage: perch daemon <status|start|stop|restart|install|uninstall>",
      );
      return 1;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
