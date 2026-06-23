/**
 * Platform paths shim.
 *
 * Resolves the locations Perch uses on disk. Two distinct categories:
 *
 * - **Runtime** (ephemeral, machine-local): the daemon's Unix domain socket and
 *   its pidfile. Prefer a runtime dir on Linux; co-located on macOS.
 * - **Config** (durable, user-edited): the single `perch.yaml` file.
 *
 * The GUI/CLI/MCP clients use the same logic to find `perchd`.
 *
 * - socket   macOS:  `~/Library/Application Support/Perch/perchd.sock`
 *            Linux:  `${XDG_RUNTIME_DIR || XDG_STATE_HOME || ~/.local/state}/perch/perchd.sock`
 * - pidfile  macOS:  `~/Library/Application Support/Perch/perchd.pid`
 *            Linux:  same runtime base as the socket, `perch/perchd.pid`
 * - config   macOS:  `~/Library/Application Support/Perch/perch.yaml`
 *            Linux:  `${XDG_CONFIG_HOME || ~/.config}/perch/perch.yaml`
 */
import { homedir, platform } from "node:os";
import { join } from "node:path";

/** Whether the current platform is macOS. */
function isMac(): boolean {
  return platform() === "darwin";
}

/** macOS state/config dir: `~/Library/Application Support/Perch`. */
function macSupportDir(): string {
  return join(homedir(), "Library", "Application Support", "Perch");
}

/** Linux runtime base (ephemeral): runtime dir, falling back to state dirs. */
function linuxRuntimeBase(): string {
  return (
    process.env.XDG_RUNTIME_DIR ?? process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state")
  );
}

/** Absolute path to the daemon's Unix domain socket for the current platform. */
export function socketPath(): string {
  if (isMac()) return join(macSupportDir(), "perchd.sock");
  return join(linuxRuntimeBase(), "perch", "perchd.sock");
}

/**
 * Absolute path to the daemon's pidfile. Co-located with the socket (runtime
 * state): macOS in the support dir, Linux in the runtime base.
 */
export function pidPath(): string {
  if (isMac()) return join(macSupportDir(), "perchd.pid");
  return join(linuxRuntimeBase(), "perch", "perchd.pid");
}

/**
 * Absolute path to the durable `perch.yaml` config file. Lives in the config
 * dir (not the runtime dir) so it survives reboots and is where users edit it.
 */
export function configPath(): string {
  if (isMac()) return join(macSupportDir(), "perch.yaml");
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "perch", "perch.yaml");
}
