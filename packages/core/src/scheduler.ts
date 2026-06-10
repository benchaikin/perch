/**
 * Scheduler / poller.
 *
 * For each active subscription to a read with `refresh.every`, polls on that
 * interval, runs the capability, caches the result, and emits a
 * {@link CapabilityUpdate} on the event bus. Timers are reference-counted per
 * `(capabilityId, inputKey)` so multiple subscribers share one poller, and are
 * all cleared on shutdown.
 */
import type { EventBus } from "./event-bus.js";
import { inputKey } from "./cache.js";
import { parseDuration } from "./duration.js";
import { invokeCapability, type InvokerDeps } from "./invoker.js";
import type { RegisteredCapability } from "./registry.js";

interface Poller {
  timer: ReturnType<typeof setInterval>;
  /** Number of active subscribers sharing this poller. */
  refs: number;
  /** The validated input passed to the read. */
  input: unknown;
}

/** Owns refresh timers and refcounts for active read subscriptions. */
export class Scheduler {
  readonly #pollers = new Map<string, Poller>();

  constructor(
    private readonly deps: InvokerDeps,
    private readonly bus: EventBus,
  ) {}

  #key(id: string, key: string): string {
    return `${id} ${key}`;
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

    const every = entry.cap.refresh?.every;
    if (every) {
      const intervalMs = parseDuration(every);
      const timer = setInterval(() => {
        void this.#poll(entry, input, key);
      }, intervalMs);
      // Don't keep the event loop alive solely for polling.
      timer.unref?.();
      this.#pollers.set(mapKey, { timer, refs: 1, input });
    } else {
      // No interval: still track the ref so unsubscribe is symmetric.
      this.#pollers.set(mapKey, { timer: undefined as never, refs: 1, input });
    }
    return key;
  }

  /** Drop one subscriber; stop the poller when the last one leaves. */
  unsubscribe(id: string, key: string): void {
    const mapKey = this.#key(id, key);
    const poller = this.#pollers.get(mapKey);
    if (!poller) return;
    poller.refs -= 1;
    if (poller.refs <= 0) {
      if (poller.timer) clearInterval(poller.timer);
      this.#pollers.delete(mapKey);
    }
  }

  async #poll(entry: RegisteredCapability, input: unknown, key: string): Promise<void> {
    try {
      const data = await invokeCapability(this.deps, entry, input);
      this.bus.emit({ id: entry.id, inputKey: key, data });
    } catch (err) {
      console.error(`perchd: poll failed for ${entry.id}:`, err);
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
