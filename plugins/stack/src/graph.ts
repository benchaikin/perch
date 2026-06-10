/**
 * The `StackGraph` — the shape of `stack.view`'s output (spec §8.2).
 *
 * A stack is an **ordered linear chain** (bottom → top): index 0 is the
 * trunk-adjacent layer, the last entry is the tip. Each layer is one branch
 * with at most one PR. The schema is deliberately **tolerant**: every
 * PR-derived field is optional so a half-formed stack (branch pushed, PR not
 * yet opened; CI not yet reported) still parses.
 */
import { z } from "@perch/sdk";

/**
 * Normalized CI rollup for a layer:
 * - `pass`    — all required checks succeeded
 * - `fail`    — at least one check failed / errored
 * - `pending` — checks queued or in progress
 * - `none`    — no checks reported (or no PR yet)
 */
export const CiStatus = z.enum(["pass", "fail", "pending", "none"]);
export type CiStatus = z.infer<typeof CiStatus>;

/** One layer of the stack: a branch and (usually) its PR. */
export const StackLayer = z.object({
  /** The layer's branch name (the join key against `gh pr list`). */
  branch: z.string(),
  /** PR number, if a PR has been opened for this branch. */
  prNumber: z.number().int().optional(),
  /** PR title, if known. */
  title: z.string().optional(),
  /** Normalized CI rollup; `none` when there is no PR or no checks. */
  ciStatus: CiStatus.default("none"),
  /** GitHub review decision, passed through verbatim when present. */
  reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).optional(),
  /** GitHub mergeable state, passed through verbatim when present. */
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]).optional(),
  /** Base of this layer has advanced past it — a rebase is needed. */
  needsRebase: z.boolean().default(false),
  /** This layer currently has a merge conflict against its base. */
  conflict: z.boolean().optional(),
  /** Web URL of the PR, if known. */
  url: z.string().optional(),
});
export type StackLayer = z.infer<typeof StackLayer>;

/** The current PR stack, bottom → top. */
export const StackGraph = z.object({
  /** The repository this stack belongs to (`owner/name`), if resolved. */
  repo: z.string().optional(),
  /** Ordered layers, index 0 = trunk-adjacent, last = tip. */
  layers: z.array(StackLayer),
});
export type StackGraph = z.infer<typeof StackGraph>;
