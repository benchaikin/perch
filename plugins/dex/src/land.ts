/**
 * Auto-land: the daemon-side counterpart to the `land-dex` skill. It enumerates
 * the dex worktrees across the configured repos, and for any whose PR has
 * **merged**, reaps the loop end-to-end — removes the worktree + branch and
 * completes the dex task with PR-derived evidence — so a finished, merged task
 * cleans up after itself without a manual `land-dex` run.
 *
 * This is a faithful port of `.claude/skills/land-dex/reap-dex-worktrees.sh`:
 * the SAME guards gate every destructive step, in the same order —
 *
 *   1. The worktree's branch encodes a dex id (`dex/<id>…`), or a worktree-local
 *      `perch.dexTask` git config is set (the config wins) — same as the parser.
 *   2. The branch's PR is MERGED (`state == MERGED` and `mergedAt` present).
 *   3. The worktree tree is clean (`git status --porcelain` is empty).
 *   4. NO-CI BUILD GATE: if the merged PR reported zero CI checks, CI never gated
 *      the merge, so the repo's inferred build must pass locally first. Repos with
 *      CI skip this (CI was the gate).
 *
 * Only a MERGED worktree ever produces an outcome: a clean one that passes the
 * gate is `reaped`; a merged-but-unsafe one (dirty tree, failed/uninferable
 * build, or a reap that errored) is `flagged` so a human can finish it. A
 * worktree whose PR is still open (or has none) is simply skipped — it's
 * in-progress, not actionable — so the lander never nags about live work.
 *
 * Like every other provider here it runs over the injected {@link Exec} seam (and
 * a small {@link FsProbe} for the build-gate file checks), so the whole
 * enumerate→guard→reap flow unit-tests without spawning git/gh/dex.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "@perch/sdk";
import type { Notification } from "@perch/sdk";
import { parseDexTaskId, parseWorktreeList } from "@perch/plugin-worktrees";

import type { Exec } from "./provider.js";
import { GitRunner } from "./spawn.js";

/** The PR facts a land outcome carries (for evidence + notifications). */
export const LandPr = z.object({
  number: z.number().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  /** The merge commit SHA, used as `dex complete --commit`. */
  mergeCommit: z.string().optional(),
});
export type LandPr = z.infer<typeof LandPr>;

/** What happened to one merged dex worktree on a land pass. */
export const LandOutcome = z.object({
  taskId: z.string(),
  branch: z.string(),
  /** The worktree path (now removed, for a `reaped` outcome). */
  path: z.string(),
  /** The repo root the worktree belongs to. */
  repo: z.string(),
  /** `reaped` = cleaned up; `flagged` = merged but needs a human (and why). */
  action: z.enum(["reaped", "flagged"]),
  /** Human-readable detail: the completion evidence, or the flag reason. */
  reason: z.string(),
  pr: LandPr.optional(),
});
export type LandOutcome = z.infer<typeof LandOutcome>;

/**
 * `dex.land`'s output: the merged worktrees `reaped` this pass and the ones
 * `flagged` (merged but unsafe). Both are derived fresh each poll — a reaped
 * worktree is gone by the next pass, so `reaped` is "what this pass cleaned up",
 * which the notify hook turns into a one-shot "Landed" banner.
 */
export const LandBoard = z.object({
  reaped: z.array(LandOutcome),
  flagged: z.array(LandOutcome),
});
export type LandBoard = z.infer<typeof LandBoard>;

/** A build command inferred from a repo's toolchain. */
export interface BuildCommand {
  cmd: string;
  args: string[];
}

/** Filesystem probe seam for the build-gate toolchain detection (tests stub it). */
export interface FsProbe {
  exists(path: string): boolean;
  readText(path: string): string | undefined;
}

/** The real node:fs-backed probe. */
export const defaultFsProbe: FsProbe = {
  exists: (p) => existsSync(p),
  readText: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return undefined;
    }
  },
};

/**
 * Infer the build command for a repo from its toolchain — first match wins,
 * mirroring `reap-dex-worktrees.sh`'s `infer_build_command` exactly:
 *
 *   pnpm-lock.yaml                              → pnpm -r build
 *   package.json with a "build" script + yarn   → yarn build
 *   package.json with a "build" script (no yarn)→ npm run build
 *   Makefile / makefile                         → make
 *   Cargo.toml                                  → cargo build
 *   go.mod                                      → go build ./...
 *
 * pnpm is checked before plain npm/yarn so a pnpm monorepo builds recursively.
 * Returns `undefined` when nothing can be inferred (→ the gate FLAGs + skips).
 */
export function inferBuild(root: string, probe: FsProbe): BuildCommand | undefined {
  if (probe.exists(join(root, "pnpm-lock.yaml"))) return { cmd: "pnpm", args: ["-r", "build"] };

  const pkgPath = join(root, "package.json");
  if (probe.exists(pkgPath) && hasBuildScript(probe.readText(pkgPath))) {
    return probe.exists(join(root, "yarn.lock"))
      ? { cmd: "yarn", args: ["build"] }
      : { cmd: "npm", args: ["run", "build"] };
  }

  if (probe.exists(join(root, "Makefile")) || probe.exists(join(root, "makefile"))) {
    return { cmd: "make", args: [] };
  }
  if (probe.exists(join(root, "Cargo.toml"))) return { cmd: "cargo", args: ["build"] };
  if (probe.exists(join(root, "go.mod"))) return { cmd: "go", args: ["build", "./..."] };
  return undefined;
}

/** Whether a package.json's text declares a non-empty `scripts.build`. */
function hasBuildScript(pkgText: string | undefined): boolean {
  if (!pkgText) return false;
  try {
    const pkg = JSON.parse(pkgText) as { scripts?: Record<string, unknown> };
    return typeof pkg.scripts?.build === "string" && pkg.scripts.build.length > 0;
  } catch {
    return false;
  }
}

/** PR-derived completion evidence, mirroring the skill's wording. */
export function evidenceFor(pr: LandPr): string {
  const num = pr.number !== undefined ? `#${pr.number}` : "(unknown #)";
  const title = pr.title ?? "(untitled)";
  const url = pr.url ?? "(no url)";
  const sha = pr.mergeCommit ?? "(no merge sha)";
  return `Merged PR ${num}: ${title} (${url}) — merge commit ${sha}`;
}

/**
 * The `git status --porcelain` lines that count as a dirty tree, dropping the
 * perch-created `.dex` store link. That symlink is the worktree's pointer at the
 * shared dex store; a repo's `.dex/` gitignore (directory-only) doesn't match a
 * symlink, so git reports a lone `?? .dex`. Newer worktrees exclude it on spawn,
 * but ones created before that fix still carry it — and a merged worktree mustn't
 * be flagged forever over a link perch itself dropped. Anything else still counts.
 */
export function meaningfulDirt(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    // Porcelain v1: 2 status chars, a space, then the path (`.dex` needs no quoting).
    .filter((line) => line.slice(3) !== ".dex");
}

/** Dependencies for {@link runLand} — the seams the capability injects, tests stub. */
export interface LandDeps {
  exec: Exec;
  gitBin: string;
  ghBin: string;
  dexBin: string;
  /** The monitored repo roots to enumerate worktrees from (in `global.repos` order). */
  repos: string[];
  /**
   * When false, a merged+clean worktree is `flagged` ("ready to land") instead of
   * reaped — detection without destruction. When true (the default), it's reaped.
   */
  autoLand: boolean;
  /** Filesystem probe for the build gate; defaults to {@link defaultFsProbe}. */
  fs?: FsProbe;
  log?: (message: string) => void;
}

/** The dex store directory for a repo root (matches the rest of the plugin). */
function storagePathOf(repo: string): string {
  return join(repo, ".dex");
}

/** Parse `gh pr view --json …` output into the fields we gate on. */
interface PrView {
  state: string;
  mergedAt: string;
  pr: LandPr;
  /** Number of CI checks GitHub reported on the head; 0 ⇒ a no-CI repo. */
  checkCount: number;
}

function parsePrView(json: string): PrView | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const mergeCommit =
    o.mergeCommit && typeof o.mergeCommit === "object"
      ? ((o.mergeCommit as Record<string, unknown>).oid as string | undefined)
      : undefined;
  const rollup = Array.isArray(o.statusCheckRollup) ? o.statusCheckRollup : [];
  return {
    state: typeof o.state === "string" ? o.state : "",
    mergedAt: typeof o.mergedAt === "string" ? o.mergedAt : "",
    checkCount: rollup.length,
    pr: {
      number: typeof o.number === "number" ? o.number : undefined,
      title: typeof o.title === "string" ? o.title : undefined,
      url: typeof o.url === "string" ? o.url : undefined,
      mergeCommit,
    },
  };
}

/** A dex worktree candidate: its repo root, path, branch, and resolved task id. */
interface Candidate {
  repo: string;
  path: string;
  branch: string;
  taskId: string;
}

/**
 * Enumerate the dex worktrees across `repos`: for each repo, `git worktree list
 * --porcelain`, skip the main (first) / bare / detached / unbranched trees, and
 * keep those whose branch encodes a dex id (or carries a `perch.dexTask`
 * override, which wins). Best-effort: a repo whose enumeration fails contributes
 * nothing rather than failing the pass.
 */
async function enumerateDexWorktrees(deps: LandDeps): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const repo of deps.repos) {
    let porcelain: string;
    try {
      porcelain = await deps.exec(deps.gitBin, ["-C", repo, "worktree", "list", "--porcelain"]);
    } catch (err) {
      deps.log?.(`dex.land: worktree list failed for ${repo}: ${String(err)}`);
      continue;
    }
    const records = parseWorktreeList(porcelain);
    let isMain = true; // git lists the main worktree first — never touch it.
    for (const r of records) {
      const skipMain = isMain;
      isMain = false;
      // Skip the main worktree and bare/detached/unbranched trees.
      if (skipMain || r.bare || r.detached || !r.branch) continue;
      const override = await dexTaskOverride(deps, r.path);
      const taskId = override || parseDexTaskId(r.branch);
      if (!taskId) continue;
      candidates.push({ repo, path: r.path, branch: r.branch, taskId });
    }
  }
  return candidates;
}

/** The worktree-local `perch.dexTask` override (trimmed), or "" when unset. */
async function dexTaskOverride(deps: LandDeps, path: string): Promise<string> {
  try {
    const out = await deps.exec(deps.gitBin, [
      "-C",
      path,
      "config",
      "--worktree",
      "--get",
      "perch.dexTask",
    ]);
    return out.trim();
  } catch {
    return "";
  }
}

/**
 * One land pass: enumerate dex worktrees, and for each MERGED one apply the
 * guards and either reap it (when `autoLand`) or flag it. Never throws — every
 * per-worktree failure degrades to a `flagged` outcome or a skip, so polling
 * stays alive.
 */
export async function runLand(deps: LandDeps): Promise<LandBoard> {
  const fs = deps.fs ?? defaultFsProbe;
  const git = new GitRunner(deps.gitBin, deps.exec);
  const reaped: LandOutcome[] = [];
  const flagged: LandOutcome[] = [];
  // Repos already freshened this pass — so N merged worktrees in one repo trigger
  // a single fetch, not N. See the freshen step just before each reap.
  const freshenedRepos = new Set<string>();

  const candidates = await enumerateDexWorktrees(deps);
  for (const c of candidates) {
    const base = { taskId: c.taskId, branch: c.branch, path: c.path, repo: c.repo };
    const flag = (reason: string, pr?: LandPr): void => {
      flagged.push({ ...base, action: "flagged", reason, pr });
    };

    // --- Guard 1: the branch has a PR, and it's MERGED. ---
    let view: PrView | undefined;
    try {
      const json = await deps.exec(
        deps.ghBin,
        [
          "pr",
          "view",
          c.branch,
          "--json",
          "state,mergedAt,mergeCommit,url,title,number,statusCheckRollup",
        ],
        { cwd: c.path },
      );
      view = parsePrView(json);
    } catch {
      // No PR for the branch — in-progress or never opened; not actionable.
      continue;
    }
    if (!view) continue;
    if (view.state !== "MERGED" || !view.mergedAt) continue; // open/closed-unmerged → skip

    const pr = view.pr;

    // --- Guard 2: the worktree tree must be clean. ---
    let dirt: string;
    try {
      dirt = await deps.exec(deps.gitBin, ["-C", c.path, "status", "--porcelain"]);
    } catch {
      flag("merged, but its worktree status couldn't be read", pr);
      continue;
    }
    if (meaningfulDirt(dirt).length > 0) {
      flag("merged, but the worktree has uncommitted changes — land it by hand", pr);
      continue;
    }

    // --- Guard 3 (no-CI repos only): the local build must pass. ---
    if (view.checkCount === 0) {
      const build = inferBuild(c.path, fs);
      if (!build) {
        flag("merged with no CI, and no build command could be inferred", pr);
        continue;
      }
      if (!deps.autoLand) {
        flag(`ready to land (no-CI build gate: ${build.cmd} ${build.args.join(" ")})`, pr);
        continue;
      }
      try {
        deps.log?.(`dex.land: ${c.taskId}: no CI — build gate \`${build.cmd}\` in ${c.path}`);
        await deps.exec(build.cmd, build.args, { cwd: c.path });
      } catch (err) {
        flag(`merged with no CI, but the build failed (${build.cmd}): ${String(err)}`, pr);
        continue;
      }
    } else if (!deps.autoLand) {
      flag("ready to land", pr);
      continue;
    }

    // --- All guards passed: reap (worktree + branch + dex complete). ---
    // First, freshen this repo's default branch from origin — ONCE per pass,
    // before the reap completes the task — so the PR's merge commit is present
    // locally and `reap` links the real SHA via `dex complete --commit` instead
    // of the `--no-commit` fallback. Best-effort: a fetch failure (offline, no
    // origin) leaves the trunk stale and the reap degrades to `--no-commit`; it
    // never blocks the reap.
    if (!freshenedRepos.has(c.repo)) {
      freshenedRepos.add(c.repo);
      const repoBase = await git.defaultBranch(c.repo);
      const freshened = await git.fetchBase(c.repo, repoBase);
      if (!freshened) {
        deps.log?.(
          `dex.land: couldn't fetch origin/${repoBase} in ${c.repo}; reaping off the stale local trunk`,
        );
      }
    }

    const evidence = evidenceFor(pr);
    try {
      await reap(deps, c, pr, evidence);
      reaped.push({ ...base, action: "reaped", reason: evidence, pr });
      deps.log?.(`dex.land: reaped ${c.taskId} [${c.branch}] — ${evidence}`);
    } catch (err) {
      flag(`merged, but the reap failed: ${String(err)}`, pr);
    }
  }

  return { reaped, flagged };
}

/**
 * The destructive cleanup, run only after every guard passes. Ordered so a
 * failure never leaves a half-reaped state:
 *
 *   1. Complete the dex task first (idempotent — skipped when it's already done,
 *      so a task completed by hand or a previous pass doesn't error here). A real
 *      completion failure throws BEFORE anything is removed, so the caller flags
 *      it with nothing destroyed.
 *   2. Remove the worktree.
 *   3. Delete the branch — `-d` first (git's "refuse if not merged" net), falling
 *      back to `-D` only because the PR's `mergedAt` already proved the merge
 *      authoritatively (the local trunk is often just behind, which makes `-d`
 *      refuse a branch that really is merged upstream).
 */
async function reap(deps: LandDeps, c: Candidate, pr: LandPr, evidence: string): Promise<void> {
  if (!(await isTaskCompleted(deps, c))) {
    const completeArgs = ["--storage-path", storagePathOf(c.repo), "complete", c.taskId];
    // `dex complete --commit <sha>` validates the SHA exists in the LOCAL repo.
    // runLand fetches origin's default branch before reaping, so the merge commit
    // is normally present by now — but the fetch is best-effort (it can fail when
    // offline or origin-less), so link the commit only when it's actually present;
    // else complete with `--no-commit` (the merge SHA is still in the evidence text).
    if (pr.mergeCommit && (await commitExistsLocally(deps, c.repo, pr.mergeCommit))) {
      completeArgs.push("--commit", pr.mergeCommit);
    } else {
      completeArgs.push("--no-commit");
    }
    completeArgs.push("--result", evidence);
    await deps.exec(deps.dexBin, completeArgs);
  }
  await deps.exec(deps.gitBin, ["-C", c.repo, "worktree", "remove", c.path]);
  try {
    await deps.exec(deps.gitBin, ["-C", c.repo, "branch", "-d", c.branch]);
  } catch {
    await deps.exec(deps.gitBin, ["-C", c.repo, "branch", "-D", c.branch]);
  }
}

/** Whether `sha` resolves to a commit in the local repo (`git cat-file -e`). */
async function commitExistsLocally(deps: LandDeps, repo: string, sha: string): Promise<boolean> {
  try {
    await deps.exec(deps.gitBin, ["-C", repo, "cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the dex task is already marked completed (`"completed": true` in `dex
 * show --json`). Best-effort: any failure (missing task, unparseable output)
 * returns false, so the reaper falls through to attempting `dex complete` rather
 * than skipping it on a read hiccup.
 */
async function isTaskCompleted(deps: LandDeps, c: Candidate): Promise<boolean> {
  try {
    const out = await deps.exec(deps.dexBin, [
      "--storage-path",
      storagePathOf(c.repo),
      "show",
      c.taskId,
      "--json",
    ]);
    const parsed: unknown = JSON.parse(out);
    const task = Array.isArray(parsed) ? parsed[0] : parsed;
    return Boolean(task && typeof task === "object" && (task as { completed?: unknown }).completed);
  } catch {
    return false;
  }
}

/** A short PR label for a land notification body. */
function prLabel(pr: LandPr | undefined): string {
  if (pr?.number !== undefined) return `PR #${pr.number}`;
  return "its PR";
}

/**
 * Change-detection for the `dex.land` read: announce a worktree that was just
 * **reaped** (the loop closed — merged PR cleaned up) and one newly **flagged**
 * (merged but needs a hand). Pure; mirrors the other plugins' notify shape.
 *
 * `reaped` items are freshly reaped each pass (a reaped worktree is gone by the
 * next poll), so each fires once — the dedupe key guards any repeat. `flagged`
 * items persist across polls until resolved, so they're diffed by task id
 * against `prev` to warn exactly once. `[]` on the first poll (no `prev`).
 */
export function landNotifications(
  prev: LandBoard | undefined,
  next: LandBoard,
): Notification[] {
  if (prev === undefined) return [];
  const notes: Notification[] = [];

  for (const o of next.reaped) {
    notes.push({
      title: "Landed",
      body: `dex ${o.taskId}: reaped ${prLabel(o.pr)} (worktree + branch removed, task completed)`,
      level: "success",
      dedupeKey: `land:${o.taskId}:reaped`,
    });
  }

  const flaggedBefore = new Set(prev.flagged.map((o) => o.taskId));
  for (const o of next.flagged) {
    if (flaggedBefore.has(o.taskId)) continue; // already warned; don't repeat each poll
    notes.push({
      title: "PR merged — needs landing",
      body: `dex ${o.taskId}: ${o.reason}`,
      level: "warning",
      dedupeKey: `land:${o.taskId}:flagged`,
    });
  }

  return notes;
}
