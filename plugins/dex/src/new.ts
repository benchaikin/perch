/**
 * The `dex.new` action's machinery: spawn a Claude Code agent IN A DEX REPO's
 * directory, seeded to turn a free-form description into well-formed dex work —
 * either a single task or, when the description warrants it, a parent epic with
 * dependency-ordered sub-tasks (it reads the code, then runs `dex create`). The
 * complement of `dex.spawn` —
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

import { buildAgentLaunchCommand, spawnInTerminal, type GlobalTerminalConfig } from "@perch/sdk";

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
  /**
   * Author AND immediately start working the new task: the author agent, after
   * running `dex create`, spawns a separate agent in a `dex/<id>-<slug>` worktree to
   * implement it (overriding the default author-only "do NOT implement" guidance).
   * Defaults to author-only.
   */
  start?: boolean;
  /**
   * Author the work as a CHILD of this existing task — the agent runs `dex create
   * --parent <parentId>` so the new task nests under it. The GUI passes this (with
   * the parent's `project`, which pins the repo) when the composer is armed from a
   * task row's "new sub-task" control. Omitted authors a top-level task.
   */
  parentId?: string;
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
 * runs `dex create` in the repo to write well-formed work — a single task for a
 * focused change, or a parent epic with dependency-ordered sub-tasks for a large
 * one. The agent judges the scope itself. The agent's cwd IS the repo, so `dex
 * create` targets the right store with no `--storage-path`. The description is
 * embedded verbatim (the launcher shell-quotes the whole prompt, so
 * backticks/quotes inside it don't expand).
 *
 * After authoring, the prompt has the agent RECONCILE the new work against the
 * tasks already in the store — wiring blocker edges in both directions (`dex
 * create --blocked-by` / `dex edit --add-blocker`) wherever a real ordering
 * dependency or a likely merge conflict (file overlap) exists, biased toward not
 * over-wiring. In `start` mode this runs BEFORE the worker handoff, so the worker
 * never picks up a task whose blocked status is about to change.
 *
 * When `start` is set the closing line is swapped: instead of the author-only "do
 * NOT implement" guidance, the agent is told to spawn a SEPARATE worker agent on
 * the new task (a `dex/<id>-<slug>` worktree, the spawn-dex/dex-worktree flow) right
 * after authoring — the one-click "author it AND start working it" path.
 *
 * When `parentId` is set the work is authored as a CHILD of that task (`dex create
 * --parent <parentId>`). The scope judgment is different here: a sub-task is by
 * definition already inside an epic, so the prompt biases to a SINGLE sub-task and
 * tells the agent NOT to spin up a fresh epic — unlike the top-level path, which
 * judges single-task-vs-epic from scratch.
 */
export function newTaskPrompt(description: string, start = false, parentId?: string): string {
  const closing = start
    ? `Once authored, do NOT stop — START WORKING the new task by handing it to a ` +
      `separate worker agent: take the id \`dex create\` returned (for an epic, the ` +
      `first ready leaf sub-task), create a \`dex/<id>-<slug>\` git worktree for it ` +
      `(the spawn-dex / dex-worktree skill flow, so perch links the worktree to the ` +
      `task), and launch an agent in that worktree to IMPLEMENT it. Do NOT implement ` +
      `the work yourself in this session — author it here, then spawn the worker that ` +
      `does the implementation.`
    : `Do NOT implement the work — only author it.`;
  const reconcile =
    `Then, BEFORE anything starts on the new work, reconcile it against the tasks ALREADY ` +
    `in this store so its blocked status is correct: run \`dex list\` and \`dex show <id> ` +
    `--full\` the plausibly-related open tasks to read what they actually touch. For each ` +
    `direction, wire a blocker edge ONLY where a real ordering dependency or a likely merge ` +
    `conflict exists:\n` +
    `- NEW blocked by EXISTING — the new work needs an existing task's code, API, schema, or ` +
    `migration to land first: wire it at creation with \`dex create ... --blocked-by ` +
    `<existingIds>\`, or after the fact with \`dex edit <newId> --add-blocker <existingId>\`.\n` +
    `- EXISTING blocked by NEW — the new task lays groundwork an in-flight task should build ` +
    `on, OR the two edit the same files/regions and must be serialized so they aren't spawned ` +
    `concurrently and collide at merge: wire it with \`dex edit <existingId> --add-blocker ` +
    `<newId>\`.\n` +
    `Base the merge-conflict judgment on REAL file overlap — compare the files each task names ` +
    `(read them when unsure), not just topical similarity. Reconcile only against OPEN tasks in ` +
    `THIS store (a done blocker is auto-satisfied; edges can't cross stores), and for an epic ` +
    `reconcile the individual children/parent against the existing tasks, not the epic as a ` +
    `blob. dex rejects self-blocks and cycles — surface its message rather than fighting it. ` +
    `Bias toward NOT wiring an edge when unsure (a spurious blocker stalls the board), the same ` +
    `way you bias against over-decomposing. `;
  if (parentId) {
    return (
      `Here is a rough description of work to create as a SUB-TASK of the existing dex ` +
      `task \`${parentId}\`:\n\n${description}\n\n` +
      `Author this as well-formed dex work for THIS repository (your cwd), nested UNDER ` +
      `\`${parentId}\` as its child. First read the relevant code to ground the work in how ` +
      `things actually work here — find the real reuse points, the files to touch, and the ` +
      `gotchas.\n\n` +
      `Create it with \`dex create --parent ${parentId}\` in this directory (so it lands in ` +
      `this repo's .dex store, nested under its parent). This work is ALREADY inside an epic, ` +
      `so default to a SINGLE sub-task — do NOT spin up a new epic. Only when the description ` +
      `genuinely spans multiple independently-mergeable pieces, create several sub-tasks ` +
      `(each with \`dex create --parent ${parentId}\`, wired with \`--blocked-by <ids>\` using ` +
      `the real ids \`dex create\` returns) to encode their order — but bias hard toward one.\n\n` +
      `Give each task a concise imperative name and a rich description that follows this repo's ` +
      `existing task conventions: the WHY, the key design, reuse pointers, guards/edge cases, ` +
      `and acceptance criteria. After creating, run \`dex show <id> --full\` to verify each ` +
      `sub-task was created and reads well, and confirm it nests under \`${parentId}\` (e.g. ` +
      `\`dex list ${parentId}\`).\n\n${reconcile}${closing}`
    );
  }
  return (
    `Here is a rough description of work to create as dex task(s):\n\n${description}\n\n` +
    `Author this as well-formed dex work for THIS repository (your cwd). First read the ` +
    `relevant code to ground the work in how things actually work here — find the real ` +
    `reuse points, the files to touch, and the gotchas.\n\n` +
    `Then JUDGE THE SCOPE of the description and choose ONE of:\n` +
    `1. SINGLE TASK (default — prefer this): for a focused, independently-mergeable ` +
    `change, create one task with \`dex create\` in this directory (so it lands in this ` +
    `repo's .dex store).\n` +
    `2. EPIC + SUB-TASKS: only when the description genuinely spans multiple ` +
    `independently-mergeable pieces (a multi-PR effort), create a parent "epic" task ` +
    `FIRST with \`dex create\` to get its id, then break the work into small, mergeable ` +
    `sub-tasks — each created with \`dex create --parent <epic-id>\` and wired with ` +
    `\`--blocked-by <ids>\` (using the real child ids \`dex create\` returns, so you ` +
    `never reference an id that does not exist yet) to encode the dependency order. ` +
    `Use \`-p/--priority\` where ordering within a level matters. The parent carries ` +
    `the epic-level WHY, design, and a dependency-ordered TASK BREAKDOWN; each child ` +
    `carries its own.\n\n` +
    `Do NOT over-decompose: a small or focused description must produce ONE task — only ` +
    `reach for an epic when the work clearly does not fit in a single PR.\n\n` +
    `Whatever you create, give each task a concise imperative name and a rich ` +
    `description that follows this repo's existing task conventions: the WHY, the key ` +
    `design, reuse pointers, guards/edge cases, and acceptance criteria. After creating, ` +
    `run \`dex show <id> --full\` to verify each task was created and reads well; for an ` +
    `epic, also confirm the parent/child tree and the blocked-by edges read correctly ` +
    `(e.g. \`dex list <epic-id>\` or \`dex show <epic-id> --full\`).\n\n${reconcile}${closing}`
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
    command: buildAgentLaunchCommand(dir, newTaskPrompt(description, input.start, input.parentId)),
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
    message: input.start
      ? `Spawned an agent in ${dir} to author the task and start an agent working it; it'll appear on the next refresh.`
      : `Spawned an agent in ${dir} to author the task; it'll appear on the next refresh.`,
    repo: dir,
  };
}
