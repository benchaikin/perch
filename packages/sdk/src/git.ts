/**
 * Shared git binary path — the `git` executable Perch shells out to, used by
 * every plugin that runs git (attribution, dex spawn/land, worktree open/list,
 * stack actions). Lives in the SDK so the machine-level "which git" choice is
 * authored against one config shape + one reader, set once, and applied
 * everywhere — instead of each plugin carrying its own copy.
 *
 * The config is the cross-plugin global setting `global.git` ({ gitBin }); read
 * it from `ctx.global` via {@link gitConfigOf}.
 */
import { z } from "zod";

import type { SettingsField } from "./index.js";

/** The cross-plugin git preference (lives at `global.git`). */
export const GlobalGitConfig = z.object({
  /** Path to the `git` binary; empty/unset ⇒ resolve `git` on PATH. */
  gitBin: z.string().optional(),
});
export type GlobalGitConfig = z.infer<typeof GlobalGitConfig>;

/**
 * The settings fields the "General" tab renders for the git preference. Keyed
 * under `git.*` (the General tab writes to `global.git`).
 */
export const GIT_SETTINGS_FIELDS: SettingsField[] = [
  {
    key: "git.gitBin",
    type: "string",
    label: "git binary path",
    description:
      "Path to the git executable Perch shells out to — used everywhere it runs git " +
      "(commit attribution, dex spawn/land, opening/listing worktrees, and stack actions). " +
      "Leave as git to resolve it on your PATH.",
    default: "git",
  },
];

/** Narrow `ctx.global` to the git settings at `global.git`; {} on miss. */
export function gitConfigOf(global: unknown): GlobalGitConfig {
  const g = global && typeof global === "object" ? (global as Record<string, unknown>) : {};
  const parsed = GlobalGitConfig.safeParse(g.git ?? {});
  return parsed.success ? parsed.data : {};
}
