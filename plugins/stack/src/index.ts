/**
 * @perch/plugin-stack — the v1 Stack/PR plugin, built on GitHub's `gh stack`.
 *
 * M4 implements the `StackProvider` adapter + the `stack.view` read; M6 adds the
 * action wrappers (sync, submit, push, add, merge, checkout, link, unstack);
 * M7 adds the cross-machine + base-ref fallback provider.
 */
import { definePlugin } from "@perch/sdk";

export default definePlugin({
  id: "stack",
  capabilities: {
    // TODO(M4): "view" read — `gh stack view --json` joined with `gh pr list --json`.
    // TODO(M6): action wrappers.
  },
});
