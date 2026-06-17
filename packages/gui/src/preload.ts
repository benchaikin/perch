/**
 * Preload bridge. Runs in an isolated context with access to a limited set of
 * Electron APIs; exposes a narrow, typed `window.perch` to the renderer via
 * `contextBridge`. With `contextIsolation` on and `nodeIntegration` off, this is
 * the only channel between the renderer and the main process.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { Channels, type PerchBridge } from "./ipc.js";
import type { PanelState } from "./panel-state.js";

const bridge: PerchBridge = {
  onState(handler) {
    const listener = (_event: IpcRendererEvent, state: PanelState): void => handler(state);
    ipcRenderer.on(Channels.stateFromMain, listener);
    return () => ipcRenderer.removeListener(Channels.stateFromMain, listener);
  },
  refresh() {
    ipcRenderer.send(Channels.refresh);
  },
  sync(repo) {
    ipcRenderer.send(Channels.sync, repo);
  },
  resolveConflicts(request) {
    return ipcRenderer.invoke(Channels.resolveConflicts, request);
  },
  openAgent(request) {
    return ipcRenderer.invoke(Channels.openAgent, request);
  },
  openPr(url) {
    ipcRenderer.send(Channels.openPr, url);
  },
  serviceAction(request) {
    ipcRenderer.send(Channels.serviceAction, request);
  },
  servicesBulk(action) {
    ipcRenderer.send(Channels.servicesBulk, action);
  },
  serviceLogs(name) {
    ipcRenderer.send(Channels.serviceLogs, name);
  },
  copyText(text) {
    ipcRenderer.send(Channels.copyText, text);
  },
  setActiveTab(id) {
    ipcRenderer.send(Channels.setActiveTab, id);
  },
  setDexViewMode(mode) {
    ipcRenderer.send(Channels.setDexViewMode, mode);
  },
  worktreeOpen(path) {
    ipcRenderer.send(Channels.worktreeOpen, path);
  },
  dexSpawn(id) {
    return ipcRenderer.invoke(Channels.dexSpawn, id);
  },
  dexSpawnReady() {
    return ipcRenderer.invoke(Channels.dexSpawnReady);
  },
  dexDelete(id) {
    return ipcRenderer.invoke(Channels.dexDelete, id);
  },
};

contextBridge.exposeInMainWorld("perch", bridge);
