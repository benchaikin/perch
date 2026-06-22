/**
 * The `stack.open-agent` action's machinery: drop into a live, agenda-free
 * Claude Code session in a worktree checked out on a PR's head branch. Unlike
 * `dex.spawn` (seeds a task) and `stack.resolve-conflicts` (seeds a rebase +
 * conflict prompt), this launches `claude --permission-mode auto` with NO seed
 * prompt — a one-click "open an agent here, no agenda" entry point for ad-hoc
 * work on any PR's branch.
 *
 * Reuses the shared worktree primitives ({@link resolveOrCreateWorktree}) and the
 * SDK's agent-spawn seam ({@link spawnInTerminal} + {@link buildAgentLaunchCommand}
 * with no prompt). The impure edges — the `git` CLI ({@link Exec}) and the
 * terminal spawn — are injected seams, so the pure bits (title, launch command)
 * unit-test directly with stubs.
 */
import { type spawn as nodeSpawn } from "node:child_process";

import { parseDexTaskId } from "@perch/plugin-worktrees";
import {
  buildAgentLaunchCommand,
  dexTaskColorRgb,
  spawnInTerminal,
  type GlobalAgentConfig,
  type GlobalTerminalConfig,
} from "@perch/sdk";

import type { Exec } from "./provider.js";
import { resolveOrCreateWorktree } from "./worktree.js";

/** The `stack.open-agent` action input. */
export interface OpenAgentInput {
  /** The PR's head branch to check out + open the session on. */
  headRefName: string;
  /** The PR number, used only for the agent window's title/messaging. */
  number?: number;
  /** Configured repo selector (name or path) — resolved to a cwd by the caller. */
  repo?: string;
}

/** The `stack.open-agent` action result, surfaced to every surface. */
export interface OpenAgentResult {
  ok: boolean;
  message: string;
  /** The worktree the agent launched in, present on success. */
  worktreePath?: string;
  /** True when an existing worktree for the branch was reused rather than created. */
  reused?: boolean;
}

/**
 * The agent window's title: `agent · #<number>` when the PR number is known, else
 * `agent · <branch>` — so a row of agent windows stays self-identifying,
 * mirroring the resolve-conflicts spawn's `fix conflicts · #<n>`.
 */
export function agentTitle(input: OpenAgentInput): string {
  const tail = input.number !== undefined ? `#${input.number}` : input.headRefName;
  return `agent · ${tail}`;
}

/** Dependencies for {@link runOpenAgent} — the seams the action injects. */
export interface OpenAgentDeps {
  /** The concrete repo directory (the resolved repo cwd, or `process.cwd()`). */
  repoDir: string;
  /** Injected command runner (tests stub it); defaults to a real `git` spawn. */
  exec?: Exec;
  /** The git binary to run. */
  gitBin: string;
  /** The terminal preference (from `terminalConfigOf(ctx.global)`). */
  terminal: GlobalTerminalConfig;
  /** The agent-spawn defaults — model + permission mode (from `agentConfigOf(ctx.global)`). */
  agent?: GlobalAgentConfig;
  /** Injected terminal spawn (tests stub it). */
  spawn?: typeof nodeSpawn;
  /** Injected script writer for the terminal launcher (tests stub it). */
  writeScript?: (label: string, command: string) => string;
  log?: (message: string) => void;
}

/**
 * Check out the PR's branch in a worktree and launch an agenda-free `claude`
 * session there (auto mode, no seed prompt — the agent waits for the user).
 * Never throws: every failure (no branch, git error, terminal error) returns a
 * clear `{ ok:false, message }`, and nothing is half-created — the agent launches
 * only once the worktree exists.
 *
 * Reuses an existing worktree for the branch when one is already checked out
 * (e.g. the PR was spawned from a dex task or had its conflicts resolved): the
 * launch uses the worktree path as a focus marker, so on a focus-capable
 * terminal it raises that live agent window instead of opening a second shell.
 */
export async function runOpenAgent(
  input: OpenAgentInput,
  deps: OpenAgentDeps,
): Promise<OpenAgentResult> {
  const headRef = input.headRefName?.trim();
  if (!headRef) {
    return { ok: false, message: "no head branch given; can't open an agent." };
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
    // No prompt — buildAgentLaunchCommand emits `cd … && exec claude
    // --permission-mode <mode>` (the configured mode, default auto) with nothing
    // after it, dropping straight into a live interactive session.
    command: buildAgentLaunchCommand(worktreePath, undefined, deps.agent),
    terminal: deps.terminal,
    label: `agent ${headRef}`,
    title: agentTitle(input),
    // Tint the window by the branch's identity color (a stable per-branch hue),
    // matching how the dex spawn + resolve-conflicts tint their windows. For a
    // dex-encoded branch, key off the bare task id so the window matches the dex
    // task's color everywhere else; a non-dex branch falls back to the full
    // headRef, unchanged.
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
    message: `Opened an agent session on ${headRef} in ${where}.`,
    worktreePath,
    reused,
  };
}
