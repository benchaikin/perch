/**
 * Electron-free, pure normalization of `dex list --json` output into the
 * {@link DexBoard} view-model the GUI renders. No process spawning, no I/O — it
 * takes already-parsed task arrays (one group per monitored dex store) so it
 * unit-tests directly.
 *
 * dex stores no explicit per-task status; we DERIVE it from the fields it does
 * emit:
 *   - `completed` true                                   → "done"
 *   - an unmet blocker (a `blockedBy` id still active)   → "blocked"
 *   - `started_at` set (and not blocked)                 → "in-progress"
 *   - otherwise                                          → "ready"
 *
 * "Active" = present in the fetched set with `completed !== true`. Because the
 * default `dex list` excludes completed tasks, a blocker that's been completed
 * simply isn't in the set and so no longer blocks — exactly the desired
 * behavior. Precedence is done > blocked > in-progress > ready (a blocked task
 * reads as blocked even if it was also started).
 */
import { z } from "@perch/sdk";

/** A blocker reference: dex emits ids (strings); tolerate `{ id }` objects too. */
const Blocker = z.union([z.string(), z.object({ id: z.string() }).passthrough()]);

/**
 * Raw task as emitted by `dex list --json`. Loose + passthrough: we read only
 * the subset we need and ignore the rest, so a dex schema addition can't break
 * parsing.
 */
export const RawDexTask = z
  .object({
    id: z.string(),
    parent_id: z.string().nullable().optional(),
    name: z.string(),
    description: z.string().nullable().optional(),
    result: z.string().nullable().optional(),
    priority: z.number().optional(),
    completed: z.boolean().optional(),
    started_at: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    blockedBy: z.array(Blocker).optional(),
    children: z.array(z.unknown()).optional(),
  })
  .passthrough();
export type RawDexTask = z.infer<typeof RawDexTask>;

/** Derived task lifecycle. */
export const DexStatus = z.enum(["done", "in-progress", "blocked", "ready"]);
export type DexStatus = z.infer<typeof DexStatus>;

/** One rendered task row, pre-ordered as a tree pre-order traversal. */
export const DexTaskView = z.object({
  id: z.string(),
  name: z.string(),
  /** Full task description (the "ticket body"); empty string when none. */
  description: z.string(),
  /** Completion result, present only on done tasks; null otherwise. */
  result: z.string().nullable(),
  status: DexStatus,
  /** Lower = higher priority (dex convention); 0 when unset. */
  priority: z.number(),
  /** Tree depth: 0 for a root/epic, 1 for its tasks, etc. (drives indentation). */
  depth: z.number(),
  /** Parent task id, when this row nests under another. */
  parentId: z.string().optional(),
  /** True when this task has children in the fetched set (render as a group). */
  isEpic: z.boolean(),
  /** Count of still-active blockers (>0 ⇒ status "blocked"); equals `blockedBy.length`. */
  blockedByCount: z.number(),
  /**
   * Ids of the still-ACTIVE blockers (completed blockers are filtered out, same
   * as for status derivation). The blocker EDGES, kept so a future
   * dependency-graph view can be built; tree mode ignores this and reads
   * `blockedByCount`.
   */
  blockedBy: z.array(z.string()),
  /** Source project label when monitoring multiple dex stores. */
  project: z.string().optional(),
});
export type DexTaskView = z.infer<typeof DexTaskView>;

/** `dex.tasks`'s output: a flat, tree-ordered list of task rows. */
export const DexBoard = z.object({
  tasks: z.array(DexTaskView),
  /**
   * The monitored projects (repo basenames) in config order, INCLUDING any with
   * zero tasks — so the GUI can render a header + New "+" for a configured-but-empty
   * repo. Empty when the board reads the daemon's own cwd store (no configured
   * repos), in which case the GUI stays a flat list.
   */
  projects: z.array(z.string()),
  /**
   * Per-repo auto-spawn mode (`plugins.dex.autoSpawn`), keyed by project basename:
   * `true` ⇒ the reap pass auto-spawns that repo's ready tasks (Auto), absent/false
   * ⇒ Manual. Surfaced on the board so the GUI's per-repo header can render the
   * Auto/Manual toggle and reflect the persisted mode. Optional/absent ⇒ all Manual.
   */
  autoSpawn: z.record(z.boolean()).optional(),
});
export type DexBoard = z.infer<typeof DexBoard>;

/** One monitored dex store's tasks, optionally tagged with a project label. */
export interface DexGroup {
  project?: string;
  tasks: RawDexTask[];
}

function blockerId(b: z.infer<typeof Blocker>): string {
  return typeof b === "string" ? b : b.id;
}

function deriveStatus(task: RawDexTask, activeIds: ReadonlySet<string>): DexStatus {
  if (task.completed) return "done";
  const blocked = (task.blockedBy ?? []).map(blockerId).some((id) => activeIds.has(id));
  if (blocked) return "blocked";
  if (task.started_at) return "in-progress";
  return "ready";
}

/** Stable order: priority ascending (lower = higher), then creation time. */
function compareTasks(a: RawDexTask, b: RawDexTask): number {
  const byPriority = (a.priority ?? 0) - (b.priority ?? 0);
  if (byPriority !== 0) return byPriority;
  return String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
}

/**
 * Normalize one store's flat task array into ordered {@link DexTaskView}s.
 * `dex list --json` returns every task as an array element (each carrying both
 * `parent_id` and a `children` array), so we rebuild the tree from `parent_id`
 * and pre-order traverse it — roots first, then descendants, depth-tagged.
 */
function buildGroup(tasks: RawDexTask[], project: string | undefined): DexTaskView[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const activeIds = new Set(tasks.filter((t) => t.completed !== true).map((t) => t.id));

  const childrenOf = new Map<string, RawDexTask[]>();
  const roots: RawDexTask[] = [];
  for (const t of tasks) {
    const pid = t.parent_id ?? undefined;
    if (pid !== undefined && byId.has(pid)) {
      const siblings = childrenOf.get(pid) ?? [];
      siblings.push(t);
      childrenOf.set(pid, siblings);
    } else {
      // No parent, or a parent that isn't in this set (e.g. a completed epic
      // excluded from the default list) — treat as a root.
      roots.push(t);
    }
  }

  const out: DexTaskView[] = [];
  const visit = (task: RawDexTask, depth: number): void => {
    const kids = (childrenOf.get(task.id) ?? []).slice().sort(compareTasks);
    // Keep only blockers still active (drop completed ones, as status does).
    const activeBlockers = (task.blockedBy ?? [])
      .map(blockerId)
      .filter((id) => activeIds.has(id));
    out.push({
      id: task.id,
      name: task.name,
      description: task.description ?? "",
      result: task.result ?? null,
      status: deriveStatus(task, activeIds),
      priority: task.priority ?? 0,
      depth,
      parentId: task.parent_id ?? undefined,
      isEpic: kids.length > 0,
      blockedBy: activeBlockers,
      blockedByCount: activeBlockers.length,
      project,
    });
    for (const kid of kids) visit(kid, depth + 1);
  };
  for (const root of roots.slice().sort(compareTasks)) visit(root, 0);
  return out;
}

/**
 * Build the full {@link DexBoard} from one or more monitored stores' task
 * arrays. Each group is normalized independently (blocker resolution is
 * per-store) and concatenated; rows carry their `project` tag so the GUI can
 * group by source when more than one store is monitored. The board's `projects`
 * lists every group's project in input (config) order — including groups with
 * zero tasks — so a configured-but-empty repo still surfaces a header. Pure:
 * same input → same output.
 */
export function buildDexBoard(groups: ReadonlyArray<DexGroup>): DexBoard {
  const tasks: DexTaskView[] = [];
  const projects: string[] = [];
  for (const group of groups) {
    tasks.push(...buildGroup(group.tasks, group.project));
    if (group.project !== undefined) projects.push(group.project);
  }
  return { tasks, projects };
}

/**
 * Validate already-parsed JSON into a `RawDexTask[]`, tolerating shape drift:
 * unknown/extra fields pass through, and a non-array (or a malformed payload)
 * yields `[]` rather than throwing — so a dex output change degrades to "no
 * tasks" instead of breaking the poll.
 */
export function parseRawTasks(json: unknown): RawDexTask[] {
  const parsed = z.array(RawDexTask).safeParse(json);
  return parsed.success ? parsed.data : [];
}
