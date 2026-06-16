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
}

/** `worktrees.list`'s output: every worktree of the repo, main first. */
export interface WorktreeList {
  worktrees: Worktree[];
}

/** A rendered worktree row (identical to the wire shape today; kept distinct for the renderer's contract). */
export type WorktreeRow = Worktree;

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
 * headers. Pure: same input → same output.
 */
export function buildWorktreesSection(list: WorktreeList | undefined): WorktreesSection {
  if (!list || list.worktrees.length === 0) {
    return { visible: false, rows: [], counts: { ...ZERO_COUNTS }, multiRepo: false };
  }
  const counts: WorktreeCounts = { ...ZERO_COUNTS, total: list.worktrees.length };
  const repos = new Set<string>();
  for (const w of list.worktrees) {
    if (w.dirty) counts.dirty += 1;
    if (w.conflict) counts.conflict += 1;
    if (w.repo) repos.add(w.repo);
  }
  return { visible: true, rows: list.worktrees, counts, multiRepo: repos.size > 1 };
}
