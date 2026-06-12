/**
 * IPC contract shared by the main process, the preload bridge, and the
 * renderer. Plain types + channel constants only — no Electron imports — so it
 * is safe to import from any of the three contexts.
 */
import type { PanelState } from "./panel-state.js";
import type { ServiceAction } from "./services-state.js";

/** Renderer → main payload for a service lifecycle action (M2). */
export interface ServiceActionRequest {
  /** The process name to act on. */
  name: string;
  /** Which lifecycle action to invoke. */
  action: ServiceAction;
}

/** IPC channel names. `*FromMain` are pushes; the rest are renderer→main calls. */
export const Channels = {
  /** Main → renderer: a fresh {@link PanelState} to render. */
  stateFromMain: "perch:state",
  /** Renderer → main: re-invoke `stack.prs`. */
  refresh: "perch:refresh",
  /** Renderer → main: invoke `stack.sync` for a repo (payload: the repo name). */
  sync: "perch:sync",
  /** Renderer → main: open a PR's URL in the browser (payload: the URL). */
  openPr: "perch:open-pr",
  /**
   * Renderer → main: invoke a service lifecycle action (payload: a
   * {@link ServiceActionRequest}). Main runs `services.<action>`.
   */
  serviceAction: "perch:service-action",
} as const;

/**
 * The API the preload bridge exposes on `window.perch` via `contextBridge`.
 * The renderer programs against this and never touches Node/Electron directly.
 */
export interface PerchBridge {
  /** Subscribe to panel-state pushes. Returns an unsubscribe function. */
  onState(handler: (state: PanelState) => void): () => void;
  /** Ask the main process to re-fetch the PRs overview. */
  refresh(): void;
  /** Ask the main process to run the Sync action for a repo (by name). */
  sync(repo: string): void;
  /** Ask the main process to open a PR's URL in the browser. */
  openPr(url: string): void;
  /** Ask the main process to start/stop/restart a service (by name). */
  serviceAction(request: ServiceActionRequest): void;
}

declare global {
  interface Window {
    perch: PerchBridge;
  }
}
