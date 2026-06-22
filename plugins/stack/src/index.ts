/**
 * @perch/plugin-stack — the v1 Stack/PR plugin, built on GitHub's `gh stack`.
 *
 * M4 implements the `StackProvider` adapter + the `stack.view` read; M6 adds
 * the action wrappers (sync, submit, push, add, merge, checkout, link,
 * unstack); M7 adds the cross-machine + base-ref fallback provider.
 */
import {
  action,
  agentConfigOf,
  definePlugin,
  read,
  reposOf,
  terminalConfigOf,
  validateSettingsDescriptor,
  z,
} from "@perch/sdk";

import { ghStackProvider } from "./gh-provider.js";
import { StackGraph } from "./graph.js";
import { prNotifications } from "./notify.js";
import { runOpenAgent, type OpenAgentInput, type OpenAgentResult } from "./open-agent.js";
import { buildPrOverview, PrOverview, type StackDirection } from "./prs.js";
import { reposResult, ReposResult, resolveRepoCwd } from "./repos.js";
import {
  runResolveConflicts,
  type ResolveConflictsInput,
  type ResolveConflictsResult,
} from "./resolve-conflicts.js";
import { resolveStackView } from "./resolve-view.js";

export type {
  Exec,
  ExecOptions,
  MergeMethod,
  MergeOptions,
  MergePrOptions,
  StackProvider,
  SyncResult,
} from "./provider.js";
export { ghStackProvider } from "./gh-provider.js";
export { baseRefProvider } from "./base-ref-provider.js";
export { resolveStackView } from "./resolve-view.js";
export {
  runResolveConflicts,
  type ResolveConflictsInput,
  type ResolveConflictsResult,
} from "./resolve-conflicts.js";
export { runOpenAgent, type OpenAgentInput, type OpenAgentResult } from "./open-agent.js";
export {
  parseWorktreeForBranch,
  resolveOrCreateWorktree,
  sanitizeBranchForPath,
  worktreeAddArgs,
  worktreeListArgs,
  worktreePathFor,
  type WorktreeDeps,
  type WorktreeResolution,
} from "./worktree.js";
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
  /**
   * Logins to treat as non-human when counting inline review comments — the
   * escape hatch for AI reviewers (CodeRabbit/Copilot/Sonar) that post as
   * ordinary accounts rather than as a GitHub App (GitHub Apps / `[bot]` logins
   * are always excluded regardless). Feeds the "review comments to address"
   * badge + notification.
   *
   * TODO: could become a user-facing settings *field* once the settings
   * descriptor types support arrays/lists — today they're only enum/boolean/
   * string/number, so this stays config-only (`plugins.stack.reviewBotIgnore`).
   */
  reviewBotIgnore: z.array(z.string()).optional(),
  /**
   * Strategy for the per-PR `merge-pr` action (`gh pr merge --<method>`).
   * Defaults to `squash` (linear trunk history). Distinct from the stack-wide
   * `merge`, which delegates the strategy to `gh stack merge`.
   */
  mergeMethod: z.enum(["squash", "merge", "rebase"]).default("squash"),
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
 * Resolve the **effective** repo list with cross-plugin precedence, given a
 * capability's `ctx.config` + `ctx.global`:
 *
 * 1. `plugins.stack.repos` if set and non-empty → the plugin-local **override**.
 * 2. else the shared `global.repos` list (via {@link reposOf}) if non-empty.
 * 3. else `undefined` → the `process.cwd()` single-repo back-compat fallback.
 *
 * Computed here (where `ctx` is in hand) and threaded down to the pure helpers
 * (`resolveRepoCwd`/`reposResult`/`buildPrOverview`), so those stay pure and the
 * `stack.repos` read reflects the same list the actions target.
 */
function effectiveRepos(config: unknown, global: unknown): string[] | undefined {
  const override = configRepos(config);
  if (override && override.length > 0) {
    return override;
  }
  const shared = reposOf(global);
  return shared.length > 0 ? shared : undefined;
}

/**
 * Read the configured review-bot ignore-list from a capability's `ctx.config`
 * (logins to treat as non-human when counting inline review comments). Narrowed
 * locally for the same reason as {@link configRepos}; `undefined`/malformed → no
 * extra logins ignored (bots are still filtered).
 */
function configReviewBotIgnore(config: unknown): string[] | undefined {
  if (
    config &&
    typeof config === "object" &&
    Array.isArray((config as StackConfig).reviewBotIgnore)
  ) {
    return (config as StackConfig).reviewBotIgnore;
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

/**
 * Read the resolved per-PR merge strategy from a capability's `ctx.config`,
 * defaulting to `"squash"` when unset or malformed. Narrowed locally for the
 * same reason as {@link configRepos}.
 */
function configMergeMethod(config: unknown): "squash" | "merge" | "rebase" {
  if (config && typeof config === "object") {
    const value = (config as StackConfig).mergeMethod;
    if (value === "squash" || value === "merge" || value === "rebase") {
      return value;
    }
  }
  return "squash";
}

/** Best-effort message from a rejected `gh` invocation (carries gh's stderr). */
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
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
    {
      key: "mergeMethod",
      type: "enum",
      label: "Merge method",
      description:
        "How the per-PR Merge button merges a mergeable PR (gh pr merge). Squash keeps trunk history linear.",
      default: "squash",
      options: [
        { value: "squash", label: "Squash" },
        { value: "merge", label: "Merge commit" },
        { value: "rebase", label: "Rebase" },
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
          cwd: resolveRepoCwd(effectiveRepos(ctx.config, ctx.global), input?.repo),
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
      run: ({ ctx }) => reposResult(effectiveRepos(ctx.config, ctx.global)),
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
      // Background (panel-closed) polling drops to 5min: PR status changes don't
      // need 60s resolution when nobody's looking, and it frees API headroom.
      refresh: { every: "60s", idleEvery: "300s", on: ["focus"] },
      view: { kind: "list", title: "My PRs" },
      expose: { mcp: true },
      run: ({ ctx }) =>
        buildPrOverview({
          repos: effectiveRepos(ctx.config, ctx.global),
          stackDirection: configStackDirection(ctx.config),
          reviewBotIgnore: configReviewBotIgnore(ctx.config),
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
        const cwd = resolveRepoCwd(effectiveRepos(ctx.config, ctx.global), input?.repo);
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

    /**
     * Spin up an agent to resolve a conflicting PR's merge conflict — the
     * complement of `sync`, which deliberately stops on a conflict. Checks out
     * the PR's existing head branch in a worktree (reusing one already checked
     * out, e.g. a dex-spawned PR) and launches a seeded `claude` to rebase onto
     * the base, resolve, verify, and push. Perch never auto-merges; this only
     * clears the conflict so the user can merge once the PR is green.
     *
     * The worktree lives next to the repo (`<repo>-worktrees/<branch>`), so the
     * repo's directory — not just `gh`'s cwd — is needed; we resolve it the same
     * way `stack.view` does, falling back to `process.cwd()` when no repos are
     * configured. MCP stays off (matching the other actions; agents drive git
     * directly).
     */
    "resolve-conflicts": action<ResolveConflictsInput, StackConfig, ResolveConflictsResult>({
      summary: "Spin up an agent to resolve a conflicting PR's merge conflict",
      // `headRefName` is required (the branch to fix); the rest are optional.
      input: z.object({
        repo: z.string().optional(),
        headRefName: z.string(),
        baseRefName: z.string().optional(),
        number: z.number().int().optional(),
      }),
      run: ({ input, ctx }): Promise<ResolveConflictsResult> => {
        const cwd = resolveRepoCwd(effectiveRepos(ctx.config, ctx.global), input.repo);
        return runResolveConflicts(input, {
          repoDir: cwd ?? process.cwd(),
          gitBin: "git",
          terminal: terminalConfigOf(ctx.global),
          agent: agentConfigOf(ctx.global),
          log: ctx.log,
        });
      },
    }),

    /**
     * Open a free-form Claude agent session on a PR's branch — the agenda-free
     * sibling of `resolve-conflicts`. Checks out the PR's head branch in a
     * worktree (reusing one already checked out, e.g. a dex-spawned PR or one
     * whose conflicts were resolved) and launches `claude --permission-mode auto`
     * with NO seed prompt, dropping straight into a live interactive session for
     * ad-hoc work. General-purpose: available on every PR, not just conflicting
     * ones.
     *
     * Resolves the repo's directory the same way `stack.view`/`resolve-conflicts`
     * do (the worktree lives at `<repo>-worktrees/<branch>`), falling back to
     * `process.cwd()` when no repos are configured. MCP stays off (matching the
     * other actions; agents drive git directly).
     */
    "open-agent": action<OpenAgentInput, StackConfig, OpenAgentResult>({
      summary: "Open a free-form Claude agent session on a PR's branch (auto mode, no prompt)",
      // `headRefName` is required (the branch to open on); the rest are optional.
      input: z.object({
        repo: z.string().optional(),
        headRefName: z.string(),
        number: z.number().int().optional(),
      }),
      run: ({ input, ctx }): Promise<OpenAgentResult> => {
        const cwd = resolveRepoCwd(effectiveRepos(ctx.config, ctx.global), input.repo);
        return runOpenAgent(input, {
          repoDir: cwd ?? process.cwd(),
          gitBin: "git",
          terminal: terminalConfigOf(ctx.global),
          agent: agentConfigOf(ctx.global),
          log: ctx.log,
        });
      },
    }),

    submit: action({
      summary: "Push the stack and create/link its PRs (gh stack submit)",
      input: z.object({ repo: z.string().optional() }).default({}),
      run: ({ input, ctx }) =>
        ghStackProvider({
          cwd: resolveRepoCwd(effectiveRepos(ctx.config, ctx.global), input?.repo),
        }).submit(),
    }),

    push: action({
      summary: "Push the stack's branches (lighter than submit; gh stack push)",
      input: z.object({ repo: z.string().optional() }).default({}),
      run: ({ input, ctx }) =>
        ghStackProvider({
          cwd: resolveRepoCwd(effectiveRepos(ctx.config, ctx.global), input?.repo),
        }).push(),
    }),

    add: action({
      summary: "Add a new top layer to the stack (gh stack add)",
      input: z.object({ branch: z.string().optional() }).default({}),
      run: ({ input, ctx }) =>
        ghStackProvider({
          cwd: resolveRepoCwd(effectiveRepos(ctx.config, ctx.global), undefined),
        }).add(input?.branch),
    }),

    merge: action({
      summary: "Merge the stack bottom-up while CI is green (gh stack merge)",
      input: z.object({ repo: z.string().optional() }).default({}),
      run: ({ input, ctx }) =>
        ghStackProvider({
          cwd: resolveRepoCwd(effectiveRepos(ctx.config, ctx.global), input?.repo),
        }).merge({}),
    }),

    /**
     * Merge ONE mergeable PR by number (`gh pr merge --<method>`) — the per-PR
     * complement of the stack-wide `merge` (`gh stack merge`, bottom-up). The
     * natural completion of the My PRs row workflow: a standalone green/approved
     * PR gets a one-click merge, where `resolve-conflicts` only clears the
     * conflict so the user *can* merge.
     *
     * Deliberately single-PR and number-keyed — NOT for stacked layers, which
     * must merge bottom-up via `stack.merge`; the GUI only offers this button on
     * standalone PRs. The merge's own server-side mergeability check is the
     * authority: `gh pr merge` exits non-zero (→ `{ ok:false }`) when the PR is
     * not mergeable, checks are pending, or branch protection rejects it, so a
     * stale panel can't force a bad merge. MCP stays off (agents drive `gh`).
     */
    "merge-pr": action({
      summary: "Merge a single mergeable PR by number (gh pr merge)",
      // A merge is the front of the land→reap→auto-spawn chain; poke the daemon's
      // land janitor so it runs immediately instead of at its next poll.
      invalidates: ["dex.land"],
      // `number` is required (the PR to merge); `headRefName` is accepted for
      // parity with the other per-PR actions (the GUI passes it) but the merge
      // keys off `number`.
      input: z.object({
        repo: z.string().optional(),
        number: z.number().int(),
        headRefName: z.string().optional(),
      }),
      run: async ({ input, ctx }) => {
        const cwd = resolveRepoCwd(effectiveRepos(ctx.config, ctx.global), input.repo);
        const method = configMergeMethod(ctx.config);
        try {
          await ghStackProvider({ cwd }).mergePr({ number: input.number, method });
          const message = `Merged PR #${input.number} (${method}).`;
          ctx.log(message);
          return { ok: true, message };
        } catch (err) {
          // gh's stderr explains the rejection (not mergeable, pending checks,
          // branch protection, needs review) — surface it verbatim.
          const message = `Couldn't merge PR #${input.number}: ${errorMessage(err)}`;
          ctx.log(message);
          return { ok: false, message };
        }
      },
    }),

    checkout: action({
      summary: "Check out a stack branch or PR number, hydrating local tracking",
      // Required: the branch name or PR number to check out.
      input: z.object({ ref: z.union([z.string(), z.number().int()]) }),
      run: ({ input, ctx }) =>
        ghStackProvider({
          cwd: resolveRepoCwd(effectiveRepos(ctx.config, ctx.global), undefined),
        }).checkout(input.ref),
    }),

    link: action({
      summary: "Create/update a server-side stack from refs (gh stack link)",
      // Required: one or more branch names or PR numbers to link into a stack.
      input: z.object({ refs: z.array(z.union([z.string(), z.number().int()])).min(1) }),
      run: ({ input, ctx }) =>
        ghStackProvider({
          cwd: resolveRepoCwd(effectiveRepos(ctx.config, ctx.global), undefined),
        }).link(input.refs),
    }),

    unstack: action({
      summary: "Delete the stack locally and on GitHub (gh stack unstack)",
      input: z.object({}).default({}),
      run: ({ ctx }) =>
        ghStackProvider({
          cwd: resolveRepoCwd(effectiveRepos(ctx.config, ctx.global), undefined),
        }).unstack(),
    }),
  },
});
