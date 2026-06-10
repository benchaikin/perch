/**
 * Platform paths shim.
 *
 * Resolves the location of the daemon's Unix domain socket. The GUI/CLI/MCP
 * clients use the same logic to find `perchd`.
 *
 * - macOS:   `~/Library/Application Support/Perch/perchd.sock`
 * - Linux:   `${XDG_RUNTIME_DIR || XDG_STATE_HOME || ~/.local/state}/perch/perchd.sock`
 */
import { homedir, platform } from "node:os";
import { join } from "node:path";

/** Absolute path to the daemon's Unix domain socket for the current platform. */
export function socketPath(): string {
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "Perch", "perchd.sock");
  }
  // Linux (and other POSIX): prefer a runtime dir, fall back to state dirs.
  const base =
    process.env.XDG_RUNTIME_DIR ?? process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(base, "perch", "perchd.sock");
}
