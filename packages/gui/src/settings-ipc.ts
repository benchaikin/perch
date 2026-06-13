/**
 * IPC contract for the Settings window. A SEPARATE channel set + bridge from
 * the main panel's `window.perch` — the Settings renderer programs against
 * `window.perchSettings`. Plain types + channel constants only (no Electron
 * imports) so it's safe to import from main, preload, and renderer.
 */
import type { PluginSettingsDescription } from "@perch/core";
import type { Proc } from "./procs.js";
import type { RepoEntry } from "./repos.js";

/** Settings IPC channel names. All are renderer→main `invoke` (request/response). */
export const SettingsChannels = {
  /** Load the current configured repo list. */
  list: "perch-settings:list",
  /** Open a folder picker, validate, append, and persist. */
  add: "perch-settings:add",
  /** Remove a repo (payload: its path) and persist. */
  remove: "perch-settings:remove",
  /** Make a repo the default (payload: its path) and persist. */
  setDefault: "perch-settings:set-default",
  /** Fetch the per-plugin settings descriptors (`settings.describe`). */
  describePlugins: "perch-settings:describe-plugins",
  /** Persist one plugin field's value via `config.update`, then re-describe. */
  setField: "perch-settings:set-field",
  /** Load the configured managed processes (`plugins.services.procs`). */
  listProcs: "perch-settings:list-procs",
  /** Append a process (payload: the `Proc`), validate + persist. */
  addProc: "perch-settings:add-proc",
  /** Remove a process by name (payload: its name) and persist. */
  removeProc: "perch-settings:remove-proc",
} as const;

/**
 * The result of any Settings operation: the (possibly unchanged) repo list,
 * plus an optional `error` to surface inline (e.g. a failed path validation or
 * a daemon that's unavailable). A cancelled folder picker returns the list
 * unchanged with no error.
 */
export interface SettingsResult {
  /** The current configured repos, as display rows. */
  repos: RepoEntry[];
  /** Whether the daemon is reachable; when false the list is empty + read-only. */
  daemonUp: boolean;
  /** Inline error/explanation (validation reason, RPC failure), if any. */
  error?: string;
}

/**
 * Payload for persisting one plugin field change: which plugin, which field
 * (`key` may be a dotted path), and the already-coerced value to write.
 */
export interface SetFieldRequest {
  /** The plugin whose config section is written (`plugins[pluginId]`). */
  pluginId: string;
  /** The field's config key within `plugins[pluginId]` (may be dotted, e.g. `a.b`). */
  key: string;
  /** The new value to persist (already coerced to the field's type). */
  value: unknown;
}

/**
 * The result of a per-plugin settings operation: the refreshed descriptors plus
 * the same `daemonUp` / `error` surface as {@link SettingsResult}. After a write
 * the descriptors are re-fetched so the UI reflects the persisted state.
 */
export interface PluginSettingsResult {
  /** One section per plugin that declares a settings descriptor (registration order). */
  plugins: PluginSettingsDescription[];
  /** Whether the daemon is reachable; when false `plugins` is empty + read-only. */
  daemonUp: boolean;
  /** Inline error/explanation (RPC failure), if any. */
  error?: string;
}

/**
 * The result of any managed-process operation on the Services tab: the
 * (possibly unchanged) proc list plus the same `daemonUp` / `error` surface as
 * {@link SettingsResult}. After a write the procs are re-read so the UI reflects
 * the persisted state; a validation failure (blank field, duplicate name)
 * returns the unchanged list with the reason as an inline `error`.
 */
export interface ServicesResult {
  /** The current configured managed processes. */
  procs: Proc[];
  /** Whether the daemon is reachable; when false `procs` is empty + read-only. */
  daemonUp: boolean;
  /** Inline error/explanation (validation reason, RPC failure), if any. */
  error?: string;
}

/**
 * The API the settings preload exposes on `window.perchSettings`. Every call is
 * async and resolves to a refreshed result, so the renderer just re-renders from
 * what it gets back.
 */
export interface PerchSettingsBridge {
  /** Load the current repo list (called on open). */
  listRepos(): Promise<SettingsResult>;
  /** Open a native folder picker, validate + add the chosen dir. */
  addRepo(): Promise<SettingsResult>;
  /** Remove the repo at `path`. */
  removeRepo(path: string): Promise<SettingsResult>;
  /** Make the repo at `path` the default (move it to the front). */
  setDefault(path: string): Promise<SettingsResult>;
  /** Fetch the per-plugin settings descriptors (called on open). */
  describePlugins(): Promise<PluginSettingsResult>;
  /** Persist one plugin field's value, then return the refreshed descriptors. */
  setField(request: SetFieldRequest): Promise<PluginSettingsResult>;
  /** Load the configured managed processes (called on open). */
  listProcs(): Promise<ServicesResult>;
  /** Append `proc` (validate + persist), then return the refreshed proc list. */
  addProc(proc: Proc): Promise<ServicesResult>;
  /** Remove the process named `name`, then return the refreshed proc list. */
  removeProc(name: string): Promise<ServicesResult>;
}

declare global {
  interface Window {
    perchSettings: PerchSettingsBridge;
  }
}
