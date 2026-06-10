/**
 * Plugin host / loader.
 *
 * Dynamically imports plugin packages (e.g. `@perch/plugin-stack`) and collects
 * their default-exported {@link PluginDef}. Also builds the per-capability
 * runtime context handed to `run`.
 */
import type { CapabilityContext, PluginDef } from "@perch/sdk";

/**
 * The runtime context core hands to a capability's `run`. Satisfies the SDK's
 * {@link CapabilityContext} and additionally carries an {@link AbortSignal} that
 * is aborted on daemon shutdown.
 */
export interface CoreContext<Cfg = unknown> extends CapabilityContext<Cfg> {
  /** Aborted when the daemon shuts down; long-running `run`s should honor it. */
  signal: AbortSignal;
}

/** Build a capability context for an invocation. */
export function buildContext<Cfg>(args: {
  pluginId: string;
  config: Cfg;
  signal: AbortSignal;
  log?: (message: string) => void;
}): CoreContext<Cfg> {
  const { pluginId, config, signal } = args;
  const log = args.log ?? ((message: string) => console.error(`[${pluginId}] ${message}`));
  return { config, log, signal };
}

/**
 * Dynamically import each plugin package by id and collect its default-exported
 * {@link PluginDef}. Throws if a package has no default `PluginDef`.
 */
export async function loadPlugins(ids: string[]): Promise<PluginDef[]> {
  const plugins: PluginDef[] = [];
  for (const id of ids) {
    const mod: unknown = await import(id);
    const def = (mod as { default?: unknown }).default;
    if (!isPluginDef(def)) {
      throw new Error(`perchd: ${JSON.stringify(id)} has no default-exported PluginDef`);
    }
    plugins.push(def);
  }
  return plugins;
}

function isPluginDef(value: unknown): value is PluginDef {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.capabilities === "object" && v.capabilities != null;
}
