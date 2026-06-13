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
import type { Proc } from "./procs.js";
import {
  SettingsChannels,
  type PerchSettingsBridge,
  type PluginSettingsResult,
  type ServicesResult,
  type SetFieldRequest,
  type SettingsResult,
} from "./settings-ipc.js";

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
  describePlugins(): Promise<PluginSettingsResult> {
    return ipcRenderer.invoke(SettingsChannels.describePlugins);
  },
  setField(request: SetFieldRequest): Promise<PluginSettingsResult> {
    return ipcRenderer.invoke(SettingsChannels.setField, request);
  },
  listProcs(): Promise<ServicesResult> {
    return ipcRenderer.invoke(SettingsChannels.listProcs);
  },
  addProc(proc: Proc): Promise<ServicesResult> {
    return ipcRenderer.invoke(SettingsChannels.addProc, proc);
  },
  removeProc(name): Promise<ServicesResult> {
    return ipcRenderer.invoke(SettingsChannels.removeProc, name);
  },
};

contextBridge.exposeInMainWorld("perchSettings", bridge);
