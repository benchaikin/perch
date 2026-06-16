/**
 * `perch.json` config loading.
 *
 * The single durable config file (see v1-spec §6) holds the enabled plugins
 * (each keyed by plugin id, mapping to that plugin's own config object) and the
 * GUI widget `layout`. v1 consumes only `plugins`; `layout` is parsed and
 * passed through untouched (reserved — layout persistence is post-v1).
 *
 * ```json
 * {
 *   "plugins": { "stack": { "repos": ["ashby/main"] } },
 *   "layout":  { "widgets": [{ "id": "stack", "x": 0, "y": 0 }] }
 * }
 * ```
 *
 * Per-plugin config objects are NOT validated against each plugin's `config`
 * schema here (the plugins aren't loaded yet at config-read time); core hands
 * each section to the matching plugin, and the invoker/loader validates against
 * the plugin's zod schema. A missing file yields sensible defaults (no plugins)
 * rather than an error — the daemon should start cleanly out of the box.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { configPath as defaultConfigPath } from "./paths.js";

/** Zod schema for `perch.json`. */
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

/** Parsed, validated `perch.json` contents. */
export type PerchConfig = z.infer<typeof configSchema>;

/** Default config used when `perch.json` is absent: no plugins, no global, no layout. */
export function defaultConfig(): PerchConfig {
  return { plugins: {}, global: {} };
}

/**
 * Read and validate `perch.json` from `path` (defaults to the platform config
 * path). A missing file resolves to {@link defaultConfig}. JSON-parse and schema
 * errors are surfaced with a clear, path-prefixed message.
 */
export async function loadConfig(path: string = defaultConfigPath()): Promise<PerchConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultConfig();
    }
    throw new Error(`perch: failed to read config ${path}: ${errorMessage(err)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`perch: invalid JSON in config ${path}: ${errorMessage(err)}`);
  }

  const result = configSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`perch: invalid config ${path}:\n${issues}`);
  }
  return result.data;
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
