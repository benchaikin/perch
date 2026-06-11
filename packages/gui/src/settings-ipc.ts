/**
 * IPC contract for the Settings window. A SEPARATE channel set + bridge from
 * the main panel's `window.perch` — the Settings renderer programs against
 * `window.perchSettings`. Plain types + channel constants only (no Electron
 * imports) so it's safe to import from main, preload, and renderer.
 */
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
 * The API the settings preload exposes on `window.perchSettings`. Every call is
 * async and resolves to the refreshed {@link SettingsResult}, so the renderer
 * just re-renders from what it gets back.
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
}

declare global {
  interface Window {
    perchSettings: PerchSettingsBridge;
  }
}
