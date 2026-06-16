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
import type { EventBus } from "./event-bus.js";
import { inputKey } from "./cache.js";
import { parseDuration } from "./duration.js";
import { invokeCapability, type InvokerDeps } from "./invoker.js";
import { buildContext } from "./loader.js";
import type { NotificationService } from "./notifications.js";
import type { RegisteredCapability } from "./registry.js";

interface Poller {
  timer: ReturnType<typeof setInterval>;
  /** Number of active subscribers sharing this poller. */
  refs: number;
  /** The validated input passed to the read. */
  input: unknown;
  /**
   * Whether a persistent (notify-driven) interest is holding this poller open
   * independent of client subscriptions. Such a poller stays armed even when
   * `refs` drops to zero, so notifications keep firing with no client attached.
   */
  persistent: boolean;
}

/** Owns refresh timers and refcounts for active read subscriptions. */
export class Scheduler {
  readonly #pollers = new Map<string, Poller>();

  constructor(
    private readonly deps: InvokerDeps,
    private readonly bus: EventBus,
    /** Sink for `notify`-hook output. Absent → notify hooks are not run. */
    private readonly notifications?: NotificationService,
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
        if (poller.timer) clearInterval(poller.timer);
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
    return key;
  }

  /**
   * Arm persistent pollers for every notify-read among `entries`. For each read
   * with a `notify` hook, the default input (`{}`/undefined validated through
   * the read's input schema, like a normal invoke) is computed and a persistent
   * poller armed via {@link armPersistent}. Reads with no `refresh.every` are
   * skipped (no interval to poll on). Returns the number armed. Safe to call
   * repeatedly — {@link armPersistent} is idempotent per `(id, input)`.
   */
  armNotifyReads(entries: Iterable<RegisteredCapability>): number {
    let armed = 0;
    for (const entry of entries) {
      if (entry.cap.kind !== "read") continue;
      const read = entry.cap as ReadDef<unknown, unknown, unknown>;
      if (!read.notify || !read.refresh?.every) continue;
      let input: unknown;
      try {
        input = read.input ? read.input.parse(undefined) : undefined;
      } catch (err) {
        // A notify-read whose default input fails validation can't be
        // persistently polled; log and skip rather than aborting boot.
        console.error(
          `perchd: cannot arm notify poller for ${entry.id} (invalid default input):`,
          err,
        );
        continue;
      }
      this.armPersistent(entry, input);
      armed += 1;
    }
    return armed;
  }

  /** Build a poller (starting its interval timer if the read declares one). */
  #makePoller(
    entry: RegisteredCapability,
    input: unknown,
    key: string,
    persistent: boolean,
  ): Poller {
    const every = entry.cap.kind === "read" ? entry.cap.refresh?.every : undefined;
    if (every) {
      const intervalMs = parseDuration(every);
      const timer = setInterval(() => {
        void this.#poll(entry, input, key);
      }, intervalMs);
      // Don't keep the event loop alive solely for polling.
      timer.unref?.();
      return { timer, refs: 1, input, persistent };
    }
    // No interval: still track the ref so unsubscribe is symmetric.
    return { timer: undefined as never, refs: 1, input, persistent };
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
      if (poller.timer) clearInterval(poller.timer);
      this.#pollers.delete(mapKey);
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

  async #poll(entry: RegisteredCapability, input: unknown, key: string): Promise<void> {
    try {
      // Snapshot the previous cached value before `invokeCapability` overwrites
      // it — this is the `prev` the notify hook diffs against (undefined on the
      // first poll, since nothing is cached yet).
      const prev = this.deps.cache.get(entry.id, key)?.data;
      const data = await invokeCapability(this.deps, entry, input);
      this.bus.emit({ id: entry.id, inputKey: key, data });
      await this.#runNotify(entry, prev, data);
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

  /** Stop and clear all timers (shutdown). */
  stop(): void {
    for (const poller of this.#pollers.values()) {
      if (poller.timer) clearInterval(poller.timer);
    }
    this.#pollers.clear();
  }
}
