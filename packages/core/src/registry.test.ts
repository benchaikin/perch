import assert from "node:assert/strict";
import { test } from "node:test";
import { action, read, definePlugin, z, type Capability } from "@perch/sdk";
import { Registry, resolveExpose } from "./registry.js";

// The M0 SDK skeleton types `Capability` invariantly in its input, so a
// concretely-typed `read`/`action` doesn't widen to `Capability` without a
// cast. (M2 fleshes out the SDK; this is a test-only shim.)
const asCap = (c: unknown): Capability => c as Capability;

test("resolveExpose: read defaults — no view → gui off, cli on, mcp off", () => {
  const cap = asCap(read({ summary: "no view", run: () => 1 }));
  assert.deepEqual(resolveExpose(cap), { cli: true, gui: false, mcp: false });
});

test("resolveExpose: read with a view → gui on by default", () => {
  const cap = asCap(read({ summary: "with view", view: { kind: "list" }, run: () => 1 }));
  assert.deepEqual(resolveExpose(cap), { cli: true, gui: true, mcp: false });
});

test("resolveExpose: action defaults — gui on", () => {
  const cap = asCap(action({ summary: "act", run: () => {} }));
  assert.deepEqual(resolveExpose(cap), { cli: true, gui: true, mcp: false });
});

test("resolveExpose: explicit fields override every default", () => {
  const cap = asCap(
    read({
      summary: "overrides",
      view: { kind: "list" },
      expose: { cli: false, gui: false, mcp: true },
      run: () => 1,
    }),
  );
  assert.deepEqual(resolveExpose(cap), { cli: false, gui: false, mcp: true });
});

test("resolveExpose: partial override keeps other defaults", () => {
  const cap = asCap(action({ summary: "act", expose: { mcp: true }, run: () => {} }));
  assert.deepEqual(resolveExpose(cap), { cli: true, gui: true, mcp: true });
});

test("Registry: indexes capabilities under `${pluginId}.${name}` with metadata", () => {
  const plugin = definePlugin({
    id: "demo",
    capabilities: {
      view: asCap(
        read({
          summary: "a read",
          input: z.object({ q: z.string() }),
          output: z.number(),
          refresh: { every: "60s", on: ["focus"] },
          view: { kind: "list", title: "Demo" },
          run: () => 1,
        }),
      ),
      go: asCap(action({ summary: "an action", run: () => {} })),
    },
  });

  const registry = new Registry();
  registry.register(plugin);

  const list = registry.list();
  assert.equal(list.length, 2);

  const view = registry.get("demo.view");
  assert.ok(view);
  assert.equal(view.pluginId, "demo");
  assert.equal(view.name, "view");

  const viewMeta = list.find((m) => m.id === "demo.view");
  assert.ok(viewMeta);
  assert.equal(viewMeta.kind, "read");
  assert.equal(viewMeta.summary, "a read");
  assert.equal(viewMeta.hasInput, true);
  assert.equal(viewMeta.hasOutput, true);
  assert.deepEqual(viewMeta.refresh, { every: "60s", on: ["focus"] });
  assert.deepEqual(viewMeta.view, { kind: "list", title: "Demo" });
  assert.deepEqual(viewMeta.expose, { cli: true, gui: true, mcp: false });

  const goMeta = list.find((m) => m.id === "demo.go");
  assert.ok(goMeta);
  assert.equal(goMeta.kind, "action");
  assert.equal(goMeta.hasInput, false);
  assert.equal(goMeta.hasOutput, false);
  assert.equal(goMeta.refresh, undefined);
});

test("Registry: settingsDescriptors exposes declared descriptors with display name", () => {
  const withSettings = definePlugin({
    id: "stack",
    name: "Stack",
    settings: [{ key: "showDrafts", type: "boolean", label: "Show drafts", default: false }],
    capabilities: {},
  });
  const noSettings = definePlugin({ id: "noop", capabilities: {} });

  const registry = new Registry();
  registry.register(withSettings);
  registry.register(noSettings);

  const descriptors = registry.settingsDescriptors();
  assert.equal(descriptors.length, 1);
  const [stack] = descriptors;
  assert.ok(stack);
  assert.equal(stack.pluginId, "stack");
  assert.equal(stack.name, "Stack");
  assert.deepEqual(stack.fields, withSettings.settings);
});

test("Registry: unregister drops a plugin's settings descriptor", () => {
  const plugin = definePlugin({
    id: "stack",
    settings: [{ key: "x", type: "string", label: "X" }],
    capabilities: {},
  });
  const registry = new Registry();
  registry.register(plugin);
  assert.equal(registry.settingsDescriptors().length, 1);
  registry.unregister("stack");
  assert.equal(registry.settingsDescriptors().length, 0);
  // Name falls back to id when none is declared.
  registry.register(plugin);
  const [reregistered] = registry.settingsDescriptors();
  assert.ok(reregistered);
  assert.equal(reregistered.name, "stack");
});

test("Registry: rejects duplicate capability ids", () => {
  const a = definePlugin({
    id: "dup",
    capabilities: { x: asCap(read({ summary: "x", run: () => 1 })) },
  });
  const registry = new Registry();
  registry.register(a);
  assert.throws(() => registry.register(a), /duplicate capability id/);
});
