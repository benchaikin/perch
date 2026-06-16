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
import { dexNotifications } from "./notify.js";
import { defaultExec, DexProvider, type Exec } from "./provider.js";
import { runSpawn, type SpawnInput, type SpawnResult } from "./spawn.js";

export { buildDexBoard, DexBoard, DexStatus, DexTaskView, parseRawTasks, RawDexTask } from "./normalize.js";
export type { DexGroup } from "./normalize.js";
export { dexNotifications } from "./notify.js";
export { DexProvider } from "./provider.js";
export type { Exec, ListOptions } from "./provider.js";
export {
  branchFor,
  buildClaudeLaunch,
  bootstrapPrompt,
  deriveSlug,
  DexRunner,
  findTask,
  GitRunner,
  isValidTaskId,
  resolveRepo,
  runSpawn,
  storagePathOf as spawnStoragePathOf,
  worktreeAddArgs,
  worktreePathFor,
} from "./spawn.js";
export type { SpawnDeps, SpawnInput, SpawnResult } from "./spawn.js";

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
  /** Path to the `git` binary (for the `spawn` action); defaults to `git` on PATH. */
  gitBin: z.string().optional(),
  /** Include completed (done) tasks in the board; default false. */
  showCompleted: z.boolean().optional(),
});
export type DexConfig = z.infer<typeof DexConfig>;

/** The `dex.spawn` action input: a task id, with an optional explicit repo override. */
const SpawnInputSchema = z.object({
  id: z.string(),
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
        const showCompleted = cfg.showCompleted ?? false;
        // `dirs` overrides the shared `global.repos`; falls back to it, then to
        // the daemon's cwd-resolved store when both are empty.
        const dirs = effectiveDirs(cfg.dirs ?? [], ctx.global);

        // One group per monitored store; an unreadable store contributes nothing
        // rather than failing the whole poll.
        const fetchGroup = async (dir?: string): Promise<DexGroup> => {
          try {
            const raw = await provider.listRaw(
              dir
                ? { storagePath: storagePathOf(dir), showCompleted }
                : { showCompleted },
            );
            return { project: dir ? basename(dir) : undefined, tasks: parseRawTasks(raw) };
          } catch (err) {
            ctx.log(`dex.tasks: failed to read ${dir ?? "default store"}: ${String(err)}`);
            return { project: dir ? basename(dir) : undefined, tasks: [] };
          }
        };

        const groups =
          dirs.length === 0
            ? [await fetchGroup()]
            : await Promise.all(dirs.map((dir) => fetchGroup(dir)));

        return buildDexBoard(groups);
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
  },
});
