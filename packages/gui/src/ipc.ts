/**
 * IPC contract shared by the main process, the preload bridge, and the
 * renderer. Plain types + channel constants only — no Electron imports — so it
 * is safe to import from any of the three contexts.
 */
import type { PanelState } from "./panel-state.js";

/** IPC channel names. `*FromMain` are pushes; the rest are renderer→main calls. */
export const Channels = {
  /** Main → renderer: a fresh {@link PanelState} to render. */
  stateFromMain: "perch:state",
  /** Renderer → main: re-invoke `stack.view`. */
  refresh: "perch:refresh",
  /** Renderer → main: invoke `stack.sync`. */
  sync: "perch:sync",
} as const;

/**
 * The API the preload bridge exposes on `window.perch` via `contextBridge`.
 * The renderer programs against this and never touches Node/Electron directly.
 */
export interface PerchBridge {
  /** Subscribe to panel-state pushes. Returns an unsubscribe function. */
  onState(handler: (state: PanelState) => void): () => void;
  /** Ask the main process to re-fetch the stack. */
  refresh(): void;
  /** Ask the main process to run the Sync action. */
  sync(): void;
}

declare global {
  interface Window {
    perch: PerchBridge;
  }
}
