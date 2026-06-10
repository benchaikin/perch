/**
 * Plugin host / loader.
 *
 * Loads plugin packages by id and collects their default-exported
 * {@link PluginDef}. Per the spec, plugins live in the workspace `plugins/` dir;
 * the loader discovers them there and imports by file URL (so resolution does
 * not depend on a package manager linking unreferenced workspace packages, and
 * keeps working once the daemon is packaged for distribution). Unknown ids fall
 * back to bare module resolution. Also builds the per-capability runtime context
 * handed to `run`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
 * Walk up from `startDir` to the workspace root (the dir containing
 * `pnpm-workspace.yaml`). Returns undefined if none is found.
 */
export function findWorkspaceRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Scan `<root>/plugins/*` and build a map of package `name` → absolute entry
 * path (from each package.json `main`, defaulting to `dist/index.js`).
 */
export function discoverWorkspacePlugins(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const pluginsDir = join(root, "plugins");
  if (!existsSync(pluginsDir)) return map;
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(pluginsDir, entry.name, "package.json");
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; main?: string };
      if (!pkg.name) continue;
      map.set(pkg.name, resolvePath(pluginsDir, entry.name, pkg.main ?? "dist/index.js"));
    } catch {
      // Skip an unreadable/malformed package.json rather than failing discovery.
    }
  }
  return map;
}

/**
 * Load each plugin package by id and collect its default-exported
 * {@link PluginDef}. Ids matching a package under the workspace `plugins/` dir
 * are imported by file URL; others fall back to bare module resolution. Throws
 * if a plugin fails to import or has no default `PluginDef`.
 */
export async function loadPlugins(ids: string[]): Promise<PluginDef[]> {
  const root = findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)));
  const discovered = root ? discoverWorkspacePlugins(root) : new Map<string, string>();

  const plugins: PluginDef[] = [];
  for (const id of ids) {
    const entry = discovered.get(id);
    const specifier = entry ? pathToFileURL(entry).href : id;
    let mod: unknown;
    try {
      mod = await import(specifier);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`perchd: failed to load plugin ${JSON.stringify(id)}: ${reason}`);
    }
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
