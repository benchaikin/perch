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
import type { LandableState, LandablePr } from "./landable.js";
import type { AgentSummary } from "./agents-state.js";

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
  /**
   * The monitored projects (repo basenames) in config order, including any with
   * zero tasks. Drives the board's per-repo grouping so a configured-but-empty
   * repo still gets a header + New "+". Absent/empty when the daemon reads its own
   * cwd store (no configured repos), keeping that board a flat list. Optional so an
   * older daemon (whose `dex.tasks` predates this field) still decodes — grouping
   * then falls back to the projects seen on tasks.
   */
  projects?: string[];
  /**
   * Per-repo auto-spawn mode (`plugins.dex.autoSpawn`), keyed by project basename:
   * `true` ⇒ Auto (the daemon's reap pass spawns that repo's ready tasks), absent/
   * false ⇒ Manual. Drives each repo header's Auto/Manual toggle. Absent on an older
   * daemon (or when no repo is Auto) ⇒ every repo reads Manual.
   */
  autoSpawn?: Record<string, boolean>;
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
  /**
   * The matched PR's `{ number, url }`, joined in by `buildPanelState` from
   * `deriveLandablePrByTaskId` alongside {@link landable} (same branch→PR join,
   * so the two are populated together). Lets the renderer turn the landable chip
   * into an actionable `#<number>` button that opens the PR. Absent for rows with
   * no matched PR — render defensively (never assume it exists just because
   * {@link landable} is set).
   */
  pr?: LandablePr;
  /**
   * The live Claude Code session (agent) working this task, when one matches —
   * joined in by `buildPanelState` from `deriveAgentByTaskId`. Absent when no
   * session is attributed to this task's worktree; the renderer surfaces its
   * lifecycle state (running / blocked / done / error) as a compact marker so the
   * task list reads as a fleet at-a-glance. Display-only — the agent state never
   * feeds the dex counts or tab badge (Vibe Island owns agent attention).
   */
  agent?: AgentSummary;
}

/**
 * Whether a dex task is "open": unblocked (no active blockers) and not yet
 * completed. The shared predicate behind a task's identity-color accent — an
 * open task gets a {@link dexTaskColor} on its row, and the worktrees/terminals
 * surfaces match against this same notion of open.
 *
 * Deliberately BROADER than the renderer's `canSpawnDex`, which additionally
 * requires the task be `ready` with no live worktree/agent: an open task that's
 * already being worked (has a worktree or running agent) still counts here, so
 * its color stays consistent everywhere it appears. Structural on purpose so it
 * applies to a {@link DexRow} or a raw {@link DexTask} alike.
 */
export function isOpenDexTask(task: Pick<DexRow, "status" | "blockedByCount">): boolean {
  return task.blockedByCount === 0 && task.status !== "done";
}

/** Tallies per status, for the tab badge + any header summary. */
export interface DexCounts {
  ready: number;
  blocked: number;
  inProgress: number;
  done: number;
  total: number;
}

/** One repo's task rows, grouped under a per-repo header on a multi-repo board. */
export interface DexRepoGroup {
  /** Source project label (a repo basename) the rows belong to. */
  project: string;
  /** This project's rows, in the board's pre-order (tree-ordered, depth-tagged). */
  rows: DexRow[];
  /** Auto-spawn mode for this repo: `true` ⇒ Auto, `false` ⇒ Manual (the default). */
  autoSpawn: boolean;
}

/**
 * The rendered Dex section. `visible` tracks plugin *presence*, not task count:
 * it's false only when the dex plugin isn't installed — so users without the
 * plugin see the unchanged panel, while an installed-but-empty plugin still
 * shows an empty state. `rows` are pre-ordered (tree pre-order, depth-tagged);
 * `counts` drives the tab badge. `multiRepo` is true when more than one repo is
 * *configured* (not merely when >1 repo has tasks), so the renderer groups them
 * under collapsible per-repo headers; when true, `repoGroups` holds one group per
 * configured repo (config order, then any project seen only on tasks) — INCLUDING
 * configured-but-empty repos as empty groups, so each gets a header + New "+".
 * When false `repoGroups` is empty and rows render as a flat list.
 */
export interface DexSection {
  visible: boolean;
  rows: DexRow[];
  counts: DexCounts;
  multiRepo: boolean;
  repoGroups: DexRepoGroup[];
  /**
   * Per-repo auto-spawn modes (keyed by project basename), carried through from the
   * board so the single-repo header can look up its repo's mode. Empty when the
   * board reports none. Per-repo groups also carry their own resolved {@link
   * DexRepoGroup.autoSpawn}; this is the raw map for the non-grouped header.
   */
  autoSpawn: Record<string, boolean>;
  /**
   * The sole configured repo on a single-repo board (so its header can render the
   * Auto/Manual toggle), or undefined when the board groups multiple repos or reads
   * the daemon's own cwd store (no project to key auto-spawn on).
   */
  soleProject?: string;
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
 * The repos the board groups by: the configured `projects` (config order,
 * including any with zero tasks) unioned with any project seen on a task but not
 * configured (a repo dropped from config but still holding tasks), appended in
 * first-appearance order. When `projects` is absent (an older daemon's board), it
 * degrades to just the projects seen on tasks — the pre-this-change behavior. A
 * task with no project (the single cwd store) contributes nothing, so that board
 * stays flat.
 */
function configuredRepos(board: DexBoard): string[] {
  const seen = new Set<string>();
  const repos: string[] = [];
  const add = (project: string): void => {
    if (seen.has(project)) return;
    seen.add(project);
    repos.push(project);
  };
  for (const project of board.projects ?? []) add(project);
  for (const t of board.tasks) {
    if (t.project) add(t.project);
  }
  return repos;
}

/**
 * Group a board's rows by `project` into one {@link DexRepoGroup} per repo. The
 * order is seeded from the `configured` repo list (config order) so a
 * configured-but-empty repo still yields an EMPTY group (header + New "+"), then
 * any project seen only on tasks (a repo dropped from config but still holding
 * tasks) is appended in first-appearance order. Within a group rows keep the
 * board's pre-order. A row with no `project` buckets under `"(unknown)"`; in
 * practice only a single-store board yields unprojected rows, and that board
 * isn't multi-repo, so this branch never runs for it.
 */
function groupRowsByProject(
  rows: DexRow[],
  configured: readonly string[],
  autoSpawn: Record<string, boolean>,
): DexRepoGroup[] {
  const byProject = new Map<string, DexRow[]>();
  const order: string[] = [];
  const ensure = (project: string): DexRow[] => {
    let group = byProject.get(project);
    if (!group) {
      group = [];
      byProject.set(project, group);
      order.push(project);
    }
    return group;
  };
  // Seed every configured repo first (in config order) so empty ones get a group.
  for (const project of configured) ensure(project);
  for (const row of rows) ensure(row.project ?? "(unknown)").push(row);
  return order.map((project) => ({
    project,
    rows: byProject.get(project)!,
    autoSpawn: autoSpawn[project] === true,
  }));
}

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
 * annotates it with its PR's landable state; `landablePrByTaskId` (from
 * `deriveLandablePrByTaskId`) annotates it with that PR's `{ number, url }`;
 * `agentByTaskId` (from `deriveAgentByTaskId`) annotates it with its live agent
 * session. Pass an empty map (or omit any) for no annotation. Pure.
 */
export function buildDexSection(
  board: DexBoard | undefined,
  present: boolean,
  worktreeByTaskId?: ReadonlyMap<string, LinkedWorktree>,
  landableByTaskId?: ReadonlyMap<string, LandableState>,
  agentByTaskId?: ReadonlyMap<string, AgentSummary>,
  landablePrByTaskId?: ReadonlyMap<string, LandablePr>,
): DexSection {
  if (!board) {
    return {
      visible: present,
      rows: [],
      counts: { ...ZERO_COUNTS },
      multiRepo: false,
      repoGroups: [],
      autoSpawn: {},
    };
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
      pr: landablePrByTaskId?.get(t.id),
      agent: agentByTaskId?.get(t.id),
    };
  });
  // Grouping is driven by the CONFIGURED repo list (so a configured-but-empty repo
  // still gets a header), falling back to the projects seen on tasks when the board
  // predates the `projects` field. Union them so a repo dropped from config but
  // still holding tasks isn't lost. >1 distinct repo ⇒ grouped; 0/1 stays flat.
  const repos = configuredRepos(board);
  const multiRepo = repos.length > 1;
  const autoSpawn = board.autoSpawn ?? {};
  const repoGroups = multiRepo ? groupRowsByProject(rows, repos, autoSpawn) : [];
  // A single configured repo (not the cwd store) is the sole project whose header
  // carries the Auto/Manual toggle; multi-repo headers carry their own per group.
  const soleProject = !multiRepo && repos.length === 1 ? repos[0] : undefined;
  return { visible: present, rows, counts, multiRepo, repoGroups, autoSpawn, soleProject };
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
