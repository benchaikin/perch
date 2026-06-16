/**
 * Electron-free "landable" derivation: joins each work-item (a dex task linked
 * to a live worktree) to its open PR and reduces the PR's CI + review + merge
 * state to a single, glanceable {@link LandableState}.
 *
 * This is the data foundation for a later merge-queue view. It deliberately does
 * NOT render anything — it only computes per-task state the next task consumes.
 *
 * Like `worktree-task-link.ts`, it's a pure GUI-side derivation from the reads
 * that already flow into panel state (`worktrees.list`, `dex.tasks`, `stack.prs`)
 * — no plugin-to-plugin calls. Match is by head branch: a work-item's worktree
 * carries a `branch`; the matching PR is the one whose `headRefName === branch`.
 */

import type { PrInfo, PrOverview } from "./panel-state.js";
import type { WorktreeTaskLink } from "./worktree-task-link.js";

/**
 * The merge-readiness of a work-item's PR, in (roughly) ascending desirability
 * within the unfinished states, with the two terminal-ish states at the ends:
 *
 * - `none`              — no matching PR (or no boards/overview). Nothing to land.
 * - `needs-review`      — CI green but not yet approved (review still required).
 * - `ci-running`        — CI is in progress (or only partially reported).
 * - `ci-failed`         — CI failed.
 * - `changes-requested` — a reviewer requested changes.
 * - `ready`             — CI green AND approved: safe to land.
 * - `merged`            — already merged (terminal).
 */
export type LandableState =
  | "none"
  | "needs-review"
  | "ci-running"
  | "ci-failed"
  | "changes-requested"
  | "ready"
  | "merged";

/**
 * Derive the {@link LandableState} from a single PR's CI + review fields.
 *
 * Precedence (highest wins), chosen so the most actionable blocker surfaces:
 *
 *   merged > ci-failed > changes-requested > ci-running > needs-review > ready
 *
 * Rationale:
 *  - `merged` is terminal — it overrides everything (the work is landed).
 *  - A hard `ci-failed` outranks `changes-requested`: a red build blocks the
 *    merge outright, where requested changes are a review-loop signal.
 *  - `ci-running` outranks `needs-review`: you can't land (or meaningfully
 *    re-review) until CI settles, so "wait for CI" is the live signal.
 *  - `needs-review` (CI green, not yet approved) outranks the happy path.
 *  - `ready` (CI green AND approved) is the only "go" state.
 *
 * Note: `stack.prs` only lists OPEN PRs, so in practice `merged` won't arrive on
 * the overview today; it's modeled for completeness and so a future read that
 * surfaces merged PRs maps cleanly. We treat a `MERGED`-like state as merged if
 * a PR ever carries it — see {@link prIsMerged}.
 */
export function deriveLandable(pr: PrInfo): LandableState {
  if (prIsMerged(pr)) return "merged";

  const ci = pr.ciStatus ?? "none";
  if (ci === "fail") return "ci-failed";

  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes-requested";

  // CI not yet conclusive (running, or no checks reported yet) — wait on it
  // before review can land the PR.
  if (ci === "pending" || ci === "none") return "ci-running";

  // CI is green (`pass`) past this point.
  if (pr.reviewDecision === "APPROVED") return "ready";

  // Green CI but not approved (REVIEW_REQUIRED or no decision yet).
  return "needs-review";
}

/**
 * Whether a PR should be treated as already merged. `PrInfo`'s wire shape has no
 * dedicated `merged`/`state` field today (the overview lists only open PRs), so
 * this is defensive: it reads an optional `merged`/`state` if a future read adds
 * one, and otherwise reports false. Centralized so {@link deriveLandable} stays
 * declarative.
 */
function prIsMerged(pr: PrInfo): boolean {
  const extra = pr as Partial<{ merged: boolean; state: string }>;
  if (extra.merged === true) return true;
  return typeof extra.state === "string" && extra.state.toUpperCase() === "MERGED";
}

/** Index every PR in an overview by its head branch for O(1) branch→PR lookup.
 *  When two PRs share a head ref (shouldn't happen for open PRs in one repo,
 *  but repos aren't disambiguated here), the first seen wins deterministically. */
function indexPrsByBranch(overview: PrOverview): Map<string, PrInfo> {
  const byBranch = new Map<string, PrInfo>();
  for (const repo of overview.repos) {
    for (const group of repo.groups) {
      const prs = group.kind === "stack" ? group.layers : [group.pr];
      for (const pr of prs) {
        if (!byBranch.has(pr.headRefName)) byBranch.set(pr.headRefName, pr);
      }
    }
  }
  return byBranch;
}

/**
 * Join the worktree↔task link to the PR overview and emit each work-item's
 * {@link LandableState}, keyed by dex task id. A work-item is a task that has a
 * live worktree (from {@link WorktreeTaskLink.worktreeByTaskId}); we match that
 * worktree's `branch` to the PR whose `headRefName` equals it, then derive the
 * state from that PR.
 *
 * Tolerant by design: a missing overview, a work-item whose worktree has no
 * branch, or a branch with no matching PR all simply omit that task from the map
 * (its state is `none` — absence). Never throws.
 *
 * Pure: same inputs → same map, no side effects.
 */
export function deriveLandableByTaskId(
  link: WorktreeTaskLink,
  overview: PrOverview | undefined,
): Map<string, LandableState> {
  const byTaskId = new Map<string, LandableState>();
  if (!overview) return byTaskId;

  const prByBranch = indexPrsByBranch(overview);
  if (prByBranch.size === 0) return byTaskId;

  for (const [taskId, worktree] of link.worktreeByTaskId) {
    const branch = worktree.branch;
    if (!branch) continue;
    const pr = prByBranch.get(branch);
    if (!pr) continue;
    byTaskId.set(taskId, deriveLandable(pr));
  }

  return byTaskId;
}
