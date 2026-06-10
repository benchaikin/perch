/**
 * Dynamic config reload pipeline.
 *
 * Computes the difference between the currently-running plugin set and a freshly
 * read `perch.json`, then hot-applies it to the live {@link Registry},
 * {@link Scheduler}, {@link Cache}, and shared config/plugin maps — without
 * restarting the daemon (see v1.1 "Dynamic config reloading").
 *
 * The diff ({@link diffConfigs}) is a pure function over plugin-id sets and
 * per-plugin config values, so it is unit-tested with injected inputs and never
 * depends on fs-watch timing. {@link applyReload} performs the side effects,
 * loading newly-enabled plugins through an injected loader so tests can supply
 * pre-built {@link PluginDef}s.
 */
import type { PluginDef } from "@perch/sdk";
import type { Cache } from "./cache.js";
import type { PluginConfigs } from "./invoker.js";
import type { Registry } from "./registry.js";
import type { Scheduler } from "./scheduler.js";

/** The outcome of diffing a desired plugin set against the running one. */
export interface ConfigDiff {
  /** Plugin ids enabled in the new config but not currently running. */
  added: string[];
  /** Plugin ids currently running but absent from the new config. */
  removed: string[];
  /** Plugin ids running in both, whose per-plugin config value changed. */
  updated: string[];
}

/** Whether a diff carries any change at all. */
export function isEmptyDiff(diff: ConfigDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.updated.length === 0;
}

/**
 * Pure diff: compare the desired plugins (ids + per-plugin config) against the
 * currently-running plugins (ids + their current config). A plugin in both sets
 * is "updated" iff its config value is not deeply equal. Order-independent;
 * result arrays are sorted for stable, testable output.
 */
export function diffConfigs(args: {
  /** Plugin ids that should be running, with their desired config. */
  desiredIds: string[];
  desiredConfigs: PluginConfigs;
  /** Plugin ids currently running, with their current config. */
  currentIds: string[];
  currentConfigs: PluginConfigs;
}): ConfigDiff {
  const desired = new Set(args.desiredIds);
  const current = new Set(args.currentIds);

  const added = [...desired].filter((id) => !current.has(id)).sort();
  const removed = [...current].filter((id) => !desired.has(id)).sort();
  const updated = [...desired]
    .filter((id) => current.has(id))
    .filter((id) => !deepEqual(args.desiredConfigs[id], args.currentConfigs[id]))
    .sort();

  return { added, removed, updated };
}

/** Loader signature: resolve {@link PluginDef}s for a set of plugin ids. */
export type LoadPlugins = (ids: string[]) => Promise<PluginDef[]>;

/** Mutable runtime state the reload mutates in place (shared by reference). */
export interface ReloadState {
  registry: Registry;
  scheduler: Scheduler;
  cache: Cache;
  /** Live per-plugin config object the invoker reads by reference. */
  configs: PluginConfigs;
  /** Live plugin-by-id map the invoker reads by reference. */
  plugins: Map<string, PluginDef>;
  /** Loads newly-enabled plugins (injected so tests can skip dynamic import). */
  load: LoadPlugins;
  /** Optional structured logger; defaults to `console.error`. */
  log?: (message: string) => void;
}

/**
 * Apply a {@link ConfigDiff} to the live runtime, given the new desired configs.
 * Mutates the shared `configs`/`plugins` maps in place so the invoker, scheduler
 * and server (which all hold those references) immediately observe the change.
 *
 * - **Removed**: stop pollers, unregister capabilities, drop cache + config.
 * - **Added**: load the plugin, register it, record its config.
 * - **Updated**: rebind config in place, then stop pollers + clear cache so the
 *   next invoke/subscribe re-runs `run` with the new config (the invoker reads
 *   `configs` live, so no re-registration is needed).
 *
 * Returns the diff actually applied (added entries that failed to load are
 * dropped from `added`), so the caller can decide whether to notify clients.
 */
export async function applyReload(
  state: ReloadState,
  diff: ConfigDiff,
  desiredConfigs: PluginConfigs,
): Promise<ConfigDiff> {
  const log = state.log ?? ((m: string) => console.error(m));

  // 1. Remove newly-disabled plugins: pollers → capabilities → cache → config.
  for (const id of diff.removed) {
    state.scheduler.stopForPlugin(id);
    state.registry.unregister(id);
    state.cache.clearForPlugin(id);
    delete state.configs[id];
    state.plugins.delete(id);
  }

  // 2. Add newly-enabled plugins. A load failure for one plugin must not abort
  //    the whole reload — drop it from `added` and keep going.
  const added: string[] = [];
  if (diff.added.length > 0) {
    let defs: PluginDef[] = [];
    try {
      defs = await state.load(diff.added);
    } catch (err) {
      log(`perchd: reload failed to load added plugins ${diff.added.join(", ")}: ${message(err)}`);
      defs = [];
    }
    for (const def of defs) {
      try {
        state.registry.register(def);
        state.plugins.set(def.id, def);
        state.configs[def.id] = desiredConfigs[def.id];
        added.push(def.id);
      } catch (err) {
        log(`perchd: reload failed to register plugin ${JSON.stringify(def.id)}: ${message(err)}`);
        // Best-effort rollback so a half-registered plugin doesn't linger.
        state.registry.unregister(def.id);
        state.plugins.delete(def.id);
        delete state.configs[def.id];
      }
    }
  }

  // 3. Update changed per-plugin configs: rebind in place, drop stale pollers +
  //    cache so the next call re-runs with the new config.
  for (const id of diff.updated) {
    state.configs[id] = desiredConfigs[id];
    state.scheduler.stopForPlugin(id);
    state.cache.clearForPlugin(id);
  }

  return { added, removed: diff.removed, updated: diff.updated };
}

/** Structured `unknown`-error → message. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Deep structural equality over JSON-ish values (configs are plain JSON). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  const arrA = Array.isArray(a);
  const arrB = Array.isArray(b);
  if (arrA !== arrB) return false;
  if (arrA && arrB) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const recA = a as Record<string, unknown>;
  const recB = b as Record<string, unknown>;
  const keysA = Object.keys(recA);
  const keysB = Object.keys(recB);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (k) => Object.prototype.hasOwnProperty.call(recB, k) && deepEqual(recA[k], recB[k]),
  );
}
