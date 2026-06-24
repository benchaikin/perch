/**
 * The `worktrees.resolve` action's machinery: launch an interactive Claude Code
 * agent in an *existing* conflicted worktree, seeded to resolve its merge
 * conflicts. The renderer's WorktreesAlertWidget wires its "Resolve" button to
 * this, so a conflicted worktree surfaced as an alert can be handed to an agent
 * with one click.
 *
 * Unlike `stack.resolve-conflicts` (which checks out a PR branch in a fresh
 * worktree) the worktree already exists on disk — the agent just launches in it.
 * Reuses the SDK's shared agent-spawn primitives so every spawn flow shares one
 * launch command + terminal behavior (title, tab color, raise-or-spawn focus).
 */
import { basename } from "node:path";

import { buildAgentLaunchCommand, dexTaskColorRgb, type GlobalAgentConfig } from "@perch/sdk";

import { parseDexTaskId } from "./parse.js";

/** The `worktrees.resolve` action input. */
export interface ResolveInput {
  /** The conflicted worktree's absolute path — the agent launches here. */
  path: string;
  /** The worktree's branch, used only for the agent window's title/tab color. */
  branch?: string;
}

/**
 * The short bootstrap prompt seeding the conflict-resolution agent. It works the
 * worktree it's launched in, so it discovers the in-progress operation and the
 * conflicted files itself; we only point it at the no-push/no-merge boundary.
 */
export function resolvePrompt(): string {
  return (
    "This git worktree has unresolved merge conflicts. Resolve them so the tree is clean:\n" +
    "1. Run `git status` to see the in-progress operation (merge/rebase/cherry-pick) and the conflicted files.\n" +
    "2. Resolve every conflicted file, then stage them.\n" +
    "3. Continue the operation (`git rebase --continue` / `git merge --continue`, etc.).\n" +
    "4. Verify the result with the project's build/test/lint. Do NOT push or merge — leave that to the user."
  );
}

/**
 * The agent window's title: `resolve conflicts · <branch>` when the branch is
 * known, else `resolve conflicts · <name>` (the worktree basename) — so a row of
 * agent windows stays self-identifying, mirroring the dex spawn's `dex <id> · …`.
 */
export function resolveTitle(input: ResolveInput): string {
  const tail = input.branch?.trim() || basename(input.path);
  return `resolve conflicts · ${tail}`;
}

/**
 * The stable identity color for a resolve window's terminal tab: keyed off the
 * branch's dex task id when it's a `dex/<id>` branch (so the window matches that
 * task's color everywhere else), else the branch name, else the worktree path.
 */
export function resolveTabColor(input: ResolveInput): ReturnType<typeof dexTaskColorRgb> {
  const branch = input.branch?.trim();
  const key = (branch && parseDexTaskId(branch)) || branch || input.path;
  return dexTaskColorRgb(key);
}

/** Build the `cd … && exec claude …` launch line for a resolve agent. */
export function resolveLaunchCommand(input: ResolveInput, agent?: GlobalAgentConfig): string {
  return buildAgentLaunchCommand(input.path, resolvePrompt(), agent);
}
