/**
 * Per-repo targeting helpers (v1.1 "repo switcher").
 *
 * The stack plugin's config carries an optional `repos: string[]` — a list of
 * **local repo paths**. Each repo's display **name** is the basename of its
 * path; the **default** repo is the first entry. These helpers turn that config
 * into the `stack.repos` read's output and resolve a requested repo (by name or
 * by path) down to the cwd that `gh`/`git` should run in.
 *
 * Everything here is pure (no I/O), so it is exhaustively unit-testable.
 */
import { basename } from "node:path";

import { z } from "@perch/sdk";

/** One configured repo as surfaced to the CLI/GUI switcher. */
export const RepoEntry = z.object({
  /** Display name — the basename of the repo's path. */
  name: z.string(),
  /** Absolute/relative local path to the repo (used as the `gh`/`git` cwd). */
  path: z.string(),
});
export type RepoEntry = z.infer<typeof RepoEntry>;

/** Output of the `stack.repos` read: the configured repos + the default name. */
export const ReposResult = z.object({
  /** Configured repos, in config order (index 0 = default). */
  repos: z.array(RepoEntry),
  /** Name of the default repo (the first entry), if any are configured. */
  default: z.string().optional(),
});
export type ReposResult = z.infer<typeof ReposResult>;

/** Project a list of configured repo paths onto named {@link RepoEntry} rows. */
export function toRepoEntries(repos: string[] | undefined): RepoEntry[] {
  return (repos ?? []).map((path) => ({ name: basename(path), path }));
}

/** Build the `stack.repos` read result from configured paths. */
export function reposResult(repos: string[] | undefined): ReposResult {
  const entries = toRepoEntries(repos);
  return { repos: entries, default: entries[0]?.name };
}

/**
 * Resolve a requested repo (by **name** or by **path**) to the cwd `gh`/`git`
 * should run in, given the configured repo paths:
 *
 * - No repos configured → `undefined` (caller falls back to `process.cwd()`,
 *   preserving the single-repo back-compat behavior).
 * - A `requested` that matches an entry by path or by basename name → its path.
 * - A `requested` that matches nothing, or is omitted → the default (first)
 *   repo's path.
 */
export function resolveRepoCwd(
  repos: string[] | undefined,
  requested: string | undefined,
): string | undefined {
  const entries = toRepoEntries(repos);
  if (entries.length === 0) {
    return undefined;
  }
  if (requested !== undefined) {
    const match = entries.find((e) => e.path === requested || e.name === requested);
    if (match) {
      return match.path;
    }
  }
  // No (or unmatched) request → the default repo.
  return entries[0]!.path;
}
