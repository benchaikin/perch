/**
 * The `stack.resolve-conflicts` action's machinery: spin up an interactive
 * Claude Code agent in a worktree checked out on a *conflicting* PR's head
 * branch, seeded to rebase the branch onto its base, resolve the conflicts,
 * verify, and push — so a conflicting PR can be unblocked from the My PRs panel
 * with one click. (Perch never auto-merges; this only clears the conflict so the
 * user can merge once the PR is green.)
 *
 * The complement of the hero `sync` action, which deliberately STOPS on a
 * conflict ("resolve manually, then re-run sync"). Where `dex.spawn` creates a
 * NEW `dex/<id>-<slug>` branch, this checks out an EXISTING PR head branch.
 *
 * Reuses the SDK's shared agent-spawn primitives — {@link buildAgentLaunchCommand}
 * (the `cd … && exec claude …` line) and {@link spawnInTerminal} (with the same
 * title + tab-color + raise-or-spawn focus marker the dex spawn uses). The impure
 * edges — the `git` CLI ({@link Exec}) and the terminal spawn — are seams, so the
 * pure bits (worktree path, git args, the prompt, the launch command) unit-test
 * directly with stubs.
 */
import { type spawn as nodeSpawn } from "node:child_process";

import { parseDexTaskId } from "@perch/plugin-worktrees";
import {
  buildAgentLaunchCommand,
  dexTaskColorRgb,
  spawnInTerminal,
  type GlobalTerminalConfig,
} from "@perch/sdk";

import type { Exec } from "./provider.js";
import {
  parseWorktreeForBranch,
  resolveOrCreateWorktree,
  sanitizeBranchForPath,
  worktreeAddArgs,
  worktreeListArgs,
  worktreePathFor,
} from "./worktree.js";

// Re-export the shared worktree primitives from their historical home so the
// action's tests and any external importers keep resolving them here.
export {
  parseWorktreeForBranch,
  sanitizeBranchForPath,
  worktreeAddArgs,
  worktreeListArgs,
  worktreePathFor,
};

/** The `stack.resolve-conflicts` action input. */
export interface ResolveConflictsInput {
  /** The conflicting PR's head branch (the branch to check out + fix). */
  headRefName: string;
  /** The base branch the PR merges into (what to rebase onto). Optional on the
   *  CLI; the GUI always supplies it from the PR row. */
  baseRefName?: string;
  /** The PR number, used only for the agent window's title/messaging. */
  number?: number;
  /** Configured repo selector (name or path) — resolved to a cwd by the caller. */
  repo?: string;
}

/** The `stack.resolve-conflicts` action result, surfaced to every surface. */
export interface ResolveConflictsResult {
  ok: boolean;
  message: string;
  /** The worktree the agent launched in, present on success. */
  worktreePath?: string;
  /** True when an existing worktree for the branch was reused rather than created. */
  reused?: boolean;
}

/**
 * The short bootstrap prompt seeding the conflict-resolution agent. It pulls its
 * own context; we only point it at the right base and the no-merge boundary. When
 * the base is unknown (CLI invocation without `--base-ref-name`), it tells the
 * agent to determine the PR's base itself.
 */
export function conflictPrompt(input: ResolveConflictsInput): string {
  const base = input.baseRefName?.trim();
  const baseClause = base ? `its base \`${base}\`` : "its base branch (check the PR for it)";
  const rebaseClause = base ? `git rebase origin/${base}` : "git rebase onto the PR's base";
  return (
    `The pull request on branch \`${input.headRefName}\` has a merge conflict against ` +
    `${baseClause}. You are in a fresh git worktree checked out on \`${input.headRefName}\`. ` +
    `Resolve the conflict so the PR can merge:\n` +
    `1. \`git fetch origin\`.\n` +
    `2. Rebase onto the base (\`${rebaseClause}\`; use a merge instead if a rebase gets messy), ` +
    `resolving every conflict.\n` +
    `3. Verify the result with the project's build/test/lint.\n` +
    `4. Push the resolved branch (\`git push --force-with-lease\` after a rebase). Do NOT merge ` +
    `the PR — leave that to the user once CI is green.`
  );
}

/**
 * The agent window's title: `fix conflicts · #<number>` when the PR number is
 * known, else `fix conflicts · <branch>` — so a row of agent windows stays
 * self-identifying, mirroring the dex spawn's `dex <id> · <name>`.
 */
export function agentTitle(input: ResolveConflictsInput): string {
  const tail = input.number !== undefined ? `#${input.number}` : input.headRefName;
  return `fix conflicts · ${tail}`;
}

/** Dependencies for {@link runResolveConflicts} — the seams the action injects. */
export interface ResolveConflictsDeps {
  /** The concrete repo directory (the resolved repo cwd, or `process.cwd()`). */
  repoDir: string;
  /** Injected command runner (tests stub it); defaults to a real `git` spawn. */
  exec?: Exec;
  /** The git binary to run. */
  gitBin: string;
  /** The terminal preference (from `terminalConfigOf(ctx.global)`). */
  terminal: GlobalTerminalConfig;
  /** Injected terminal spawn (tests stub it). */
  spawn?: typeof nodeSpawn;
  /** Injected script writer for the terminal launcher (tests stub it). */
  writeScript?: (label: string, command: string) => string;
  log?: (message: string) => void;
}

/**
 * Check out the conflicting PR's branch in a worktree and launch a seeded
 * `claude` agent there to resolve the conflict. Never throws: every failure (no
 * branch, git error, terminal error) returns a clear `{ ok:false, message }`, and
 * nothing is half-created — the agent launches only once the worktree exists.
 *
 * Reuses an existing worktree for the branch when one is already checked out
 * (e.g. the PR was itself spawned from a dex task): the launch uses the worktree
 * path as a focus marker, so on a focus-capable terminal it raises that live
 * agent window instead of opening a second shell on top of it.
 */
export async function runResolveConflicts(
  input: ResolveConflictsInput,
  deps: ResolveConflictsDeps,
): Promise<ResolveConflictsResult> {
  const headRef = input.headRefName?.trim();
  if (!headRef) {
    return { ok: false, message: "no head branch given; can't resolve conflicts." };
  }

  const resolved = await resolveOrCreateWorktree(headRef, {
    repoDir: deps.repoDir,
    exec: deps.exec,
    gitBin: deps.gitBin,
    log: deps.log,
  });
  if (!resolved.ok) {
    return { ok: false, message: resolved.message };
  }
  const { worktreePath, reused } = resolved;

  const launched = spawnInTerminal({
    command: buildAgentLaunchCommand(worktreePath, conflictPrompt(input)),
    terminal: deps.terminal,
    label: `resolve ${headRef}`,
    title: agentTitle(input),
    // Tint the window by the branch's identity color (a stable per-branch hue).
    // For a dex-encoded branch, key off the bare task id so the window matches
    // the dex task's color everywhere else (GUI chip + the dex-spawn terminal);
    // a non-dex branch falls back to the full headRef, unchanged.
    tabColor: dexTaskColorRgb(parseDexTaskId(headRef) ?? headRef),
    // Tag the window with the worktree path so a later launch (or a "jump to
    // agent") raises THIS live session rather than opening a new shell on it.
    focusMarker: worktreePath,
    log: deps.log,
    spawn: deps.spawn,
    writeScript: deps.writeScript,
  });
  if (!launched.ok) {
    const created = reused ? "reused worktree" : `created worktree at ${worktreePath}`;
    return { ok: false, message: `${created}, but ${launched.message}`, worktreePath, reused };
  }

  const where = reused ? `existing worktree ${worktreePath}` : worktreePath;
  return {
    ok: true,
    message: `Spawned an agent to resolve conflicts on ${headRef} in ${where}.`,
    worktreePath,
    reused,
  };
}
