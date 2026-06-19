/**
 * The `dex.spawn` action's machinery: create the `dex/<id>-<slug>` worktree for a
 * dex task and launch an interactive Claude Code agent in the user's terminal,
 * seeded for that task. Daemon-side; the GUI button is a separate surface.
 *
 * The TS here replicates the reference flow of `.claude/skills/dex-worktree`
 * (slug derivation, sibling `<repo>-worktrees/<id>-<slug>` path, base =
 * `origin/HEAD` → `main`) so the packaged daemon needs no skill scripts on disk.
 * The impure edges — the `dex`/`git` CLIs and the terminal `spawn` — are seams,
 * so the pure bits (slug, repo resolution, git args, the launch command) unit-test
 * directly with stubs.
 */
import { basename, dirname, isAbsolute, join } from "node:path";
import { appendFile, lstat, readFile, symlink } from "node:fs/promises";
import type { spawn as nodeSpawn } from "node:child_process";

import {
  buildAgentLaunchCommand,
  dexTaskColorRgb,
  spawnInTerminal,
  type GlobalTerminalConfig,
} from "@perch/sdk";

import type { DexStatus } from "./normalize.js";
import type { Exec } from "./provider.js";

/** The `dex.spawn` action input. */
export interface SpawnInput {
  /** The dex task id (lowercase-alphanumeric, per the branch convention). */
  id: string;
  /** Explicit repo path override; else the task's project maps to a `global.repos` path. */
  repo?: string;
}

/** The `dex.spawn` action result, surfaced to every projected surface. */
export interface SpawnResult {
  ok: boolean;
  message: string;
  /** The created worktree path, present only on success. */
  worktreePath?: string;
}

/**
 * Derive a short kebab slug from a task name, matching the reference helper's
 * logic (`.claude/skills/dex-worktree/create-dex-worktree.sh`): lowercase,
 * non-alphanumeric runs → a single hyphen, trim leading/trailing hyphens, and
 * keep only the first few words for a readable branch. Returns "" when the name
 * has no usable alphanumerics (the caller then falls back to a bare `dex/<id>`).
 */
export function deriveSlug(name: string, maxWords = 5): string {
  const kebab = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!kebab) return "";
  return kebab.split("-").slice(0, maxWords).join("-");
}

/** True when an id is the lowercase-alphanumeric form the branch parser recovers. */
export function isValidTaskId(id: string): boolean {
  return /^[a-z0-9]+$/.test(id);
}

/** The branch a task gets: `dex/<id>-<slug>`, or bare `dex/<id>` when the slug is empty. */
export function branchFor(id: string, slug: string): string {
  return slug ? `dex/${id}-${slug}` : `dex/${id}`;
}

/**
 * The worktree path a task gets: a sibling of the repo root named
 * `<repo>-worktrees/<id>-<slug>` (or `<id>-task` when the slug is empty), so
 * multiple dex worktrees don't collide and are easy to spot.
 */
export function worktreePathFor(repo: string, id: string, slug: string): string {
  const worktreesDir = join(dirname(repo), `${basename(repo)}-worktrees`);
  return join(worktreesDir, slug ? `${id}-${slug}` : `${id}-task`);
}

/**
 * Resolve the repo directory for a task. An explicit `input.repo` wins (used as
 * given). Otherwise the task's `project` (the basename the dex board groups by)
 * is matched against `repos` by basename: a single match resolves; none or
 * several is a clean failure (we don't guess). Returns the repo path on success,
 * or an `error` message describing why it couldn't be resolved.
 */
export function resolveRepo(
  input: { repo?: string },
  project: string | undefined,
  repos: string[],
): { repo: string } | { error: string } {
  if (input.repo) return { repo: input.repo };
  if (!project) {
    return {
      error: "couldn't determine the task's project; pass an explicit repo to spawn.",
    };
  }
  const matches = repos.filter((r) => basename(r) === project);
  if (matches.length === 1) return { repo: matches[0]! };
  if (matches.length === 0) {
    return {
      error: `no configured repo matches project "${project}"; add it to global.repos or pass an explicit repo.`,
    };
  }
  return {
    error: `project "${project}" is ambiguous (matches ${matches.length} repos); pass an explicit repo.`,
  };
}

/**
 * The args for `git -C <repo> worktree add -b <branch> <path> <base>` — creating
 * the worktree on a NEW branch matching the dex convention, based off the repo's
 * default branch.
 */
export function worktreeAddArgs(
  repo: string,
  branch: string,
  path: string,
  base: string,
): string[] {
  return ["-C", repo, "worktree", "add", "-b", branch, path, base];
}

/** A short bootstrap prompt for the spawned agent; it fetches its own full context. */
export function bootstrapPrompt(id: string): string {
  return (
    `Work on dex task ${id}. Run \`dex show ${id} --full\` for the full context, ` +
    `then implement it. Verify (build/test/lint), open a PR with the create-pr skill, ` +
    `and don't reference the dex id in commit messages or the PR.`
  );
}

/**
 * Build the inner command the terminal runs: cd into the worktree and `exec` an
 * interactive `claude` seeded with the bootstrap prompt. Modeled on
 * `worktrees/open`'s `buildShellInDir` — the path and prompt are shell-quoted, and
 * `exec` replaces the launcher's `sh` so Ctrl-C reaches `claude` directly.
 *
 * The session starts in auto mode (`--permission-mode auto`) so a freshly-spawned
 * agent can act without first toggling its permission mode by hand — the whole
 * point of spawning it is to let it run.
 *
 * Delegates to the SDK's {@link buildAgentLaunchCommand} so every agent-spawn
 * flow (dex spawn, stack resolve-conflicts) shares one launch command.
 */
export function buildClaudeLaunch(worktreePath: string, prompt: string): string {
  return buildAgentLaunchCommand(worktreePath, prompt);
}

/**
 * The window title for a spawned agent: `dex <id> · <name>`, trimmed to a
 * readable length, falling back to a bare `dex <id>` when the name has no usable
 * text. The id is always present so a row of agent windows stays self-identifying
 * (it's the same id encoded in the `dex/<id>-<slug>` branch).
 */
export function agentTitle(id: string, name: string, maxNameLength = 40): string {
  const trimmed = name.trim();
  if (!trimmed) return `dex ${id}`;
  const short =
    trimmed.length > maxNameLength ? `${trimmed.slice(0, maxNameLength - 1).trimEnd()}…` : trimmed;
  return `dex ${id} · ${short}`;
}

/** A git runner around the {@link Exec} seam, mirroring `worktrees/provider`. */
export class GitRunner {
  constructor(
    private readonly gitBin: string,
    private readonly exec: Exec,
  ) {}

  /**
   * The repo's default branch: `git symbolic-ref --short refs/remotes/origin/HEAD`
   * with the `origin/` prefix stripped, falling back to `main` when there's no
   * remote HEAD (a fresh repo, or no `origin`).
   */
  async defaultBranch(repo: string): Promise<string> {
    try {
      const out = await this.exec(
        this.gitBin,
        ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
        { cwd: repo },
      );
      return out.trim().replace(/^origin\//, "") || "main";
    } catch {
      return "main";
    }
  }

  /**
   * Freshen `<branch>` from origin so callers can base work on the latest pushed
   * trunk: `git -C <repo> fetch origin <branch>`. Returns `true` when the fetch
   * landed (and `origin/<branch>` is therefore a usable, current base), `false`
   * on any failure — no `origin`, offline, or a branch origin doesn't have — so
   * the caller falls back to the local ref. Best-effort by construction: it only
   * advances the remote-tracking ref, never the working tree or the local branch,
   * so it's safe no matter what the main worktree has checked out, and it never
   * throws.
   */
  async fetchBase(repo: string, branch: string): Promise<boolean> {
    try {
      await this.exec(this.gitBin, ["-C", repo, "fetch", "origin", branch]);
      return true;
    } catch {
      return false;
    }
  }

  /** Create the worktree; rejects (surfacing git's stderr) on failure. */
  worktreeAdd(repo: string, branch: string, path: string, base: string): Promise<string> {
    return this.exec(this.gitBin, worktreeAddArgs(repo, branch, path, base));
  }

  /**
   * Absolute path to the `info/exclude` git honors for `worktree` — resolved via
   * `git rev-parse --git-path`, which points at the shared common git dir (git has
   * no per-worktree `info/exclude`). A relative result is anchored to the worktree.
   */
  async infoExcludePath(worktree: string): Promise<string> {
    const out = await this.exec(this.gitBin, [
      "-C",
      worktree,
      "rev-parse",
      "--git-path",
      "info/exclude",
    ]);
    const path = out.trim();
    return isAbsolute(path) ? path : join(worktree, path);
  }
}

/** A dex runner around the {@link Exec} seam (the `show`/`start` subcommands). */
export class DexRunner {
  constructor(
    private readonly dexBin: string,
    private readonly exec: Exec,
  ) {}

  /**
   * `dex [--storage-path P] show <id> --json --full` → the task object, or
   * `undefined` when the store has no such task (or the call fails). `--storage-path`
   * is a global option, so it precedes the subcommand.
   */
  async show(id: string, storagePath?: string): Promise<{ name?: string } | undefined> {
    const args: string[] = [];
    if (storagePath) args.push("--storage-path", storagePath);
    args.push("show", id, "--json", "--full");
    try {
      const stdout = await this.exec(this.dexBin, args);
      const parsed: unknown = JSON.parse(stdout);
      // `dex show` yields an object for one id, or an array; take the first match.
      const task = Array.isArray(parsed) ? parsed[0] : parsed;
      if (task && typeof task === "object") return task as { name?: string };
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * `dex [--storage-path P] start <id> --force` — mark the task in-progress.
   * Resolves `{ ok: true }` on success, or `{ ok: false, detail }` surfacing the
   * CLI's error on failure (the caller decides what to do; it does NOT swallow).
   *
   * `--force` makes this idempotent: `dex start` errors "already in progress" on
   * a task that's already started, but spawning (or re-spawning) an agent for a
   * task IS claiming it, so we re-claim rather than treat that as a failure.
   */
  async start(id: string, storagePath?: string): Promise<{ ok: boolean; detail?: string }> {
    const args: string[] = [];
    if (storagePath) args.push("--storage-path", storagePath);
    args.push("start", id, "--force");
    try {
      await this.exec(this.dexBin, args);
      return { ok: true };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, detail };
    }
  }

  /**
   * `dex [--storage-path P] delete <id> --force`; resolves with the CLI's stdout,
   * rejects (surfacing stderr) on failure. `--force` keeps the call non-interactive
   * — `dex delete` otherwise prompts when a task has subtasks, which would hang the
   * daemon's `execFile` (no TTY on stdin) — and matches `dex rm -f`'s cascade.
   */
  async delete(id: string, storagePath?: string): Promise<string> {
    const args: string[] = [];
    if (storagePath) args.push("--storage-path", storagePath);
    args.push("delete", id, "--force");
    return this.exec(this.dexBin, args);
  }

  /**
   * Add or remove a blocker edge via `dex [--storage-path P] edit <blockedId>
   * --add-blocker|--remove-blocker <blockerId>` — wiring a dependency so
   * `blockedId` waits on `blockerId` (or unwiring one). Resolves with the CLI's
   * stdout; rejects (surfacing stderr) on failure. dex itself rejects a self-block
   * and a cycle with a clear message, so the caller can pass those straight through.
   */
  async editBlocker(
    op: "add" | "remove",
    blockedId: string,
    blockerId: string,
    storagePath?: string,
  ): Promise<string> {
    const args: string[] = [];
    if (storagePath) args.push("--storage-path", storagePath);
    args.push("edit", blockedId, op === "add" ? "--add-blocker" : "--remove-blocker", blockerId);
    return this.exec(this.dexBin, args);
  }

  /**
   * Edit a task's metadata via `dex [--storage-path P] edit <id> [-n ...] [-d ...]
   * [-p ...]` — only the fields present in `fields` become flags, so an unchanged
   * field is never sent (a no-op edit composes to a bare `edit <id>`, which the
   * caller skips). Resolves with the CLI's stdout; rejects (surfacing stderr) on
   * failure. An empty `description` clears it (allowed); name/priority validity is
   * the caller's concern (it rejects an empty name before reaching here).
   */
  async edit(
    id: string,
    fields: { name?: string; description?: string; priority?: number },
    storagePath?: string,
  ): Promise<string> {
    const args: string[] = [];
    if (storagePath) args.push("--storage-path", storagePath);
    args.push("edit", id);
    if (fields.name !== undefined) args.push("-n", fields.name);
    if (fields.description !== undefined) args.push("-d", fields.description);
    if (fields.priority !== undefined) args.push("-p", String(fields.priority));
    return this.exec(this.dexBin, args);
  }

  /**
   * `dex [--storage-path P] complete <id> --result "<text>" --no-commit [--force]`
   * — mark a task done. Resolves with the CLI's stdout; rejects (surfacing stderr)
   * on failure. `dex complete` REQUIRES a non-empty `--result`, so the caller
   * defaults one. `--no-commit` because a manual completion has no merge commit to
   * link (the auto-land path is the one that passes `--commit <sha>`).
   *
   * `--force` is OFF by default, so dex's own incomplete-subtask validation
   * surfaces verbatim rather than silently force-completing an epic with open
   * children. It's only ever set after a deliberate GUI opt-in ("Complete anyway"),
   * never automatically — preserving the "never a silent force-complete" invariant.
   */
  async complete(id: string, result: string, storagePath?: string, force = false): Promise<string> {
    const args: string[] = [];
    if (storagePath) args.push("--storage-path", storagePath);
    args.push("complete", id, "--result", result, "--no-commit");
    if (force) args.push("--force");
    return this.exec(this.dexBin, args);
  }
}

/**
 * A tiny keyed async mutex: calls sharing a `key` run one at a time (each awaits
 * the prior call on that key, then becomes the new tail), while different keys run
 * concurrently. The only synchronization primitive {@link runSpawn} needs to make
 * a concurrent batch safe — see {@link SpawnLocks}. The stored tail swallows
 * rejections so one failed section never poisons the next waiter on that key.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    const result = prior.then(fn, fn);
    this.tails.set(
      key,
      result.then(
        () => {},
        () => {},
      ),
    );
    return result;
  }
}

/**
 * The locks a batch shares across its concurrent {@link runSpawn} calls so the
 * racey sections serialize while independent work (fetch, slug derivation) still
 * overlaps. One per contended domain (see {@link runSpawnBatch}'s docstring for
 * the WHY behind each):
 *   - `store` keyed by storage-path — the unlocked `dex start` JSONL rewrite;
 *   - `repo` keyed by repo — `git worktree add` + the link/exclude git ops that
 *     contend on `.git/worktrees` + `index.lock`;
 *   - `terminal` on one fixed key — the terminal launcher, which races regardless
 *     of repo, so it serializes even across a cross-repo batch.
 */
export interface SpawnLocks {
  store: KeyedMutex;
  repo: KeyedMutex;
  terminal: KeyedMutex;
}

/** A fresh, independent set of {@link SpawnLocks} (the default for a lone spawn). */
export function createSpawnLocks(): SpawnLocks {
  return { store: new KeyedMutex(), repo: new KeyedMutex(), terminal: new KeyedMutex() };
}

/** The fixed key for the single global terminal-launcher lock. */
const TERMINAL_LOCK_KEY = "terminal";

/** Dependencies for {@link runSpawn} — the seams the action injects, tests stub. */
export interface SpawnDeps {
  exec: Exec;
  dexBin: string;
  gitBin: string;
  /** The monitored project roots, in `global.repos` order (each carries a `.dex/`). */
  repos: string[];
  /** The terminal preference (from `terminalConfigOf(ctx.global)`). */
  terminal: GlobalTerminalConfig;
  /** Injected terminal spawn (tests stub it). */
  spawn?: typeof nodeSpawn;
  /** Injected script writer for the terminal launcher (tests stub it). */
  writeScript?: (label: string, command: string) => string;
  /** Filesystem ops for linking the dex store into the worktree (tests stub it). */
  fs?: FsOps;
  /**
   * Max number of {@link runSpawn} calls a batch runs at once (see
   * {@link runSpawnBatch}); the effective pool clamps to `[1, ready.length]`.
   * Unused by a lone `runSpawn`. Defaults to 5 at the read site.
   */
  maxConcurrency?: number;
  /**
   * Locks shared across a batch so concurrent spawns serialize their racey
   * sections. Defaults to a fresh per-call set, so a lone {@link runSpawn} is
   * still self-contained (its locks just never contend).
   */
  locks?: SpawnLocks;
  log?: (message: string) => void;
}

/**
 * The filesystem ops {@link runSpawn} needs to link the dex store into a fresh
 * worktree — a seam so unit tests never touch disk.
 */
export interface FsOps {
  /** True if `path` already exists (any type, including a dangling symlink). */
  exists(path: string): Promise<boolean>;
  /** Create a symlink at `linkPath` pointing to `target`. */
  symlink(target: string, linkPath: string): Promise<void>;
  /** Read a UTF-8 text file; rejects if it doesn't exist. */
  readFile(path: string): Promise<string>;
  /** Append text to a file, creating it if absent. */
  appendFile(path: string, data: string): Promise<void>;
}

/** The real {@link FsOps}, backed by `node:fs/promises`. */
export const defaultFsOps: FsOps = {
  async exists(path) {
    try {
      // `lstat`, not `access`: we want an existing-but-dangling symlink to count,
      // so we never clobber whatever is already at the path.
      await lstat(path);
      return true;
    } catch {
      return false;
    }
  },
  symlink: (target, linkPath) => symlink(target, linkPath),
  readFile: (path) => readFile(path, "utf8"),
  appendFile: (path, data) => appendFile(path, data),
};

/**
 * The store path to query for a repo's tasks: its `.dex` directory (matching
 * `dex.tasks`' `storagePathOf`). Exported so the resolution stays in lockstep.
 */
export function storagePathOf(repo: string): string {
  return join(repo, ".dex");
}

/**
 * Where to link the shared dex store into a worktree: a `.dex` entry at the
 * worktree root pointing at the source repo's store (`<repo>/.dex`). The spawned
 * agent's cwd IS the worktree, so this makes every `dex` command there (the
 * bootstrap's `dex show <id>`, plus `dex start`/`dex complete` and the user's
 * own) resolve the shared store with no `--storage-path`.
 */
export function dexStoreLinkSpec(
  worktreePath: string,
  repo: string,
): { linkPath: string; target: string } {
  return { linkPath: join(worktreePath, ".dex"), target: storagePathOf(repo) };
}

/**
 * Best-effort: symlink the source repo's dex store into the freshly-created
 * worktree. A worktree is a sibling dir with no `.dex` of its own, and dex has no
 * storage env var — so without this the spawned agent's first command
 * (`dex show <id> --full`) fails with "task not found". Never throws: a missing
 * source store, a `.dex` already present (we don't clobber), or a symlink error
 * just skips linking — the agent can still fall back to `--storage-path`.
 */
export async function linkDexStore(
  worktreePath: string,
  repo: string,
  fs: FsOps,
  log?: (message: string) => void,
): Promise<void> {
  const { linkPath, target } = dexStoreLinkSpec(worktreePath, repo);
  try {
    if (!(await fs.exists(target))) return; // the repo has no store to share
    if (await fs.exists(linkPath)) return; // don't clobber an existing `.dex`
    await fs.symlink(target, linkPath);
    log?.(`linked dex store: ${linkPath} → ${target}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log?.(`couldn't link dex store into ${worktreePath}: ${detail}`);
  }
}

/** The git-exclude pattern for the perch-dropped `.dex` link — root-anchored. */
export const DEX_EXCLUDE_PATTERN = "/.dex";

/**
 * Best-effort: teach git to ignore the perch-created `.dex` link in this worktree
 * by adding `/.dex` to its `info/exclude`. A repo's `.gitignore` ignores the store
 * as `.dex/` — a DIRECTORY-only pattern — but in a worktree `.dex` is a SYMLINK
 * (git sees a file), so that pattern misses it and `git status` reports `?? .dex`.
 * That lone untracked entry is what trips auto-land's clean-tree guard and leaves
 * merged worktrees un-reaped, so we exclude it at the source. Idempotent (skips if
 * the pattern is already present) and never throws — excluding is an optimization,
 * not a correctness requirement (the land guard tolerates a lone `.dex` too).
 */
export async function excludeDexLink(
  worktreePath: string,
  git: GitRunner,
  fs: FsOps,
  log?: (message: string) => void,
): Promise<void> {
  try {
    const excludePath = await git.infoExcludePath(worktreePath);
    let existing = "";
    try {
      existing = await fs.readFile(excludePath);
    } catch {
      // No exclude file yet (fresh repo, or unreadable) — appendFile creates it.
    }
    if (existing.split(/\r?\n/).some((line) => line.trim() === DEX_EXCLUDE_PATTERN)) return;
    // Don't glue our pattern onto a final line that lacks a trailing newline.
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await fs.appendFile(excludePath, `${prefix}${DEX_EXCLUDE_PATTERN}\n`);
    log?.(`excluded ${DEX_EXCLUDE_PATTERN} in ${excludePath}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log?.(`couldn't exclude .dex link in ${worktreePath}: ${detail}`);
  }
}

/**
 * Locate which configured repo's dex store holds `id`, returning the task's
 * `name` + the `project` (the store repo's basename, the same tag the dex board
 * groups by) so {@link resolveRepo} can map it back to a repo path. Probes each
 * store via `dex show`; the first store that knows the id wins. When no repos are
 * configured, falls back to the cwd-resolved store (project `undefined`).
 * `undefined` when no store has the id.
 */
export async function findTask(
  dex: DexRunner,
  id: string,
  repos: string[],
): Promise<{ project: string | undefined; name: string } | undefined> {
  for (const repo of repos) {
    const task = await dex.show(id, storagePathOf(repo));
    if (task && typeof task.name === "string") return { project: basename(repo), name: task.name };
  }
  // No monitored repos: fall back to the cwd-resolved store (no project tag).
  if (repos.length === 0) {
    const task = await dex.show(id);
    if (task && typeof task.name === "string") return { project: undefined, name: task.name };
  }
  return undefined;
}

/**
 * Create the `dex/<id>-<slug>` worktree and launch a seeded `claude` agent in the
 * user's terminal. Never throws: every failure (bad id, unresolved repo, a task
 * we can't mark in-progress, an existing worktree, a git error, a terminal error)
 * returns a clear `{ ok:false, message }`, and nothing is half-created — an
 * already-existing worktree is rejected up front (before any state changes), the
 * task is then marked in-progress, the worktree is only added once the repo +
 * branch are settled, and the agent is launched only after it exists.
 */
export async function runSpawn(input: SpawnInput, deps: SpawnDeps): Promise<SpawnResult> {
  const id = input.id.trim();
  if (!isValidTaskId(id)) {
    return {
      ok: false,
      message: `dex id "${input.id}" is not lowercase-alphanumeric; the branch parser would not match it.`,
    };
  }

  const dex = new DexRunner(deps.dexBin, deps.exec);
  // A lone spawn gets its own (never-contending) locks; a batch passes shared ones
  // so its concurrent runSpawns serialize the racey sections below.
  const locks = deps.locks ?? createSpawnLocks();

  // Resolve the task (name → slug) and its project (the repo its store lives in).
  // An explicit `input.repo` short-circuits the per-store probe: we just need the
  // name from that repo's store (or the default store).
  let name: string;
  let resolvedRepo: string;
  if (input.repo) {
    const task = await dex.show(id, storagePathOf(input.repo));
    const fallback = task ?? (await dex.show(id));
    if (!fallback || typeof fallback.name !== "string") {
      return { ok: false, message: `dex task "${id}" not found.` };
    }
    name = fallback.name;
    resolvedRepo = input.repo;
  } else {
    const found = await findTask(dex, id, deps.repos);
    if (!found) {
      return {
        ok: false,
        message: `dex task "${id}" not found in any configured repo's store.`,
      };
    }
    name = found.name;
    const resolved = resolveRepo(input, found.project, deps.repos);
    if ("error" in resolved) return { ok: false, message: resolved.error };
    resolvedRepo = resolved.repo;
  }

  const slug = deriveSlug(name);
  const branch = branchFor(id, slug);
  const worktreePath = worktreePathFor(resolvedRepo, id, slug);

  // Pre-flight (BEFORE the in-progress mark): refuse a task whose worktree is
  // already on disk. `git worktree add` would reject the path anyway, but only
  // AFTER we'd marked the task in-progress (below) — and dex has no `unstart`, so
  // that mark can't be rolled back, leaving the task reading 'in-progress' with no
  // agent (the exact wrong-state symptom). Catching an existing worktree here lets
  // a re-spawn of an already-spawned task fail cleanly without touching its state.
  const fs = deps.fs ?? defaultFsOps;
  if (await fs.exists(worktreePath)) {
    return {
      ok: false,
      message: `worktree for dex task "${id}" already exists at ${worktreePath}; not re-spawning.`,
    };
  }

  // Mark the task in-progress BEFORE building the worktree + launching the agent.
  // Spawning an agent for a task IS starting work on it, and `started_at` is the
  // only thing perch keys the in-progress status off (normalize.ts `deriveStatus`)
  // — a live worktree is not consulted. So this is a hard requirement, not a
  // best-effort nicety: if we can't mark it, we must NOT go on to create a worktree
  // + launch an agent on a task that still reads as 'ready' (the bug this guards
  // against). Marking here (after the existing-worktree pre-flight, but before the
  // build) means a launched agent always sits on an in-progress task; the only
  // failure that can now outrun the mark is a worktree-add error on a path the
  // pre-flight didn't see (e.g. a stale registered branch), which `--force` heals
  // on the eventual re-spawn. The per-store lock serializes this unlocked JSONL
  // rewrite so concurrent batch spawns into one store don't clobber each other's
  // `started_at` (see runSpawnBatch).
  const storagePath = storagePathOf(resolvedRepo);
  const started = await locks.store.run(storagePath, () => dex.start(id, storagePath));
  if (!started.ok) {
    return {
      ok: false,
      message: `couldn't mark dex task "${id}" in-progress (${started.detail ?? "dex start failed"}); not spawning an agent.`,
    };
  }

  // Create the worktree off the repo's default branch. Freshen it from origin
  // first so the agent starts from the latest pushed trunk, not a stale local
  // ref — basing on `origin/<base>` when the fetch lands, falling back to the
  // local `<base>` when it doesn't (offline, no origin). Best-effort: a fetch
  // failure never blocks the spawn. git's own `worktree add` refuses an existing
  // path, but we surface a clearer message either way.
  const git = new GitRunner(deps.gitBin, deps.exec);
  const localBase = await git.defaultBranch(resolvedRepo);
  const freshened = await git.fetchBase(resolvedRepo, localBase);
  if (!freshened) {
    deps.log?.(
      `dex.spawn: couldn't fetch origin/${localBase} in ${resolvedRepo}; basing the worktree on the local ${localBase}`,
    );
  }
  const base = freshened ? `origin/${localBase}` : localBase;
  // Serialize the worktree add + the link/exclude git ops per repo: concurrent
  // `git worktree add` (and the rev-parse/exclude writes) into one repo contend on
  // `.git/worktrees` + `index.lock`. The fetch above stays outside the lock so
  // independent repos' freshens overlap. Returns a failure message, or undefined.
  const worktreeError = await locks.repo.run(resolvedRepo, async () => {
    try {
      await git.worktreeAdd(resolvedRepo, branch, worktreePath, base);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return `couldn't create worktree at ${worktreePath} (branch ${branch}): ${detail}`;
    }
    // The worktree is a sibling dir with no `.dex`; link the source repo's store in
    // so the spawned agent's `dex show <id>` (and the user's dex commands) resolve
    // without a `--storage-path`. Best-effort — never blocks the launch.
    await linkDexStore(worktreePath, resolvedRepo, fs, deps.log);
    // …and exclude that link from git, so its lone `?? .dex` never reads as a dirty
    // tree and blocks auto-land from reaping the worktree once its PR merges.
    await excludeDexLink(worktreePath, git, fs, deps.log);
    return undefined;
  });
  if (worktreeError) return { ok: false, message: worktreeError };

  // The task is already marked in-progress (above) and the worktree exists, so
  // launch the seeded agent. The single global terminal lock serializes the
  // launcher across the whole batch — the osascript that drives Terminal.app
  // races regardless of repo, so this one lock is required even cross-repo.
  const launched = await locks.terminal.run(TERMINAL_LOCK_KEY, () =>
    Promise.resolve(
      spawnInTerminal({
        command: buildClaudeLaunch(worktreePath, bootstrapPrompt(id)),
        terminal: deps.terminal,
        label: `dex ${id}`,
        // Title the agent's window with its dex id (+ name) so a row of agent
        // terminals is identifiable at a glance and each ties back to its task —
        // matching the per-task tab color. Falls back to the bare id when the name
        // has no usable text.
        title: agentTitle(id, name),
        // Tint the agent's window tab/header to the task's identity color so it
        // matches the task's dex row + linked worktree across the fleet (a no-op on
        // terminals without a tab-color hook).
        tabColor: dexTaskColorRgb(id),
        // Tag the window with the worktree path so a later "jump to agent" (the
        // worktree-open control, keyed by the same path) raises THIS live session
        // rather than spawning a new shell on top of it.
        focusMarker: worktreePath,
        log: deps.log,
        spawn: deps.spawn,
        writeScript: deps.writeScript,
      }),
    ),
  );
  if (!launched.ok) {
    return {
      ok: false,
      message: `created worktree at ${worktreePath}, but ${launched.message}`,
      worktreePath,
    };
  }

  return {
    ok: true,
    message: `Spawned agent for ${id} in ${worktreePath} (branch ${branch}).`,
    worktreePath,
  };
}

/** The minimal task shape {@link runSpawnBatch} reads to decide readiness. */
export interface SpawnCandidate {
  id: string;
  status: DexStatus;
  blockedByCount: number;
}

/**
 * Whether a batch spawn should hand this task to a fresh agent: an unblocked
 * `ready` row. This is the daemon-side half of the GUI's `canSpawnDex` gate —
 * the worktree/agent checks live in the GUI (the daemon board tracks neither
 * live worktrees nor running agent processes). It doesn't need to: a `ready`
 * task hasn't been started, and {@link runSpawn} itself refuses a task whose
 * worktree already exists (git's `worktree add` rejects the path), so a stray
 * worktree is caught there and counted as a failure rather than half-created.
 */
export function isReadyToSpawn(task: SpawnCandidate): boolean {
  return task.status === "ready" && task.blockedByCount === 0;
}

/** One task's outcome within a {@link SpawnBatchResult}. */
export interface SpawnBatchEntry {
  id: string;
  result: SpawnResult;
}

/** The `dex.spawn-all` result: per-task outcomes plus a rolled-up summary. */
export interface SpawnBatchResult {
  /** True when every ready task spawned (or there were none to spawn). */
  ok: boolean;
  /** Number of agents successfully launched. */
  spawned: number;
  /** Number of ready tasks whose spawn failed. */
  failed: number;
  /** Per-task outcomes, in board order (ready tasks only). */
  results: SpawnBatchEntry[];
  /** A human-readable one-line summary. */
  message: string;
}

/**
 * Spawn an agent for every ready (unblocked) task in `tasks`, up to
 * `deps.maxConcurrency` at a time — the batch counterpart of {@link runSpawn} and
 * the GUI's "spawn all ready" button. Filters to {@link isReadyToSpawn}
 * candidates, runs {@link runSpawn} over them through a bounded worker pool (each
 * gets its own `dex/<id>-<slug>` worktree + seeded agent), and rolls the per-task
 * outcomes into a summary. Never throws: each task's failure is captured in its
 * own `SpawnResult` (and a worker that throws unexpectedly still resolves its slot
 * as an `ok:false` entry), so one bad task doesn't sink the rest. `results` stays
 * in board order even though tasks finish out of order, so the GUI toast names the
 * failed ids correctly.
 *
 * Bounded, not unbounded `Promise.all`: every `runSpawn` mutates shared,
 * unsynchronized state that races under concurrency. The pool caps how many run at
 * once, and {@link SpawnLocks} (shared across the batch) serialize the three
 * contended domains so raising the cap stays SAFE —
 *   - the per-repo `.dex` store: `dex start` reads the whole JSONL store and
 *     rewrites it (temp-file + rename) with NO lock, so concurrent starts would
 *     lose each other's `started_at` → the per-storage-path `store` lock;
 *   - the repo's `.git/worktrees` + `index.lock`: concurrent `git worktree add`
 *     in one repo contend and some fail → the per-repo `repo` lock;
 *   - the terminal launcher: concurrent `osascript` to Terminal.app races and
 *     drops windows regardless of repo → the single global `terminal` lock.
 * Because those locks serialize the racey sections per store/repo, a SINGLE-repo
 * batch (the common case) effectively serializes there and the real throughput win
 * is CROSS-repo; the cap's guarantee is a ceiling ("never more than N in flight"),
 * which holds either way. Each launched agent runs detached, so we never wait on it.
 */
export async function runSpawnBatch(
  tasks: ReadonlyArray<SpawnCandidate>,
  deps: SpawnDeps,
): Promise<SpawnBatchResult> {
  const ready = tasks.filter(isReadyToSpawn);
  // Pre-sized so workers write outcomes by board index, not completion order.
  const results: SpawnBatchEntry[] = new Array(ready.length);
  // One shared lock set for the whole batch, so concurrent runSpawns actually
  // contend (and serialize) on the racey sections rather than each getting its own.
  const locks = deps.locks ?? createSpawnLocks();
  const poolSize = Math.max(1, Math.min(deps.maxConcurrency ?? 5, ready.length));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < ready.length; i = next++) {
      const t = ready[i]!;
      let result: SpawnResult;
      try {
        result = await runSpawn({ id: t.id }, { ...deps, locks });
      } catch (err) {
        // runSpawn is contracted never to throw; guard anyway so a rogue rejection
        // is captured as a failed entry instead of rejecting the whole batch.
        const detail = err instanceof Error ? err.message : String(err);
        result = { ok: false, message: `unexpected error spawning ${t.id}: ${detail}` };
      }
      results[i] = { id: t.id, result };
    }
  };
  await Promise.all(Array.from({ length: poolSize }, worker));
  const spawned = results.filter((r) => r.result.ok).length;
  const failed = results.length - spawned;
  const failedIds = results.filter((r) => !r.result.ok).map((r) => r.id);
  const message =
    ready.length === 0
      ? "No ready tasks to spawn."
      : `Spawned ${spawned} of ${ready.length} ready task${ready.length === 1 ? "" : "s"}` +
        // Name the failed ids so the GUI toast (which only shows this rolled-up
        // message) surfaces WHICH tasks failed, not just a bare count.
        (failed > 0 ? ` (${failed} failed: ${failedIds.join(", ")}).` : ".");
  return { ok: failed === 0, spawned, failed, results, message };
}
