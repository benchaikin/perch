/**
 * `services.list` crash notifications (Dev services M1).
 *
 * Pure diff of two {@link ServiceList} snapshots, wired into the `services.list`
 * read's `notify` hook. The daemon calls the hook after each poll with the
 * previous cached list (`prev`) and the fresh one (`next`); we fire one
 * {@link Notification} per process that transitions INTO `crashed` (an `Error`
 * status, or a `Completed` with a non-zero exit code).
 *
 * The `dedupeKey` carries the restart count (`<name>:crashed:<restartCount>`) so
 * the daemon suppresses re-announcing the same crash on every subsequent poll
 * while it holds, but a crash that follows a restart (a new restart count)
 * re-announces. No fire on the first poll (`prev` undefined), on an unchanged
 * crashed state, or on a recovery (crashed → running).
 */
import type { Notification } from "@perch/sdk";

import type { Service, ServiceList } from "./services.js";

/** Index a list's services by name for O(1) prev/next lookup. */
function byName(list: ServiceList): Map<string, Service> {
  const out = new Map<string, Service>();
  for (const svc of list.services) out.set(svc.name, svc);
  return out;
}

/** `<name> crashed (exit <code>)`, or `<name> crashed` when no exit code is known. */
function crashBody(svc: Service): string {
  return svc.exitCode !== undefined
    ? `${svc.name} crashed (exit ${svc.exitCode})`
    : `${svc.name} crashed`;
}

/**
 * Diff `prev` vs `next` service lists into crash notifications. Fires once per
 * process that newly entered `crashed`:
 *
 * - A process whose status is `crashed` in `next` but was NOT `crashed` in
 *   `prev` (status flip, including `running`/`completed` → `crashed`).
 * - A process that is new in `next` and already `crashed` (e.g. it errored
 *   before the first poll captured a healthy state) — surfaced once.
 *
 * Returns `[]` when `prev` is `undefined` (the first poll — nothing to diff).
 */
export function crashNotifications(
  prev: ServiceList | undefined,
  next: ServiceList,
): Notification[] {
  if (prev === undefined) return [];

  const before = byName(prev);
  const notes: Notification[] = [];

  for (const svc of next.services) {
    if (svc.status !== "crashed") continue;
    const prevSvc = before.get(svc.name);
    // Already crashed and unchanged → don't re-announce.
    if (prevSvc && prevSvc.status === "crashed") continue;
    notes.push({
      title: "Service crashed",
      body: crashBody(svc),
      level: "error",
      dedupeKey: `${svc.name}:crashed:${svc.restartCount ?? 0}`,
    });
  }

  return notes;
}
