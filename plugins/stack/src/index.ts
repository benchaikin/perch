/**
 * @perch/plugin-stack — the v1 Stack/PR plugin, built on GitHub's `gh stack`.
 *
 * M4 implements the `StackProvider` adapter + the `stack.view` read; M6 adds
 * the action wrappers (sync, submit, push, add, merge, checkout, link,
 * unstack); M7 adds the cross-machine + base-ref fallback provider.
 */
import { action, definePlugin, read, z } from "@perch/sdk";

import { ghStackProvider } from "./gh-provider.js";
import { StackGraph } from "./graph.js";
import { reposResult, ReposResult, resolveRepoCwd } from "./repos.js";
import { resolveStackView } from "./resolve-view.js";

export type { Exec, ExecOptions, MergeOptions, StackProvider, SyncResult } from "./provider.js";
export { ghStackProvider } from "./gh-provider.js";
export { baseRefProvider } from "./base-ref-provider.js";
export { resolveStackView } from "./resolve-view.js";
export { CiStatus, StackGraph, StackLayer } from "./graph.js";
export { RepoEntry, ReposResult, reposResult, resolveRepoCwd, toRepoEntries } from "./repos.js";

/**
 * Per-plugin config (spec §6). `repos` is an optional list of **local repo
 * paths** to target. A repo's display name is the basename of its path, and the
 * default repo is the first entry. When `repos` is absent/empty, the stack
 * plugin operates on `process.cwd()` (the daemon's launch dir) as before.
 */
const StackConfig = z.object({
  repos: z.array(z.string()).optional(),
});
type StackConfig = z.infer<typeof StackConfig>;

/**
 * Read the configured repo paths from a capability's `ctx.config`. The SDK types
 * `ctx.config` as `unknown` unless a capability pins its `Cfg`; pinning `Cfg`
 * fights the `.default({})` input schemas, so we narrow here instead. Returns
 * `undefined` (→ `process.cwd()` back-compat) when no repos are configured.
 */
function configRepos(config: unknown): string[] | undefined {
  if (config && typeof config === "object" && Array.isArray((config as StackConfig).repos)) {
    return (config as StackConfig).repos;
  }
  return undefined;
}

export default definePlugin({
  id: "stack",
  config: StackConfig,
  capabilities: {
    view: read({
      summary: "The current PR stack with per-layer CI & review status",
      // `.default({})` so the read is invocable with no args (e.g. `perch stack
      // view`): a bare invoke sends no input, which a required object would
      // reject even though every field is optional. `repo` selects a configured
      // repo by **name** or by **path**; omitted → the default (first) repo.
      input: z.object({ repo: z.string().optional() }).default({}),
      output: StackGraph,
      refresh: { every: "60s", on: ["focus"] },
      view: { kind: "graph", title: "Stack" },
      // The enriched stack read is where MCP earns its place: agents can read
      // live stack state (CI/review/needs-rebase) as a typed tool. Actions stay
      // MCP-off — agents drive `gh stack` directly (it ships its own skill).
      expose: { mcp: true },
      // Resolve the requested repo to a cwd and run `gh`/`git` there — that cwd
      // is the per-repo targeting mechanism. With no repos configured the cwd is
      // undefined and the providers run in `process.cwd()` (back-compat).
      //
      // Primary: `gh stack view`; falls back to reconstructing the stack from
      // open-PR base refs when gh-stack has no view (cross-machine / untracked).
      run: ({ input, ctx }) =>
        resolveStackView({
          cwd: resolveRepoCwd(configRepos(ctx.config), input?.repo),
          log: ctx.log,
        }),
    }),

    /**
     * The configured repos + the default, for the CLI/GUI repo switcher. Pure
     * config projection (no shelling out). Exposed on CLI + GUI but NOT MCP —
     * agents target repos via `gh -R`/cwd directly, not this read.
     */
    repos: read<void, ReposResult>({
      summary: "The configured stack repos and which one is the default",
      output: ReposResult,
      expose: { mcp: false },
      run: ({ ctx }) => reposResult(configRepos(ctx.config)),
    }),

    // ── M6 action wrappers (spec §8.3) ──
    // All actions render as CLI commands + GUI buttons automatically; none set
    // `expose.mcp` (defaults off) — agents drive `gh stack` directly per §8.3.
    // Each all-optional-input schema uses `.default({})` so the action is
    // invocable bare; with a defaulted object the inferred input type includes
    // `undefined`, so `run` reads fields via optional chaining (`input?.x`).
    //
    // Repo targeting: actions that accept a `repo` (sync/submit/push/merge)
    // resolve it to a cwd the same way `stack.view` does — `repo` selects a
    // configured repo by name or path, and the gh subcommand runs in that
    // repo's directory. Repo-agnostic actions (add/checkout/link/unstack) run in
    // the default repo's cwd when repos are configured, else `process.cwd()`.

    /**
     * Hero action: cascading rebase of the whole stack onto trunk. Unlike the
     * other mutations this returns nothing but logs whether a manual conflict
     * resolution is required (it never throws on conflict).
     */
    sync: action({
      summary: "Rebase the whole stack onto trunk (hero action; reports conflicts)",
      input: z.object({ repo: z.string().optional() }).default({}),
      view: { kind: "custom", title: "Sync" },
      run: async ({ input, ctx }) => {
        const cwd = resolveRepoCwd(configRepos(ctx.config), input?.repo);
        const result = await ghStackProvider({ cwd }).sync();
        if (result.conflict) {
          const where = result.needsResolution?.length
            ? ` (${result.needsResolution.join(", ")})`
            : "";
          ctx.log(`Sync stopped on a conflict — resolve manually, then re-run sync${where}.`);
        } else {
          ctx.log("Stack synced onto trunk.");
        }
      },
    }),

    submit: action({
      summary: "Push the stack and create/link its PRs (gh stack submit)",
      input: z.object({ repo: z.string().optional() }).default({}),
      run: ({ input, ctx }) =>
        ghStackProvider({ cwd: resolveRepoCwd(configRepos(ctx.config), input?.repo) }).submit(),
    }),

    push: action({
      summary: "Push the stack's branches (lighter than submit; gh stack push)",
      input: z.object({ repo: z.string().optional() }).default({}),
      run: ({ input, ctx }) =>
        ghStackProvider({ cwd: resolveRepoCwd(configRepos(ctx.config), input?.repo) }).push(),
    }),

    add: action({
      summary: "Add a new top layer to the stack (gh stack add)",
      input: z.object({ branch: z.string().optional() }).default({}),
      run: ({ input, ctx }) =>
        ghStackProvider({ cwd: resolveRepoCwd(configRepos(ctx.config), undefined) }).add(
          input?.branch,
        ),
    }),

    merge: action({
      summary: "Merge the stack bottom-up while CI is green (gh stack merge)",
      input: z.object({ repo: z.string().optional() }).default({}),
      run: ({ input, ctx }) =>
        ghStackProvider({ cwd: resolveRepoCwd(configRepos(ctx.config), input?.repo) }).merge({}),
    }),

    checkout: action({
      summary: "Check out a stack branch or PR number, hydrating local tracking",
      // Required: the branch name or PR number to check out.
      input: z.object({ ref: z.union([z.string(), z.number().int()]) }),
      run: ({ input, ctx }) =>
        ghStackProvider({ cwd: resolveRepoCwd(configRepos(ctx.config), undefined) }).checkout(
          input.ref,
        ),
    }),

    link: action({
      summary: "Create/update a server-side stack from refs (gh stack link)",
      // Required: one or more branch names or PR numbers to link into a stack.
      input: z.object({ refs: z.array(z.union([z.string(), z.number().int()])).min(1) }),
      run: ({ input, ctx }) =>
        ghStackProvider({ cwd: resolveRepoCwd(configRepos(ctx.config), undefined) }).link(
          input.refs,
        ),
    }),

    unstack: action({
      summary: "Delete the stack locally and on GitHub (gh stack unstack)",
      input: z.object({}).default({}),
      run: ({ ctx }) =>
        ghStackProvider({ cwd: resolveRepoCwd(configRepos(ctx.config), undefined) }).unstack(),
    }),
  },
});
