/**
 * IPC contract shared by the main process, the preload bridge, and the
 * renderer. Plain types + channel constants only — no Electron imports — so it
 * is safe to import from any of the three contexts.
 */
import type { PanelState } from "./panel-state.js";
import type { ServiceAction, ServicesBulkAction } from "./services-state.js";
import type { DexViewMode } from "./window-state.js";

/** Renderer → main payload for a service lifecycle action (M2). */
export interface ServiceActionRequest {
  /** The process name to act on. */
  name: string;
  /** Which lifecycle action to invoke. */
  action: ServiceAction;
}

/** Renderer → main payload to spawn a conflict-resolution agent for a PR. */
export interface ResolveConflictsRequest {
  /** The conflicting PR's head branch (the branch to check out + fix). */
  headRefName: string;
  /** The base branch the PR merges into (what to rebase onto). */
  baseRefName: string;
  /** The repo the PR belongs to (name), selecting which configured repo to target. */
  repo: string;
  /** The PR number, for the agent window's title/messaging. */
  number: number;
}

/** Renderer → main payload to open a free-form agent session for a PR. */
export interface OpenAgentRequest {
  /** The PR's head branch to check out + open the session on. */
  headRefName: string;
  /** The repo the PR belongs to (name), selecting which configured repo to target. */
  repo: string;
  /** The PR number, for the agent window's title/messaging. */
  number: number;
}

/** IPC channel names. `*FromMain` are pushes; the rest are renderer→main calls. */
export const Channels = {
  /** Main → renderer: a fresh {@link PanelState} to render. */
  stateFromMain: "perch:state",
  /** Renderer → main: re-invoke `stack.prs`. */
  refresh: "perch:refresh",
  /** Renderer → main: invoke `stack.sync` for a repo (payload: the repo name). */
  sync: "perch:sync",
  /**
   * Renderer → main `invoke`: spawn an agent to resolve a conflicting PR's merge
   * conflict (payload: a {@link ResolveConflictsRequest}). Main runs
   * `stack.resolve-conflicts` and resolves when the worktree/terminal work
   * finishes, so the button can clear its in-progress state.
   */
  resolveConflicts: "perch:resolve-conflicts",
  /**
   * Renderer → main `invoke`: open a free-form Claude agent session on a PR's
   * branch (payload: an {@link OpenAgentRequest}). Main runs `stack.open-agent`
   * and resolves when the worktree/terminal work finishes, so the button can
   * clear its in-progress state.
   */
  openAgent: "perch:open-agent",
  /** Renderer → main: open a PR's URL in the browser (payload: the URL). */
  openPr: "perch:open-pr",
  /**
   * Renderer → main: invoke a service lifecycle action (payload: a
   * {@link ServiceActionRequest}). Main runs `services.<action>`.
   */
  serviceAction: "perch:service-action",
  /**
   * Renderer → main: invoke a whole-stack action (payload: a
   * {@link ServicesBulkAction}). Main runs `services.<startAll|stopAll|restartAll>`.
   */
  servicesBulk: "perch:services-bulk",
  /**
   * Renderer → main: open a terminal tailing a service's logs (payload: the
   * process name). Main runs `services.logs` (fire-and-forget; M3).
   */
  serviceLogs: "perch:service-logs",
  /** Renderer → main: copy text to the clipboard (payload: the text). */
  copyText: "perch:copy-text",
  /** Renderer → main: persist the selected tab id (payload: the tab id). */
  setActiveTab: "perch:set-active-tab",
  /** Renderer → main: persist the Dex view mode (payload: a {@link DexViewMode}). */
  setDexViewMode: "perch:set-dex-view-mode",
  /** Renderer → main: open a worktree dir (payload: the path). Main runs `worktrees.open`. */
  worktreeOpen: "perch:worktree-open",
  /**
   * Renderer → main `invoke`: spawn an agent for a ready dex task (payload: the
   * task id). Main runs `dex.spawn` and resolves when the worktree/terminal work
   * finishes, so the button can clear its in-progress state.
   */
  dexSpawn: "perch:dex-spawn",
  /**
   * Renderer → main `invoke`: spawn agents for every ready dex task at once (no
   * payload). Main runs `dex.spawn-all` and resolves when the fleet launch
   * finishes, so the button can clear its in-progress state.
   */
  dexSpawnReady: "perch:dex-spawn-ready",
  /**
   * Renderer → main `invoke`: delete a dex task (payload: the task id). Main runs
   * `dex.delete`, refreshes the board, and resolves when the delete finishes, so
   * the renderer can clear its in-progress state; the outcome is toasted from main.
   */
  dexDelete: "perch:dex-delete",
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
  /**
   * Ask the main process to spawn an agent to resolve a conflicting PR's merge
   * conflict. Resolves when the spawn finishes (or fails), so the caller can
   * clear its in-progress UI; the success/error notice is pushed via panel state.
   */
  resolveConflicts(request: ResolveConflictsRequest): Promise<void>;
  /**
   * Ask the main process to open a free-form Claude agent session on a PR's
   * branch. Resolves when the spawn finishes (or fails), so the caller can clear
   * its in-progress UI; the success/error notice is pushed via panel state.
   */
  openAgent(request: OpenAgentRequest): Promise<void>;
  /** Ask the main process to open a PR's URL in the browser. */
  openPr(url: string): void;
  /** Ask the main process to start/stop/restart a service (by name). */
  serviceAction(request: ServiceActionRequest): void;
  /** Ask the main process to run a whole-stack action (start/stop/restart all). */
  servicesBulk(action: ServicesBulkAction): void;
  /** Ask the main process to open a terminal tailing a service's logs (by name). */
  serviceLogs(name: string): void;
  /** Ask the main process to copy text to the system clipboard. */
  copyText(text: string): void;
  /** Tell the main process which tab is now selected, so it persists across opens. */
  setActiveTab(id: string): void;
  /** Tell the main process the Dex view mode, so it persists across opens. */
  setDexViewMode(mode: DexViewMode): void;
  /** Ask the main process to open a worktree directory (by path). */
  worktreeOpen(path: string): void;
  /**
   * Ask the main process to spawn an agent for a ready dex task (by id).
   * Resolves when the spawn finishes (or fails), so the caller can clear its
   * in-progress UI; the success/error notice is pushed via panel state.
   */
  dexSpawn(id: string): Promise<void>;
  /**
   * Ask the main process to spawn agents for every ready dex task at once.
   * Resolves when the fleet launch finishes (or fails), so the caller can clear
   * its in-progress UI; the "Spawned N of M" notice is pushed via panel state.
   */
  dexSpawnReady(): Promise<void>;
  /**
   * Ask the main process to delete a dex task (by id). Resolves when the delete
   * finishes (or fails) and the board has refreshed, so the caller can clear its
   * in-progress UI; the success/error notice is pushed via panel state.
   */
  dexDelete(id: string): Promise<void>;
}

declare global {
  interface Window {
    perch: PerchBridge;
  }
}
