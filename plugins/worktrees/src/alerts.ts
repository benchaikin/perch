/**
 * Alert derivation for the `worktrees.list` read: surface every worktree with
 * unresolved merge conflicts as a durable alert, so a conflict the user must
 * resolve shows in the dashboard until it's fixed (or the worktree removed).
 *
 * Pure (no I/O): diffs the previous board against the next by conflict alert id
 * and emits {@link AlertOp}s — `raise` for each worktree newly (or with a changed
 * payload) conflicted, `clear` for each that was conflicted and no longer is
 * (resolved, or its row left the board). The alert id is stable per worktree
 * ({@link conflictAlertId}) so a raise is idempotent.
 *
 * Unlike `notify`, this does NOT suppress the first poll (`prev` undefined): a
 * worktree already conflicted when polling starts (e.g. just after a daemon
 * restart) is a real condition that should surface. To avoid churning the alert's
 * `raisedAt`, a still-conflicted worktree whose payload is unchanged emits no op.
 * Distinct from {@link ./notify.ts}, which fires a one-shot notification the
 * moment a worktree *enters* conflict.
 */
import type { AlertOp } from "@perch/sdk";

import type { Worktree, Worktrees } from "./parse.js";

/**
 * The opaque payload a worktree conflict alert carries to the renderer's
 * {@link WorktreesAlertWidget}: enough to label the alert (branch + repo) and to
 * drive its Resolve action (the worktree `path`).
 */
export interface ConflictAlertPayload {
  /** The conflicted worktree's absolute path — what the Resolve action spawns in. */
  path: string;
  /** The worktree's branch (the primary label); absent for a detached HEAD. */
  branch?: string;
  /** The source repo (basename) the worktree belongs to; absent for the cwd default. */
  repo?: string;
  /** The worktree's display name (basename), a fallback label for a detached tree. */
  name: string;
}

/**
 * The stable alert id for a conflicted worktree: `worktrees:<repo>:<branch>:conflict`.
 * git forbids the same branch in two worktrees, so `<repo>:<branch>` is unique;
 * a detached HEAD (no branch) falls back to the worktree name, and the cwd-default
 * repo (untagged) to an empty segment.
 */
export function conflictAlertId(w: Worktree): string {
  return `worktrees:${w.repo ?? ""}:${w.branch ?? w.name}:conflict`;
}

function conflictPayload(w: Worktree): ConflictAlertPayload {
  return { path: w.path, branch: w.branch, repo: w.repo, name: w.name };
}

/**
 * Diff `prev`→`next` and emit the alert raises/clears for conflicted worktrees.
 * See the module doc for the first-poll and idempotency semantics.
 */
export function worktreeAlerts(prev: Worktrees | undefined, next: Worktrees): AlertOp[] {
  // alert id → payload, for the worktrees conflicted in the previous board.
  const wasConflicted = new Map<string, ConflictAlertPayload>();
  for (const w of prev?.worktrees ?? []) {
    if (w.conflict) wasConflicted.set(conflictAlertId(w), conflictPayload(w));
  }

  const ops: AlertOp[] = [];
  const stillConflicted = new Set<string>();
  for (const w of next.worktrees) {
    if (!w.conflict) continue;
    const id = conflictAlertId(w);
    stillConflicted.add(id);
    const payload = conflictPayload(w);
    // Raise only when the condition is newly true or its payload changed, so a
    // persistently-conflicted worktree doesn't re-stamp `raisedAt` every poll.
    const before = wasConflicted.get(id);
    if (before && samePayload(before, payload)) continue;
    ops.push({ op: "raise", id, payload });
  }

  // Clear any worktree that was conflicted but isn't anymore (resolved, or its
  // row left the board entirely).
  for (const id of wasConflicted.keys()) {
    if (!stillConflicted.has(id)) ops.push({ op: "clear", id });
  }

  return ops;
}

function samePayload(a: ConflictAlertPayload, b: ConflictAlertPayload): boolean {
  return a.path === b.path && a.branch === b.branch && a.repo === b.repo && a.name === b.name;
}
