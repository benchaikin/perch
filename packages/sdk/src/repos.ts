/**
 * Shared repository list — the user's set of repo directories, used by any
 * plugin that operates over "all my repos" (the PRs/stack view, worktrees, dex).
 * Lives in the SDK so every plugin authors against one config shape + one
 * reader, instead of each rolling its own.
 *
 * The config is the cross-plugin global setting `global.repos` (an array of
 * absolute repo directory paths); read it from `ctx.global` via {@link reposOf}.
 */
import { z } from "zod";

/** The cross-plugin repo list (lives at `global.repos`). */
export const GlobalReposConfig = z.object({
  /** Absolute repo directory paths the user works across. */
  repos: z.array(z.string()).optional(),
});
export type GlobalReposConfig = z.infer<typeof GlobalReposConfig>;

/**
 * Narrow `ctx.global` to the repo list at `global.repos`; [] on miss. The result
 * is cleaned for consumers: each entry trimmed, blanks dropped, duplicates
 * removed (first-seen order preserved). Paths are not resolved or checked for
 * existence — plugins degrade gracefully on bad paths.
 */
export function reposOf(global: unknown): string[] {
  const g = global && typeof global === "object" ? (global as Record<string, unknown>) : {};
  const parsed = GlobalReposConfig.safeParse({ repos: g.repos });
  if (!parsed.success || !parsed.data.repos) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of parsed.data.repos) {
    const path = entry.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}
