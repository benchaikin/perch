import assert from "node:assert/strict";
import { test } from "node:test";

import type { CapabilityContext } from "@perch/sdk";

import plugin from "./index.js";
import { ReposResult } from "./repos.js";

/** Minimal `CapabilityContext` for invoking a capability's `run` directly. */
function ctx(config: unknown): CapabilityContext {
  return { config, log: () => {} };
}

test("stack.repos returns the configured repos + default, validated by its schema", async () => {
  const repos = plugin.capabilities.repos!;
  assert.equal(repos.kind, "read");

  const out = await repos.run({
    input: undefined,
    ctx: ctx({ repos: ["/work/main", "/work/infra"] }),
  });

  // The read declares this output schema — it must parse.
  const parsed = ReposResult.parse(out);
  assert.deepEqual(parsed, {
    repos: [
      { name: "main", path: "/work/main" },
      { name: "infra", path: "/work/infra" },
    ],
    default: "main",
  });
});

test("stack.repos is empty (no default) when no repos are configured", async () => {
  const out = await plugin.capabilities.repos!.run({ input: undefined, ctx: ctx({}) });
  assert.deepEqual(ReposResult.parse(out), { repos: [], default: undefined });
});

test("stack.repos is not exposed to MCP", () => {
  assert.equal(plugin.capabilities.repos!.expose?.mcp, false);
});

test("stack.prs is a read exposed to MCP", () => {
  const prs = plugin.capabilities.prs!;
  assert.equal(prs.kind, "read");
  assert.equal(prs.expose?.mcp, true);
});
