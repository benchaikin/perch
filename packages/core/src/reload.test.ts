import assert from "node:assert/strict";
import { test } from "node:test";
import { action, definePlugin, read, type Capability, type PluginDef } from "@perch/sdk";
import { Cache } from "./cache.js";
import { createEventBus } from "./event-bus.js";
import type { InvokerDeps, PluginConfigs } from "./invoker.js";
import { applyReload, diffConfigs, isEmptyDiff, type ReloadState } from "./reload.js";
import { Registry } from "./registry.js";
import { Scheduler } from "./scheduler.js";

const asCap = (c: unknown): Capability => c as Capability;

/** A plugin with one fast-polling read, so the scheduler arms a timer. */
function pollPlugin(id: string): PluginDef {
  return definePlugin({
    id,
    capabilities: {
      now: asCap(
        read({
          summary: "polls",
          refresh: { every: "50ms" },
          run: ({ ctx }) => (ctx as { config?: unknown }).config ?? null,
        }),
      ),
      go: asCap(action({ summary: "act", run: () => {} })),
    },
  });
}

function makeState(
  plugins: PluginDef[],
  configs: PluginConfigs,
): {
  state: ReloadState;
  loaded: string[][];
} {
  const registry = new Registry();
  const pluginMap = new Map<string, PluginDef>();
  for (const def of plugins) {
    registry.register(def);
    pluginMap.set(def.id, def);
  }
  const cache = new Cache();
  const bus = createEventBus();
  const invoker: InvokerDeps = {
    cache,
    configs,
    plugins: pluginMap,
    signal: new AbortController().signal,
  };
  const scheduler = new Scheduler(invoker, bus);

  const loaded: string[][] = [];
  // Injected loader: serve from a fixed catalog built from `pollPlugin`.
  const load = async (ids: string[]): Promise<PluginDef[]> => {
    loaded.push(ids);
    return ids.map((id) => pollPlugin(id));
  };

  return {
    state: { registry, scheduler, cache, configs, plugins: pluginMap, load, log: () => {} },
    loaded,
  };
}

// ---------------------------------------------------------------------------
// diffConfigs (pure)
// ---------------------------------------------------------------------------

test("diffConfigs: detects added, removed, and config-changed plugins", () => {
  const diff = diffConfigs({
    desiredIds: ["a", "b", "d"],
    desiredConfigs: { a: { x: 1 }, b: { x: 2 }, d: {} },
    currentIds: ["a", "b", "c"],
    currentConfigs: { a: { x: 1 }, b: { x: 9 }, c: {} },
  });
  assert.deepEqual(diff, { added: ["d"], removed: ["c"], updated: ["b"] });
});

test("diffConfigs: identical config → empty diff (deep equality, key order independent)", () => {
  const diff = diffConfigs({
    desiredIds: ["a"],
    desiredConfigs: { a: { x: 1, y: [1, 2] } },
    currentIds: ["a"],
    currentConfigs: { a: { y: [1, 2], x: 1 } },
  });
  assert.ok(isEmptyDiff(diff));
});

test("diffConfigs: nested config change is detected", () => {
  const diff = diffConfigs({
    desiredIds: ["a"],
    desiredConfigs: { a: { nested: { z: 2 } } },
    currentIds: ["a"],
    currentConfigs: { a: { nested: { z: 1 } } },
  });
  assert.deepEqual(diff, { added: [], removed: [], updated: ["a"] });
});

// ---------------------------------------------------------------------------
// applyReload (side effects)
// ---------------------------------------------------------------------------

test("applyReload: adds a newly-enabled plugin (loads, registers, records config)", async () => {
  const { state, loaded } = makeState([pollPlugin("a")], { a: {} });
  const applied = await applyReload(
    state,
    { added: ["b"], removed: [], updated: [] },
    { a: {}, b: { token: "t" } },
  );

  assert.deepEqual(loaded, [["b"]]);
  assert.deepEqual(applied.added, ["b"]);
  assert.ok(state.registry.get("b.now"), "b capabilities registered");
  assert.ok(state.plugins.has("b"));
  assert.deepEqual(state.configs.b, { token: "t" });
});

test("applyReload: removes a disabled plugin (unregister, stop pollers, drop cache + config)", async () => {
  const { state } = makeState([pollPlugin("a")], { a: {} });
  // Arm a poller and seed the cache for plugin a.
  const entry = state.registry.get("a.now")!;
  state.scheduler.subscribe(entry, undefined);
  state.cache.set("a.now", "null", { seeded: true });
  assert.ok(state.cache.get("a.now", "null"), "precondition: cache seeded");

  const applied = await applyReload(state, { added: [], removed: ["a"], updated: [] }, {});

  assert.deepEqual(applied.removed, ["a"]);
  assert.equal(state.registry.get("a.now"), undefined, "capabilities unregistered");
  assert.equal(state.plugins.has("a"), false);
  assert.equal(state.cache.get("a.now", "null"), undefined, "cache cleared");
  assert.equal(state.configs.a, undefined, "config dropped");
  // Stopping the poller leaves no live timer (no leak); re-subscribe re-arms.
  state.scheduler.stop();
});

test("applyReload: updates config in place and clears stale pollers + cache", async () => {
  const { state, loaded } = makeState([pollPlugin("a")], { a: { v: 1 } });
  const entry = state.registry.get("a.now")!;
  state.scheduler.subscribe(entry, undefined);
  state.cache.set("a.now", "null", { stale: true });

  const applied = await applyReload(
    state,
    { added: [], removed: [], updated: ["a"] },
    { a: { v: 2 } },
  );

  assert.deepEqual(applied.updated, ["a"]);
  assert.deepEqual(loaded, [], "no plugin (re)load needed for a config update");
  assert.deepEqual(state.configs.a, { v: 2 }, "live config rebound in place");
  assert.equal(state.cache.get("a.now", "null"), undefined, "stale cache cleared");
  assert.ok(state.registry.get("a.now"), "capabilities still registered after update");
  state.scheduler.stop();
});

test("applyReload: a load failure for an added plugin is dropped, not fatal", async () => {
  const { state } = makeState([pollPlugin("a")], { a: {} });
  state.load = async () => {
    throw new Error("boom");
  };
  const applied = await applyReload(
    state,
    { added: ["b"], removed: [], updated: [] },
    { a: {}, b: {} },
  );
  assert.deepEqual(applied.added, [], "failed add dropped from applied diff");
  assert.equal(state.registry.get("b.now"), undefined);
  assert.ok(state.registry.get("a.now"), "existing plugin untouched");
});

test("applyReload: combined add + remove + update in one pass", async () => {
  const { state } = makeState([pollPlugin("a"), pollPlugin("c")], { a: { v: 1 }, c: {} });
  const applied = await applyReload(
    state,
    { added: ["b"], removed: ["c"], updated: ["a"] },
    { a: { v: 2 }, b: {} },
  );
  assert.deepEqual(applied, { added: ["b"], removed: ["c"], updated: ["a"] });
  assert.ok(state.registry.get("b.now"));
  assert.equal(state.registry.get("c.now"), undefined);
  assert.deepEqual(state.configs.a, { v: 2 });
  state.scheduler.stop();
});

// ---------------------------------------------------------------------------
// Registry / Scheduler / Cache runtime helpers
// ---------------------------------------------------------------------------

test("Registry: unregister removes only the named plugin's capabilities", () => {
  const registry = new Registry();
  registry.register(pollPlugin("a"));
  registry.register(pollPlugin("b"));
  assert.deepEqual(registry.pluginIds().sort(), ["a", "b"]);

  const removed = registry.unregister("a");
  assert.deepEqual(removed.sort(), ["a.go", "a.now"]);
  assert.equal(registry.get("a.now"), undefined);
  assert.ok(registry.get("b.now"), "other plugin preserved");
  assert.deepEqual(registry.pluginIds(), ["b"]);
  assert.deepEqual(registry.unregister("missing"), [], "unknown plugin is a no-op");
});

test("Scheduler: stopForPlugin clears that plugin's timers only", () => {
  const cache = new Cache();
  const registry = new Registry();
  registry.register(pollPlugin("a"));
  registry.register(pollPlugin("b"));
  const invoker: InvokerDeps = {
    cache,
    configs: {},
    plugins: new Map(),
    signal: new AbortController().signal,
  };
  const scheduler = new Scheduler(invoker, createEventBus());
  scheduler.subscribe(registry.get("a.now")!, undefined);
  scheduler.subscribe(registry.get("b.now")!, undefined);

  assert.equal(scheduler.stopForPlugin("a"), 1, "one poller removed for a");
  assert.equal(scheduler.stopForPlugin("a"), 0, "idempotent: nothing left for a");
  assert.equal(scheduler.stopForPlugin("b"), 1, "b's poller still present");
  scheduler.stop();
});

test("Cache: clearForPlugin drops only that plugin's entries", () => {
  const cache = new Cache();
  cache.set("a.now", "null", 1);
  cache.set("a.other", '{"q":1}', 2);
  cache.set("b.now", "null", 3);

  assert.equal(cache.clearForPlugin("a"), 2);
  assert.equal(cache.get("a.now", "null"), undefined);
  assert.ok(cache.get("b.now", "null"), "other plugin preserved");
});
