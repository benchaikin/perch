/**
 * @perch/plugin-dex — surfaces the dex task tree (epics → tasks → subtasks) as
 * the subscribable `dex.tasks` read, for coordinating multiple AI coding agents
 * from the menu-bar panel: what's ready, in-progress, or blocked, at a glance.
 *
 * Data source: the `dex` CLI (`dex list --json`). dex stores tasks per-project
 * in `<root>/.dex/tasks.jsonl`, resolved from cwd by walking up (no global task
 * store). By default this plugin monitors the daemon's resolved project store;
 * set `dirs` to a list of project roots to aggregate several stores (each tagged
 * with its directory name as a `project`).
 *
 * The read never throws: a missing `dex` binary or unreadable store degrades to
 * an empty board, so polling stays alive and the panel simply hides the section.
 */
import { basename, join } from "node:path";

import { definePlugin, read, validateSettingsDescriptor, z } from "@perch/sdk";

import { buildDexBoard, DexBoard, type DexGroup, parseRawTasks } from "./normalize.js";
import { DexProvider, type Exec } from "./provider.js";

export { buildDexBoard, DexBoard, DexStatus, DexTaskView, parseRawTasks, RawDexTask } from "./normalize.js";
export type { DexGroup } from "./normalize.js";
export { DexProvider } from "./provider.js";
export type { Exec, ListOptions } from "./provider.js";

/**
 * Per-plugin config (`plugins.dex`). All optional: `plugins.dex = {}` monitors
 * the daemon's resolved store with the `dex` on PATH.
 */
const DexConfig = z.object({
  /**
   * Project roots to monitor (each must contain a `.dex/` store). When unset or
   * empty, the daemon's own resolved store is used (cwd-relative). When set,
   * each store is read via `--storage-path <dir>/.dex/tasks.jsonl` and tagged
   * with the directory's basename.
   */
  dirs: z.array(z.string()).optional(),
  /** Path to the `dex` binary; defaults to `dex` on PATH. */
  dexBin: z.string().optional(),
  /** Include completed (done) tasks in the board; default false. */
  showCompleted: z.boolean().optional(),
});
export type DexConfig = z.infer<typeof DexConfig>;

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

/** Where a project root's dex store lives. */
function storagePathOf(dir: string): string {
  return join(dir, ".dex", "tasks.jsonl");
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
        const dirs = cfg.dirs ?? [];

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
    }),
  },
});
