/**
 * Change-detection for the `dex.tasks` read: announce the transitions that
 * matter when coordinating multiple agents — a task becoming **blocked**, and a
 * task becoming **ready** after being blocked (an agent can now pick it up).
 *
 * Pure (no I/O): diffs the previous board against the next by task id + status,
 * mirroring the services plugin's crash notifications. Returns `[]` on the first
 * poll (no `prev`) so an initial load doesn't spam, and only fires on a genuine
 * status change. A task seen for the first time isn't announced (it could be a
 * large initial set surfacing late); only transitions of already-known tasks do.
 */
import type { Notification } from "@perch/sdk";

import type { DexBoard, DexStatus } from "./normalize.js";

export function dexNotifications(prev: DexBoard | undefined, next: DexBoard): Notification[] {
  if (prev === undefined) return [];
  const before = new Map<string, DexStatus>(prev.tasks.map((t) => [t.id, t.status]));
  const notes: Notification[] = [];
  for (const task of next.tasks) {
    const was = before.get(task.id);
    if (was === undefined || was === task.status) continue;
    if (task.status === "blocked") {
      notes.push({
        title: "Task blocked",
        body: task.name,
        level: "warning",
        dedupeKey: `dex:${task.id}:blocked`,
      });
    } else if (task.status === "ready" && was === "blocked") {
      notes.push({
        title: "Task ready",
        body: `${task.name} is unblocked`,
        level: "success",
        dedupeKey: `dex:${task.id}:ready`,
      });
    }
  }
  return notes;
}
