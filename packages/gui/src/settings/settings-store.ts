/**
 * The Settings window's external store — a tiny, framework-agnostic store the
 * React shell subscribes to via `useSyncExternalStore`. It owns the three bridge
 * snapshots (the repo list, the per-plugin descriptors, the managed processes)
 * plus the two "a call is in flight" busy flags, and exposes the same
 * seed-then-re-read action loop the old vanilla renderer had: each bridge call
 * stores its refreshed result and notifies subscribers, which re-render.
 *
 * The bridge is injected (not read off `window`) so the store unit-tests against
 * a mock `PerchSettingsBridge` with no Electron/DOM in sight; the entry wires the
 * real `window.perchSettings`.
 */
import type { SettingsFieldState } from "@perch/core";
import { coerceFieldValue } from "../settings-fields.js";
import type {
  PerchSettingsBridge,
  PluginSettingsResult,
  ServicesResult,
  SettingsResult,
} from "../settings-ipc.js";

/** The immutable snapshot the shell renders from; replaced wholesale on change. */
export interface SettingsSnapshot {
  /** Latest repo list (Pull Requests tab). */
  repos: SettingsResult;
  /** Latest per-plugin descriptors (every tab's fields). */
  plugins: PluginSettingsResult;
  /** Latest managed-process list (Services tab). */
  services: ServicesResult;
  /** Disables repo controls while a repos bridge call is in flight. */
  reposBusy: boolean;
  /** Disables service controls while a services bridge call is in flight. */
  servicesBusy: boolean;
}

/** The store the shell consumes: a snapshot source plus the action methods. */
export interface SettingsStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): SettingsSnapshot;
  /** Kick off the initial loads (repos, procs, descriptors) in parallel. */
  init(): Promise<void>;
  /** Run a repos bridge call with the repo controls disabled, store the result. */
  runRepos(call: (bridge: PerchSettingsBridge) => Promise<SettingsResult>): Promise<void>;
  /** Run a services bridge call with the service controls disabled, store result. */
  runServices(call: (bridge: PerchSettingsBridge) => Promise<ServicesResult>): Promise<void>;
  /** Run a per-plugin bridge call, store the refreshed descriptors. */
  runPlugins(call: (bridge: PerchSettingsBridge) => Promise<PluginSettingsResult>): Promise<void>;
  /** Coerce a raw control value and persist it as one plugin field, then re-read. */
  persistField(pluginId: string, field: SettingsFieldState, raw: unknown): void;
}

/** The empty defaults rendered before the first bridge results arrive. */
const EMPTY: SettingsSnapshot = {
  repos: { repos: [], daemonUp: false },
  plugins: { plugins: [], daemonUp: false },
  services: { procs: [], daemonUp: false },
  reposBusy: false,
  servicesBusy: false,
};

/** Render `err` as a human-readable string (an `Error` message or its `String`). */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Build a {@link SettingsStore} backed by `bridge`. */
export function createSettingsStore(bridge: PerchSettingsBridge): SettingsStore {
  let snapshot: SettingsSnapshot = EMPTY;
  const listeners = new Set<() => void>();

  function emit(next: SettingsSnapshot): void {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  /** Patch the snapshot (a shallow merge) and notify subscribers. */
  function patch(part: Partial<SettingsSnapshot>): void {
    emit({ ...snapshot, ...part });
  }

  async function runRepos(
    call: (b: PerchSettingsBridge) => Promise<SettingsResult>,
  ): Promise<void> {
    patch({ reposBusy: true });
    try {
      patch({ repos: await call(bridge) });
    } catch (err) {
      patch({ repos: { ...snapshot.repos, error: errorText(err) } });
    } finally {
      patch({ reposBusy: false });
    }
  }

  async function runServices(
    call: (b: PerchSettingsBridge) => Promise<ServicesResult>,
  ): Promise<void> {
    patch({ servicesBusy: true });
    try {
      patch({ services: await call(bridge) });
    } catch (err) {
      patch({ services: { ...snapshot.services, error: errorText(err) } });
    } finally {
      patch({ servicesBusy: false });
    }
  }

  async function runPlugins(
    call: (b: PerchSettingsBridge) => Promise<PluginSettingsResult>,
  ): Promise<void> {
    try {
      patch({ plugins: await call(bridge) });
    } catch (err) {
      patch({ plugins: { ...snapshot.plugins, error: errorText(err) } });
    }
  }

  function persistField(pluginId: string, field: SettingsFieldState, raw: unknown): void {
    const value = coerceFieldValue(field.type, raw);
    // A number input cleared to blank coerces to `undefined` — skip the write
    // rather than persist nothing (the control keeps its displayed value).
    if (value === undefined) return;
    void runPlugins((b) => b.setField({ pluginId, key: field.key, value }));
  }

  async function init(): Promise<void> {
    await Promise.all([
      runRepos((b) => b.listRepos()),
      runServices((b) => b.listProcs()),
      runPlugins((b) => b.describePlugins()),
    ]);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
    init,
    runRepos,
    runServices,
    runPlugins,
    persistField,
  };
}
