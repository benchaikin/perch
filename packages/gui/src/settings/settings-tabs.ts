/**
 * Electron-free tab-model builder for the Settings window.
 *
 * The Settings window is a left-nav tabbed surface: a vertical list of tabs on
 * the left, one tab per logical config area, with the selected tab's content in
 * a pane on the right. The data feeding it arrives from two separate bridge
 * calls — the repo list ({@link SettingsResult}) and the per-plugin descriptors
 * ({@link PluginSettingsResult}) — so this module folds both into a single,
 * ordered list of {@link SettingsTab}s the renderer draws verbatim.
 *
 * Tabs are keyed by `pluginId` and ordered deterministically:
 *
 *   - **Pull Requests** (`stack`) — owns the Repositories add/remove/set-default
 *     list PLUS the stack plugin's descriptor fields (e.g. stack direction). It
 *     always appears (the Repositories list alone justifies it), even when the
 *     stack plugin declares no descriptor.
 *   - **Services** (`services`) — owns the services plugin's descriptor fields
 *     (e.g. the logs-terminal command + the process-compose connection config).
 *     It always appears so the tab is discoverable even before the daemon is up.
 *   - Any **other** plugin that declares a descriptor gets its own tab after
 *     these two, in descriptor (registration) order, so the surface still grows
 *     automatically as plugins ship settings.
 *
 * The transforms here are pure (no DOM, no Electron) so they unit-test without a
 * display.
 */
import type { PluginSettingsDescription } from "@perch/core";

/**
 * Reserved descriptor id for the cross-plugin "General" tab. A renderer-safe
 * local copy of `@perch/core`'s GLOBAL_SETTINGS_ID — importing the value from
 * core would pull the daemon's node built-ins into the browser bundle. Keep in
 * sync with core (a frozen protocol constant).
 */
export const GENERAL_TAB_ID = "__global__";

/** The plugin id whose tab owns the Repositories list (the "Pull Requests" tab). */
export const PRS_TAB_ID = "stack";
/** The plugin id whose tab owns the services config (the "Services" tab). */
export const SERVICES_TAB_ID = "services";

/** The well-known tabs, in display order, with their friendly labels. The
 * cross-plugin "General" tab leads; the per-plugin pinned tabs follow. */
const PINNED_TABS: ReadonlyArray<{ id: string; label: string }> = [
  { id: GENERAL_TAB_ID, label: "General" },
  { id: PRS_TAB_ID, label: "Pull Requests" },
  { id: SERVICES_TAB_ID, label: "Services" },
];

/** One tab in the left nav + its right-pane content model. */
export interface SettingsTab {
  /** The owning plugin id (also the tab's stable key for selection). */
  id: string;
  /** The label shown in the left nav. */
  label: string;
  /** Whether this tab renders the Repositories list above any descriptor fields. */
  showRepos: boolean;
  /** Whether this tab renders the managed-process list above any descriptor fields. */
  showServices: boolean;
  /** The plugin's descriptor (its fields), or `undefined` if it declares none. */
  plugin?: PluginSettingsDescription;
}

/**
 * Build the ordered tab list from the per-plugin descriptors. The two pinned
 * tabs (Pull Requests, Services) always come first in a fixed order — using the
 * descriptor's friendly `name` when present, else a built-in label — followed by
 * every other plugin that declares a descriptor, in descriptor order.
 *
 * `showRepos` is set only on the Pull Requests tab and `showServices` only on
 * the Services tab, so the renderer knows to draw those managed lists there
 * above the owning plugin's descriptor fields.
 */
export function buildSettingsTabs(plugins: PluginSettingsDescription[]): SettingsTab[] {
  const byId = new Map(plugins.map((p) => [p.pluginId, p]));
  const pinnedIds = new Set(PINNED_TABS.map((t) => t.id));

  const tabs: SettingsTab[] = PINNED_TABS.map(({ id, label }) => ({
    id,
    label: byId.get(id)?.name ?? label,
    showRepos: id === PRS_TAB_ID,
    showServices: id === SERVICES_TAB_ID,
    plugin: byId.get(id),
  }));

  for (const plugin of plugins) {
    if (pinnedIds.has(plugin.pluginId)) continue;
    tabs.push({
      id: plugin.pluginId,
      label: plugin.name,
      showRepos: false,
      showServices: false,
      plugin,
    });
  }

  return tabs;
}

/**
 * Resolve which tab should be active given the prior selection. Keeps the
 * current selection if it still exists (descriptors can come and go as the
 * daemon (re)loads plugins), else falls back to the first tab. Returns
 * `undefined` only when there are no tabs at all.
 */
export function resolveActiveTab(
  tabs: SettingsTab[],
  current: string | undefined,
): string | undefined {
  if (tabs.length === 0) return undefined;
  if (current !== undefined && tabs.some((t) => t.id === current)) return current;
  return tabs[0]!.id;
}
