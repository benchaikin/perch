/**
 * @perch/plugin-worktrees — surfaces the repo's git worktrees as the
 * subscribable `worktrees.list` read, so a developer running multiple AI agents
 * in parallel worktrees can glance at each one's branch, dirtiness, and
 * ahead/behind state — and spot conflicts before they merge.
 *
 * Data: `git worktree list --porcelain` (the worktree set) + a per-worktree
 * `git status --porcelain=v2 --branch` (dirty count, conflicts, ahead/behind).
 * The read never throws: a non-git directory or git failure degrades to an empty
 * list, so the section simply hides.
 *
 * Repo roots are resolved by precedence: the per-plugin `repoRoot` override (a
 * single root, back-compat) wins; else the shared `global.repos` list (enumerate
 * worktrees across every repo); else the daemon's cwd (the original default). A
 * failing root contributes nothing rather than failing the whole list, and each
 * row is tagged with its source repo so the panel can group by it.
 */
import { basename } from "node:path";
import type { spawn as nodeSpawn } from "node:child_process";

import {
  action,
  definePlugin,
  read,
  reposOf,
  spawnInTerminal,
  terminalConfigOf,
  validateSettingsDescriptor,
  z,
} from "@perch/sdk";

import {
  buildWorktrees,
  mergeWorktrees,
  parseDexTaskId,
  parseStatus,
  parseWorktreeList,
  Worktrees,
  type WorktreeStatus,
} from "./parse.js";
import { buildShellInDir } from "./open.js";
import { worktreeNotifications } from "./notify.js";
import { WorktreesProvider, type Exec } from "./provider.js";

export {
  buildWorktree,
  buildWorktrees,
  mergeWorktrees,
  parseDexTaskId,
  parseStatus,
  parseWorktreeList,
  Worktree,
  Worktrees,
  worktreeHealth,
} from "./parse.js";
export type { RawWorktree, WorktreeHealth, WorktreeStatus } from "./parse.js";
export { buildShellInDir } from "./open.js";
export { worktreeNotifications } from "./notify.js";
export { WorktreesProvider } from "./provider.js";
export type { Exec } from "./provider.js";

/** Per-plugin config (`plugins.worktrees`). All optional. */
const WorktreesConfig = z.object({
  /**
   * Single repo root to enumerate worktrees from — an override that, when set,
   * pins the list to this one repo (back-compat). When unset, the plugin uses
   * the shared `global.repos` list (all repos), or the daemon's cwd if that's
   * empty too.
   */
  repoRoot: z.string().optional(),
  /** Path to the `git` binary; defaults to `git` on PATH. */
  gitBin: z.string().optional(),
  /** Include the repo's main worktree in the list (default true). */
  showMain: z.boolean().optional(),
});
export type WorktreesConfig = z.infer<typeof WorktreesConfig>;

/** Narrow `ctx.config` (typed `unknown` by the SDK) to {@link WorktreesConfig}; {} on miss. */
function configOf(config: unknown): WorktreesConfig {
  const parsed = WorktreesConfig.safeParse(config);
  return parsed.success ? parsed.data : {};
}

/** A repo root to enumerate, paired with its display tag (basename, or undefined for cwd). */
export interface RepoRoot {
  /** The directory to run `git worktree list` in; `undefined` means the daemon cwd. */
  root: string | undefined;
  /** The `repo` tag for that root's rows (basename); `undefined` for the cwd default. */
  tag: string | undefined;
}

/**
 * Resolve the effective repo roots, by precedence:
 *   1. `cfg.repoRoot` (the override) → that single root, untagged (one repo).
 *   2. else `global.repos` (shared list) → every repo, each tagged by basename.
 *   3. else the daemon cwd → a single, untagged root (the original default).
 */
export function resolveRepoRoots(cfg: WorktreesConfig, global: unknown): RepoRoot[] {
  if (cfg.repoRoot) return [{ root: cfg.repoRoot, tag: undefined }];
  const repos = reposOf(global);
  if (repos.length > 0) return repos.map((root) => ({ root, tag: basename(root) }));
  return [{ root: undefined, tag: undefined }];
}

/**
 * Test seam for the git runner. `ctx` carries no exec, so tests override this to
 * feed fixture stdout without spawning git. Defaults to the real runner.
 */
let execOverride: Exec | undefined;

/** Inject an `exec` stub for `worktrees.list` (tests only); pass `undefined` to reset. */
export function __setExec(exec: Exec | undefined): void {
  execOverride = exec;
}

/** Test seam for the open action's spawn (tests only); pass `undefined` to reset. */
let openSpawn: typeof nodeSpawn | undefined;
export function __setOpenSpawn(spawnFn: typeof nodeSpawn | undefined): void {
  openSpawn = spawnFn;
}

/** A small {ok, message} result, mirroring the services actions. */
const OpenInput = z.object({ path: z.string() });

/**
 * Input for the `remove` action: the worktree `path` to drop, plus an optional
 * `force` for a dirty/conflicted/locked tree (git refuses to remove one without
 * it). The GUI computes `force` from the row and warns before passing it.
 */
const RemoveInput = z.object({ path: z.string(), force: z.boolean().optional() });

/** Surface git's own error text (its stderr) over the generic exec wrapper message. */
function gitErrorMessage(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
  return stderr || e.message || String(err);
}

export default definePlugin({
  id: "worktrees",
  name: "Worktrees",
  config: WorktreesConfig,
  settings: validateSettingsDescriptor([
    {
      key: "showMain",
      type: "boolean",
      label: "Show main worktree",
      description: "Include the repository's primary worktree in the list.",
      default: true,
    },
  ]),
  capabilities: {
    /**
     * The repo's worktrees with per-tree dirtiness + ahead/behind. Subscribable
     * + polled (10s) and refreshed on focus, mirroring `services.list`. Exposed
     * on MCP so an agent can read "which worktrees have conflicts?". Never throws.
     */
    list: read({
      summary: "Git worktrees with branch, dirty state, and ahead/behind",
      input: z.object({}).default({}),
      output: Worktrees,
      // Background (panel-closed) polling drops to 60s — worktree state barely
      // changes when nobody's acting on it.
      refresh: { every: "10s", idleEvery: "60s", on: ["focus"] },
      view: { kind: "list", title: "Worktrees" },
      expose: { mcp: true },
      run: async ({ ctx }): Promise<Worktrees> => {
        const cfg = configOf(ctx.config);
        const provider = new WorktreesProvider(cfg.gitBin ?? "git", { exec: execOverride });
        const roots = resolveRepoRoots(cfg, ctx.global);

        // Build one board per repo root; a non-git / failing root contributes
        // nothing (logged + skipped) rather than failing the whole list.
        const boardFor = async ({ root, tag }: RepoRoot): Promise<Worktrees> => {
          let listing: string;
          try {
            listing = await provider.listRaw(root);
          } catch (err) {
            ctx.log(`worktrees.list: git worktree list failed for ${root ?? "cwd"}: ${String(err)}`);
            return { worktrees: [] };
          }
          const raws = parseWorktreeList(listing);
          // Per-worktree status + dex task id, bounded by the worktree count
          // (typically a handful). The task id resolves to the worktree-local
          // `perch.dexTask` config when set, else the `dex/<id>` branch parse.
          const statusByPath = new Map<string, WorktreeStatus>();
          const taskIdByPath = new Map<string, string | undefined>();
          await Promise.all(
            raws
              .filter((r) => !r.bare)
              .map(async (r) => {
                const [status, config] = await Promise.all([
                  provider.statusRaw(r.path),
                  provider.configRaw(r.path),
                ]);
                statusByPath.set(r.path, parseStatus(status));
                taskIdByPath.set(r.path, config || parseDexTaskId(r.branch));
              }),
          );
          return buildWorktrees(raws, statusByPath, tag, taskIdByPath);
        };

        const board = mergeWorktrees(await Promise.all(roots.map(boardFor)));
        // Optionally hide each repo's main worktree (the dir its daemon runs from).
        if (cfg.showMain === false) {
          return { worktrees: board.worktrees.filter((w) => !w.main) };
        }
        return board;
      },
      // Announce a worktree that newly conflicted, or one that just appeared.
      notify: ({ prev, next }) => worktreeNotifications(prev, next),
    }),

    /**
     * Open the user's terminal-of-choice (the global setting) cd'd into the
     * worktree directory. Fire-and-forget; MCP-exposed so an agent can drop a
     * human into a worktree. Returns a small {ok, message}.
     */
    open: action<z.infer<typeof OpenInput>, unknown, { ok: boolean; message: string }>({
      summary: "Open a terminal in a worktree directory",
      input: OpenInput,
      expose: { mcp: true },
      run: ({ input, ctx }) => {
        const name = input.path.split("/").filter(Boolean).pop() ?? input.path;
        return spawnInTerminal({
          command: buildShellInDir(input.path),
          terminal: terminalConfigOf(ctx.global),
          label: `worktree ${name}`,
          // Key the window to this worktree so a jump raises a session already
          // running here (e.g. a live agent spawned by `dex.spawn`) instead of
          // opening a fresh shell that disconnects from it; falls back to a new
          // window when none is found (or the terminal has no focus hook).
          focusMarker: input.path,
          log: ctx.log,
          spawn: openSpawn,
        });
      },
    }),

    /**
     * Remove a single worktree (`git worktree remove`). MCP-exposed so an agent
     * can clean up an abandoned tree. Removes ONLY the worktree directory — it
     * never deletes the `dex/<id>` branch or completes the linked task (that's
     * land-dex's job). `force` drops a dirty/conflicted/locked tree; the GUI
     * warns before setting it. Returns a small {ok, message}: a git failure
     * (e.g. the main worktree, or an unforced dirty tree) degrades to
     * `{ ok:false, message }` rather than throwing.
     */
    remove: action<z.infer<typeof RemoveInput>, unknown, { ok: boolean; message: string }>({
      summary: "Remove a git worktree (force discards uncommitted changes)",
      input: RemoveInput,
      expose: { mcp: true },
      run: async ({ input, ctx }) => {
        const cfg = configOf(ctx.config);
        const provider = new WorktreesProvider(cfg.gitBin ?? "git", { exec: execOverride });
        const name = input.path.split("/").filter(Boolean).pop() ?? input.path;
        try {
          await provider.removeRaw(input.path, { force: input.force });
          return { ok: true, message: `Removed worktree ${name}.` };
        } catch (err) {
          ctx.log(`worktrees.remove: git worktree remove failed for ${input.path}: ${String(err)}`);
          return {
            ok: false,
            message: `Couldn't remove worktree ${name}: ${gitErrorMessage(err)}`,
          };
        }
      },
    }),
  },
});
