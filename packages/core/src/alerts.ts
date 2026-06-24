/**
 * Alert store.
 *
 * An alert is a durable, plugin-raised condition the user should see (e.g.
 * "services:perch:api-server:crashed") — distinct from a {@link ./notifications.ts}
 * notification, which is a one-shot, fire-and-forget event. An alert stays raised
 * until the condition clears or the user dismisses it.
 *
 * State splits in two:
 * - **Active alerts** live only in daemon memory, keyed by a stable, caller-chosen
 *   id. {@link AlertStore.raise} is idempotent: re-raising an id refreshes its
 *   `raisedAt`/`payload` in place rather than stacking duplicates, and
 *   {@link AlertStore.clear} removes one by id.
 * - **The dismiss list** is persisted (via a {@link DismissalStore}, by default
 *   the user's `perch.yaml`) so an alert the user chose to ignore stays ignored
 *   across daemon restarts. {@link AlertStore.list} filters dismissed ids out.
 *
 * Persistence is injected so the store is unit-testable without touching real
 * config paths; {@link createAlertStore} wires the default config-backed store and
 * loads the saved dismiss list before returning.
 */
import { getConfig, updateConfig } from "./config-store.js";
import { configPath as defaultConfigPath } from "./paths.js";

/** An active alert held in the store. */
export interface Alert {
  /** Stable, caller-chosen id (e.g. `services:perch:api-server:crashed`). */
  id: string;
  /** The plugin id that raised it. */
  pluginId: string;
  /** Wall-clock time the alert was (re-)raised (ms since epoch). */
  raisedAt: number;
  /** Opaque, plugin-defined detail rendered by the frontend. */
  payload: unknown;
}

/** The fields a caller supplies to {@link AlertStore.raise}. */
export type RaiseInput = Omit<Alert, "id">;

/**
 * Durable backing for the dismiss list. Implementations persist the full set of
 * dismissed ids; the store treats it as the source of truth on boot and rewrites
 * it on every dismissal.
 */
export interface DismissalStore {
  /** Read the persisted dismissed ids (empty when none saved yet). */
  load(): Promise<string[]>;
  /** Persist the full set of dismissed ids, replacing any prior list. */
  save(ids: string[]): Promise<void>;
}

/** Options for {@link createAlertStore}. */
export interface AlertStoreOptions {
  /** Dismiss-list persistence. Defaults to the user's `perch.yaml`. */
  dismissals?: DismissalStore;
}

/**
 * In-memory active alerts plus a persisted dismiss list.
 *
 * Construct via {@link createAlertStore} so the saved dismiss list is loaded
 * before first use; the constructor takes the already-loaded state directly.
 */
export class AlertStore {
  readonly #alerts = new Map<string, Alert>();
  readonly #dismissed: Set<string>;
  readonly #dismissals: DismissalStore;

  constructor(dismissals: DismissalStore, dismissed: Iterable<string>) {
    this.#dismissals = dismissals;
    this.#dismissed = new Set(dismissed);
  }

  /**
   * Raise (or re-raise) the alert `id`. Idempotent: re-raising an existing id
   * overwrites its `raisedAt`/`payload` in place rather than creating a duplicate.
   * Raising a dismissed id does not un-dismiss it — it stays filtered from
   * {@link list} until {@link restore}d.
   */
  raise(id: string, input: RaiseInput): Alert {
    const alert: Alert = { id, ...input };
    this.#alerts.set(id, alert);
    return alert;
  }

  /** Remove the active alert `id`. Returns whether one was present. */
  clear(id: string): boolean {
    return this.#alerts.delete(id);
  }

  /**
   * Mark `id` dismissed and persist the updated list. Idempotent — dismissing an
   * already-dismissed id is a no-op that skips the write. The id need not be
   * currently raised; a future {@link raise} of it will still be filtered out.
   */
  async dismiss(id: string): Promise<void> {
    if (this.#dismissed.has(id)) return;
    this.#dismissed.add(id);
    await this.#dismissals.save([...this.#dismissed]);
  }

  /** Remove `id` from the dismiss list and persist. Returns whether it was set. */
  async restore(id: string): Promise<boolean> {
    if (!this.#dismissed.delete(id)) return false;
    await this.#dismissals.save([...this.#dismissed]);
    return true;
  }

  /** Whether `id` is on the persisted dismiss list. */
  isDismissed(id: string): boolean {
    return this.#dismissed.has(id);
  }

  /** Active alerts that are not dismissed, in raise order. */
  list(): Alert[] {
    return [...this.#alerts.values()].filter((a) => !this.#dismissed.has(a.id));
  }
}

/**
 * Build an {@link AlertStore} with its dismiss list loaded. Uses the config-backed
 * {@link DismissalStore} (the user's `perch.yaml`) unless one is injected.
 */
export async function createAlertStore(options: AlertStoreOptions = {}): Promise<AlertStore> {
  const dismissals = options.dismissals ?? configDismissalStore();
  return new AlertStore(dismissals, await dismissals.load());
}

/**
 * A {@link DismissalStore} backed by the durable `perch.yaml` `dismissedAlerts`
 * array (defaults to the platform config path). Reads via {@link getConfig} and
 * writes the full array via {@link updateConfig} (arrays replace wholesale).
 */
export function configDismissalStore(path: string = defaultConfigPath()): DismissalStore {
  return {
    async load() {
      return (await getConfig(path)).dismissedAlerts ?? [];
    },
    async save(ids) {
      await updateConfig({ dismissedAlerts: ids }, path);
    },
  };
}
