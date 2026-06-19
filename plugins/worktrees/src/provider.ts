/**
 * Thin runner around `git` for the worktrees plugin. The {@link Exec} seam
 * (mirroring the stack/dex providers) is injected so the daemon spawns real
 * processes while tests pass a stub.
 *
 * Two reads: the worktree list (run at the repo root) and per-worktree status
 * (run with `-C <path>`). Status is best-effort per worktree — a missing/locked
 * tree yields empty output rather than failing the whole list.
 */
import { execFile } from "node:child_process";

/** Run a command and resolve its stdout; rejects on a non-zero exit. */
export type Exec = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<string>;

type ExecError = Error & { stdout?: string; stderr?: string };

const defaultExec: Exec = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, cwd: opts?.cwd },
      (err, stdout, stderr) => {
        if (err) {
          (err as ExecError).stdout = stdout;
          (err as ExecError).stderr = stderr;
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });

export interface WorktreesProviderDeps {
  exec?: Exec;
}

export class WorktreesProvider {
  private readonly exec: Exec;

  constructor(
    private readonly gitBin: string,
    deps: WorktreesProviderDeps = {},
  ) {
    this.exec = deps.exec ?? defaultExec;
  }

  /** `git worktree list --porcelain`, run at `repoRoot`. */
  listRaw(repoRoot?: string): Promise<string> {
    return this.exec(this.gitBin, ["worktree", "list", "--porcelain"], { cwd: repoRoot });
  }

  /** `git status --porcelain=v2 --branch` for one worktree; "" on failure. */
  async statusRaw(worktreePath: string): Promise<string> {
    try {
      return await this.exec(this.gitBin, ["status", "--porcelain=v2", "--branch"], {
        cwd: worktreePath,
      });
    } catch {
      return "";
    }
  }

  /**
   * Remove one worktree: `git -C <path> worktree remove [--force] <path>`. The
   * `-C <path>` resolves the repo from the worktree itself, so the caller needs
   * only the worktree path (not the repo root). `--force` lets git drop a dirty,
   * conflicted, or locked tree (git refuses otherwise) — the caller passes it
   * only after the user confirms the discarded changes. Rejects on git failure
   * (the action turns that into `{ ok:false, message }`).
   */
  removeRaw(worktreePath: string, opts: { force?: boolean } = {}): Promise<string> {
    const args = ["-C", worktreePath, "worktree", "remove"];
    if (opts.force) args.push("--force");
    args.push(worktreePath);
    return this.exec(this.gitBin, args);
  }

  /**
   * The worktree-local `perch.dexTask` git config (trimmed), or "" when unset.
   * Best-effort: `git config --worktree --get` exits non-zero when the key is
   * missing *or* when `extensions.worktreeConfig` is disabled — both degrade
   * silently to "" rather than throwing.
   */
  async configRaw(worktreePath: string): Promise<string> {
    try {
      const out = await this.exec(
        this.gitBin,
        ["config", "--worktree", "--get", "perch.dexTask"],
        { cwd: worktreePath },
      );
      return out.trim();
    } catch {
      return "";
    }
  }
}
