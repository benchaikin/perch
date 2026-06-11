/**
 * Preload bridge for the Settings window. Runs in an isolated context; exposes
 * a narrow, typed `window.perchSettings` to the settings renderer via
 * `contextBridge`. Separate from the main panel's `window.perch` bridge so the
 * two windows don't share surface area.
 *
 * Every method is a request/response `invoke` returning the refreshed repo list
 * (the main process owns the folder picker, validation, and config RPCs).
 */
import { contextBridge, ipcRenderer } from "electron";
import { SettingsChannels, type PerchSettingsBridge, type SettingsResult } from "./settings-ipc.js";

const bridge: PerchSettingsBridge = {
  listRepos(): Promise<SettingsResult> {
    return ipcRenderer.invoke(SettingsChannels.list);
  },
  addRepo(): Promise<SettingsResult> {
    return ipcRenderer.invoke(SettingsChannels.add);
  },
  removeRepo(path): Promise<SettingsResult> {
    return ipcRenderer.invoke(SettingsChannels.remove, path);
  },
  setDefault(path): Promise<SettingsResult> {
    return ipcRenderer.invoke(SettingsChannels.setDefault, path);
  },
};

contextBridge.exposeInMainWorld("perchSettings", bridge);
