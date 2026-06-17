/**
 * Shared worktree primitives for the "spawn an agent on a PR's branch" actions
 * (`stack.resolve-conflicts`, `stack.open-agent`). Each action checks out a PR's
 * existing head branch in a sibling worktree (reusing one already checked out)
 * and launches `claude` there; the only thing that differs between them is the
 * seed prompt + window title.
 *
 * Everything here is pure or takes the `git` CLI as an injected {@link Exec}
 * seam, so the path/args/parsing and the resolve-or-create flow unit-test
 * directly with stubs — nothing spawns a real process.
 */
import { basename, dirname, join } from "node:path";
import { execFile } from "node:child_process";

import type { Exec } from "./provider.js";

/**
 * Make a branch name safe to use as a single path segment: lowercase isn't
 * forced (branch names are case-sensitive), but a branch can contain `/`
 * (`dex/abc-foo`, `feat/x`) and other separators, which would otherwise nest or
 * escape the worktrees dir. Collapse every run of non-`[A-Za-z0-9._]` to a single
 * `-` and trim leading/trailing hyphens. Returns `"branch"` if nothing usable
 * remains (so the path is always well-formed).
 */
export function sanitizeBranchForPath(branch: string): string {
  const safe = branch
    .replace(/[^A-Za-z0-9._]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return safe || "branch";
}

/**
 * The worktree path for a branch: a sibling of the repo named
 * `<repo>-worktrees/<sanitized-branch>`, matching the dex spawn's sibling
 * convention so all of Perch's spawned worktrees live in one place and are easy
 * to spot.
 */
export function worktreePathFor(repoDir: string, branch: string): string {
  const worktreesDir = join(dirname(repoDir), `${basename(repoDir)}-worktrees`);
  return join(worktreesDir, sanitizeBranchForPath(branch));
}

/**
 * The args for `git -C <repoDir> worktree add <path> <branch>` — checking out an
 * EXISTING branch (no `-b`), unlike the dex spawn which creates a new branch.
 * git's own DWIM creates a local tracking branch from `origin/<branch>` when the
 * branch isn't yet local (the common case for a teammate-less PR it still is).
 */
export function worktreeAddArgs(repoDir: string, path: string, branch: string): string[] {
  return ["-C", repoDir, "worktree", "add", path, branch];
}

/** The args for `git -C <repoDir> worktree list --porcelain`. */
export function worktreeListArgs(repoDir: string): string[] {
  return ["-C", repoDir, "worktree", "list", "--porcelain"];
}

/**
 * Scan `git worktree list --porcelain` output for an existing worktree whose
 * checked-out branch is `branch`, returning its path (or `undefined` if none).
 * The porcelain format is blank-line-separated records, each starting with a
 * `worktree <path>` line; a `branch refs/heads/<name>` line names the branch
 * (absent for a detached HEAD). We match `refs/heads/<branch>` exactly so a
 * branch already checked out elsewhere is reused, not double-added (git refuses
 * to check the same branch out in two worktrees anyway).
 */
export function parseWorktreeForBranch(porcelain: string, branch: string): string | undefined {
  const wanted = `refs/heads/${branch}`;
  let currentPath: string | undefined;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      if (ref === wanted && currentPath) return currentPath;
    }
  }
  return undefined;
}

/** Default command runner: spawn a real `git` and resolve its stdout. */
export const defaultExec: Exec = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, cwd: opts?.cwd },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });

/** The seams {@link resolveOrCreateWorktree} needs from its caller. */
export interface WorktreeDeps {
  /** The concrete repo directory (the resolved repo cwd, or `process.cwd()`). */
  repoDir: string;
  /** Injected command runner (tests stub it); defaults to a real `git` spawn. */
  exec?: Exec;
  /** The git binary to run. */
  gitBin: string;
  log?: (message: string) => void;
}

/** The outcome of resolving a worktree for a branch. */
export type WorktreeResolution =
  | { ok: true; worktreePath: string; reused: boolean }
  | { ok: false; message: string };

/**
 * Resolve a worktree checked out on `branch`: reuse one already checked out
 * (e.g. a dex-spawned or conflict-resolution worktree) rather than double-adding
 * it (git refuses to check the same branch out twice anyway), else create a
 * sibling `<repo>-worktrees/<branch>` worktree on the existing branch. Never
 * throws — listing failures fall through to a create attempt, and a create
 * failure returns a clear `{ ok:false, message }`.
 */
export async function resolveOrCreateWorktree(
  branch: string,
  deps: WorktreeDeps,
): Promise<WorktreeResolution> {
  const exec = deps.exec ?? defaultExec;

  // Best-effort reuse: if the list fails we just fall through to creating one,
  // and let `worktree add` surface a clearer error.
  try {
    const list = await exec(deps.gitBin, worktreeListArgs(deps.repoDir));
    const existing = parseWorktreeForBranch(list, branch);
    if (existing) {
      deps.log?.(`reusing existing worktree for ${branch}: ${existing}`);
      return { ok: true, worktreePath: existing, reused: true };
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log?.(`couldn't list worktrees (continuing): ${detail}`);
  }

  const path = worktreePathFor(deps.repoDir, branch);
  try {
    await exec(deps.gitBin, worktreeAddArgs(deps.repoDir, path, branch));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `couldn't create worktree at ${path} for branch ${branch}: ${detail}`,
    };
  }
  return { ok: true, worktreePath: path, reused: false };
}
