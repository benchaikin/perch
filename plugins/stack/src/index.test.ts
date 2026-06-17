import assert from "node:assert/strict";
import { test } from "node:test";

import { type CapabilityContext, validateSettingsDescriptor } from "@perch/sdk";

import plugin from "./index.js";
import { ReposResult } from "./repos.js";

/** Minimal `CapabilityContext` for invoking a capability's `run` directly. */
function ctx(config: unknown, global?: unknown): CapabilityContext {
  return { config, global, log: () => {} };
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

test("stack.repos falls back to shared global.repos when plugins.stack.repos is unset", async () => {
  // Precedence step 2: no plugin-local override → the shared `global.repos`.
  const out = await plugin.capabilities.repos!.run({
    input: undefined,
    ctx: ctx({}, { repos: ["/g/main", "/g/infra"] }),
  });
  assert.deepEqual(ReposResult.parse(out), {
    repos: [
      { name: "main", path: "/g/main" },
      { name: "infra", path: "/g/infra" },
    ],
    default: "main",
  });
});

test("stack.repos: plugins.stack.repos overrides the shared global.repos", async () => {
  // Precedence step 1: a non-empty plugin-local list wins over the shared one.
  const out = await plugin.capabilities.repos!.run({
    input: undefined,
    ctx: ctx({ repos: ["/local/app"] }, { repos: ["/g/main", "/g/infra"] }),
  });
  assert.deepEqual(ReposResult.parse(out), {
    repos: [{ name: "app", path: "/local/app" }],
    default: "app",
  });
});

test("stack.repos: an empty plugins.stack.repos falls through to shared global.repos", async () => {
  // An explicitly empty override is treated as "unset" → the shared list.
  const out = await plugin.capabilities.repos!.run({
    input: undefined,
    ctx: ctx({ repos: [] }, { repos: ["/g/main"] }),
  });
  assert.deepEqual(ReposResult.parse(out), {
    repos: [{ name: "main", path: "/g/main" }],
    default: "main",
  });
});

test("stack.repos is empty when neither plugins.stack.repos nor global.repos is set", async () => {
  // Precedence step 3: nothing configured → empty (the cwd back-compat fallback).
  const out = await plugin.capabilities.repos!.run({
    input: undefined,
    ctx: ctx({}, { repos: [] }),
  });
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

test("stack.merge-pr is a single-PR action, distinct from the stack-wide merge", () => {
  const mergePr = plugin.capabilities["merge-pr"]!;
  const merge = plugin.capabilities.merge!;
  assert.ok(mergePr, "merge-pr action is registered");
  assert.equal(mergePr.kind, "action");
  // It must NOT collide with or replace the stack-wide merge.
  assert.ok(merge, "the stack-wide merge action still exists");
  assert.notEqual(mergePr, merge);
  // Like the other actions, it's not exposed to MCP (agents drive gh directly).
  assert.notEqual(mergePr.expose?.mcp, true);
});

test("stack.merge-pr requires a PR number in its input schema", () => {
  const mergePr = plugin.capabilities["merge-pr"]!;
  const input = mergePr.input!;
  // `number` is required — a bare object is rejected…
  assert.throws(() => input.parse({}));
  // …and a number (with the optional repo/headRefName) parses.
  assert.doesNotThrow(() => input.parse({ number: 7 }));
  assert.doesNotThrow(() => input.parse({ number: 7, repo: "r", headRefName: "feat-x" }));
});

test("StackConfig defaults mergeMethod to squash and parses/rejects overrides", () => {
  const config = plugin.config!;
  assert.equal((config.parse({}) as { mergeMethod: string }).mergeMethod, "squash");
  assert.equal(
    (config.parse({ mergeMethod: "rebase" }) as { mergeMethod: string }).mergeMethod,
    "rebase",
  );
  assert.throws(() => config.parse({ mergeMethod: "fast-forward" }));
});

test("the plugin declares a valid mergeMethod settings descriptor", () => {
  const settings = plugin.settings!;
  const field = settings.find((f) => f.key === "mergeMethod")!;
  assert.ok(field, "mergeMethod field is declared");
  assert.equal(field.type, "enum");
  assert.equal(field.default, "squash");
  assert.deepEqual(
    field.options?.map((o) => o.value),
    ["squash", "merge", "rebase"],
  );
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
