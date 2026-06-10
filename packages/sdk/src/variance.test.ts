import test from "node:test";
import assert from "node:assert/strict";
import { definePlugin, read, action, z } from "./index.js";

// Regression guard for the `Capability` variance fix: precisely-typed `read`
// and `action` definitions (with concrete input/output schemas) must compose in
// a single `capabilities` map WITHOUT casts. If `Capability` regresses to an
// invariant element type, this file fails to type-check (and the build breaks).
test("typed capabilities compose in one plugin without casts", () => {
  const plugin = definePlugin({
    id: "demo",
    config: z.object({ repo: z.string().optional() }),
    capabilities: {
      view: read({
        summary: "list things",
        input: z.object({ state: z.enum(["open", "all"]) }),
        output: z.array(z.string()),
        run: ({ input }) => [input.state],
      }),
      doit: action({
        summary: "do a thing",
        input: z.object({ n: z.number() }),
        run: ({ input }) => {
          void input.n;
        },
      }),
    },
  });

  assert.equal(plugin.id, "demo");
  assert.ok("view" in plugin.capabilities);
  assert.ok("doit" in plugin.capabilities);
});
