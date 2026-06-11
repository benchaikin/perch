/**
 * Electron-free logic for the Settings window's repo list.
 *
 * The stack plugin's configured repos live at `config.plugins.stack.repos`: an
 * array of local repo paths where the basename is the display name and the
 * first entry is the default. The Settings window lets the user add / remove /
 * set-default; this module computes the resulting array (and derives the
 * display rows) so the pure transforms are unit-testable without a display.
 *
 * All mutators are pure: they take the current array and return a new one,
 * normalizing along the way (trim, drop empties, de-duplicate).
 */
import { basename } from "node:path";
import type { PerchConfig } from "@perch/core";

/** One repo as shown in the Settings list. */
export interface RepoEntry {
  /** Absolute local path to the repo (the stored value). */
  path: string;
  /** Display name — the path's basename. */
  name: string;
  /** True for the first repo (the stack's default). */
  isDefault: boolean;
}

/** Shape of the stack plugin's config section we care about. */
interface StackConfig {
  repos?: unknown;
}

/** Read `plugins.stack.repos` out of a parsed config as a clean string array. */
export function reposFromConfig(config: PerchConfig): string[] {
  const stack = (config.plugins?.stack ?? undefined) as StackConfig | undefined;
  const repos = stack?.repos;
  if (!Array.isArray(repos)) return [];
  return normalize(repos.filter((r): r is string => typeof r === "string"));
}

/** Derive the display rows (name + default flag) from a repos array. */
export function toEntries(repos: string[]): RepoEntry[] {
  return repos.map((path, i) => ({ path, name: basename(path), isDefault: i === 0 }));
}

/**
 * Trim each path, drop empties, and de-duplicate while preserving order (first
 * occurrence wins, so the default — the first entry — is stable).
 */
function normalize(repos: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of repos) {
    const path = raw.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/** Append `path` to the repos array (no-op if already present after normalizing). */
export function addRepo(repos: string[], path: string): string[] {
  return normalize([...repos, path]);
}

/** Remove `path` from the repos array (no-op if absent). */
export function removeRepo(repos: string[], path: string): string[] {
  const target = path.trim();
  return normalize(repos.filter((r) => r.trim() !== target));
}

/**
 * Move `path` to the front (making it the default). No-op if `path` isn't in
 * the array; the rest keep their relative order.
 */
export function setDefault(repos: string[], path: string): string[] {
  const target = path.trim();
  const list = normalize(repos);
  if (!list.includes(target)) return list;
  return [target, ...list.filter((r) => r !== target)];
}
