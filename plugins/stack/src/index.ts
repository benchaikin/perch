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
import { resolveStackView } from "./resolve-view.js";

export type { Exec, MergeOptions, StackProvider, SyncResult } from "./provider.js";
export { ghStackProvider } from "./gh-provider.js";
export { baseRefProvider } from "./base-ref-provider.js";
export { resolveStackView } from "./resolve-view.js";
export { CiStatus, StackGraph, StackLayer } from "./graph.js";

/** Per-plugin config: an optional allow-list of `owner/name` repos (spec §6). */
const StackConfig = z.object({
  repos: z.array(z.string()).optional(),
});
type StackConfig = z.infer<typeof StackConfig>;

export default definePlugin({
  id: "stack",
  config: StackConfig,
  capabilities: {
    view: read({
      summary: "The current PR stack with per-layer CI & review status",
      // `.default({})` so the read is invocable with no args (e.g. `perch stack
      // view`): a bare invoke sends no input, which a required object would
      // reject even though every field is optional.
      input: z.object({ repo: z.string().optional() }).default({}),
      output: StackGraph,
      refresh: { every: "60s", on: ["focus"] },
      view: { kind: "graph", title: "Stack" },
      // Primary: `gh stack view`; falls back to reconstructing the stack from
      // open-PR base refs when gh-stack has no view (cross-machine / untracked).
      run: ({ input, ctx }) => resolveStackView({ repo: input?.repo, log: ctx.log }),
    }),

    // ── M6 action wrappers (spec §8.3) ──
    // All actions render as CLI commands + GUI buttons automatically; none set
    // `expose.mcp` (defaults off) — agents drive `gh stack` directly per §8.3.
    // Each all-optional-input schema uses `.default({})` so the action is
    // invocable bare; with a defaulted object the inferred input type includes
    // `undefined`, so `run` reads fields via optional chaining (`input?.x`).

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
        const result = await ghStackProvider().sync(input?.repo);
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
      run: ({ input }) => ghStackProvider().submit(input?.repo),
    }),

    push: action({
      summary: "Push the stack's branches (lighter than submit; gh stack push)",
      input: z.object({ repo: z.string().optional() }).default({}),
      run: ({ input }) => ghStackProvider().push(input?.repo),
    }),

    add: action({
      summary: "Add a new top layer to the stack (gh stack add)",
      input: z.object({ branch: z.string().optional() }).default({}),
      run: ({ input }) => ghStackProvider().add(input?.branch),
    }),

    merge: action({
      summary: "Merge the stack bottom-up while CI is green (gh stack merge)",
      input: z.object({ repo: z.string().optional() }).default({}),
      run: ({ input }) => ghStackProvider().merge({ repo: input?.repo }),
    }),

    checkout: action({
      summary: "Check out a stack branch or PR number, hydrating local tracking",
      // Required: the branch name or PR number to check out.
      input: z.object({ ref: z.union([z.string(), z.number().int()]) }),
      run: ({ input }) => ghStackProvider().checkout(input.ref),
    }),

    link: action({
      summary: "Create/update a server-side stack from refs (gh stack link)",
      // Required: one or more branch names or PR numbers to link into a stack.
      input: z.object({ refs: z.array(z.union([z.string(), z.number().int()])).min(1) }),
      run: ({ input }) => ghStackProvider().link(input.refs),
    }),

    unstack: action({
      summary: "Delete the stack locally and on GitHub (gh stack unstack)",
      input: z.object({}).default({}),
      run: () => ghStackProvider().unstack(),
    }),
  },
});
