/**
 * @perch/plugin-stack — the v1 Stack/PR plugin, built on GitHub's `gh stack`.
 *
 * M4 implements the `StackProvider` adapter + the `stack.view` read; M6 adds
 * the action wrappers (sync, submit, push, add, merge, checkout, link,
 * unstack); M7 adds the cross-machine + base-ref fallback provider.
 */
import { definePlugin, read, z } from "@perch/sdk";

import { ghStackProvider } from "./gh-provider.js";
import { StackGraph } from "./graph.js";

export type { Exec, MergeOptions, StackProvider, SyncResult } from "./provider.js";
export { ghStackProvider } from "./gh-provider.js";
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
      run: ({ input }) => ghStackProvider().view(input?.repo),
    }),
    // TODO(M6): action wrappers (sync, submit, push, add, merge, checkout, link, unstack).
  },
});
