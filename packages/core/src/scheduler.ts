/**
 * Scheduler / poller.
 *
 * For each active subscription to a read with `refresh.every`, polls on that
 * interval, runs the capability, caches the result, and emits a
 * {@link CapabilityUpdate} on the event bus. Timers are reference-counted per
 * `(capabilityId, inputKey)` so multiple subscribers share one poller, and are
 * all cleared on shutdown.
 */
import type { ReadDef } from "@perch/sdk";
import type { AlertSink } from "./alerts.js";
import type { EventBus } from "./event-bus.js";
import { inputKey } from "./cache.js";
import { parseDuration } from "./duration.js";
import { invokeCapability, type InvokerDeps } from "./invoker.js";
import { buildContext } from "./loader.js";
import type { NotificationService } from "./notifications.js";
import type { RegisteredCapability } from "./registry.js";

interface Poller {
  /** The read capability this poller refreshes (needed to re-poll on poke). */
  entry: RegisteredCapability;
  /**
   * Handle for the pending next poll. Reassigned on each cycle because polling
   * self-reschedules via `setTimeout` (see `#makePoller`); `undefined` for a
   * read with no `refresh.every`.
   */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Number of active subscribers sharing this poller. */
  refs: number;
  /** The validated input passed to the read. */
  input: unknown;
  /** The input key this poller is bound to (needed to re-arm its own timer). */
  key: string;
  /**
   * Whether a persistent (notify-driven) interest is holding this poller open
   * independent of client subscriptions. Such a poller stays armed even when
   * `refs` drops to zero, so notifications keep firing with no client attached.
   */
  persistent: boolean;
  /**
   * Set when the poller is torn down. Because each poll re-arms the next timer
   * only after it finishes, clearing the timer cannot stop a poll already in
   * flight; this flag tells that in-flight poll not to reschedule itself.
   */
  stopped: boolean;
  /**
   * Normal poll interval (ms) used while a GUI client is subscribed
   * (`refs > 0`); `undefined` for a read with no `refresh.every`.
   */
  everyMs: number | undefined;
  /**
   * Slower poll interval (ms) used while only persistent interest holds the
   * poller open (`refs === 0`). Falls back to {@link everyMs} when the read
   * declares no `refresh.idleEvery`.
   */
  idleMs: number | undefined;
  /** Interval (ms) the currently-armed timer is using, so we re-arm only when
   *  the desired interval actually changes. */
  currentMs: number | undefined;
}

/** Owns refresh timers and refcounts for active read subscriptions. */
export class Scheduler {
  readonly #pollers = new Map<string, Poller>();

  constructor(
    private readonly deps: InvokerDeps,
    private readonly bus: EventBus,
    /** Sink for `notify`-hook output. Absent → notify hooks are not run. */
    private readonly notifications?: NotificationService,
    /** Store for `alerts`-hook output. Absent → alerts hooks are not run. */
    private readonly alerts?: AlertSink,
  ) {}

  #key(id: string, key: string): string {
    return `${id} ${key}`;
  }

  /** Split a composite poller key back into its `(capabilityId, inputKey)`. */
  #splitId(mapKey: string): string {
    return mapKey.slice(0, mapKey.indexOf(" "));
  }

  /**
   * Stop and drop every poller whose capability id starts with `${pluginId}.`
   * (runtime reload: a plugin was disabled or its config changed). Clears the
   * underlying timers; refcounts are discarded since the owning capability is
   * going away. Returns the number of pollers removed.
   *
   * Note: server-side subscription bookkeeping (per-connection `#subs`) is left
   * intact deliberately — a later `unsubscribe` for a now-gone capability is a
   * no-op here, so there is nothing to leak.
   */
  stopForPlugin(pluginId: string): number {
    const prefix = `${pluginId}.`;
    let removed = 0;
    for (const [mapKey, poller] of this.#pollers) {
      const id = this.#splitId(mapKey);
      if (id === pluginId || id.startsWith(prefix)) {
        this.#teardown(poller);
        this.#pollers.delete(mapKey);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Register a subscription to a read. Starts (or shares) a poller if the read
   * declares `refresh.every`. Returns the input key the subscription is bound
   * to. Reads only — throws for actions.
   */
  subscribe(entry: RegisteredCapability, input: unknown): string {
    if (entry.cap.kind !== "read") {
      throw new Error(
        `perchd: cannot subscribe to non-read capability ${JSON.stringify(entry.id)}`,
      );
    }
    const key = inputKey(input);
    const mapKey = this.#key(entry.id, key);
    const existing = this.#pollers.get(mapKey);
    if (existing) {
      existing.refs += 1;
      // First GUI client on an idling persistent poller → switch to the fast
      // interval right away rather than waiting out the idle one.
      this.#retune(existing);
      return key;
    }

    this.#pollers.set(mapKey, this.#makePoller(entry, input, key, false));
    return key;
  }

  /**
   * Arm a persistent poller for a notify-driven read so it polls even with no
   * client subscribed (notifications fire with the panel closed). Idempotent: a
   * pre-existing poller for the same `(id, input)` — e.g. from a client
   * subscription — is reused and simply marked persistent, so the key is never
   * double-polled. No-op for reads without `refresh.every` (nothing to poll on).
   */
  armPersistent(entry: RegisteredCapability, input: unknown): string {
    if (entry.cap.kind !== "read") {
      throw new Error(
        `perchd: cannot arm persistent poller for non-read ${JSON.stringify(entry.id)}`,
      );
    }
    const key = inputKey(input);
    const mapKey = this.#key(entry.id, key);
    const existing = this.#pollers.get(mapKey);
    if (existing) {
      existing.persistent = true;
      return key;
    }
    if (!entry.cap.refresh?.every) return key;
    // refs starts at 0: no client holds it, only the persistent interest.
    const poller = this.#makePoller(entry, input, key, true);
    poller.refs = 0;
    this.#pollers.set(mapKey, poller);
    // With no client subscribed, drop to the idle interval immediately.
    this.#retune(poller);
    return key;
  }

  /**
   * Arm persistent pollers for every notify- or alert-driven read among
   * `entries`. For each read with a `notify` and/or `alerts` hook, the default
   * input (`{}`/undefined validated through the read's input schema, like a
   * normal invoke) is computed and a persistent poller armed via
   * {@link armPersistent} — so a blocked-agent (or other) alert fires even with
   * the panel closed, just as notifications do. Reads with no `refresh.every` are
   * skipped (no interval to poll on). Returns the number armed. Safe to call
   * repeatedly — {@link armPersistent} is idempotent per `(id, input)`.
   */
  armNotifyReads(entries: Iterable<RegisteredCapability>): number {
    let armed = 0;
    for (const entry of entries) {
      if (entry.cap.kind !== "read") continue;
      const read = entry.cap as ReadDef<unknown, unknown, unknown>;
      if ((!read.notify && !read.alerts) || !read.refresh?.every) continue;
      let input: unknown;
      try {
        input = read.input ? read.input.parse(undefined) : undefined;
      } catch (err) {
        // A notify/alert read whose default input fails validation can't be
        // persistently polled; log and skip rather than aborting boot.
        console.error(
          `perchd: cannot arm persistent poller for ${entry.id} (invalid default input):`,
          err,
        );
        continue;
      }
      this.armPersistent(entry, input);
      armed += 1;
    }
    return armed;
  }

  /**
   * Force an immediate poll of every active poller for capability `id`, outside
   * its normal timer interval. This is the action→read reactivity primitive: a
   * mutation can refresh the reads that depend on its outcome the moment it
   * lands, rather than waiting for the next tick. Fire-and-forget — each poll
   * runs in the background and emits on the event bus when done; the timer-driven
   * cycle is untouched. A capability with no active poller (nothing subscribed,
   * no persistent interest) is silently a no-op.
   */
  poke(id: string): void {
    for (const [mapKey, poller] of this.#pollers) {
      if (this.#splitId(mapKey) !== id) continue;
      void this.#poll(poller.entry, poller.input, poller.key);
    }
  }

  /**
   * Build a poller, arming a self-rescheduling timer if the read declares an
   * interval. Each poll runs to completion and only then schedules the next one
   * a full interval later, so polls never overlap and the idle gap matches the
   * declared interval regardless of how long a poll takes.
   */
  #makePoller(
    entry: RegisteredCapability,
    input: unknown,
    key: string,
    persistent: boolean,
  ): Poller {
    // No interval: still track the ref so unsubscribe is symmetric.
    const poller: Poller = {
      entry,
      timer: undefined,
      refs: 1,
      input,
      key,
      persistent,
      stopped: false,
      everyMs: undefined,
      idleMs: undefined,
      currentMs: undefined,
    };
    const refresh = entry.cap.kind === "read" ? entry.cap.refresh : undefined;
    if (refresh?.every) {
      poller.everyMs = parseDuration(refresh.every);
      poller.idleMs = refresh.idleEvery ? parseDuration(refresh.idleEvery) : poller.everyMs;
      this.#arm(poller);
    }
    return poller;
  }

  /**
   * The interval (ms) the poller should currently use: the fast {@link
   * Poller.everyMs} while a GUI client is subscribed, or the slower {@link
   * Poller.idleMs} when only persistent interest holds it open. `undefined` for
   * a read with no `refresh.every`.
   */
  #desiredIntervalMs(poller: Poller): number | undefined {
    if (poller.everyMs === undefined) return undefined;
    return poller.refs > 0 ? poller.everyMs : (poller.idleMs ?? poller.everyMs);
  }

  /**
   * Arm the next poll using the poller's currently-desired interval. The timer
   * re-arms itself after each poll, so a poll always re-reads `refs` and adapts
   * the interval on the next cycle.
   */
  #arm(poller: Poller): void {
    const intervalMs = this.#desiredIntervalMs(poller);
    if (intervalMs === undefined) return;
    poller.currentMs = intervalMs;
    const timer = setTimeout(async () => {
      await this.#poll(poller.entry, poller.input, poller.key);
      if (!poller.stopped) this.#arm(poller);
    }, intervalMs);
    // Don't keep the event loop alive solely for polling.
    timer.unref?.();
    poller.timer = timer;
  }

  /**
   * Re-arm a poller's timer when its desired interval changed because `refs`
   * crossed the subscribed/idle boundary. Resets the pending delay to the new
   * interval so a switch takes effect immediately rather than after the old
   * interval elapses. No-op when the interval is unchanged.
   */
  #retune(poller: Poller): void {
    if (poller.stopped || poller.everyMs === undefined) return;
    if (this.#desiredIntervalMs(poller) === poller.currentMs) return;
    if (poller.timer) clearTimeout(poller.timer);
    this.#arm(poller);
  }

  /**
   * Stop a poller's timer and mark it stopped so an in-flight poll won't re-arm
   * the next one. Does not remove it from `#pollers` — callers handle that.
   */
  #teardown(poller: Poller): void {
    poller.stopped = true;
    if (poller.timer) clearTimeout(poller.timer);
  }

  /**
   * Drop one subscriber; stop the poller when the last one leaves — unless a
   * persistent (notify-driven) interest is holding it open, in which case the
   * timer stays armed.
   */
  unsubscribe(id: string, key: string): void {
    const mapKey = this.#key(id, key);
    const poller = this.#pollers.get(mapKey);
    if (!poller) return;
    poller.refs -= 1;
    if (poller.refs <= 0 && !poller.persistent) {
      this.#teardown(poller);
      this.#pollers.delete(mapKey);
    } else {
      // Last GUI client left a persistent poller → drop to the idle interval.
      this.#retune(poller);
    }
  }

  /** Whether a poller exists for `(id, key)` (test/introspection helper). */
  hasPoller(id: string, key: string): boolean {
    return this.#pollers.has(this.#key(id, key));
  }

  /** Whether a persistent poller is armed for `(id, key)` (test helper). */
  hasPersistentPoller(id: string, key: string): boolean {
    return this.#pollers.get(this.#key(id, key))?.persistent === true;
  }

  /**
   * The interval (ms) the poller for `(id, key)` is currently armed at, or
   * `undefined` if there is no poller / it has no interval (test helper).
   */
  pollerIntervalMs(id: string, key: string): number | undefined {
    return this.#pollers.get(this.#key(id, key))?.currentMs;
  }

  async #poll(entry: RegisteredCapability, input: unknown, key: string): Promise<void> {
    try {
      // Snapshot the previous cached value before `invokeCapability` overwrites
      // it — this is the `prev` the notify hook diffs against (undefined on the
      // first poll, since nothing is cached yet).
      const prev = this.deps.cache.get(entry.id, key)?.data;
      const data = await invokeCapability(this.deps, entry, input);
      this.bus.emit({ id: entry.id, inputKey: key, data });
      await this.#runNotify(entry, prev, data);
      await this.#runAlerts(entry, prev, data);
    } catch (err) {
      console.error(`perchd: poll failed for ${entry.id}:`, err);
    }
  }

  /**
   * Run a read's `notify` hook (if any) and route its output to the
   * {@link NotificationService}. Isolated in try/catch: a throwing or rejecting
   * notify hook is logged and swallowed so it can never break polling.
   */
  async #runNotify(entry: RegisteredCapability, prev: unknown, next: unknown): Promise<void> {
    if (!this.notifications || entry.cap.kind !== "read") return;
    const read = entry.cap as ReadDef<unknown, unknown, unknown>;
    if (!read.notify) return;
    try {
      const ctx = buildContext({
        pluginId: entry.pluginId,
        config: this.deps.configs[entry.pluginId],
        globalConfig: this.deps.global,
        signal: this.deps.signal,
      });
      const items = await read.notify({ prev, next, ctx });
      if (items.length > 0) this.notifications.emit(entry.id, items);
    } catch (err) {
      console.error(`perchd: notify hook failed for ${entry.id}:`, err);
    }
  }

  /**
   * Run a read's `alerts` hook (if any) and apply its {@link AlertOp}s to the
   * {@link AlertSink} — raise/clear by id, stamping the raising plugin and
   * `raisedAt` server-side (mirroring the `alerts.raise` RPC handler). Isolated
   * in try/catch like {@link #runNotify}: a throwing or rejecting hook is logged
   * and swallowed so it can never break polling.
   */
  async #runAlerts(entry: RegisteredCapability, prev: unknown, next: unknown): Promise<void> {
    if (!this.alerts || entry.cap.kind !== "read") return;
    const read = entry.cap as ReadDef<unknown, unknown, unknown>;
    if (!read.alerts) return;
    try {
      const ctx = buildContext({
        pluginId: entry.pluginId,
        config: this.deps.configs[entry.pluginId],
        globalConfig: this.deps.global,
        signal: this.deps.signal,
      });
      const ops = await read.alerts({ prev, next, ctx });
      for (const op of ops) {
        if (op.op === "raise") {
          this.alerts.raise(op.id, { pluginId: entry.pluginId, raisedAt: Date.now(), payload: op.payload });
        } else {
          this.alerts.clear(op.id);
        }
      }
    } catch (err) {
      console.error(`perchd: alerts hook failed for ${entry.id}:`, err);
    }
  }

  /** Stop and clear all timers (shutdown). */
  stop(): void {
    for (const poller of this.#pollers.values()) {
      this.#teardown(poller);
    }
    this.#pollers.clear();
  }
}
