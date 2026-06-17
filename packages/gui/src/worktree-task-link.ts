/**
 * Electron-free join between the panel's two boards: `worktrees.list` and
 * `dex.tasks`. The worktrees plugin tags each worktree with an optional
 * `taskId` (parsed from a `dex/<taskId>-<slug>` branch or a `perch.dexTask` git
 * config); dex tasks carry a stable short `id`. Matching `worktree.taskId` to a
 * task `id` lets the renderer show each worktree's task and each task's live
 * worktree.
 *
 * The join lives here — not in either section builder — so it can run once from
 * the two raw boards and feed both directions into the section builders, keeping
 * those pure and independently testable. No plugin-to-plugin calls: this is a
 * GUI-side derivation from the two reads that already flow into panel state.
 */

import type { DexBoard, DexStatus } from "./dex-state.js";
import type { Worktree, WorktreeList } from "./worktrees-state.js";

/** The dex-task facet attached to a matched worktree row. */
export interface LinkedTask {
  id: string;
  name: string;
  status: DexStatus;
  /**
   * Count of still-active blockers, carried so the worktree row can apply the
   * task's identity color only when the task is open (see `isOpenDexTask`).
   */
  blockedByCount: number;
}

/** The worktree facet attached to a matched dex task row. */
export interface LinkedWorktree {
  path: string;
  branch?: string;
  repo?: string;
  dirty: boolean;
  dirtyCount: number;
  ahead?: number;
  behind?: number;
}

/**
 * The bidirectional association between worktrees and dex tasks.
 *
 * - {@link taskByWorktreePath}: worktree path → its matched dex task summary.
 * - {@link worktreeByTaskId}: dex task id → its matched worktree summary.
 *
 * A path/id absent from its map simply has no match. The two directions need not
 * be symmetric: several worktrees can carry the same `taskId`, so the
 * task→worktree direction picks one deterministically (see
 * {@link linkWorktreesAndTasks}).
 */
export interface WorktreeTaskLink {
  taskByWorktreePath: Map<string, LinkedTask>;
  worktreeByTaskId: Map<string, LinkedWorktree>;
}

/** Summarize a worktree into the facet a task row carries. */
function summarizeWorktree(w: Worktree): LinkedWorktree {
  return {
    path: w.path,
    branch: w.branch,
    repo: w.repo,
    dirty: w.dirty,
    dirtyCount: w.dirtyCount,
    ahead: w.ahead,
    behind: w.behind,
  };
}

/**
 * Should candidate `w` replace the already-chosen `chosen` worktree for a task?
 * Prefer a non-main worktree (the checkout you actually work in over the repo's
 * main worktree); within the same main/non-main class, the lexicographically-
 * first path wins. This makes the task→worktree pick stable across renders.
 */
function preferWorktree(w: Worktree, chosen: Worktree): boolean {
  if (w.main !== chosen.main) return !w.main; // non-main beats main
  return w.path < chosen.path; // same class → smaller path wins
}

/**
 * Compute the worktree ↔ dex-task association from the two raw boards. Match by
 * exact `worktree.taskId === task.id`; unmatched entries are simply omitted from
 * their map. Tolerates either board being `undefined` (returns empty maps — no
 * association, no throw), so a user missing either plugin sees no linkage.
 *
 * For the task→worktree direction, when several worktrees carry the same
 * `taskId` we pick one deterministically (see {@link preferWorktree}). The extra
 * worktrees still get their own task annotation in the other direction.
 *
 * Pure: same boards → same maps, no side effects.
 */
export function linkWorktreesAndTasks(
  worktreesBoard: WorktreeList | undefined,
  dexBoard: DexBoard | undefined,
): WorktreeTaskLink {
  const taskByWorktreePath = new Map<string, LinkedTask>();
  const worktreeByTaskId = new Map<string, LinkedWorktree>();

  const worktrees = worktreesBoard?.worktrees ?? [];
  const tasks = dexBoard?.tasks ?? [];
  if (worktrees.length === 0 || tasks.length === 0) {
    return { taskByWorktreePath, worktreeByTaskId };
  }

  // Index tasks by id for O(1) lookup; dex ids are unique.
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  // Track the worktree we've chosen per task so we can compare a later candidate
  // against the full row (not just the summary, which drops `main`).
  const chosenByTaskId = new Map<string, Worktree>();

  for (const w of worktrees) {
    if (!w.taskId) continue;
    const task = taskById.get(w.taskId);
    if (!task) continue;

    // worktree → task: every matched worktree carries its task.
    taskByWorktreePath.set(w.path, {
      id: task.id,
      name: task.name,
      status: task.status,
      blockedByCount: task.blockedByCount,
    });

    // task → worktree: keep the deterministically-preferred single match.
    const chosen = chosenByTaskId.get(task.id);
    if (!chosen || preferWorktree(w, chosen)) {
      chosenByTaskId.set(task.id, w);
      worktreeByTaskId.set(task.id, summarizeWorktree(w));
    }
  }

  return { taskByWorktreePath, worktreeByTaskId };
}
