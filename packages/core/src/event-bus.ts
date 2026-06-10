/**
 * A tiny typed event emitter.
 *
 * The scheduler publishes capability updates here; the RPC server subscribes
 * and forwards them as `capability.update` notifications to live clients.
 */

/** Payload pushed when a subscribed read produces fresh data. */
export interface CapabilityUpdate {
  /** Canonical capability id. */
  id: string;
  /** Serialized input key the update is keyed to. */
  inputKey: string;
  /** The fresh (output-validated) data. */
  data: unknown;
}

type Listener<T> = (event: T) => void;

/** Minimal single-event typed emitter with explicit unsubscribe. */
export class TypedEmitter<T> {
  readonly #listeners = new Set<Listener<T>>();

  /** Subscribe; returns an unsubscribe function. */
  on(listener: Listener<T>): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Emit an event to all current listeners. */
  emit(event: T): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  /** Remove all listeners (used on shutdown). */
  clear(): void {
    this.#listeners.clear();
  }
}

/** The daemon's event bus: a stream of {@link CapabilityUpdate}s. */
export type EventBus = TypedEmitter<CapabilityUpdate>;

/** Create a fresh event bus. */
export function createEventBus(): EventBus {
  return new TypedEmitter<CapabilityUpdate>();
}
