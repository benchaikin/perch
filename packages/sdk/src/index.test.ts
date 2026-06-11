import assert from "node:assert/strict";
import { test } from "node:test";

import {
  action,
  capabilityId,
  definePlugin,
  parseConfig,
  parseInput,
  parseOutput,
  parseRefreshInterval,
  read,
  validateSettingsDescriptor,
  z,
  type SettingsDescriptor,
} from "./index.js";

test("capabilityId joins plugin and capability names", () => {
  assert.equal(capabilityId("stack", "view"), "stack.view");
});

test("parseInput validates against the input schema", () => {
  const cap = read({
    summary: "echo",
    input: z.object({ repo: z.string() }),
    run: ({ input }) => input,
  });
  assert.deepEqual(parseInput(cap, { repo: "ashby/main" }), { repo: "ashby/main" });
  assert.throws(() => parseInput(cap, { repo: 123 }), z.ZodError);
  assert.throws(() => parseInput(cap, {}), z.ZodError);
});

test("parseInput passes through when no input schema is present", () => {
  const cap = read({ summary: "no input", run: () => null });
  const raw = { anything: true };
  assert.equal(parseInput(cap, raw), raw);
});

test("parseInput works for actions", () => {
  const cap = action({
    summary: "do",
    input: z.object({ force: z.boolean() }),
    run: () => {},
  });
  assert.deepEqual(parseInput(cap, { force: true }), { force: true });
  assert.throws(() => parseInput(cap, { force: "yes" }), z.ZodError);
});

test("parseOutput validates a read's output schema", () => {
  const cap = read({
    summary: "count",
    output: z.object({ count: z.number() }),
    run: () => ({ count: 1 }),
  });
  assert.deepEqual(parseOutput(cap, { count: 5 }), { count: 5 });
  assert.throws(() => parseOutput(cap, { count: "nope" }), z.ZodError);
});

test("parseOutput passes through reads without an output schema", () => {
  const cap = read({ summary: "raw", run: () => 42 });
  assert.equal(parseOutput(cap, 42), 42);
});

test("parseConfig validates against the plugin config schema", () => {
  const plugin = definePlugin({
    id: "stack",
    config: z.object({ repos: z.array(z.string()) }),
    capabilities: {},
  });
  assert.deepEqual(parseConfig(plugin, { repos: ["a/b"] }), { repos: ["a/b"] });
  assert.throws(() => parseConfig(plugin, { repos: "a/b" }), z.ZodError);
});

test("parseConfig passes through when no config schema is present", () => {
  const plugin = definePlugin({ id: "bare", capabilities: {} });
  const raw = { whatever: 1 };
  assert.equal(parseConfig(plugin, raw), raw);
});

test("parseRefreshInterval converts each supported unit", () => {
  assert.equal(parseRefreshInterval("500ms"), 500);
  assert.equal(parseRefreshInterval("60s"), 60_000);
  assert.equal(parseRefreshInterval("5m"), 300_000);
  assert.equal(parseRefreshInterval("2h"), 7_200_000);
  assert.equal(parseRefreshInterval("0s"), 0);
});

test("definePlugin: a plugin can declare a settings descriptor", () => {
  const plugin = definePlugin({
    id: "stack",
    name: "Stack",
    settings: [
      {
        key: "stackDirection",
        type: "enum",
        label: "Stack direction",
        description: "Order PRs are stacked in",
        default: "down",
        options: [
          { value: "down", label: "Down" },
          { value: "up", label: "Up" },
        ],
      },
      { key: "showDrafts", type: "boolean", label: "Show drafts", default: false },
    ],
    capabilities: {},
  });
  assert.equal(plugin.name, "Stack");
  assert.equal(plugin.settings?.length, 2);
  const first = plugin.settings?.[0];
  assert.ok(first);
  assert.equal(first.key, "stackDirection");
  assert.equal(first.type, "enum");
  assert.deepEqual(first.options, [
    { value: "down", label: "Down" },
    { value: "up", label: "Up" },
  ]);
});

test("validateSettingsDescriptor: returns a valid descriptor unchanged", () => {
  const descriptor: SettingsDescriptor = [
    { key: "name", type: "string", label: "Name" },
    {
      key: "mode",
      type: "enum",
      label: "Mode",
      options: [{ value: "a", label: "A" }],
    },
  ];
  assert.equal(validateSettingsDescriptor(descriptor), descriptor);
});

test("validateSettingsDescriptor: rejects duplicate keys", () => {
  assert.throws(
    () =>
      validateSettingsDescriptor([
        { key: "x", type: "string", label: "X" },
        { key: "x", type: "number", label: "X again" },
      ]),
    /duplicate settings field key/,
  );
});

test("validateSettingsDescriptor: rejects an enum field without options", () => {
  assert.throws(
    () => validateSettingsDescriptor([{ key: "mode", type: "enum", label: "Mode" }]),
    /requires non-empty `options`/,
  );
  assert.throws(
    () => validateSettingsDescriptor([{ key: "mode", type: "enum", label: "Mode", options: [] }]),
    /requires non-empty `options`/,
  );
});

test("validateSettingsDescriptor: rejects a field without a key", () => {
  assert.throws(
    () => validateSettingsDescriptor([{ key: "", type: "string", label: "Empty" }]),
    /missing a `key`/,
  );
});

test("parseRefreshInterval throws on malformed input", () => {
  for (const bad of ["", "60", "s", "m5", "5sec", "1.5s", "-5s", "5 s", "5x", "ms", "5ms5"]) {
    assert.throws(
      () => parseRefreshInterval(bad),
      /Invalid refresh interval/,
      `expected throw for ${JSON.stringify(bad)}`,
    );
  }
});
