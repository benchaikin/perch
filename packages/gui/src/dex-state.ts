/**
 * Electron-free view-model derivation for the panel's "Dex" section.
 *
 * Mirrors `services-state.ts` but for the `dex.tasks` read: the main process
 * subscribes over RPC and feeds the raw {@link DexBoard} through
 * {@link buildDexSection}; the renderer draws the returned {@link DexSection}
 * verbatim. Kept separate from `buildPanelState` so the My-PRs view-model stays
 * untouched.
 *
 * The `DexBoard` wire shape is duplicated here (rather than depending on the dex
 * plugin) because the GUI is a thin client of the daemon — it only knows the
 * wire shape of `dex.tasks`'s output, not the plugin's internals.
 */

import type { LinkedWorktree } from "./worktree-task-link.js";
import type { LandableState } from "./landable.js";

/** Canonical capability id of the dex task board read the section renders. */
export const DEX_TASKS_ID = "dex.tasks";

/** Derived task lifecycle (mirrors the dex plugin's `DexStatus`). */
export type DexStatus = "done" | "in-progress" | "blocked" | "ready";

/** One task row as it arrives over RPC (the wire shape of `DexTaskView`). */
export interface DexTask {
  id: string;
  name: string;
  /** Full task description (the "ticket body"); empty string when none. */
  description: string;
  /** Completion result, present only on done tasks; null otherwise. */
  result: string | null;
  status: DexStatus;
  priority: number;
  /** Tree depth: 0 for a root/epic, 1 for its tasks, etc. */
  depth: number;
  parentId?: string;
  /** True when this task has children (render as a group header). */
  isEpic: boolean;
  /** Count of still-active blockers; equals `blockedBy.length`. */
  blockedByCount: number;
  /**
   * Ids of the still-active blockers (the blocker edges). Carried through for a
   * future dependency-graph view; the tree section ignores it.
   */
  blockedBy: string[];
  /** Source project label when multiple dex stores are monitored. */
  project?: string;
}

/** `dex.tasks`'s output: a flat, tree-ordered list of task rows. */
export interface DexBoard {
  tasks: DexTask[];
}

/** A rendered task row's marker health → CSS dot color. */
export type DexHealth = "ok" | "warn" | "bad" | "muted";

/** One rendered task row. */
export interface DexRow {
  id: string;
  name: string;
  description: string;
  result: string | null;
  status: DexStatus;
  /**
   * Status the row's marker should render as, which can differ from {@link status}:
   * an epic that isn't itself blocked or in-progress rolls up to `in-progress`
   * when any descendant is in progress, so a collapsed parent still signals that
   * work is underway beneath it. Equals {@link status} for every other row. The
   * rollup is display-only — {@link DexCounts} stay keyed off the real status.
   */
  displayStatus: DexStatus;
  depth: number;
  isEpic: boolean;
  blockedByCount: number;
  /** Ids of the still-active blockers (the blocker edges); carried for a future graph view. */
  blockedBy: string[];
  project?: string;
  /** Marker color: blocked=red(bad), in-progress=amber(warn), done=green(ok), ready=grey(muted). */
  health: DexHealth;
  /**
   * The live git worktree this task is being worked in, when one matches —
   * joined in by `buildPanelState` from `linkWorktreesAndTasks`. Absent when no
   * worktree carries this task's id (or the worktrees board is missing).
   */
  worktree?: LinkedWorktree;
  /**
   * The work-item's "landable" signal — its open PR's CI + review + merge state
   * reduced to one glanceable state (see `landable.ts`), joined in by
   * `buildPanelState` from `deriveLandableByTaskId`. Absent (or `"none"`) when no
   * PR matches this task's worktree branch; the renderer surfaces it as a chip so
   * a finished agent's review/merge queue reads off the task list. The renderer
   * falls back to a neutral chip for any state it doesn't recognize, so a future
   * landable state added upstream renders rather than crashes.
   */
  landable?: LandableState;
}

/** Tallies per status, for the tab badge + any header summary. */
export interface DexCounts {
  ready: number;
  blocked: number;
  inProgress: number;
  done: number;
  total: number;
}

/**
 * The rendered Dex section. `visible` tracks plugin *presence*, not task count:
 * it's false only when the dex plugin isn't installed — so users without the
 * plugin see the unchanged panel, while an installed-but-empty plugin still
 * shows an empty state. `rows` are pre-ordered (tree pre-order, depth-tagged);
 * `counts` drives the tab badge.
 */
export interface DexSection {
  visible: boolean;
  rows: DexRow[];
  counts: DexCounts;
}

/** Map a derived status to its marker color. */
export function dexHealth(status: DexStatus): DexHealth {
  switch (status) {
    case "blocked":
      return "bad";
    case "in-progress":
      return "warn";
    case "done":
      return "ok";
    case "ready":
      return "muted";
  }
}

const ZERO_COUNTS: DexCounts = { ready: 0, blocked: 0, inProgress: 0, done: 0, total: 0 };

/**
 * The worst (most attention-worthy) health for the Dex tab's badge: `bad` if
 * anything is blocked, else `warn` if anything is ready to pick up, else `ok`
 * if work is in progress, else `muted` (nothing notable / empty). This is about
 * "what needs me", so blocked outranks ready outranks in-progress.
 */
export function worstDexHealth(section: DexSection): DexHealth {
  const { blocked, ready, inProgress } = section.counts;
  if (blocked > 0) return "bad";
  if (ready > 0) return "warn";
  if (inProgress > 0) return "ok";
  return "muted";
}

/**
 * Build the Dex section from the latest `dex.tasks` output. Visibility is driven
 * by `present` — whether the dex plugin is installed (its `dex.tasks` capability
 * exists) — not by whether a board has arrived. So an installed plugin with no
 * board yet (or an empty board) still shows an empty state, and finishing all
 * your tasks doesn't make the tab vanish; only an uninstalled plugin hides the
 * section. `worktreeByTaskId` (from `linkWorktreesAndTasks`) annotates each task
 * row with its live worktree; `landableByTaskId` (from `deriveLandableByTaskId`)
 * annotates it with its PR's landable state. Pass an empty map (or omit either)
 * for no annotation. Pure.
 */
export function buildDexSection(
  board: DexBoard | undefined,
  present: boolean,
  worktreeByTaskId?: ReadonlyMap<string, LinkedWorktree>,
  landableByTaskId?: ReadonlyMap<string, LandableState>,
): DexSection {
  if (!board) {
    return { visible: present, rows: [], counts: { ...ZERO_COUNTS } };
  }
  const activeAncestors = ancestorsWithActiveDescendant(board.tasks);
  const counts: DexCounts = { ...ZERO_COUNTS, total: board.tasks.length };
  const rows: DexRow[] = board.tasks.map((t) => {
    switch (t.status) {
      case "ready":
        counts.ready += 1;
        break;
      case "blocked":
        counts.blocked += 1;
        break;
      case "in-progress":
        counts.inProgress += 1;
        break;
      case "done":
        counts.done += 1;
        break;
    }
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      result: t.result,
      status: t.status,
      displayStatus: rollupDisplayStatus(t, activeAncestors),
      depth: t.depth,
      isEpic: t.isEpic,
      blockedByCount: t.blockedByCount,
      blockedBy: t.blockedBy,
      project: t.project,
      health: dexHealth(t.status),
      worktree: worktreeByTaskId?.get(t.id),
      landable: landableByTaskId?.get(t.id),
    };
  });
  return { visible: present, rows, counts };
}

/**
 * Ids of every task that has an in-progress *descendant* (any depth). Built by
 * walking each in-progress task's `parentId` chain up to the root and marking
 * the ancestors — so it spans grandchildren, not just direct children. The
 * `parentId` chain is authoritative; we don't rely on the rows' array ordering.
 */
function ancestorsWithActiveDescendant(tasks: DexTask[]): Set<string> {
  const parentOf = new Map(tasks.map((t) => [t.id, t.parentId]));
  const marked = new Set<string>();
  for (const t of tasks) {
    if (t.status !== "in-progress") continue;
    let pid = t.parentId;
    // Stop early once we hit an already-marked ancestor: its own ancestors were
    // marked when it was added, so the rest of the chain is already covered.
    while (pid && !marked.has(pid)) {
      marked.add(pid);
      pid = parentOf.get(pid);
    }
  }
  return marked;
}

/**
 * The status a row's marker renders as. An epic that isn't itself blocked or
 * in-progress rolls up to `in-progress` when it has an in-progress descendant;
 * blocked outranks the rollup (a blocked parent keeps reading as blocked,
 * consistent with {@link worstDexHealth}). Everything else renders as-is.
 */
function rollupDisplayStatus(t: DexTask, activeAncestors: Set<string>): DexStatus {
  if (
    t.isEpic &&
    t.status !== "blocked" &&
    t.status !== "in-progress" &&
    activeAncestors.has(t.id)
  ) {
    return "in-progress";
  }
  return t.status;
}

// ---------------------------------------------------------------------------
// Dependency-graph view derivation
//
// The graph view renders the blocker edges (`blockedBy`) rather than the
// parent/child task tree. Kept here — out of the DOM layer — so the derivation
// is unit-testable without a jsdom harness; the renderer walks the forest below
// and draws each node with the same row vocabulary as the tree view.
// ---------------------------------------------------------------------------

/**
 * One node in the dependency forest: a task row plus the (recursively derived)
 * tasks it blocks. Edge direction is blocker → blocked, so a node's `children`
 * are the tasks waiting on it.
 */
export interface DexGraphNode {
  row: DexRow;
  /** The tasks this row blocks (its dependents); empty for a leaf. */
  children: DexGraphNode[];
}

/**
 * Derive the dependency forest from a section's rows, following the `blockedBy`
 * blocker edges (not the task tree). Pure — no DOM. The renderer walks the
 * returned roots depth-first, indenting children under their blocker.
 *
 * Shape:
 *   - **Roots = UNBLOCKED tasks** — those with no still-active blocker present
 *     in the set (empty `blockedBy`, or every listed blocker id is unknown).
 *   - A **blocked** task nests under *each* of its active blockers, so it can
 *     appear more than once when several tasks gate it. We chose
 *     appear-under-every-blocker (rather than a single "primary" blocker)
 *     because the point of the graph view is to surface *all* the edges a task
 *     waits on — collapsing to one blocker would silently hide dependencies.
 *
 * Edge cases:
 *   - **Cycles** (A blocks B blocks A): we never recurse into a node already on
 *     the current ancestor path, so a cycle terminates instead of looping
 *     forever. The cyclic node still appears once (as a child of its blocker);
 *     its own children are simply not re-expanded under that ancestor.
 *   - **Unknown blocker id** (a blocker not in the row set): ignored — a task
 *     whose only blockers are all unknown becomes a root, since it can't nest
 *     under a parent that isn't there.
 *   - **Standalone tasks** (no edges either way): roots with no children.
 *   - Completed blockers are already filtered out upstream, so a `blockedBy`
 *     entry is always an active blocker (or an unknown id, handled above).
 */
export function deriveDexGraph(rows: readonly DexRow[]): DexGraphNode[] {
  const rowById = new Map(rows.map((r) => [r.id, r]));
  // blocker id → the rows it blocks (the reverse of each row's `blockedBy`).
  const dependentsOf = new Map<string, DexRow[]>();
  for (const row of rows) {
    for (const blockerId of row.blockedBy) {
      // Skip edges to blockers that aren't in the set (stale/foreign ids).
      if (!rowById.has(blockerId)) continue;
      const list = dependentsOf.get(blockerId);
      if (list) list.push(row);
      else dependentsOf.set(blockerId, [row]);
    }
  }

  // Build a node and recurse into its dependents, carrying the ancestor path so
  // a cycle (an id already above us) stops rather than re-expands forever.
  const build = (row: DexRow, path: Set<string>): DexGraphNode => {
    const children: DexGraphNode[] = [];
    for (const dep of dependentsOf.get(row.id) ?? []) {
      if (path.has(dep.id)) continue; // cycle guard: dep is already an ancestor
      path.add(dep.id);
      children.push(build(dep, path));
      path.delete(dep.id);
    }
    return { row, children };
  };

  // Roots are the unblocked tasks: none of their listed blockers is a known row.
  const roots: DexGraphNode[] = [];
  for (const row of rows) {
    const blocked = row.blockedBy.some((id) => rowById.has(id));
    if (blocked) continue;
    roots.push(build(row, new Set([row.id])));
  }
  return roots;
}
