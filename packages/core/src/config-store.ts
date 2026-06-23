/**
 * Config read + mutation store.
 *
 * Backs the `config.*` RPC surface: read the current `perch.yaml`, apply a
 * deep-merge patch, validate it against {@link configSchema}, and write it back
 * **atomically** (temp file + rename) so the {@link ConfigWatcher} never observes
 * a partially-written file. Mutations deliberately do NOT trigger a reload: the
 * atomic rename is itself a watcher event, so the daemon's existing watch →
 * reload → `registry.changed` path is the single source of truth for applying a
 * config change (see {@link ./index.ts}).
 *
 * Every function takes the config path as a parameter (defaulting to the
 * platform {@link configPath}) so the store is unit-testable against a temp file
 * without the real platform paths.
 *
 * The "stack" plugin reads `plugins.stack.repos` — an array of local git repo
 * paths. {@link validateRepoPath} lets a GUI/CLI check a path before adding it
 * to that array (the caller computes the new array and sends it via
 * {@link updateConfig}); core keeps the API general rather than offering
 * per-repo RPCs.
 */
import { access, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  configSchema,
  legacyJsonPath,
  loadConfig,
  serializeConfig,
  type PerchConfig,
} from "./config.js";
import { configPath as defaultConfigPath } from "./paths.js";

/** A JSON-mergeable patch: same shape as a partial config; `null` deletes a key. */
export type ConfigPatch = Record<string, unknown>;

/** Result of {@link validateRepoPath}: whether `path` is a usable git repo. */
export interface RepoPathValidation {
  /** True iff the path exists and looks like a git repository. */
  ok: boolean;
  /** Human-readable explanation when `ok` is false. */
  reason?: string;
}

/**
 * Read and validate the current config from `path` (defaults to the platform
 * config path). A missing file yields {@link defaultConfig} — same semantics as
 * {@link loadConfig}, re-exposed here as the store's read primitive.
 */
export async function getConfig(path: string = defaultConfigPath()): Promise<PerchConfig> {
  return loadConfig(path);
}

/**
 * Deep-merge `patch` into the current config, validate, and write it back
 * atomically; returns the new, validated config.
 *
 * Merge semantics ({@link deepMerge}):
 * - Plain objects merge recursively, key by key.
 * - A `null` value deletes that key from the result (so a GUI can remove
 *   `plugins.stack` or `layout` by patching it to `null`).
 * - Any other value (string, number, boolean, array) **replaces** the existing
 *   value wholesale — arrays are never element-merged, so the caller sends the
 *   full desired `plugins.stack.repos` array.
 *
 * The merged object is parsed through {@link configSchema}; an invalid result
 * throws before any write, so a bad patch never corrupts `perch.yaml`. The write
 * goes to a sibling temp file then `rename`s over the target (atomic on POSIX),
 * which the {@link ConfigWatcher} picks up to drive the normal reload path — this
 * function never triggers a reload itself.
 */
export async function updateConfig(
  patch: ConfigPatch,
  path: string = defaultConfigPath(),
): Promise<PerchConfig> {
  const current = await loadConfig(path);
  const merged = deepMerge(current as Record<string, unknown>, patch);

  const result = configSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`perch: config.update produced invalid config:\n${issues}`);
  }

  await writeAtomic(path, serializeConfig(result.data));
  return result.data;
}

/**
 * One-time YAML migration: if the durable `perch.yaml` at `path` is absent but a
 * legacy sibling `perch.json` (the pre-YAML format) exists, rewrite the config to
 * `path` as YAML via the atomic writer, so the durable file becomes YAML going
 * forward. The legacy `perch.json` is intentionally left in place — it's simply
 * ignored once `perch.yaml` exists. No-op (returns false) if `perch.yaml` already
 * exists or there's no legacy file to migrate.
 */
export async function migrateLegacyConfig(path: string = defaultConfigPath()): Promise<boolean> {
  if (await pathExists(path)) return false;
  const legacy = legacyJsonPath(path);
  if (legacy === path || !(await pathExists(legacy))) return false;
  // updateConfig reads via loadConfig (which falls back to the legacy file) and
  // writes the result to `path` as YAML — an empty patch makes it a pure rewrite.
  await updateConfig({}, path);
  return true;
}

/** True iff `path` exists and is accessible. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate that `path` is a usable git repo for the stack plugin: it must exist,
 * be a directory, and contain a `.git` entry (a directory in a normal clone, or
 * a file in a worktree/submodule). Returns `{ ok, reason? }` rather than throwing
 * so a GUI can render the failure inline.
 */
export async function validateRepoPath(path: string): Promise<RepoPathValidation> {
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: `path does not exist: ${path}` };
    }
    return { ok: false, reason: `cannot access path: ${errorMessage(err)}` };
  }

  if (!info.isDirectory()) {
    return { ok: false, reason: `not a directory: ${path}` };
  }

  try {
    // `.git` is a directory in a normal clone, a file in a worktree/submodule.
    await stat(join(path, ".git"));
  } catch {
    return { ok: false, reason: `not a git repository (no .git): ${path}` };
  }

  return { ok: true };
}

/**
 * Recursively merge `patch` into `base`. A `null` patch value deletes the key;
 * a plain-object value merges into the matching object (or replaces a non-object
 * base); any other value replaces. Pure — neither argument is mutated.
 */
function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
    } else if (isPlainObject(value)) {
      const existing = out[key];
      out[key] = isPlainObject(existing) ? deepMerge(existing, value) : deepMerge({}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** True for a non-null, non-array plain object (recursable in {@link deepMerge}). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Write `contents` to `path` atomically: write a sibling temp file, then rename
 * it over the target. The rename is atomic on POSIX, so a reader (the watcher)
 * sees either the old or the new file, never a partial write.
 */
async function writeAtomic(path: string, contents: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, path);
}

/** Structured `unknown`-error → message. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
