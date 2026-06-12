import assert from "node:assert/strict";
import { test } from "node:test";

import { type CapabilityContext, validateSettingsDescriptor } from "@perch/sdk";

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

test("StackConfig defaults stackDirection to bottom-to-top and parses an override", () => {
  const config = plugin.config!;
  assert.equal((config.parse({}) as { stackDirection: string }).stackDirection, "bottom-to-top");
  assert.equal(
    (config.parse({ stackDirection: "top-to-bottom" }) as { stackDirection: string })
      .stackDirection,
    "top-to-bottom",
  );
  // An unknown direction is rejected by the enum.
  assert.throws(() => config.parse({ stackDirection: "sideways" }));
});

test("the plugin declares a valid stackDirection settings descriptor", () => {
  assert.equal(plugin.name, "Stack");
  const settings = plugin.settings!;
  // Structurally valid (unique keys, enum options present).
  assert.doesNotThrow(() => validateSettingsDescriptor(settings));
  const field = settings.find((f) => f.key === "stackDirection")!;
  assert.ok(field, "stackDirection field is declared");
  assert.equal(field.type, "enum");
  assert.equal(field.default, "bottom-to-top");
  assert.deepEqual(
    field.options?.map((o) => o.value),
    ["bottom-to-top", "top-to-bottom"],
  );
});
