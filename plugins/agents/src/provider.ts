/**
 * Best-effort attribution for a reported event: resolve the event's `cwd` (the
 * attribution anchor) to a git branch and, from it, a dex task id — reusing the
 * worktrees plugin's `parseDexTaskId` and honoring the worktree-local
 * `perch.dexTask` git-config override it also reads.
 *
 * This runs in the daemon when an event is ingested. It's intentionally thin and
 * non-throwing: a non-git cwd or a missing git binary degrades to "no
 * attribution" (undefined branch/taskId) rather than failing the report. The
 * authoritative `cwd === worktree.path` join against the worktrees board is a
 * later GUI task; here we keep it simple — two cheap git calls at the cwd.
 *
 * The {@link Exec} seam (mirroring the worktrees/dex providers) is injected so
 * the daemon spawns real `git` while tests pass a stub.
 */
import { execFile } from "node:child_process";

import { parseDexTaskId } from "@perch/plugin-worktrees";

/** Run a command and resolve its stdout; rejects on a non-zero exit. */
export type Exec = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<string>;

const defaultExec: Exec = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 1024 * 1024, cwd: opts?.cwd }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });

/** The attribution resolved from a cwd: its branch and the dex task it encodes. */
export interface Attribution {
  branch?: string;
  taskId?: string;
}

export interface AttributionProviderDeps {
  exec?: Exec;
}

/** Resolves a cwd to its branch + dex task id via `git`. Never throws. */
export class AttributionProvider {
  private readonly exec: Exec;

  constructor(
    private readonly gitBin: string = "git",
    deps: AttributionProviderDeps = {},
  ) {
    this.exec = deps.exec ?? defaultExec;
  }

  /**
   * Resolve `cwd` → `{ branch, taskId }`. The task id prefers the worktree-local
   * `perch.dexTask` config (the same override the worktrees plugin honors), else
   * falls back to parsing a `dex/<id>` branch. A non-git / missing cwd yields
   * `{}` (no attribution).
   */
  async attribute(cwd: string | undefined): Promise<Attribution> {
    if (!cwd) return {};
    const branch = await this.branchOf(cwd);
    const config = await this.configOf(cwd);
    const taskId = config || parseDexTaskId(branch);
    return { branch, taskId };
  }

  /** `git -C <cwd> branch --show-current`, or undefined when not a git repo. */
  private async branchOf(cwd: string): Promise<string | undefined> {
    try {
      const out = await this.exec(this.gitBin, ["branch", "--show-current"], { cwd });
      const branch = out.trim();
      return branch.length > 0 ? branch : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The worktree-local `perch.dexTask` config (trimmed), or "" when unset.
   * Best-effort: a missing key or disabled worktree config exits non-zero and
   * degrades silently to "".
   */
  private async configOf(cwd: string): Promise<string> {
    try {
      const out = await this.exec(this.gitBin, ["config", "--worktree", "--get", "perch.dexTask"], {
        cwd,
      });
      return out.trim();
    } catch {
      return "";
    }
  }
}
