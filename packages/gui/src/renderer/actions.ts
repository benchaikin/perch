/**
 * The renderer's typed actions surface — a thin pass-through over the
 * renderer→main half of the preload bridge ({@link PerchBridge} minus its
 * `onState` push, which the store in `store.ts` owns).
 *
 * Components call these instead of reaching for `window.perch` directly, so the
 * bridge stays a single seam: one place imports `window.perch`, the rest program
 * against a typed surface. Every method keeps the bridge's exact signature — this
 * adds no behavior, only indirection.
 *
 * Sandbox-safe: touches nothing but `window.perch` (no Node/Electron), and reads
 * it lazily per call so importing this module never touches `window`.
 */
import type { PerchBridge } from "../ipc.js";

/** The renderer→main actions: the full bridge minus its `onState` push. */
export type PerchActions = Omit<PerchBridge, "onState">;

/**
 * Build the actions surface over a bridge. Bridge-injected so it can be
 * unit-tested against a fake `window.perch`; the app uses the {@link actions}
 * singleton, which reads the real `window.perch` lazily on each call.
 */
export function createActions(bridge: () => PerchActions): PerchActions {
  return {
    refresh() {
      bridge().refresh();
    },
    sync(repo) {
      bridge().sync(repo);
    },
    resolveConflicts(request) {
      return bridge().resolveConflicts(request);
    },
    openAgent(request) {
      return bridge().openAgent(request);
    },
    mergePr(request) {
      return bridge().mergePr(request);
    },
    openPr(url) {
      bridge().openPr(url);
    },
    serviceAction(request) {
      bridge().serviceAction(request);
    },
    servicesBulk(action, project) {
      bridge().servicesBulk(action, project);
    },
    serviceLogs(name) {
      bridge().serviceLogs(name);
    },
    servicesSetAuto(request) {
      return bridge().servicesSetAuto(request);
    },
    copyText(text) {
      bridge().copyText(text);
    },
    setActiveTab(id) {
      bridge().setActiveTab(id);
    },
    setDexViewMode(mode) {
      bridge().setDexViewMode(mode);
    },
    setNewTaskDialogSize(size) {
      bridge().setNewTaskDialogSize(size);
    },
    worktreeOpen(path) {
      bridge().worktreeOpen(path);
    },
    resolveWorktree(request) {
      return bridge().resolveWorktree(request);
    },
    worktreeRemove(request) {
      return bridge().worktreeRemove(request);
    },
    dexSpawn(id) {
      return bridge().dexSpawn(id);
    },
    dexSpawnReady(project) {
      return bridge().dexSpawnReady(project);
    },
    dexSetAutoSpawn(request) {
      return bridge().dexSetAutoSpawn(request);
    },
    dexDelete(request) {
      return bridge().dexDelete(request);
    },
    dexEdit(request) {
      return bridge().dexEdit(request);
    },
    dexComplete(request) {
      return bridge().dexComplete(request);
    },
    dexAddBlocker(request) {
      return bridge().dexAddBlocker(request);
    },
    dexRemoveBlocker(request) {
      return bridge().dexRemoveBlocker(request);
    },
    dexNew(request) {
      return bridge().dexNew(request);
    },
    alertsList() {
      return bridge().alertsList();
    },
    alertsDismiss(id) {
      return bridge().alertsDismiss(id);
    },
  };
}

/**
 * The app's actions surface, bound to the real preload bridge (read lazily per
 * call, so the sandboxed renderer's `window.perch` is resolved at call time).
 */
export const actions: PerchActions = createActions(() => window.perch);

/** Access the typed actions surface from a component. */
export function useActions(): PerchActions {
  return actions;
}
