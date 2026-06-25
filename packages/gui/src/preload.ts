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
  mergePr(request) {
    return ipcRenderer.invoke(Channels.mergePr, request);
  },
  openPr(url) {
    ipcRenderer.send(Channels.openPr, url);
  },
  serviceAction(request) {
    ipcRenderer.send(Channels.serviceAction, request);
  },
  servicesBulk(action, project) {
    ipcRenderer.send(Channels.servicesBulk, action, project);
  },
  serviceLogs(name) {
    ipcRenderer.send(Channels.serviceLogs, name);
  },
  servicesSetAuto(request) {
    return ipcRenderer.invoke(Channels.servicesSetAuto, request);
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
  setNewTaskDialogSize(size) {
    ipcRenderer.send(Channels.setNewTaskDialogSize, size);
  },
  worktreeOpen(path) {
    ipcRenderer.send(Channels.worktreeOpen, path);
  },
  resolveWorktree(request) {
    return ipcRenderer.invoke(Channels.worktreeResolve, request);
  },
  worktreeRemove(request) {
    return ipcRenderer.invoke(Channels.worktreeRemove, request);
  },
  dexSpawn(id) {
    return ipcRenderer.invoke(Channels.dexSpawn, id);
  },
  dexSpawnReady(project) {
    return ipcRenderer.invoke(Channels.dexSpawnReady, project);
  },
  dexSetAutoSpawn(request) {
    return ipcRenderer.invoke(Channels.dexSetAutoSpawn, request);
  },
  dexDelete(request) {
    return ipcRenderer.invoke(Channels.dexDelete, request);
  },
  dexEdit(request) {
    return ipcRenderer.invoke(Channels.dexEdit, request);
  },
  dexComplete(request) {
    return ipcRenderer.invoke(Channels.dexComplete, request);
  },
  dexAddBlocker(request) {
    return ipcRenderer.invoke(Channels.dexAddBlocker, request);
  },
  dexRemoveBlocker(request) {
    return ipcRenderer.invoke(Channels.dexRemoveBlocker, request);
  },
  dexNew(request) {
    return ipcRenderer.invoke(Channels.dexNew, request);
  },
  alertsList() {
    return ipcRenderer.invoke(Channels.alertsList);
  },
  alertsDismiss(id) {
    return ipcRenderer.invoke(Channels.alertsDismiss, id);
  },
};

contextBridge.exposeInMainWorld("perch", bridge);
