/**
 * Capability invocation.
 *
 * Validates input inline against the capability's own schema, runs it, and (for
 * reads) validates output. Results are written to the cache. This is the single
 * code path used by both `capability.invoke` and the scheduler/poller.
 */
import type { PluginDef, ReadDef } from "@perch/sdk";
import { Cache, inputKey } from "./cache.js";
import { buildContext } from "./loader.js";
import type { RegisteredCapability } from "./registry.js";

/** Resolved per-plugin config, keyed by plugin id. */
export type PluginConfigs = Record<string, unknown>;

/** Inputs the invoker needs to run any capability. */
export interface InvokerDeps {
  cache: Cache;
  configs: PluginConfigs;
  /** Cross-plugin global settings (perch.json `global`), surfaced as `ctx.global`. */
  global?: unknown;
  /** Plugins by id (for config-schema validation, future use). */
  plugins: Map<string, PluginDef>;
  /** Aborted on daemon shutdown. */
  signal: AbortSignal;
}

/**
 * Run a capability with the given raw input. Input is validated inline with the
 * capability's schema (`cap.input ? cap.input.parse(raw) : raw`); for reads the
 * output is validated the same way. The (validated) result is cached under
 * `(id, serialized-input)` and returned.
 */
export async function invokeCapability(
  deps: InvokerDeps,
  entry: RegisteredCapability,
  rawInput: unknown,
): Promise<unknown> {
  const { cap } = entry;
  const input: unknown = cap.input ? cap.input.parse(rawInput) : rawInput;

  const ctx = buildContext({
    pluginId: entry.pluginId,
    config: deps.configs[entry.pluginId],
    globalConfig: deps.global,
    signal: deps.signal,
  });

  const raw: unknown = await cap.run({ input, ctx } as Parameters<typeof cap.run>[0]);

  let result: unknown = raw;
  if (cap.kind === "read") {
    const read = cap as ReadDef<unknown, unknown, unknown>;
    result = read.output ? read.output.parse(raw) : raw;
    // Only reads have meaningful, cacheable state.
    deps.cache.set(entry.id, inputKey(input), result);
  }
  return result;
}
