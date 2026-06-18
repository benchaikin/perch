/**
 * The Settings window shell: a vertical tab list on the left (one tab per logical
 * config area, built by {@link buildSettingsTabs}) and the selected tab's content
 * in a pane on the right. It subscribes to the {@link SettingsStore} via
 * `useSyncExternalStore`, rebuilding the tab model from the latest descriptors on
 * every change.
 *
 * The active tab follows the same seed-then-own pattern as the panel: it's
 * undefined until the user picks one, so {@link resolveActiveTab} falls back to
 * the first tab (the seed); a click adopts a selection (we own it); and if the
 * owned tab later disappears (the daemon dropped a plugin), an effect re-syncs to
 * the fallback so the stale id can't snap back when the tab returns.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { PluginFields } from "./fields.js";
import { RepositoriesSection } from "./repos.js";
import { ServicesSection } from "./services.js";
import type { ServicesResult, SettingsResult } from "../settings-ipc.js";
import type { SettingsStore } from "./settings-store.js";
import { buildSettingsTabs, resolveActiveTab, type SettingsTab } from "./settings-tabs.js";

/** The left-nav button for one tab, marking the active one. */
function TabButton({
  tab,
  active,
  onSelect,
}: {
  tab: SettingsTab;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={active ? "tab tab-active" : "tab"}
      aria-current={active ? "page" : "false"}
      onClick={onSelect}
    >
      {tab.label}
    </button>
  );
}

/** The right pane for one tab: its managed list(s) (if any) + descriptor fields. */
function Pane({
  tab,
  store,
  reposBusy,
  servicesBusy,
  reposResult,
  servicesResult,
  daemonUp,
  pluginsError,
}: {
  tab: SettingsTab;
  store: SettingsStore;
  reposBusy: boolean;
  servicesBusy: boolean;
  reposResult: SettingsResult;
  servicesResult: ServicesResult;
  daemonUp: boolean;
  pluginsError?: string;
}) {
  return (
    <>
      {tab.showRepos && (
        <RepositoriesSection repos={reposResult} busy={reposBusy} store={store} />
      )}
      {tab.showServices && (
        <ServicesSection services={servicesResult} busy={servicesBusy} store={store} />
      )}
      {tab.plugin ? (
        // The descriptor fields render under the plugin's own name. On the PRs tab
        // they read as a follow-on block after the Repositories list above.
        <PluginFields
          plugin={tab.plugin}
          heading={tab.plugin.name}
          onPersist={(pluginId, field, raw) => store.persistField(pluginId, field, raw)}
        />
      ) : (
        !tab.showRepos &&
        !tab.showServices && (
          // A pinned tab whose plugin isn't loaded (daemon down or plugin disabled).
          // The PRs/Services tabs own a managed list + form, so they're never blank.
          <div className="empty">
            {daemonUp
              ? "This plugin isn’t available."
              : "Perch daemon is not running. Start it to configure this plugin."}
          </div>
        )
      )}
      {pluginsError && <div className="error">{pluginsError}</div>}
    </>
  );
}

/** The Settings window shell. */
export function Settings({ store }: { store: SettingsStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [activeTabId, setActiveTabId] = useState<string | undefined>(undefined);

  const tabs = buildSettingsTabs(snapshot.plugins.plugins);
  const resolvedId = resolveActiveTab(tabs, activeTabId);

  // Adopt the resolved id so a dropped tab can't snap back when it returns
  // (mirrors the old renderer reassigning `activeTabId = resolveActiveTab(...)`).
  useEffect(() => {
    if (resolvedId !== activeTabId) setActiveTabId(resolvedId);
  }, [resolvedId, activeTabId]);

  const active = tabs.find((t) => t.id === resolvedId);

  return (
    <div className="settings">
      <nav className="tabs" aria-label="Settings sections">
        {tabs.map((tab) => (
          <TabButton
            key={tab.id}
            tab={tab}
            active={tab.id === resolvedId}
            onSelect={() => setActiveTabId(tab.id)}
          />
        ))}
      </nav>
      <main className="pane">
        {active ? (
          <Pane
            tab={active}
            store={store}
            reposBusy={snapshot.reposBusy}
            servicesBusy={snapshot.servicesBusy}
            reposResult={snapshot.repos}
            servicesResult={snapshot.services}
            daemonUp={snapshot.plugins.daemonUp}
            pluginsError={snapshot.plugins.error}
          />
        ) : (
          <div className="empty">No settings available.</div>
        )}
      </main>
    </div>
  );
}
