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
import { basename, dirname, join } from "node:path";
import { execFile, type spawn as nodeSpawn } from "node:child_process";

import {
  buildAgentLaunchCommand,
  dexTaskColorRgb,
  spawnInTerminal,
  type GlobalTerminalConfig,
} from "@perch/sdk";

import type { Exec } from "./provider.js";

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
 * Make a branch name safe to use as a single path segment: lowercase isn't
 * forced (branch names are case-sensitive), but a branch can contain `/`
 * (`dex/abc-foo`, `feat/x`) and other separators, which would otherwise nest or
 * escape the worktrees dir. Collapse every run of non-`[A-Za-z0-9._]` to a single
 * `-` and trim leading/trailing hyphens. Returns `"branch"` if nothing usable
 * remains (so the path is always well-formed).
 */
export function sanitizeBranchForPath(branch: string): string {
  const safe = branch
    .replace(/[^A-Za-z0-9._]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return safe || "branch";
}

/**
 * The worktree path for resolving a branch's conflicts: a sibling of the repo
 * named `<repo>-worktrees/<sanitized-branch>`, matching the dex spawn's sibling
 * convention so all of Perch's spawned worktrees live in one place and are easy
 * to spot.
 */
export function worktreePathFor(repoDir: string, branch: string): string {
  const worktreesDir = join(dirname(repoDir), `${basename(repoDir)}-worktrees`);
  return join(worktreesDir, sanitizeBranchForPath(branch));
}

/**
 * The args for `git -C <repoDir> worktree add <path> <branch>` — checking out an
 * EXISTING branch (no `-b`), unlike the dex spawn which creates a new branch.
 * git's own DWIM creates a local tracking branch from `origin/<branch>` when the
 * branch isn't yet local (the common case for a teammate-less PR it still is).
 */
export function worktreeAddArgs(repoDir: string, path: string, branch: string): string[] {
  return ["-C", repoDir, "worktree", "add", path, branch];
}

/** The args for `git -C <repoDir> worktree list --porcelain`. */
export function worktreeListArgs(repoDir: string): string[] {
  return ["-C", repoDir, "worktree", "list", "--porcelain"];
}

/**
 * Scan `git worktree list --porcelain` output for an existing worktree whose
 * checked-out branch is `branch`, returning its path (or `undefined` if none).
 * The porcelain format is blank-line-separated records, each starting with a
 * `worktree <path>` line; a `branch refs/heads/<name>` line names the branch
 * (absent for a detached HEAD). We match `refs/heads/<branch>` exactly so a
 * branch already checked out elsewhere is reused, not double-added (git refuses
 * to check the same branch out in two worktrees anyway).
 */
export function parseWorktreeForBranch(porcelain: string, branch: string): string | undefined {
  const wanted = `refs/heads/${branch}`;
  let currentPath: string | undefined;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      if (ref === wanted && currentPath) return currentPath;
    }
  }
  return undefined;
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

/** Default command runner: spawn a real `git` and resolve its stdout. */
const defaultExec: Exec = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, cwd: opts?.cwd },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });

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

  const exec = deps.exec ?? defaultExec;

  // Reuse an existing worktree for this branch rather than double-adding it (git
  // refuses to check the same branch out twice anyway). Best-effort: if the list
  // fails we just fall through to creating one, and let `worktree add` surface a
  // clearer error.
  let worktreePath: string | undefined;
  let reused = false;
  try {
    const list = await exec(deps.gitBin, worktreeListArgs(deps.repoDir));
    const existing = parseWorktreeForBranch(list, headRef);
    if (existing) {
      worktreePath = existing;
      reused = true;
      deps.log?.(`reusing existing worktree for ${headRef}: ${existing}`);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log?.(`couldn't list worktrees (continuing): ${detail}`);
  }

  if (!worktreePath) {
    const path = worktreePathFor(deps.repoDir, headRef);
    try {
      await exec(deps.gitBin, worktreeAddArgs(deps.repoDir, path, headRef));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: `couldn't create worktree at ${path} for branch ${headRef}: ${detail}`,
      };
    }
    worktreePath = path;
  }

  const launched = spawnInTerminal({
    command: buildAgentLaunchCommand(worktreePath, conflictPrompt(input)),
    terminal: deps.terminal,
    label: `resolve ${headRef}`,
    title: agentTitle(input),
    // Tint the window by the branch's identity color (a stable per-branch hue),
    // matching how the dex spawn tints by task id.
    tabColor: dexTaskColorRgb(headRef),
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
