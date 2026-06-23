/**
 * `perch.yaml` config loading.
 *
 * The single durable config file (see v1-spec §6) holds the enabled plugins
 * (each keyed by plugin id, mapping to that plugin's own config object) and the
 * GUI widget `layout`. v1 consumes only `plugins`; `layout` is parsed and
 * passed through untouched (reserved — layout persistence is post-v1).
 *
 * ```yaml
 * plugins:
 *   stack:
 *     repos: [ashby/main]
 * layout:
 *   widgets:
 *     - { id: stack, x: 0, y: 0 }
 * ```
 *
 * The on-disk format is YAML so users can comment and hand-edit comfortably;
 * because YAML is a superset of JSON, a hand-pasted JSON body still parses. The
 * in-memory shape is unchanged.
 *
 * Per-plugin config objects are NOT validated against each plugin's `config`
 * schema here (the plugins aren't loaded yet at config-read time); core hands
 * each section to the matching plugin, and the invoker/loader validates against
 * the plugin's zod schema. A missing file yields sensible defaults (no plugins)
 * rather than an error — the daemon should start cleanly out of the box.
 */
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { configPath as defaultConfigPath } from "./paths.js";

/** Zod schema for `perch.yaml`. */
export const configSchema = z.object({
  /**
   * Enabled plugins, keyed by plugin id. Each value is that plugin's own
   * (opaque-to-core) config object, validated later against the plugin schema.
   */
  plugins: z.record(z.string(), z.unknown()).optional(),
  /**
   * Cross-plugin "global" settings (e.g. the shared terminal preference). Opaque
   * to core; handed to every capability as `ctx.global` for plugins that opt in.
   */
  global: z.record(z.string(), z.unknown()).optional(),
  /** Reserved GUI widget layout; passed through untouched in v1. */
  layout: z.unknown().optional(),
});

/** Parsed, validated `perch.yaml` contents. */
export type PerchConfig = z.infer<typeof configSchema>;

/** Default config used when `perch.yaml` is absent: no plugins, no global, no layout. */
export function defaultConfig(): PerchConfig {
  return { plugins: {}, global: {} };
}

/** Serialize a validated config to its canonical on-disk YAML form (trailing newline included). */
export function serializeConfig(config: PerchConfig): string {
  return stringifyYaml(config);
}

/**
 * Read and validate `perch.yaml` from `path` (defaults to the platform config
 * path). A missing file resolves to {@link defaultConfig}. YAML-parse and schema
 * errors are surfaced with a clear, path-prefixed message.
 *
 * Migration shim: when `perch.yaml` is absent, fall back to a sibling legacy
 * `perch.json` (the pre-YAML format) so existing installs keep working on first
 * boot. The next {@link updateConfig} write persists the config as `perch.yaml`,
 * after which the legacy file is ignored. See {@link legacyJsonPath}.
 */
export async function loadConfig(path: string = defaultConfigPath()): Promise<PerchConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return loadLegacyConfig(path);
    }
    throw new Error(`perch: failed to read config ${path}: ${errorMessage(err)}`);
  }
  return parseConfig(text, path);
}

/** Parse and validate raw YAML config `text` read from `path`. */
function parseConfig(text: string, path: string): PerchConfig {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    throw new Error(`perch: invalid YAML in config ${path}: ${errorMessage(err)}`);
  }

  const result = configSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`perch: invalid config ${path}:\n${issues}`);
  }
  return result.data;
}

/**
 * Fallback for a missing `perch.yaml`: read a sibling legacy `perch.json` if one
 * exists (YAML is a JSON superset, so the same parser handles it), else return
 * {@link defaultConfig}. Keeps pre-YAML installs working read-only until the next
 * write migrates them.
 */
async function loadLegacyConfig(path: string): Promise<PerchConfig> {
  const legacy = legacyJsonPath(path);
  if (legacy === path) return defaultConfig();
  let text: string;
  try {
    text = await readFile(legacy, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultConfig();
    }
    throw new Error(`perch: failed to read config ${legacy}: ${errorMessage(err)}`);
  }
  return parseConfig(text, legacy);
}

/** Sibling `…/<base>.json` path for a config file (the pre-YAML filename). */
export function legacyJsonPath(path: string): string {
  return join(dirname(path), `${basename(path, extname(path))}.json`);
}

/**
 * Derive the enabled plugin ids and per-plugin configs from a parsed config.
 * Enabled = every key under `plugins`; the value becomes that plugin's config.
 */
export function pluginsFromConfig(config: PerchConfig): {
  ids: string[];
  configs: Record<string, unknown>;
} {
  const plugins = config.plugins ?? {};
  return { ids: Object.keys(plugins), configs: { ...plugins } };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
