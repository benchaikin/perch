/**
 * Electron-free, pure parsing + normalization of git's worktree/status output
 * into the {@link Worktrees} view-model the GUI renders. No process spawning —
 * it takes already-captured command stdout, so it unit-tests directly.
 *
 * Two inputs per worktree:
 *   - `git worktree list --porcelain` — the worktree set (path, HEAD, branch or
 *     detached, plus bare/locked/prunable flags). The main worktree is listed
 *     first.
 *   - `git -C <path> status --porcelain=v2 --branch` — per-worktree dirtiness
 *     (changed/untracked entries; an `u ` entry means an unmerged conflict) and
 *     ahead/behind vs upstream (the `# branch.ab +A -B` header, present only
 *     when the branch tracks an upstream).
 */
import { z } from "@perch/sdk";

/** A worktree record as parsed from `git worktree list --porcelain`. */
export interface RawWorktree {
  path: string;
  head?: string;
  /** Short branch name (refs/heads/ stripped), or undefined when detached. */
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

/** Working-tree state parsed from `git status --porcelain=v2 --branch`. */
export interface WorktreeStatus {
  /** Count of changed + untracked entries (uncommitted work). */
  dirtyCount: number;
  /** True when any entry is unmerged (a merge/rebase conflict). */
  conflict: boolean;
  /** Commits ahead of upstream, when the branch tracks one. */
  ahead?: number;
  /** Commits behind upstream, when the branch tracks one. */
  behind?: number;
}

/** A worktree's marker health → CSS dot color. */
export type WorktreeHealth = "ok" | "warn" | "bad" | "muted";

/** One rendered worktree row. */
export const Worktree = z.object({
  path: z.string(),
  /** Basename of the path (the display label). */
  name: z.string(),
  /**
   * The source repo this worktree belongs to (basename of its repo root), so the
   * panel can group/label worktrees when several repos are enumerated. Undefined
   * when the source root is unknown (the daemon-cwd default).
   */
  repo: z.string().optional(),
  /**
   * The dex task this worktree is associated with, when one is encoded — either
   * parsed from a `dex/<id>` branch or read from the worktree-local
   * `perch.dexTask` git config (the config wins). Undefined when unassociated.
   */
  taskId: z.string().optional(),
  branch: z.string().optional(),
  detached: z.boolean(),
  /** The repository's main worktree (listed first by git). */
  main: z.boolean(),
  dirty: z.boolean(),
  dirtyCount: z.number(),
  conflict: z.boolean(),
  ahead: z.number().optional(),
  behind: z.number().optional(),
  locked: z.boolean(),
  prunable: z.boolean(),
  health: z.enum(["ok", "warn", "bad", "muted"]),
});
export type Worktree = z.infer<typeof Worktree>;

/** `worktrees.list`'s output: every worktree of the repo, main first. */
export const Worktrees = z.object({
  worktrees: z.array(Worktree),
});
export type Worktrees = z.infer<typeof Worktrees>;

/**
 * Extract the dex task id a branch encodes, per the shared convention: a branch
 * named `dex/<id>` or `dex/<id>-<slug>`, where `<id>` is a run of lowercase
 * alphanumerics (`[a-z0-9]`) immediately after the literal `dex/` prefix, up to
 * the next `-`/`/`/end. A branch that doesn't start with `dex/` (or is
 * undefined/detached/empty) → undefined.
 */
export function parseDexTaskId(branch: string | undefined): string | undefined {
  if (!branch) return undefined;
  const m = /^dex\/([a-z0-9]+)/.exec(branch);
  return m ? m[1] : undefined;
}

/** Parse `git worktree list --porcelain` into records (main worktree first). */
export function parseWorktreeList(porcelain: string): RawWorktree[] {
  const records: RawWorktree[] = [];
  let current: RawWorktree | undefined;
  const flush = (): void => {
    if (current) records.push(current);
    current = undefined;
  };
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current = {
        path: line.slice("worktree ".length),
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      };
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      current.prunable = true;
    }
  }
  flush();
  return records;
}

/** Parse `git status --porcelain=v2 --branch` into {@link WorktreeStatus}. */
export function parseStatus(porcelainV2: string): WorktreeStatus {
  let dirtyCount = 0;
  let conflict = false;
  let ahead: number | undefined;
  let behind: number | undefined;
  for (const line of porcelainV2.split("\n")) {
    if (line.length === 0) continue;
    if (line.startsWith("# branch.ab ")) {
      const m = /^# branch\.ab \+(-?\d+) (-?\d+)$/.exec(line);
      if (m) {
        ahead = Math.abs(Number(m[1]));
        behind = Math.abs(Number(m[2]));
      }
    } else if (line.startsWith("#")) {
      // Other header (branch.oid/head/upstream) — nothing to extract here.
      continue;
    } else {
      // A change entry: 1/2 ordinary/renamed, u unmerged (conflict), ? untracked.
      dirtyCount += 1;
      if (line.startsWith("u ")) conflict = true;
    }
  }
  return { dirtyCount, conflict, ahead, behind };
}

/**
 * A worktree's marker health: `bad` for a conflict or a prunable (stale) tree;
 * `warn` when diverged from upstream (commits both ahead AND behind, i.e. a
 * rebase/merge is needed); otherwise `muted` (nothing notable — clean, or merely
 * dirty/ahead, which is normal for an active worktree and shown via row chips).
 */
export function worktreeHealth(w: {
  conflict: boolean;
  prunable: boolean;
  ahead?: number;
  behind?: number;
}): WorktreeHealth {
  if (w.conflict || w.prunable) return "bad";
  if ((w.ahead ?? 0) > 0 && (w.behind ?? 0) > 0) return "warn";
  return "muted";
}

/** Combine a raw worktree + its status into the rendered {@link Worktree}. */
export function buildWorktree(
  raw: RawWorktree,
  status: WorktreeStatus | undefined,
  main: boolean,
  repo?: string,
  taskId?: string,
): Worktree {
  const dirtyCount = status?.dirtyCount ?? 0;
  const conflict = status?.conflict ?? false;
  const ahead = status?.ahead;
  const behind = status?.behind;
  const name = raw.path.split("/").filter(Boolean).pop() ?? raw.path;
  return {
    path: raw.path,
    name,
    repo,
    taskId,
    branch: raw.branch,
    detached: raw.detached,
    main,
    dirty: dirtyCount > 0,
    dirtyCount,
    conflict,
    ahead,
    behind,
    locked: raw.locked,
    prunable: raw.prunable,
    health: worktreeHealth({ conflict, prunable: raw.prunable, ahead, behind }),
  };
}

/**
 * Build the {@link Worktrees} board for a single repo root: its worktree list +
 * a per-path status map. Skips bare worktrees (no working tree to report on).
 * The first (non-bare) record is that repo's main worktree. `repo` (the root's
 * basename) tags each row so callers can group/label multiple repos; pass
 * undefined for the daemon-cwd default (a single, unlabeled repo). An optional
 * `taskIdByPath` supplies each worktree's resolved dex task id (config override
 * or branch parse); paths absent from it fall back to the branch parse.
 */
export function buildWorktrees(
  raws: RawWorktree[],
  statusByPath: ReadonlyMap<string, WorktreeStatus>,
  repo?: string,
  taskIdByPath?: ReadonlyMap<string, string | undefined>,
): Worktrees {
  const visible = raws.filter((r) => !r.bare);
  const worktrees = visible.map((raw, i) => {
    const taskId = taskIdByPath?.has(raw.path)
      ? taskIdByPath.get(raw.path)
      : parseDexTaskId(raw.branch);
    return buildWorktree(raw, statusByPath.get(raw.path), i === 0, repo, taskId);
  });
  return { worktrees };
}

/**
 * Merge per-repo boards into one, concatenating rows in repo order. Each board
 * already carries its own main-first ordering + `repo` tag, so the GUI can group
 * by `repo`; the overall list preserves the order the roots were enumerated.
 */
export function mergeWorktrees(boards: Worktrees[]): Worktrees {
  return { worktrees: boards.flatMap((b) => b.worktrees) };
}
