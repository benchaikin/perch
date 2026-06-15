/**
 * The `worktrees.open` action's command builder + spawn. Opens a worktree
 * directory in whatever the user configures — an editor (`code {path}`,
 * `cursor {path}`), a terminal, or the default file manager (`open {path}` on
 * macOS, the default). Mirrors the services plugin's logs-terminal launcher.
 *
 * `buildOpenCommand` is pure (shell-quotes the path, substitutes `{path}`) so it
 * unit-tests without spawning; `spawnOpen` runs it detached and fire-and-forget.
 */
import { spawn as nodeSpawn } from "node:child_process";

/** Default open command: hand the worktree dir to the OS default (Finder on macOS). */
export const DEFAULT_OPEN_COMMAND = "open {path}";

/** Single-quote a path for safe POSIX-shell interpolation. */
function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the shell command that opens `path`, from a `template`. `{path}` is
 * replaced with the shell-quoted path; a template without `{path}` gets the
 * quoted path appended (so `code` → `code '/the/path'`).
 */
export function buildOpenCommand(template: string, path: string): string {
  const quoted = shellQuote(path);
  return template.includes("{path}")
    ? template.split("{path}").join(quoted)
    : `${template} ${quoted}`;
}

export interface SpawnOpenDeps {
  spawn?: typeof nodeSpawn;
}

/** Run an open command detached (fire-and-forget); errors are swallowed. */
export function spawnOpen(command: string, deps: SpawnOpenDeps = {}): void {
  const spawn = deps.spawn ?? nodeSpawn;
  try {
    const child = spawn("sh", ["-c", command], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    /* best-effort: a bad open command shouldn't crash the daemon */
  }
}
