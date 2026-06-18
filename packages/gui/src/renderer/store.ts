/**
 * The renderer's panel-state store — the React-side spine every pane reads from.
 *
 * The main process derives the full {@link PanelState} (see
 * `panel-state.ts:buildPanelState`) and pushes it over the preload bridge; this
 * module wraps that push into a `useSyncExternalStore`-shaped store so a push
 * re-renders the component tree. It replaces the old imperative replay path
 * (`rerender.ts`'s setRenderer/setLastState/requestRender) — in React a panel
 * that changes its own interaction state just re-renders; the external store is
 * only the main→renderer channel.
 *
 * Sandbox-safe: this module touches nothing but the typed `window.perch` bridge
 * (no Node/Electron), so it runs in the renderer's isolated context.
 */
import { useSyncExternalStore } from "react";
import type { PanelState } from "../panel-state.js";
import type { PerchBridge } from "../ipc.js";

/** The store surface `useSyncExternalStore` consumes. */
export interface PanelStore {
  /**
   * Register a re-render callback. Wires `window.perch.onState` on the first
   * subscriber and tears it down when the last one leaves; returns the
   * per-subscriber unsubscribe.
   */
  subscribe(onStoreChange: () => void): () => void;
  /**
   * The latest pushed {@link PanelState}, or `undefined` before the first push.
   * The reference is stable between pushes (it returns the cached last state,
   * not a fresh wrapper) so `useSyncExternalStore` doesn't loop.
   */
  getSnapshot(): PanelState | undefined;
}

/**
 * Build a panel-state store over a bridge's `onState` push. Pure + bridge-
 * injected so it can be unit-tested against a fake `window.perch`; the app uses
 * the {@link panelStore} singleton bound to the real preload bridge.
 *
 * Pre-first-state is modeled explicitly: `getSnapshot` returns `undefined` until
 * the first push lands, and the panel renders the same loading UI as a pushed
 * `status === "loading"` state.
 */
export function createPanelStore(bridge: Pick<PerchBridge, "onState">): PanelStore {
  // The last pushed state, cached so getSnapshot is referentially stable between
  // pushes; undefined until the first push (the pre-first-state case).
  let snapshot: PanelState | undefined;
  // The React re-render callbacks (one per mounted useSyncExternalStore call).
  const listeners = new Set<() => void>();
  // The bridge unsubscribe, held while we have ≥1 subscriber so we can detach.
  let detachBridge: (() => void) | undefined;

  /** A push from main: cache it and re-render every subscriber. */
  function handleState(state: PanelState): void {
    snapshot = state;
    for (const listener of listeners) listener();
  }

  return {
    subscribe(onStoreChange) {
      listeners.add(onStoreChange);
      // Attach to the bridge once (on the first subscriber); every component
      // shares the single IPC listener and the one cached snapshot.
      if (listeners.size === 1) detachBridge = bridge.onState(handleState);
      return () => {
        listeners.delete(onStoreChange);
        // Detach the bridge once the last subscriber leaves, so a fully
        // unmounted tree leaves no dangling IPC listener.
        if (listeners.size === 0 && detachBridge) {
          detachBridge();
          detachBridge = undefined;
        }
      };
    },
    getSnapshot() {
      return snapshot;
    },
  };
}

/**
 * The app's singleton store, bound to the real preload bridge. Created lazily on
 * first use so merely importing this module never touches `window` (keeps the
 * factory unit-testable without a DOM).
 */
let defaultStore: PanelStore | undefined;
function panelStore(): PanelStore {
  return (defaultStore ??= createPanelStore(window.perch));
}

/**
 * Subscribe a component to the panel state: returns the latest pushed
 * {@link PanelState} and re-renders on each push. `undefined` until the first
 * push (render the loading UI, same as `status === "loading"`).
 */
export function usePanelState(): PanelState | undefined {
  const store = panelStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
