/**
 * IPC contract shared by the main process, the preload bridge, and the
 * renderer. Plain types + channel constants only — no Electron imports — so it
 * is safe to import from any of the three contexts.
 */
import type { PanelState } from "./panel-state.js";
import type { ServiceAction, ServicesBulkAction } from "./services-state.js";
import type { DexViewMode, DialogSize } from "./window-state.js";

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

/** Renderer → main payload to merge a single mergeable PR. */
export interface MergePrRequest {
  /** The PR number to merge (`gh pr merge` keys off this). */
  number: number;
  /** The repo the PR belongs to (name), selecting which configured repo to target. */
  repo: string;
  /** The PR's head branch — drives the in-flight spinner key + the confirm prompt. */
  headRefName: string;
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
  /**
   * Renderer → main `invoke`: merge a single mergeable PR (payload: a
   * {@link MergePrRequest}). Main confirms (a merge is hard to reverse), runs
   * `stack.merge-pr`, refreshes the overview so the merged PR drops out, and
   * resolves when done so the button can clear its in-progress state.
   */
  mergePr: "perch:merge-pr",
  /** Renderer → main: open a PR's URL in the browser (payload: the URL). */
  openPr: "perch:open-pr",
  /**
   * Renderer → main: invoke a service lifecycle action (payload: a
   * {@link ServiceActionRequest}). Main runs `services.<action>`.
   */
  serviceAction: "perch:service-action",
  /**
   * Renderer → main: invoke a whole-stack action (payload: a
   * {@link ServicesBulkAction} plus an optional `project` scoping it to one repo's
   * services on a multi-repo board; omitted targets the whole stack). Main runs
   * `services.<startAll|stopAll|restartAll>`.
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
  /** Renderer → main: persist the New-task dialog size (payload: a {@link DialogSize}). */
  setNewTaskDialogSize: "perch:set-new-task-dialog-size",
  /** Renderer → main: open a worktree dir (payload: the path). Main runs `worktrees.open`. */
  worktreeOpen: "perch:worktree-open",
  /**
   * Renderer → main `invoke`: remove a worktree (payload: a
   * {@link WorktreeRemoveRequest}). Main confirms with a native dialog (removal
   * is irreversible and a forced one discards uncommitted work) before running
   * `worktrees.remove`, then re-reads the list so the row disappears. Resolves
   * when the removal finishes (or is declined / fails) so the row's trash control
   * can clear its in-progress state; the outcome is toasted from main.
   */
  worktreeRemove: "perch:worktree-remove",
  /**
   * Renderer → main `invoke`: spawn an agent for a ready dex task (payload: the
   * task id). Main runs `dex.spawn` and resolves when the worktree/terminal work
   * finishes, so the button can clear its in-progress state.
   */
  dexSpawn: "perch:dex-spawn",
  /**
   * Renderer → main `invoke`: spawn agents for every ready dex task at once
   * (payload: an optional `project` to scope the launch to one repo's store on a
   * multi-repo board; omitted launches every store's ready tasks). Main runs
   * `dex.spawn-all` and resolves when the fleet launch finishes, so the button
   * can clear its in-progress state.
   */
  dexSpawnReady: "perch:dex-spawn-ready",
  /**
   * Renderer → main `invoke`: delete a dex task (payload: the task id). Main runs
   * `dex.delete`, refreshes the board, and resolves when the delete finishes, so
   * the renderer can clear its in-progress state; the outcome is toasted from main.
   */
  dexDelete: "perch:dex-delete",
  /**
   * Renderer → main `invoke`: edit a dex task's metadata (payload: a
   * {@link DexEditRequest} — the id plus the changed name/description/priority).
   * Main runs `dex.edit`, refreshes the board, and resolves when the edit
   * finishes, so the renderer can leave edit mode; the outcome is toasted from main.
   */
  dexEdit: "perch:dex-edit",
  /**
   * Renderer → main `invoke`: mark a dex task complete (payload: a
   * {@link DexCompleteRequest} — the id plus an optional completion result). Main
   * runs `dex.complete`, refreshes the board, and resolves when the work finishes,
   * so the renderer can leave its confirm UI; the outcome is toasted from main.
   */
  dexComplete: "perch:dex-complete",
  /**
   * Renderer → main `invoke`: wire a dependency edge between two dex tasks (payload:
   * a {@link DexBlockerRequest}). Main runs `dex.add-blocker`, refreshes the board,
   * and resolves when the edit finishes, so the renderer can clear its drop state;
   * the success/error outcome is toasted from main.
   */
  dexAddBlocker: "perch:dex-add-blocker",
  /**
   * Renderer → main `invoke`: remove a dependency (blocker) edge between two dex
   * tasks (payload: a {@link DexBlockerRequest}). Main runs `dex.remove-blocker`,
   * refreshes the board, and resolves when the edit finishes, so the renderer can
   * clear its drop state; the success/error outcome is toasted from main. The
   * inverse of {@link Channels.dexAddBlocker}.
   */
  dexRemoveBlocker: "perch:dex-remove-blocker",
  /**
   * Renderer → main `invoke`: author a new dex task from a free-form description
   * (payload: a {@link DexNewRequest}). Main runs `dex.new` (which spawns an agent
   * in the target repo to write the task) and resolves when the launch finishes,
   * so the composer can clear its in-flight state; the outcome is toasted from main.
   */
  dexNew: "perch:dex-new",
} as const;

/**
 * Renderer → main payload to edit a dex task's metadata. `id` identifies the
 * task; each editable field is optional — only the fields the user actually
 * changed are present, so an unchanged field is never sent to `dex edit`. An
 * empty `description` is a deliberate clear; a blank `name` is rejected daemon-side.
 */
export interface DexEditRequest {
  id: string;
  name?: string;
  description?: string;
  priority?: number;
}

/**
 * Renderer → main payload to mark a dex task complete. `id` identifies the task;
 * `result` is the optional completion note the user typed (blank/omitted is
 * defaulted daemon-side, since `dex complete` requires a non-empty `--result`).
 */
export interface DexCompleteRequest {
  id: string;
  result?: string;
}

/**
 * Renderer → main payload to delete a dex task. Carries the task `name` so the
 * native confirm dialog can name what's being deleted, plus the renderer-computed
 * `warning` (the single source of truth, {@link DexRow}-derived) so the dialog's
 * detail flags a live worktree/agent or cascading subtasks. `warning` is absent
 * for a plain leaf task with no live work.
 */
export interface DexDeleteRequest {
  id: string;
  name: string;
  warning?: string;
}

/**
 * Renderer → main payload to remove a git worktree. Carries the worktree `name`
 * so the native confirm dialog can name what's being removed; `force` (computed
 * from the row — set for a dirty/conflicted/locked/prunable tree git won't drop
 * cleanly) is passed through to `worktrees.remove`; and the renderer-computed
 * `warning` (the discarded changes / orphaned linked task) reads as the dialog's
 * detail. `warning` is absent for a clean tree with no live work.
 */
export interface WorktreeRemoveRequest {
  path: string;
  name: string;
  force?: boolean;
  warning?: string;
}

/** Renderer → main payload to add/remove a dex dependency (blocker) edge. */
export interface DexBlockerRequest {
  /** The task that becomes (or stops being) blocked — `dex edit`'s target. */
  blockedId: string;
  /** The task it depends on (the blocker). Drop A onto B ⇒ blockedId B, blockerId A. */
  blockerId: string;
}

/** Renderer → main payload to author a new dex task from a description. */
export interface DexNewRequest {
  /** Free-form description of the task; an agent expands it into a well-formed task. */
  description: string;
  /**
   * The target project (a repo basename) when more than one dex repo has tasks, so
   * the author agent's `dex create` lands in the right store. Omitted when there's a
   * single (or no) project — the daemon resolves the sole repo (or its cwd store).
   */
  project?: string;
  /**
   * Author AND immediately start working the new task. The author agent spawns a
   * worker agent on the task right after `dex create` (the GUI can't chain to a
   * `dex.spawn` itself — `dex.new` returns no task id). Omitted/false authors only.
   */
  start?: boolean;
  /**
   * Author the task as a CHILD of this existing task (`dex create --parent <id>`),
   * so it nests under that parent. Set when the composer is armed from a task row's
   * "new sub-task" control; the parent's `project` pins the target store. Omitted
   * authors a top-level task, resolved by `project` as before.
   */
  parentId?: string;
}

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
  /**
   * Ask the main process to merge a single mergeable PR (it confirms first).
   * Resolves when the merge finishes (or fails) and the overview has refreshed,
   * so the caller can clear its in-progress UI; the outcome is pushed via panel
   * state.
   */
  mergePr(request: MergePrRequest): Promise<void>;
  /** Ask the main process to open a PR's URL in the browser. */
  openPr(url: string): void;
  /** Ask the main process to start/stop/restart a service (by name). */
  serviceAction(request: ServiceActionRequest): void;
  /**
   * Ask the main process to run a whole-stack action (start/stop/restart all),
   * optionally scoped to one `project` (a repo basename) so a multi-repo board's
   * per-repo control acts on only that repo's services; omitted targets the whole stack.
   */
  servicesBulk(action: ServicesBulkAction, project?: string): void;
  /** Ask the main process to open a terminal tailing a service's logs (by name). */
  serviceLogs(name: string): void;
  /** Ask the main process to copy text to the system clipboard. */
  copyText(text: string): void;
  /** Tell the main process which tab is now selected, so it persists across opens. */
  setActiveTab(id: string): void;
  /** Tell the main process the Dex view mode, so it persists across opens. */
  setDexViewMode(mode: DexViewMode): void;
  /** Tell the main process the New-task dialog size, so it persists across opens. */
  setNewTaskDialogSize(size: DialogSize): void;
  /** Ask the main process to open a worktree directory (by path). */
  worktreeOpen(path: string): void;
  /**
   * Ask the main process to remove a worktree (payload: a
   * {@link WorktreeRemoveRequest}). Main confirms with a native dialog (removal
   * is irreversible; a forced one discards uncommitted work) before removing.
   * Resolves when the removal finishes (or is declined / fails) and the list has
   * re-read, so the caller can clear its in-progress UI; the success/error notice
   * is pushed via panel state.
   */
  worktreeRemove(request: WorktreeRemoveRequest): Promise<void>;
  /**
   * Ask the main process to spawn an agent for a ready dex task (by id).
   * Resolves when the spawn finishes (or fails), so the caller can clear its
   * in-progress UI; the success/error notice is pushed via panel state.
   */
  dexSpawn(id: string): Promise<void>;
  /**
   * Ask the main process to spawn agents for every ready dex task at once,
   * optionally scoped to one `project` (a repo basename) so a multi-repo board's
   * per-repo launch only spawns that repo's ready tasks; omitted launches every
   * store's ready tasks. Resolves when the fleet launch finishes (or fails), so
   * the caller can clear its in-progress UI; the "Spawned N of M" notice is
   * pushed via panel state.
   */
  dexSpawnReady(project?: string): Promise<void>;
  /**
   * Ask the main process to delete a dex task (payload: a {@link DexDeleteRequest}
   * — the id plus the task name and any computed warning). Main confirms with a
   * native dialog (delete is irreversible and can cascade) before deleting.
   * Resolves when the delete finishes (or is declined / fails) and the board has
   * refreshed, so the caller can clear its in-progress UI; the success/error
   * notice is pushed via panel state.
   */
  dexDelete(request: DexDeleteRequest): Promise<void>;
  /**
   * Ask the main process to edit a dex task's metadata (name/description/priority).
   * Only the changed fields are sent. Resolves when the edit finishes (or fails)
   * and the board has refreshed, so the caller can leave edit mode; the
   * success/error notice is pushed via panel state.
   */
  dexEdit(request: DexEditRequest): Promise<void>;
  /**
   * Ask the main process to mark a dex task complete (payload: a
   * {@link DexCompleteRequest} — the id plus an optional completion result).
   * Resolves when the completion finishes (or fails) and the board has refreshed,
   * so the caller can leave its confirm UI; the success/error notice is pushed via
   * panel state. A completion blocked by incomplete subtasks surfaces dex's error.
   */
  dexComplete(request: DexCompleteRequest): Promise<void>;
  /**
   * Ask the main process to add a dependency (blocker) edge between two dex tasks
   * — `blockedId` becomes blocked by `blockerId`. Resolves when the edit finishes
   * (or fails) and the board has refreshed, so the caller can clear its drop UI;
   * the success/error notice is pushed via panel state.
   */
  dexAddBlocker(request: DexBlockerRequest): Promise<void>;
  /**
   * Ask the main process to remove a dependency (blocker) edge between two dex
   * tasks — `blockedId` stops being blocked by `blockerId`. Resolves when the edit
   * finishes (or fails) and the board has refreshed, so the caller can clear its
   * drop UI; the success/error notice is pushed via panel state. The inverse of
   * {@link PerchBridge.dexAddBlocker}.
   */
  dexRemoveBlocker(request: DexBlockerRequest): Promise<void>;
  /**
   * Ask the main process to author a new dex task from a free-form description —
   * it spawns an agent in the target repo to read the code and run `dex create`.
   * Resolves when the launch finishes (or fails), so the caller can clear its
   * in-flight UI; the success/error notice is pushed via panel state. The task is
   * authored asynchronously and appears on the next board refresh.
   */
  dexNew(request: DexNewRequest): Promise<void>;
}

declare global {
  interface Window {
    perch: PerchBridge;
  }
}
