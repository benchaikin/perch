/**
 * Change-detection for the `worktrees.list` read: announce a worktree that has
 * newly entered a conflict, and a newly-appeared worktree (an agent spun one up).
 *
 * Pure: diffs the previous board against the next by path. Returns `[]` on the
 * first poll (no `prev`). Dedup-keyed so a persistent state announces once.
 */
import type { Notification } from "@perch/sdk";

import type { Worktrees } from "./parse.js";

export function worktreeNotifications(
  prev: Worktrees | undefined,
  next: Worktrees,
): Notification[] {
  if (prev === undefined) return [];
  const before = new Map(prev.worktrees.map((w) => [w.path, w]));
  const notes: Notification[] = [];
  for (const w of next.worktrees) {
    const was = before.get(w.path);
    const label = `${w.name} (${w.branch ?? "detached"})`;
    if (was === undefined) {
      notes.push({
        title: "New worktree",
        body: label,
        level: "info",
        dedupeKey: `worktree:${w.path}:new`,
      });
    } else if (w.conflict && !was.conflict) {
      notes.push({
        title: "Worktree conflict",
        body: label,
        level: "warning",
        dedupeKey: `worktree:${w.path}:conflict`,
      });
    }
  }
  return notes;
}
