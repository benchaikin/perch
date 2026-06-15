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
  /** Count of still-active blockers. */
  blockedByCount: number;
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
  depth: number;
  isEpic: boolean;
  blockedByCount: number;
  project?: string;
  /** Marker color: blocked=red(bad), in-progress=amber(warn), done=green(ok), ready=grey(muted). */
  health: DexHealth;
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
 * The rendered Dex section. `visible` is false only when there are no tasks (no
 * board yet, or an empty board) — so users without the dex plugin see the
 * unchanged panel. `rows` are pre-ordered (tree pre-order, depth-tagged);
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
 * Build the Dex section from the latest `dex.tasks` output. Hidden
 * (`visible: false`) when the board is absent or has no tasks. Pure: same input
 * → same output.
 */
export function buildDexSection(board: DexBoard | undefined): DexSection {
  if (!board || board.tasks.length === 0) {
    return { visible: false, rows: [], counts: { ...ZERO_COUNTS } };
  }
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
      depth: t.depth,
      isEpic: t.isEpic,
      blockedByCount: t.blockedByCount,
      project: t.project,
      health: dexHealth(t.status),
    };
  });
  return { visible: true, rows, counts };
}
