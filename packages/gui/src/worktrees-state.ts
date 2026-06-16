/**
 * Electron-free view-model derivation for the panel's "Worktrees" section.
 *
 * Mirrors `services-state.ts` / `dex-state.ts` but for the `worktrees.list`
 * read: the main process subscribes over RPC and feeds the raw
 * {@link WorktreeList} through {@link buildWorktreesSection}; the renderer draws
 * the returned {@link WorktreesSection} verbatim.
 *
 * The `WorktreeList` wire shape is duplicated here (rather than depending on the
 * worktrees plugin) because the GUI is a thin client of the daemon — it only
 * knows the wire shape of `worktrees.list`'s output, not the plugin's internals.
 */

import type { DexStatus } from "./dex-state.js";
import type { LinkedTask } from "./worktree-task-link.js";

/** Canonical capability id of the worktrees read the section renders. */
export const WORKTREES_LIST_ID = "worktrees.list";

/** A worktree's marker health → CSS dot color (mirrors the plugin's type). */
export type WorktreeHealth = "ok" | "warn" | "bad" | "muted";

/** One worktree as it arrives over RPC (the wire shape of the plugin's `Worktree`). */
export interface Worktree {
  path: string;
  name: string;
  /** Source repo (basename of its root) when several repos are enumerated; undefined for a single repo. */
  repo?: string;
  branch?: string;
  detached: boolean;
  /** The repository's main worktree. */
  main: boolean;
  dirty: boolean;
  dirtyCount: number;
  conflict: boolean;
  ahead?: number;
  behind?: number;
  locked: boolean;
  prunable: boolean;
  health: WorktreeHealth;
  /**
   * The dex task this worktree was created for, when known — parsed by the
   * worktrees plugin from a `dex/<taskId>-<slug>` branch or a `perch.dexTask`
   * git config. Used to join worktrees to dex tasks (see `worktree-task-link`).
   */
  taskId?: string;
}

/** `worktrees.list`'s output: every worktree of the repo, main first. */
export interface WorktreeList {
  worktrees: Worktree[];
}

/**
 * A rendered worktree row: the wire shape plus an optional `task` annotation —
 * the dex task this worktree was created for, joined in by `buildPanelState`
 * from `linkWorktreesAndTasks`. Absent when the worktree carries no `taskId` or
 * no matching task exists (or the dex board is missing).
 */
export interface WorktreeRow extends Worktree {
  task?: { id: string; name: string; status: DexStatus };
}

/** Tallies for the tab badge / header summary. */
export interface WorktreeCounts {
  total: number;
  dirty: number;
  conflict: number;
}

/**
 * The rendered Worktrees section. `visible` is false only when there are no
 * worktrees to show (no list yet, or an empty list) — so users without the
 * plugin see the unchanged panel. `rows` are grouped per repo (each repo's rows
 * main-first), in the order the repos were enumerated. `multiRepo` is true when
 * rows span more than one repo, so the renderer draws a header per repo group.
 */
export interface WorktreesSection {
  visible: boolean;
  rows: WorktreeRow[];
  counts: WorktreeCounts;
  multiRepo: boolean;
}

const ZERO_COUNTS: WorktreeCounts = { total: 0, dirty: 0, conflict: 0 };

const HEALTH_RANK: Record<WorktreeHealth, number> = { muted: 0, ok: 1, warn: 2, bad: 3 };

/**
 * The worst (most severe) health across the section's rows, for the Worktrees
 * tab badge: `bad` if any worktree has a conflict / is prunable, else `warn` if
 * any is diverged, else `muted` (nothing notable). Empty → `muted`.
 */
export function worstWorktreeHealth(section: WorktreesSection): WorktreeHealth {
  let worst: WorktreeHealth = "muted";
  for (const row of section.rows) {
    if (HEALTH_RANK[row.health] > HEALTH_RANK[worst]) worst = row.health;
  }
  return worst;
}

/**
 * Build the Worktrees section from the latest `worktrees.list` output. Hidden
 * when the list is absent or empty. `multiRepo` is set when the rows carry more
 * than one distinct `repo` tag, so the renderer groups them under per-repo
 * headers. `taskByPath` (from `linkWorktreesAndTasks`) annotates each row with
 * its matched dex task; pass an empty map (or omit it) for no annotation. Pure:
 * same input → same output.
 */
export function buildWorktreesSection(
  list: WorktreeList | undefined,
  taskByPath?: ReadonlyMap<string, LinkedTask>,
): WorktreesSection {
  if (!list || list.worktrees.length === 0) {
    return { visible: false, rows: [], counts: { ...ZERO_COUNTS }, multiRepo: false };
  }
  const counts: WorktreeCounts = { ...ZERO_COUNTS, total: list.worktrees.length };
  const repos = new Set<string>();
  const rows: WorktreeRow[] = list.worktrees.map((w) => {
    if (w.dirty) counts.dirty += 1;
    if (w.conflict) counts.conflict += 1;
    if (w.repo) repos.add(w.repo);
    const task = taskByPath?.get(w.path);
    return task ? { ...w, task } : w;
  });
  return { visible: true, rows, counts, multiRepo: repos.size > 1 };
}
