/**
 * Electron-free mapping + filtering for native desktop notifications.
 *
 * The main process subscribes to `notification` pushes over RPC and displays
 * each as a native macOS notification (Electron's `Notification`). The daemon
 * already de-duplicates, so the only logic here is (a) projecting a
 * {@link NotificationPayload} onto the `{ title, body }` Electron options and
 * (b) a "should-show" predicate that drops a replayed backlog on reconnect.
 * Both are pure so they can be unit-tested without a display — the
 * `Notification`/`shell` calls themselves stay in `main.ts`.
 */
import type { NotificationPayload } from "@perch/core";

/** The subset of Electron `NotificationConstructorOptions` we populate. */
export interface NotifyOptions {
  /** Bold first line. */
  title: string;
  /** Secondary line; always a string (empty when the payload has no body). */
  body: string;
}

/**
 * Project a delivered notification onto Electron `Notification` options.
 * `body` is normalized to `""` when absent so the native banner renders cleanly.
 */
export function toNotifyOptions(note: NotificationPayload): NotifyOptions {
  return { title: note.title, body: note.body ?? "" };
}

/**
 * Whether a freshly-arrived notification should be shown.
 *
 * The daemon de-dupes live pushes, but a reconnect could in principle replay a
 * backlog; anything stamped before the app started is stale, so we drop it.
 * Notifications emitted at or after `startTime` are shown.
 */
export function shouldShowNotification(note: NotificationPayload, startTime: number): boolean {
  return note.timestamp >= startTime;
}
