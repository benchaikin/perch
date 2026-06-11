/**
 * Notification service.
 *
 * A read's `notify` hook (see `@perch/sdk`) returns {@link Notification}s when
 * its data changes; the scheduler hands them to {@link NotificationService.emit},
 * which stamps each with an id/source/timestamp, de-duplicates by `dedupeKey`
 * within a TTL window, and fans the survivors out to registered
 * {@link NotificationSink}s (e.g. the RPC sink that pushes to subscribed
 * clients).
 *
 * Unlike the workflow runtime, the daemon is real production code, so we use
 * `Date.now()` for timestamps and TTL expiry directly.
 */
import type { Notification, NotificationLevel } from "@perch/sdk";

export type { Notification, NotificationLevel };

/** A {@link Notification} after the daemon stamps delivery metadata onto it. */
export interface DeliveredNotification extends Notification {
  /** Process-unique id for this delivery. */
  id: string;
  /** The capability id that produced it (`${pluginId}.${name}`). */
  source: string;
  /** Wall-clock time the daemon emitted it (ms since epoch). */
  timestamp: number;
}

/** A destination notifications are routed to (RPC fan-out, desktop, …). */
export interface NotificationSink {
  deliver(n: DeliveredNotification): void;
}

/** Options for {@link NotificationService}. */
export interface NotificationServiceOptions {
  /**
   * De-dupe window in milliseconds. A repeat of the same `dedupeKey` within this
   * window of the last time it was seen is suppressed. Default: 5 minutes. A
   * value of `0` disables de-duplication (every emit passes).
   */
  dedupeTtlMs?: number;
  /** Time source, injectable for tests. Defaults to {@link Date.now}. */
  now?: () => number;
}

const DEFAULT_DEDUPE_TTL_MS = 5 * 60_000;
/** Sweep expired de-dupe entries at most this often. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Stamps, de-dupes, and routes notifications.
 *
 * De-dupe semantics: an item with a `dedupeKey` is suppressed if the same key
 * was last delivered within `dedupeTtlMs`; the stored timestamp is refreshed
 * each time the key passes (sliding window). Items without a `dedupeKey` always
 * pass. With `dedupeTtlMs === 0`, every item passes.
 */
export class NotificationService {
  readonly #sinks = new Set<NotificationSink>();
  /** dedupeKey → last-delivered timestamp. */
  readonly #seen = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  #seq = 0;
  #sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: NotificationServiceOptions = {}) {
    this.#ttlMs = options.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS;
    this.#now = options.now ?? Date.now;
    if (this.#ttlMs > 0) {
      this.#sweepTimer = setInterval(() => this.#sweep(), SWEEP_INTERVAL_MS);
      this.#sweepTimer.unref?.();
    }
  }

  /** Register a destination for future notifications. */
  addSink(sink: NotificationSink): void {
    this.#sinks.add(sink);
  }

  /** Unregister a destination. */
  removeSink(sink: NotificationSink): void {
    this.#sinks.delete(sink);
  }

  /**
   * Stamp `items` with id/source/timestamp, drop de-dupe suppressed ones, and
   * deliver the survivors to every sink. A throwing sink does not block the rest.
   */
  emit(source: string, items: Notification[]): void {
    const now = this.#now();
    for (const item of items) {
      if (this.#suppressed(item.dedupeKey, now)) continue;
      const delivered: DeliveredNotification = {
        ...item,
        id: `${now}-${this.#seq++}`,
        source,
        timestamp: now,
      };
      for (const sink of this.#sinks) {
        try {
          sink.deliver(delivered);
        } catch (err) {
          console.error(`perchd: notification sink failed for ${source}:`, err);
        }
      }
    }
  }

  /**
   * Whether an item should be suppressed, and (as a side effect) record/refresh
   * the key's last-seen time when it passes.
   */
  #suppressed(dedupeKey: string | undefined, now: number): boolean {
    if (dedupeKey === undefined || this.#ttlMs <= 0) return false;
    const last = this.#seen.get(dedupeKey);
    if (last !== undefined && now - last < this.#ttlMs) return true;
    this.#seen.set(dedupeKey, now);
    return false;
  }

  /** Drop de-dupe entries past their TTL so the map can't grow unbounded. */
  #sweep(): void {
    const now = this.#now();
    for (const [key, last] of this.#seen) {
      if (now - last >= this.#ttlMs) this.#seen.delete(key);
    }
  }

  /** Stop timers and drop all state (shutdown). */
  stop(): void {
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#sweepTimer = undefined;
    this.#seen.clear();
    this.#sinks.clear();
  }
}
