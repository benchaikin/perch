/**
 * The `dex.new` action's machinery: spawn a Claude Code agent IN A DEX REPO's
 * directory, seeded to turn a free-form description into a well-formed dex task
 * (it reads the code, then runs `dex create`). The complement of `dex.spawn` —
 * where spawn launches an agent FOR an existing task, this launches one to
 * CREATE a task.
 *
 * The agent runs with its cwd set to the target repo so its `dex create` writes
 * to that repo's `.dex` store with no `--storage-path` (dex resolves the store
 * from cwd). The repo is resolved the same way `dex.spawn`/`dex.tasks` resolve
 * theirs — an explicit `repo` path, else a `project` basename mapped against the
 * configured repos (reusing {@link resolveRepo}), else the sole configured repo,
 * else the daemon's own cwd store.
 *
 * The impure edges — the terminal `spawn` — are seams, so the pure bits (the repo
 * resolution, the bootstrap prompt, the window title, the launch command) unit-test
 * directly with stubs, mirroring `spawn.ts`.
 */
import type { spawn as nodeSpawn } from "node:child_process";

import {
  buildAgentLaunchCommand,
  spawnInTerminal,
  type GlobalTerminalConfig,
} from "@perch/sdk";

import { resolveRepo } from "./spawn.js";

/** The `dex.new` action input. */
export interface NewInput {
  /** Free-form description of the task to create; an agent expands it into a task. */
  description: string;
  /** Explicit repo path override (the repo whose `.dex` store the task lands in). */
  repo?: string;
  /**
   * A project basename to target (resolved against the configured repos, same as
   * `dex.spawn`'s project mapping). The GUI passes this when more than one dex repo
   * has tasks, so the target store is unambiguous.
   */
  project?: string;
}

/** The `dex.new` action result, surfaced to every projected surface. */
export interface NewResult {
  ok: boolean;
  message: string;
  /** The directory the author agent launched in, present only on success. */
  repo?: string;
}

/** Dependencies for {@link runNew} — the seams the action injects, tests stub. */
export interface NewDeps {
  /** The monitored project roots, in `global.repos` order (each carries a `.dex/`). */
  repos: string[];
  /**
   * The directory to launch in when no repo resolves (no explicit repo/project and
   * no configured repos) — the daemon's own cwd, whose `.dex` store `dex.tasks`
   * reads in that fallback. The action injects `process.cwd()`.
   */
  cwd: string;
  /** The terminal preference (from `terminalConfigOf(ctx.global)`). */
  terminal: GlobalTerminalConfig;
  /** Injected terminal spawn (tests stub it). */
  spawn?: typeof nodeSpawn;
  /** Injected script writer for the terminal launcher (tests stub it). */
  writeScript?: (label: string, command: string) => string;
  log?: (message: string) => void;
}

/**
 * Resolve which directory the author agent should run in (its cwd = the repo
 * whose `.dex` store the new task lands in). An explicit `input.repo` wins; else a
 * `input.project` basename maps against the configured repos (reusing
 * {@link resolveRepo}); else, with exactly one configured repo, that repo; else
 * `{ repo: undefined }` (no repos configured → the caller's cwd store). With
 * multiple configured repos and no project/repo given, the target is ambiguous —
 * a clean `error` rather than a guess.
 */
export function resolveNewRepo(
  input: { repo?: string; project?: string },
  repos: string[],
): { repo: string | undefined } | { error: string } {
  if (input.repo) return { repo: input.repo };
  if (input.project) return resolveRepo({}, input.project, repos);
  if (repos.length === 1) return { repo: repos[0]! };
  if (repos.length === 0) return { repo: undefined };
  return {
    error:
      "multiple dex repos are configured; specify which to create the task in (a project or repo).",
  };
}

/**
 * The bootstrap prompt for the author agent: it reads the relevant code, then
 * runs `dex create` in the repo to write a well-formed task. The agent's cwd IS
 * the repo, so `dex create` targets the right store with no `--storage-path`. The
 * description is embedded verbatim (the launcher shell-quotes the whole prompt, so
 * backticks/quotes inside it don't expand).
 */
export function newTaskPrompt(description: string): string {
  return (
    `Here is a rough description of a task to create:\n\n${description}\n\n` +
    `Turn it into a SINGLE well-formed dex task for THIS repository (your cwd). First ` +
    `read the relevant code to ground the task in how things actually work here — find ` +
    `the real reuse points, the files to touch, and the gotchas. Then create the task by ` +
    `running \`dex create\` in this directory (so it lands in this repo's .dex store), ` +
    `giving it a concise imperative name and a rich description that follows this repo's ` +
    `existing task conventions: the WHY, the key design, reuse pointers, guards/edge ` +
    `cases, and acceptance criteria. After creating it, run \`dex show <id> --full\` to ` +
    `verify it was created and reads well. Do NOT implement the task — only author it.`
  );
}

/**
 * The window title for the author agent: `dex new · <description snippet>`,
 * trimmed to a readable length (whitespace collapsed), falling back to a bare
 * `dex new` when the description has no usable text. Mirrors `spawn.ts`'s
 * {@link agentTitle} so a row of agent windows stays self-identifying.
 */
export function newTaskTitle(description: string, maxLength = 40): string {
  const trimmed = description.trim().replace(/\s+/g, " ");
  if (!trimmed) return "dex new";
  const short =
    trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1).trimEnd()}…` : trimmed;
  return `dex new · ${short}`;
}

/**
 * Spawn a Claude agent in the target dex repo, seeded to author a new task from
 * `input.description`. Never throws: an empty description, an ambiguous repo, or a
 * terminal-launch error returns a clean `{ ok:false, message }`. The agent runs in
 * AUTO MODE (like the other agent launches), in the repo dir so its `dex create`
 * writes to the right store. The created task is asynchronous — it appears on the
 * panel's next `dex.tasks` refresh, not immediately.
 */
export async function runNew(input: NewInput, deps: NewDeps): Promise<NewResult> {
  const description = input.description?.trim() ?? "";
  if (!description) {
    return { ok: false, message: "a task description is required." };
  }

  const resolved = resolveNewRepo(
    { repo: input.repo?.trim() || undefined, project: input.project?.trim() || undefined },
    deps.repos,
  );
  if ("error" in resolved) return { ok: false, message: resolved.error };
  const dir = resolved.repo ?? deps.cwd;

  const launched = spawnInTerminal({
    command: buildAgentLaunchCommand(dir, newTaskPrompt(description)),
    terminal: deps.terminal,
    label: "dex new",
    // Title the window with a description snippet so a row of author windows is
    // identifiable at a glance (mirrors the dex-spawn `dex <id> · <name>` title).
    title: newTaskTitle(description),
    log: deps.log,
    spawn: deps.spawn,
    writeScript: deps.writeScript,
  });
  if (!launched.ok) {
    return { ok: false, message: launched.message };
  }

  return {
    ok: true,
    message: `Spawned an agent in ${dir} to author the task; it'll appear on the next refresh.`,
    repo: dir,
  };
}
