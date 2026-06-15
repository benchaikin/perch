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
 */
import { definePlugin, read, z } from "@perch/sdk";

import { buildWorktrees, parseStatus, parseWorktreeList, Worktrees, type WorktreeStatus } from "./parse.js";
import { WorktreesProvider, type Exec } from "./provider.js";

export {
  buildWorktree,
  buildWorktrees,
  parseStatus,
  parseWorktreeList,
  Worktree,
  Worktrees,
  worktreeHealth,
} from "./parse.js";
export type { RawWorktree, WorktreeHealth, WorktreeStatus } from "./parse.js";
export { WorktreesProvider } from "./provider.js";
export type { Exec } from "./provider.js";

/** Per-plugin config (`plugins.worktrees`). All optional. */
const WorktreesConfig = z.object({
  /** Repo root to enumerate worktrees from; defaults to the daemon's cwd. */
  repoRoot: z.string().optional(),
  /** Path to the `git` binary; defaults to `git` on PATH. */
  gitBin: z.string().optional(),
});
export type WorktreesConfig = z.infer<typeof WorktreesConfig>;

/** Narrow `ctx.config` (typed `unknown` by the SDK) to {@link WorktreesConfig}; {} on miss. */
function configOf(config: unknown): WorktreesConfig {
  const parsed = WorktreesConfig.safeParse(config);
  return parsed.success ? parsed.data : {};
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

export default definePlugin({
  id: "worktrees",
  name: "Worktrees",
  config: WorktreesConfig,
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
      refresh: { every: "10s", on: ["focus"] },
      view: { kind: "list", title: "Worktrees" },
      expose: { mcp: true },
      run: async ({ ctx }): Promise<Worktrees> => {
        const cfg = configOf(ctx.config);
        const provider = new WorktreesProvider(cfg.gitBin ?? "git", { exec: execOverride });
        let listing: string;
        try {
          listing = await provider.listRaw(cfg.repoRoot);
        } catch (err) {
          ctx.log(`worktrees.list: git worktree list failed: ${String(err)}`);
          return { worktrees: [] };
        }
        const raws = parseWorktreeList(listing);
        // Per-worktree status, bounded by the worktree count (typically a handful).
        const statusByPath = new Map<string, WorktreeStatus>();
        await Promise.all(
          raws
            .filter((r) => !r.bare)
            .map(async (r) => {
              statusByPath.set(r.path, parseStatus(await provider.statusRaw(r.path)));
            }),
        );
        return buildWorktrees(raws, statusByPath);
      },
    }),
  },
});
