/**
 * The inner command the `worktrees.open` action runs in the user's terminal:
 * enter the worktree directory and start an interactive shell. The terminal
 * itself (which app, the launch template, spawning) is the shared global setting
 * via `@perch/sdk`'s `spawnInTerminal`; this module just builds the cd-and-shell
 * command (pure + unit-testable).
 */
import { shellQuote } from "@perch/sdk";

/**
 * Build the inner command that cd's into `path` and execs an interactive shell
 * (the user's `$SHELL`). Run inside the chosen terminal, this lands the user at
 * a prompt in the worktree. The path is shell-quoted; `exec` replaces the
 * launcher's `sh` so the window's shell *is* the worktree shell.
 */
export function buildShellInDir(path: string): string {
  return `cd ${shellQuote(path)} && exec "$SHELL"`;
}
