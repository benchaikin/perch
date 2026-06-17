/**
 * @perch/plugin-dex — surfaces the dex task tree (epics → tasks → subtasks) as
 * the subscribable `dex.tasks` read, for coordinating multiple AI coding agents
 * from the menu-bar panel: what's ready, in-progress, or blocked, at a glance.
 *
 * Data source: the `dex` CLI (`dex list --json`). dex stores tasks per-project
 * in `<root>/.dex/tasks.jsonl`, resolved from cwd by walking up (no global task
 * store). Monitored roots resolve in precedence: `plugins.dex.dirs` (override)
 * → the shared `global.repos` list → else the daemon's own resolved store
 * (cwd-relative). Each explicit root is read via `--storage-path <root>/.dex`
 * and tagged with its directory name as a `project`.
 *
 * The read never throws: a missing `dex` binary or unreadable store degrades to
 * an empty board, so polling stays alive and the panel simply hides the section.
 */
import { basename, join } from "node:path";
import type { spawn as nodeSpawn } from "node:child_process";

import {
  action,
  definePlugin,
  read,
  reposOf,
  terminalConfigOf,
  validateSettingsDescriptor,
  z,
} from "@perch/sdk";

import { buildDexBoard, DexBoard, type DexGroup, parseRawTasks } from "./normalize.js";
import {
  type BlockerInput,
  type BlockerResult,
  runAddBlocker,
  runRemoveBlocker,
} from "./blocker.js";
import { type DeleteInput, type DeleteResult, runDelete } from "./delete.js";
import { type EditInput, type EditResult, runEdit } from "./edit.js";
import { type NewInput, type NewResult, runNew } from "./new.js";
import { LandBoard, landNotifications, runLand } from "./land.js";
import { dexNotifications } from "./notify.js";
import { defaultExec, DexProvider, type Exec } from "./provider.js";
import {
  runSpawn,
  runSpawnBatch,
  type SpawnBatchResult,
  type SpawnInput,
  type SpawnResult,
} from "./spawn.js";

export {
  buildDexBoard,
  DexBoard,
  DexStatus,
  DexTaskView,
  parseRawTasks,
  RawDexTask,
} from "./normalize.js";
export type { DexGroup } from "./normalize.js";
export { resolveBlockerStore, runAddBlocker, runRemoveBlocker } from "./blocker.js";
export type { BlockerDeps, BlockerInput, BlockerResult } from "./blocker.js";
export { locateTaskStore, runDelete } from "./delete.js";
export type { DeleteDeps, DeleteInput, DeleteResult } from "./delete.js";
export { runEdit } from "./edit.js";
export type { EditDeps, EditInput, EditResult } from "./edit.js";
export { newTaskPrompt, newTaskTitle, resolveNewRepo, runNew } from "./new.js";
export type { NewDeps, NewInput, NewResult } from "./new.js";
export {
  defaultFsProbe,
  evidenceFor,
  inferBuild,
  LandBoard,
  LandOutcome,
  LandPr,
  landNotifications,
  runLand,
} from "./land.js";
export type { BuildCommand, FsProbe, LandDeps } from "./land.js";
export { dexNotifications } from "./notify.js";
export { DexProvider } from "./provider.js";
export type { Exec, ListOptions } from "./provider.js";
export {
  branchFor,
  buildClaudeLaunch,
  bootstrapPrompt,
  defaultFsOps,
  deriveSlug,
  dexStoreLinkSpec,
  DexRunner,
  findTask,
  GitRunner,
  isReadyToSpawn,
  isValidTaskId,
  linkDexStore,
  resolveRepo,
  runSpawn,
  runSpawnBatch,
  storagePathOf as spawnStoragePathOf,
  worktreeAddArgs,
  worktreePathFor,
} from "./spawn.js";
export type {
  FsOps,
  SpawnBatchEntry,
  SpawnBatchResult,
  SpawnCandidate,
  SpawnDeps,
  SpawnInput,
  SpawnResult,
} from "./spawn.js";

/**
 * Per-plugin config (`plugins.dex`). All optional: `plugins.dex = {}` monitors
 * the daemon's resolved store with the `dex` on PATH.
 */
const DexConfig = z.object({
  /**
   * Project roots to monitor (each must contain a `.dex/` store) — an override
   * for the shared `global.repos` list. When set and non-empty, only these roots
   * are monitored; when unset/empty the plugin falls back to `global.repos`, and
   * only when *both* are empty does it use the daemon's own resolved store
   * (cwd-relative). Each explicit root is read via `--storage-path <dir>/.dex`
   * and tagged with the directory's basename.
   */
  dirs: z.array(z.string()).optional(),
  /** Path to the `dex` binary; defaults to `dex` on PATH. */
  dexBin: z.string().optional(),
  /** Path to the `git` binary (for the `spawn`/`land` actions); defaults to `git` on PATH. */
  gitBin: z.string().optional(),
  /** Path to the `gh` binary (for `land`'s PR-merged lookups); defaults to `gh` on PATH. */
  ghBin: z.string().optional(),
  /** Include completed (done) tasks in the board; default false. */
  showCompleted: z.boolean().optional(),
  /**
   * Auto-land merged dex worktrees: when a `dex/<id>` worktree's PR has merged
   * (and its tree is clean, and — for no-CI repos — its build passes), reap the
   * worktree + branch and complete the dex task automatically. Default true. Set
   * false to only *detect* merged worktrees (flagged "ready to land") and leave
   * the reaping to a manual `land-dex` run.
   */
  autoLand: z.boolean().optional(),
});
export type DexConfig = z.infer<typeof DexConfig>;

/** The `dex.spawn` action input: a task id, with an optional explicit repo override. */
const SpawnInputSchema = z.object({
  id: z.string(),
  repo: z.string().optional(),
});

/** The `dex.delete` action input: a task id, with an optional explicit repo override. */
const DeleteInputSchema = z.object({
  id: z.string(),
  repo: z.string().optional(),
});

/**
 * The `dex.edit` action input: a task id, an optional explicit repo override, and
 * the new values for the editable metadata fields. Each field is optional —
 * omitting one leaves it unchanged (no flag sent); only what's present is edited.
 */
const EditInputSchema = z.object({
  id: z.string(),
  repo: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  priority: z.number().optional(),
});

/**
 * The `dex.new` action input: a free-form description, with an optional target
 * (a `project` basename the GUI passes, or an explicit `repo` path) so the author
 * agent's `dex create` lands in the right store.
 */
const NewInputSchema = z.object({
  description: z.string(),
  project: z.string().optional(),
  repo: z.string().optional(),
});

/**
 * The `dex.add-blocker` / `dex.remove-blocker` action input: the blocked task, the
 * blocker it waits on, and an optional explicit repo override. Drop A onto B ⇒
 * `{ blockedId: B, blockerId: A }`.
 */
const BlockerInputSchema = z.object({
  blockedId: z.string(),
  blockerId: z.string(),
  repo: z.string().optional(),
});

/** Narrow `ctx.config` (typed `unknown` by the SDK) to {@link DexConfig}; {} on miss. */
function configOf(config: unknown): DexConfig {
  const parsed = DexConfig.safeParse(config);
  return parsed.success ? parsed.data : {};
}

/**
 * Test seam for the dex CLI runner. `ctx` carries no exec, so tests override
 * this module-level injection point to feed fixture JSON without spawning the
 * real `dex`. Defaults to the provider's real `execFile` runner.
 */
let execOverride: Exec | undefined;

/** Inject an `exec` stub for `dex.tasks` (tests only); pass `undefined` to reset. */
export function __setExec(exec: Exec | undefined): void {
  execOverride = exec;
}

/** Test seam for the `spawn` action's terminal launcher (tests only). */
let spawnOpenSpawn: typeof nodeSpawn | undefined;
export function __setSpawnOpenSpawn(spawnFn: typeof nodeSpawn | undefined): void {
  spawnOpenSpawn = spawnFn;
}

/**
 * In-flight latch for the `land` pass. A no-CI build gate can make one pass run
 * longer than the 60s poll interval; without this, `setInterval` would fire an
 * overlapping pass that could race the same worktree's reap. While a pass runs,
 * the next poll is skipped (returns an empty board).
 */
let landing = false;

/**
 * The dex store path for a project root: its `.dex` directory. `dex
 * --storage-path` expects the store *directory* (matching `dex dir`'s output),
 * not the `tasks.jsonl` file inside it.
 */
function storagePathOf(dir: string): string {
  return join(dir, ".dex");
}

/**
 * The project roots to monitor, in precedence order: `plugins.dex.dirs` when set
 * and non-empty (an explicit override), else the shared `global.repos` list, else
 * `[]` — which the caller reads as "use the daemon's own cwd-resolved store". A
 * `global.repos` root with no `.dex/` degrades to an empty group (see `fetchGroup`).
 */
export function effectiveDirs(dirs: string[], global: unknown): string[] {
  return dirs.length > 0 ? dirs : reposOf(global);
}

/**
 * Read the dex board across the monitored stores — one group per store, with an
 * unreadable store contributing an empty group rather than failing the whole
 * read. When `dirs` is empty, falls back to the daemon's own cwd-resolved store.
 * Shared by the `tasks` read and the `spawn-all` action so both filter the same
 * board.
 */
async function fetchBoard(
  provider: DexProvider,
  dirs: string[],
  showCompleted: boolean,
  log: (message: string) => void,
): Promise<DexBoard> {
  const fetchGroup = async (dir?: string): Promise<DexGroup> => {
    try {
      const raw = await provider.listRaw(
        dir ? { storagePath: storagePathOf(dir), showCompleted } : { showCompleted },
      );
      return { project: dir ? basename(dir) : undefined, tasks: parseRawTasks(raw) };
    } catch (err) {
      log(`dex board: failed to read ${dir ?? "default store"}: ${String(err)}`);
      return { project: dir ? basename(dir) : undefined, tasks: [] };
    }
  };

  const groups =
    dirs.length === 0
      ? [await fetchGroup()]
      : await Promise.all(dirs.map((dir) => fetchGroup(dir)));

  return buildDexBoard(groups);
}

export default definePlugin({
  id: "dex",
  name: "Dex Tasks",
  config: DexConfig,
  settings: validateSettingsDescriptor([
    {
      key: "showCompleted",
      type: "boolean",
      label: "Show completed tasks",
      description: "Include done tasks in the board (greyed out) instead of hiding them.",
      default: false,
    },
    {
      key: "autoLand",
      type: "boolean",
      label: "Auto-land merged worktrees",
      description:
        "When a dex/<id> worktree's PR merges (tree clean, and the build passes for " +
        "no-CI repos), automatically remove the worktree + branch and complete the task. " +
        "Turn off to only flag merged worktrees as 'ready to land' and reap them by hand.",
      default: true,
    },
    {
      key: "dexBin",
      type: "string",
      label: "dex binary path",
      description:
        "Path to the `dex` CLI. Leave as `dex` to use PATH; set an absolute path " +
        "if the daemon can't find it (e.g. an nvm/volta install when launched from Finder).",
      default: "dex",
    },
    {
      key: "gitBin",
      type: "string",
      label: "git binary path",
      description:
        "Path to the `git` CLI, used by the spawn action to create a task's worktree. " +
        "Leave as `git` to use PATH.",
      default: "git",
    },
    // `dirs` (the monitored project roots) stays a perch.json-only setting: the
    // generic settings UI has no list field type yet, and exposing a string[] as
    // a single text input would fight the config schema. Edit it in perch.json.
  ]),
  capabilities: {
    /**
     * The open dex task tree, derived into per-task statuses. Subscribable +
     * polled (30s) and refreshed on focus, mirroring `services.list`. Exposed on
     * MCP so an agent can read "what's blocked?" as a typed tool. Never throws.
     */
    tasks: read({
      summary: "Open dex tasks (epics → tasks → subtasks) with derived status",
      input: z.object({}).default({}),
      output: DexBoard,
      refresh: { every: "30s", on: ["focus"] },
      view: { kind: "list", title: "Dex" },
      expose: { mcp: true },
      run: async ({ ctx }): Promise<DexBoard> => {
        const cfg = configOf(ctx.config);
        const provider = new DexProvider(cfg.dexBin ?? "dex", { exec: execOverride });
        // `dirs` overrides the shared `global.repos`; falls back to it, then to
        // the daemon's cwd-resolved store when both are empty.
        const dirs = effectiveDirs(cfg.dirs ?? [], ctx.global);
        return fetchBoard(provider, dirs, cfg.showCompleted ?? false, ctx.log);
      },
      // Announce tasks newly blocked, or freshly ready (unblocked) so an agent can
      // pick them up. `prev`/`next` are validated DexBoards; skip the first poll.
      notify: ({ prev, next }) => dexNotifications(prev, next),
    }),

    /**
     * Spawn an agent for a dex task: create the `dex/<id>-<slug>` worktree (off
     * the repo's default branch) and launch an interactive `claude` in the user's
     * terminal, seeded to fetch the task's full context and implement it. The repo
     * is `input.repo` when given, else resolved from the task's project against
     * `global.repos`. Daemon-side; MCP-exposed (yielding `perch dex spawn <id>` +
     * a typed tool). Never half-creates: any failure returns `{ ok:false, message }`.
     */
    spawn: action<SpawnInput, DexConfig, SpawnResult>({
      summary: "Create a worktree for a dex task and launch a seeded agent",
      input: SpawnInputSchema,
      expose: { mcp: true },
      run: ({ input, ctx }): Promise<SpawnResult> => {
        const cfg = configOf(ctx.config);
        // `dirs` overrides the shared `global.repos` (same precedence as the read);
        // these are the repos whose dex stores we probe + map the task's project to.
        const repos = effectiveDirs(cfg.dirs ?? [], ctx.global);
        return runSpawn(input, {
          exec: execOverride ?? defaultExec,
          dexBin: cfg.dexBin ?? "dex",
          gitBin: cfg.gitBin ?? "git",
          repos,
          terminal: terminalConfigOf(ctx.global),
          spawn: spawnOpenSpawn,
          log: ctx.log,
        });
      },
    }),

    /**
     * Delete a dex task from whichever monitored repo's store holds it — the
     * board's destructive counterpart to `spawn`, projecting the `dex` CLI's
     * `delete`/`rm`/`remove` onto perch's surfaces so a mistaken/duplicate/abandoned
     * task can be cleared without dropping to the CLI. The store is `input.repo`'s
     * when given, else found by probing the configured stores (same precedence as
     * `spawn`). Runs `dex delete <id> --force` (non-interactive; cascades subtasks,
     * matching `dex rm -f`). Daemon-side; MCP-exposed (yielding `perch dex delete
     * <id>` + a typed tool). Never throws: any failure returns `{ ok:false, message }`.
     *
     * The GUI gates this behind a confirmation and warns when the task has a live
     * worktree/agent — state the daemon board doesn't track — so a running agent is
     * never silently orphaned; the CLI/MCP path is an explicit power-user action.
     */
    delete: action<DeleteInput, DexConfig, DeleteResult>({
      summary: "Delete a dex task from the store that holds it",
      input: DeleteInputSchema,
      expose: { mcp: true },
      run: ({ input, ctx }): Promise<DeleteResult> => {
        const cfg = configOf(ctx.config);
        // Same repo precedence as `dex.tasks`/`dex.spawn`: `dirs` → global.repos.
        const repos = effectiveDirs(cfg.dirs ?? [], ctx.global);
        return runDelete(input, {
          exec: execOverride ?? defaultExec,
          dexBin: cfg.dexBin ?? "dex",
          repos,
          log: ctx.log,
        });
      },
    }),

    /**
     * Edit a dex task's metadata (name, description, priority) in whichever
     * monitored repo's store holds it — the board's "correct the ticket"
     * counterpart to `delete`, projecting the `dex` CLI's `edit` onto perch's
     * surfaces so a task's name/description can be fixed without dropping to the
     * CLI. The store is `input.repo`'s when given, else found by probing the
     * configured stores (same precedence as `spawn`/`delete`). Only the fields
     * present in the input become `dex edit` flags, so an unchanged field is never
     * sent; a blank name is rejected and a no-op succeeds quietly. Daemon-side;
     * MCP-exposed (yielding `perch dex edit <id> -n ... -d ...` + a typed tool).
     * Never throws: any failure returns `{ ok:false, message }`.
     *
     * Unlike delete there is no live-worktree guard — name/description/priority are
     * pure metadata, safe to change while an agent works the task. The GUI detail
     * screen drives this with an inline editor (the non-activating panel can't rely
     * on a `window.prompt`).
     */
    edit: action<EditInput, DexConfig, EditResult>({
      summary: "Edit a dex task's name/description/priority in the store that holds it",
      input: EditInputSchema,
      expose: { mcp: true },
      run: ({ input, ctx }): Promise<EditResult> => {
        const cfg = configOf(ctx.config);
        // Same repo precedence as `dex.tasks`/`dex.spawn`/`dex.delete`.
        const repos = effectiveDirs(cfg.dirs ?? [], ctx.global);
        return runEdit(input, {
          exec: execOverride ?? defaultExec,
          dexBin: cfg.dexBin ?? "dex",
          repos,
          log: ctx.log,
        });
      },
    }),

    /**
     * Create a dex task from a free-form description by spawning a Claude agent IN
     * the target repo's directory, seeded to read the code and run `dex create` —
     * the complement of `dex.spawn` (which spawns an agent FOR an existing task;
     * this spawns one to CREATE a task). The agent's cwd is the resolved repo so
     * its `dex create` writes to that repo's store with no `--storage-path`. The
     * repo is `input.repo` when given, else `input.project` mapped against the
     * configured repos, else the sole configured repo, else the daemon's cwd store
     * (same precedence helpers as `spawn`). Daemon-side; MCP-exposed (yielding
     * `perch dex new --description "..."` + a typed tool). The task is authored
     * asynchronously — it appears on the next `dex.tasks` refresh. Never throws:
     * any failure returns `{ ok:false, message }`.
     */
    new: action<NewInput, DexConfig, NewResult>({
      summary: "Spawn an agent in a repo to author a new dex task from a description",
      input: NewInputSchema,
      expose: { mcp: true },
      run: ({ input, ctx }): Promise<NewResult> => {
        const cfg = configOf(ctx.config);
        // Same repo precedence as `dex.tasks`/`dex.spawn`: `dirs` → global.repos.
        const repos = effectiveDirs(cfg.dirs ?? [], ctx.global);
        return runNew(input, {
          repos,
          // The fallback launch dir when no repo resolves (no repos configured):
          // the daemon's own cwd, whose `.dex` store `dex.tasks` reads in that case.
          cwd: process.cwd(),
          terminal: terminalConfigOf(ctx.global),
          spawn: spawnOpenSpawn,
          log: ctx.log,
        });
      },
    }),

    /**
     * Add a blocker edge: make `blockedId` depend on `blockerId` (so `blockedId`
     * is "blocked" until `blockerId` completes) — the daemon half of the board's
     * drag-and-drop dependency gesture (drop task A onto task B ⇒ B blocked-by A).
     * The store is `input.repo`'s when given, else found by probing the configured
     * stores; both tasks must live in the SAME store (a dependency can't span
     * projects). Runs `dex edit <blockedId> --add-blocker <blockerId>`; dex itself
     * rejects a self-block and a cycle with a clear message, surfaced verbatim.
     * Daemon-side; MCP-exposed (`perch dex add-blocker --blockedId B --blockerId A`
     * + a typed tool). Never throws: any failure returns `{ ok:false, message }`.
     */
    "add-blocker": action<BlockerInput, DexConfig, BlockerResult>({
      summary: "Make one dex task depend on (be blocked by) another",
      input: BlockerInputSchema,
      expose: { mcp: true },
      run: ({ input, ctx }): Promise<BlockerResult> => {
        const cfg = configOf(ctx.config);
        // Same repo precedence as `dex.tasks`/`dex.spawn`/`dex.delete`.
        const repos = effectiveDirs(cfg.dirs ?? [], ctx.global);
        return runAddBlocker(input, {
          exec: execOverride ?? defaultExec,
          dexBin: cfg.dexBin ?? "dex",
          repos,
          log: ctx.log,
        });
      },
    }),

    /**
     * Remove a blocker edge: drop `blockerId` from `blockedId`'s blockers — the
     * inverse of `add-blocker`, so a mistakenly-wired dependency can be undone from
     * the board without dropping to the CLI. Same store resolution as `add-blocker`.
     * Runs `dex edit <blockedId> --remove-blocker <blockerId>`. Daemon-side;
     * MCP-exposed (`perch dex remove-blocker --blockedId B --blockerId A` + a typed
     * tool). Never throws: any failure returns `{ ok:false, message }`.
     */
    "remove-blocker": action<BlockerInput, DexConfig, BlockerResult>({
      summary: "Remove a blocker (dependency) from one dex task",
      input: BlockerInputSchema,
      expose: { mcp: true },
      run: ({ input, ctx }): Promise<BlockerResult> => {
        const cfg = configOf(ctx.config);
        const repos = effectiveDirs(cfg.dirs ?? [], ctx.global);
        return runRemoveBlocker(input, {
          exec: execOverride ?? defaultExec,
          dexBin: cfg.dexBin ?? "dex",
          repos,
          log: ctx.log,
        });
      },
    }),

    /**
     * Batch spawn: launch an agent for EVERY ready (unblocked) dex task at once,
     * each in its own `dex/<id>-<slug>` worktree — the fleet counterpart of
     * `spawn` and the GUI's top-level "spawn all ready" button. Reads the same
     * board the `tasks` read does, filters to the daemon-side readiness gate
     * (`ready` + no active blockers; in-progress/blocked tasks are skipped, and
     * `runSpawn` itself refuses a task whose worktree already exists), and runs
     * `runSpawn` over the survivors in parallel. CLI-exposed as `perch dex
     * spawn-all` (and MCP as `dex_spawn-all`). Returns a `{ spawned, failed }`
     * summary; never throws.
     */
    "spawn-all": action({
      summary: "Spawn an agent for every ready (unblocked) dex task, in parallel",
      input: z.object({}).default({}),
      expose: { mcp: true },
      run: async ({ ctx }): Promise<SpawnBatchResult> => {
        const cfg = configOf(ctx.config);
        const dirs = effectiveDirs(cfg.dirs ?? [], ctx.global);
        const provider = new DexProvider(cfg.dexBin ?? "dex", { exec: execOverride });
        const board = await fetchBoard(provider, dirs, cfg.showCompleted ?? false, ctx.log);
        return runSpawnBatch(board.tasks, {
          exec: execOverride ?? defaultExec,
          dexBin: cfg.dexBin ?? "dex",
          gitBin: cfg.gitBin ?? "git",
          repos: dirs,
          terminal: terminalConfigOf(ctx.global),
          spawn: spawnOpenSpawn,
          log: ctx.log,
        });
      },
    }),

    /**
     * Auto-land: the back-of-loop janitor. On each poll it enumerates the dex
     * worktrees across the monitored repos and, for any whose PR has merged,
     * reaps the loop — removes the worktree + branch and completes the dex task
     * with PR-derived evidence — behind the same guards as the `land-dex` skill
     * (merged PR + clean tree + a no-CI build gate). Merged-but-unsafe worktrees
     * are `flagged` for a human, never touched.
     *
     * Modeled as a notify-driven read so the daemon's persistent poller runs it
     * even with the panel closed (the loop closes itself in the background); the
     * notify hook turns each reap into a "Landed" banner. It mutates as a side
     * effect — unusual for a read, but the daemon only schedules reads, and this
     * is the only periodic-job seam. Returns the pass's reaped + flagged
     * outcomes. Never throws; CLI-exposed (`perch dex land`) as a manual trigger.
     */
    land: read({
      summary: "Auto-land merged dex worktrees (reap worktree + branch, complete the task)",
      input: z.object({}).default({}),
      output: LandBoard,
      refresh: { every: "60s", on: ["focus"] },
      run: async ({ ctx }): Promise<LandBoard> => {
        if (landing) {
          ctx.log("dex.land: a previous pass is still running; skipping this poll");
          return { reaped: [], flagged: [] };
        }
        landing = true;
        try {
          const cfg = configOf(ctx.config);
          // Same repo precedence as `dex.tasks`/`dex.spawn`: `dirs` → global.repos.
          const repos = effectiveDirs(cfg.dirs ?? [], ctx.global);
          return await runLand({
            exec: execOverride ?? defaultExec,
            gitBin: cfg.gitBin ?? "git",
            ghBin: cfg.ghBin ?? "gh",
            dexBin: cfg.dexBin ?? "dex",
            repos,
            autoLand: cfg.autoLand ?? true,
            log: ctx.log,
          });
        } finally {
          landing = false;
        }
      },
      // Announce a worktree just reaped (loop closed) or newly flagged (needs a hand).
      notify: ({ prev, next }) => landNotifications(prev, next),
    }),
  },
});
