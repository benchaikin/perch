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
  /** Cross-plugin global settings, surfaced as `ctx.global`. */
  globalConfig?: unknown;
}): CoreContext<Cfg> {
  const { pluginId, config, signal, globalConfig } = args;
  const log = args.log ?? ((message: string) => console.error(`[${pluginId}] ${message}`));
  return { config, log, signal, global: globalConfig };
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

/**
 * Load workspace plugins selected by their **plugin id** (the `id` on the
 * `PluginDef`, e.g. `"stack"`), as opposed to {@link loadPlugins} which takes
 * package names. This is the path used when booting from `perch.yaml`, whose
 * `plugins` map is keyed by plugin id. We discover every workspace plugin
 * package, import each, and keep those whose default export's `id` is requested.
 * Throws if any requested id is not found among discovered plugins.
 */
export async function loadPluginsByIds(ids: string[]): Promise<PluginDef[]> {
  if (ids.length === 0) return [];
  const root = findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)));
  const discovered = root ? discoverWorkspacePlugins(root) : new Map<string, string>();

  const want = new Set(ids);
  const byId = new Map<string, PluginDef>();
  for (const entry of discovered.values()) {
    let mod: unknown;
    try {
      mod = await import(pathToFileURL(entry).href);
    } catch {
      // Skip a plugin that fails to import rather than failing the whole boot;
      // a requested-but-missing id is reported below.
      continue;
    }
    const def = (mod as { default?: unknown }).default;
    if (isPluginDef(def) && want.has(def.id)) {
      byId.set(def.id, def);
    }
  }

  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`perchd: no workspace plugin provides id(s): ${missing.join(", ")}`);
  }
  return ids.map((id) => byId.get(id)!);
}

function isPluginDef(value: unknown): value is PluginDef {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.capabilities === "object" && v.capabilities != null;
}
