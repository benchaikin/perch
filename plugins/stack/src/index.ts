/**
 * @perch/plugin-stack — the v1 Stack/PR plugin, built on GitHub's `gh stack`.
 *
 * M4 implements the `StackProvider` adapter + the `stack.view` read; M6 adds
 * the action wrappers (sync, submit, push, add, merge, checkout, link,
 * unstack); M7 adds the cross-machine + base-ref fallback provider.
 */
import { action, definePlugin, read, validateSettingsDescriptor, z } from "@perch/sdk";

import { ghStackProvider } from "./gh-provider.js";
import { StackGraph } from "./graph.js";
import { prNotifications } from "./notify.js";
import { buildPrOverview, PrOverview, type StackDirection } from "./prs.js";
import { reposResult, ReposResult, resolveRepoCwd } from "./repos.js";
import { resolveStackView } from "./resolve-view.js";

export type { Exec, ExecOptions, MergeOptions, StackProvider, SyncResult } from "./provider.js";
export { ghStackProvider } from "./gh-provider.js";
export { baseRefProvider } from "./base-ref-provider.js";
export { resolveStackView } from "./resolve-view.js";
export { CiStatus, StackGraph, StackLayer } from "./graph.js";
export { allChains, chainContaining } from "./chains.js";
export { prNotifications } from "./notify.js";
export { buildPrOverview, PrGroup, PrInfo, PrOverview, PrRepo, StackDirection } from "./prs.js";
export { RepoEntry, ReposResult, reposResult, resolveRepoCwd, toRepoEntries } from "./repos.js";

/**
 * Per-plugin config (spec §6). `repos` is an optional list of **local repo
 * paths** to target. A repo's display name is the basename of its path, and the
 * default repo is the first entry. When `repos` is absent/empty, the stack
 * plugin operates on `process.cwd()` (the daemon's launch dir) as before.
 *
 * `stackDirection` controls how the GUI orders a stack's layers for display.
 * The underlying data is always sourced bottom → top (trunk-adjacent base
 * first); this is purely a presentation choice. `bottom-to-top` (the default,
 * = today's behavior) reads the base #1 at the top; `top-to-bottom` reverses
 * the rendered rows so the tip reads at the top.
 */
const StackConfig = z.object({
  repos: z.array(z.string()).optional(),
  stackDirection: z.enum(["bottom-to-top", "top-to-bottom"]).default("bottom-to-top"),
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

/**
 * Read the resolved {@link StackDirection} from a capability's `ctx.config`,
 * defaulting to `"bottom-to-top"` (today's behavior) when unset or malformed.
 * Narrowed locally for the same reason as {@link configRepos}.
 */
function configStackDirection(config: unknown): StackDirection {
  if (config && typeof config === "object") {
    const value = (config as StackConfig).stackDirection;
    if (value === "bottom-to-top" || value === "top-to-bottom") {
      return value;
    }
  }
  return "bottom-to-top";
}

export default definePlugin({
  id: "stack",
  name: "Stack",
  config: StackConfig,
  // User-facing settings rendered by the generic settings panel (M2). Validated
  // at module load so a malformed descriptor surfaces immediately. The keys map
  // onto `plugins.stack.*` config; `stackDirection` mirrors the config enum.
  settings: validateSettingsDescriptor([
    {
      key: "stackDirection",
      type: "enum",
      label: "Stack order",
      description:
        "How stacks are ordered in the My PRs panel: the trunk-adjacent base PR at the top, or the tip at the top. The topmost layer is always #1.",
      default: "bottom-to-top",
      options: [
        { value: "bottom-to-top", label: "Base at top" },
        { value: "top-to-bottom", label: "Tip at top" },
      ],
    },
  ]),
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

    /**
     * The cross-repo "My PRs" overview: every configured repo's open PRs
     * (authored by the current user), with stacked PRs grouped together (spec
     * `docs/prs-view.md`). Best-effort per repo — one repo's failure doesn't
     * fail the whole overview.
     *
     * Opted into MCP: the cross-repo "my PRs + status" read is high-value for
     * agents (a single typed answer to "what are my open PRs and are they
     * green?" spanning all repos).
     */
    prs: read({
      summary: "Your open PRs across all configured repos, with stacks grouped",
      input: z.object({}).default({}),
      output: PrOverview,
      refresh: { every: "60s", on: ["focus"] },
      view: { kind: "list", title: "My PRs" },
      expose: { mcp: true },
      run: ({ ctx }) =>
        buildPrOverview({
          repos: configRepos(ctx.config),
          stackDirection: configStackDirection(ctx.config),
          log: ctx.log,
        }),
      // Diff each poll's overview against the previous one and surface notable PR
      // transitions (CI/review/conflict/rebase/opened/closed) as notifications.
      // The hook's `prev`/`next` carry the schema's *input* type (defaulted
      // fields optional); `PrOverview.parse` normalizes them to the strict
      // output shape `prNotifications` diffs over.
      notify: ({ prev, next }) =>
        prNotifications(
          prev === undefined ? undefined : PrOverview.parse(prev),
          PrOverview.parse(next),
        ),
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
          const message = `Sync stopped on a conflict — resolve manually, then re-run sync${where}.`;
          ctx.log(message);
          return { ok: false, conflict: true, message };
        }
        const message = "Stack synced onto trunk.";
        ctx.log(message);
        return { ok: true, conflict: false, message };
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
