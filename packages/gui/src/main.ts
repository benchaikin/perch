/**
 * Electron main process for @perch/gui.
 *
 * Owns a menu-bar (tray) entry that toggles a frameless, always-on-top,
 * non-activating pinned panel. Connects to `perchd` over JSON-RPC (reusing
 * {@link PerchClient} from `@perch/cli`), subscribes to `stack.prs`, and
 * forwards derived {@link PanelState} to the renderer via IPC. All data-shaping
 * lives in the Electron-free {@link buildPanelState}; this file is wiring only.
 *
 * NOTE: a visible launch is not verified in CI (no display). See README.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  shell,
  Tray,
  screen,
} from "electron";
import {
  configPath as defaultConfigPath,
  socketPath as defaultSocketPath,
  type NotificationPayload,
} from "@perch/core";
import { GENERAL_TAB_ID } from "./settings/settings-tabs.js";
import { DaemonUnavailableError, PerchClient } from "@perch/cli";
import { shouldShowNotification, toNotifyOptions } from "./notify.js";
import {
  Channels,
  type DexBlockerRequest,
  type DexDeleteRequest,
  type DexEditRequest,
  type DexNewRequest,
  type MergePrRequest,
  type OpenAgentRequest,
  type ResolveConflictsRequest,
  type ServiceActionRequest,
  type WorktreeRemoveRequest,
} from "./ipc.js";
import { addProc, procsFromConfig, removeProc, type Proc } from "./procs.js";
import { addRepo, removeRepo, reposFromConfig, setDefault, toEntries } from "./repos.js";
import { buildConfigPatch, buildGlobalConfigPatch } from "./settings-fields.js";
import {
  SettingsChannels,
  type PluginSettingsResult,
  type ServicesResult,
  type SetFieldRequest,
  type SettingsResult,
} from "./settings-ipc.js";
import {
  buildPanelState,
  landableDecisionCount,
  STACK_MERGE_PR_ID,
  STACK_OPEN_AGENT_ID,
  STACK_PRS_ID,
  STACK_RESOLVE_CONFLICTS_ID,
  STACK_SYNC_ID,
  type BuildInput,
  type Notice,
  type PanelState,
  type PrOverview,
} from "./panel-state.js";
import { SERVICES_LIST_ID, type ServiceList, type ServicesBulkAction } from "./services-state.js";
import { DEX_TASKS_ID, type DexBoard } from "./dex-state.js";
import { WORKTREES_LIST_ID, type WorktreeList } from "./worktrees-state.js";
import { AGENTS_LIST_ID, type AgentFleet } from "./agents-state.js";
import {
  centeredPosition,
  MIN_WINDOW_SIZE,
  readActiveTab,
  readDexViewMode,
  readWindowSize,
  writeActiveTab,
  writeDexViewMode,
  writeWindowSize,
  type DexViewMode,
} from "./window-state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Where the user's resized panel size is persisted (GUI-local UI state). */
function windowStatePath(): string {
  return join(app.getPath("userData"), "window-state.json");
}

/**
 * When the app started (ms since epoch). Used to drop any notification backlog a
 * reconnect might replay — see {@link shouldShowNotification}.
 */
const appStartTime = Date.now();

let tray: Tray | null = null;
let panel: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let client: PerchClient | null = null;
/** Pending debounced size-save timer, cleared on each resize. */
let saveSizeTimer: ReturnType<typeof setTimeout> | null = null;

/** Latest inputs to the view-model; updated piecemeal then rebuilt + pushed. */
const buildInput: BuildInput = { daemonUp: false, syncAvailable: false };
/** Subscription key echoed on `stack.prs` `capability.update` notifications. */
let subscriptionKey: string | undefined;
/** Subscription key echoed on `services.list` `capability.update` notifications. */
let servicesKey: string | undefined;
/** Subscription key echoed on `dex.tasks` `capability.update` notifications. */
let dexKey: string | undefined;
/** Subscription key echoed on `worktrees.list` `capability.update` notifications. */
let worktreesKey: string | undefined;
/** Subscription key echoed on `agents.list` `capability.update` notifications. */
let agentsKey: string | undefined;
/**
 * The last-selected tab id, loaded from GUI-local state when the panel is
 * created and updated when the renderer reports a tab change. Attached to every
 * pushed state so the renderer can seed its selection (sticky across panel opens
 * + restarts). Loaded lazily (not at module init) since it reads a userData path.
 */
let savedActiveTab: string | undefined;
/**
 * The persisted Dex view mode (tree/graph), loaded from GUI-local state when the
 * panel is created and updated when the renderer reports a toggle. Attached to
 * every pushed state so the renderer can seed its Dex view (sticky across panel
 * opens + restarts). Loaded lazily (not at module init) since it reads userData.
 */
let savedDexViewMode: DexViewMode | undefined;

/** Recompute the panel state from current inputs and push it to the renderer. */
function pushState(): void {
  const state: PanelState = { ...buildPanelState(buildInput), savedActiveTab, savedDexViewMode };
  panel?.webContents.send(Channels.stateFromMain, state);
  updateTrayBadge(state);
}

/**
 * Set the menu-bar badge to the count of landable work-items needing *your*
 * decision (`needs-review` + `ready`) — the merge-queue counterpart of the
 * panel's per-task landable chips. `Tray.setTitle` renders text beside the icon
 * in the menu bar (a macOS-only API; a no-op elsewhere); an empty string clears
 * it so the icon stands alone when there's nothing waiting.
 */
function updateTrayBadge(state: PanelState): void {
  const count = landableDecisionCount(state.landableByTaskId);
  tray?.setTitle(count > 0 ? String(count) : "");
}

/**
 * (Re)subscribe to `stack.prs` and seed the overview from the subscription's
 * current value. The subscription key is tracked so live `capability.update`
 * notes for this exact (id, input) are matched.
 */
async function subscribePrs(): Promise<void> {
  if (!client) return;
  const sub = await client.subscribe({ id: STACK_PRS_ID });
  subscriptionKey = sub.inputKey;
  if (sub.current !== undefined) buildInput.overview = sub.current as PrOverview;
  buildInput.error = undefined;
}

/**
 * (Re)subscribe to `services.list` and seed the section from the subscription's
 * current value. Mirrors {@link subscribePrs}. Best-effort and gated by the
 * registry — the services plugin may be disabled, in which case this isn't
 * called and the Services section stays hidden.
 */
async function subscribeServices(): Promise<void> {
  if (!client) return;
  const sub = await client.subscribe({ id: SERVICES_LIST_ID });
  servicesKey = sub.inputKey;
  if (sub.current !== undefined) buildInput.servicesList = sub.current as ServiceList;
}

/**
 * (Re)subscribe to `dex.tasks` and seed the section from the subscription's
 * current value. Mirrors {@link subscribeServices}. Best-effort and gated by the
 * registry — the dex plugin may be disabled, in which case this isn't called and
 * the Dex section stays hidden.
 */
async function subscribeDex(): Promise<void> {
  if (!client) return;
  const sub = await client.subscribe({ id: DEX_TASKS_ID });
  dexKey = sub.inputKey;
  if (sub.current !== undefined) buildInput.dexBoard = sub.current as DexBoard;
}

/**
 * (Re)subscribe to `worktrees.list` and seed the section from the subscription's
 * current value. Mirrors {@link subscribeDex}; gated by the registry — the
 * worktrees plugin may be disabled, in which case the section stays hidden.
 */
async function subscribeWorktrees(): Promise<void> {
  if (!client) return;
  const sub = await client.subscribe({ id: WORKTREES_LIST_ID });
  worktreesKey = sub.inputKey;
  if (sub.current !== undefined) buildInput.worktreesList = sub.current as WorktreeList;
}

/**
 * (Re)subscribe to `agents.list` and seed the fleet from the subscription's
 * current value. Mirrors {@link subscribeWorktrees}; gated by the registry — the
 * agents plugin may be disabled, in which case this isn't called and no agent
 * state joins the work-item.
 */
async function subscribeAgents(): Promise<void> {
  if (!client) return;
  const sub = await client.subscribe({ id: AGENTS_LIST_ID });
  agentsKey = sub.inputKey;
  if (sub.current !== undefined) buildInput.agentFleet = sub.current as AgentFleet;
}

/**
 * Whether we've already spawned (or attempted to spawn) the bundled daemon this
 * session. The GUI self-starts perchd at most once: a second `connect()` that
 * still fails (e.g. a genuinely broken daemon) renders "daemon down" rather than
 * spawning a pile of orphan processes.
 */
let daemonSpawned = false;

/** Absolute path to the bundled `perchd.cjs` (asar-unpacked when packaged). */
function perchdEntryPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "app.asar.unpacked", "dist", "perchd.cjs")
    : join(__dirname, "perchd.cjs");
}

/**
 * Self-start the bundled daemon. Runs the Electron binary (`process.execPath`,
 * which is `node` in dev and the app binary when packaged) as plain Node via
 * `ELECTRON_RUN_AS_NODE` against `dist/perchd.cjs`. Detached + unref'd so the
 * daemon outlives a GUI relaunch; idempotent via {@link daemonSpawned}.
 */
function spawnDaemon(): void {
  if (daemonSpawned) return;
  daemonSpawned = true;
  const entry = perchdEntryPath();
  try {
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (err) {
    console.error(`[daemon] spawn failed: ${errorMessage(err)}`);
  }
}

/** Whether the Unix socket at `path` currently accepts a connection. */
function socketAccepts(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = netConnect(path);
    const done = (ok: boolean): void => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** Poll until the socket accepts a connection or `timeoutMs` elapses. */
async function waitForSocket(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await socketAccepts(path)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Connect to perchd, subscribe to `stack.prs`, and detect Sync availability. */
async function connect(): Promise<void> {
  const socket = process.env.PERCH_SOCKET ?? defaultSocketPath();
  try {
    client = await PerchClient.connect(socket);
  } catch (err) {
    if (err instanceof DaemonUnavailableError) {
      // No daemon reachable: spawn the bundled one (once), wait briefly for it to
      // bind the socket, then retry the connect a single time. If it still isn't
      // up, fall through to the "daemon down" panel state.
      if (!daemonSpawned) {
        spawnDaemon();
        if (await waitForSocket(socket, 10_000)) {
          await connect();
          return;
        }
      }
      buildInput.daemonUp = false;
      pushState();
      return;
    }
    throw err;
  }

  buildInput.daemonUp = true;

  // Live updates: refresh the view-model whenever a matching update arrives.
  client.onUpdate((note) => {
    if (note.id === STACK_PRS_ID && note.inputKey === subscriptionKey) {
      buildInput.overview = note.data as PrOverview;
      buildInput.error = undefined;
      pushState();
    } else if (note.id === SERVICES_LIST_ID && note.inputKey === servicesKey) {
      buildInput.servicesList = note.data as ServiceList;
      pushState();
    } else if (note.id === DEX_TASKS_ID && note.inputKey === dexKey) {
      buildInput.dexBoard = note.data as DexBoard;
      pushState();
    } else if (note.id === WORKTREES_LIST_ID && note.inputKey === worktreesKey) {
      buildInput.worktreesList = note.data as WorktreeList;
      pushState();
    } else if (note.id === AGENTS_LIST_ID && note.inputKey === agentsKey) {
      buildInput.agentFleet = note.data as AgentFleet;
      pushState();
    }
  });

  // The daemon hot-reloads perch.json — re-sync when the registry changes.
  client.onRegistryChanged(() => void reloadFromRegistry());

  // Stream daemon notifications and surface each as a native macOS banner.
  client.onNotification(showNativeNotification);
  try {
    await client.subscribeNotifications();
  } catch (err) {
    console.error(`[notifications] subscribe failed: ${errorMessage(err)}`);
  }

  // Sync may be absent (stack plugin disabled); services.list may be absent
  // (services plugin disabled) — gate both on the registry rather than assuming
  // they exist.
  let servicesPresent = false;
  let dexPresent = false;
  let worktreesPresent = false;
  let agentsPresent = false;
  try {
    const caps = await client.registryList();
    buildInput.syncAvailable = caps.some((c) => c.id === STACK_SYNC_ID);
    buildInput.resolveConflictsAvailable = caps.some((c) => c.id === STACK_RESOLVE_CONFLICTS_ID);
    buildInput.openAgentAvailable = caps.some((c) => c.id === STACK_OPEN_AGENT_ID);
    buildInput.mergePrAvailable = caps.some((c) => c.id === STACK_MERGE_PR_ID);
    servicesPresent = caps.some((c) => c.id === SERVICES_LIST_ID);
    dexPresent = caps.some((c) => c.id === DEX_TASKS_ID);
    buildInput.dexPresent = dexPresent;
    worktreesPresent = caps.some((c) => c.id === WORKTREES_LIST_ID);
    agentsPresent = caps.some((c) => c.id === AGENTS_LIST_ID);
  } catch {
    buildInput.syncAvailable = false;
    buildInput.resolveConflictsAvailable = false;
    buildInput.openAgentAvailable = false;
    buildInput.mergePrAvailable = false;
  }

  try {
    await subscribePrs();
  } catch (err) {
    buildInput.error = `stack.prs: ${errorMessage(err)}`;
  }

  // Subscribe to services only when the plugin is installed. A failure here is
  // non-fatal — the Services section just stays hidden.
  if (servicesPresent) {
    try {
      await subscribeServices();
    } catch (err) {
      console.error(`[services] subscribe failed: ${errorMessage(err)}`);
    }
  }

  // Subscribe to the dex board only when the plugin is installed. Non-fatal —
  // the Dex section just stays hidden on failure.
  if (dexPresent) {
    try {
      await subscribeDex();
    } catch (err) {
      console.error(`[dex] subscribe failed: ${errorMessage(err)}`);
    }
  }

  // Subscribe to worktrees only when the plugin is installed. Non-fatal.
  if (worktreesPresent) {
    try {
      await subscribeWorktrees();
    } catch (err) {
      console.error(`[worktrees] subscribe failed: ${errorMessage(err)}`);
    }
  }

  // Subscribe to the agent fleet only when the plugin is installed. Non-fatal —
  // its absence just means no agent state joins the work-item.
  if (agentsPresent) {
    try {
      await subscribeAgents();
    } catch (err) {
      console.error(`[agents] subscribe failed: ${errorMessage(err)}`);
    }
  }
  pushState();
}

/** Re-invoke `stack.prs` on demand (Refresh button). */
async function refresh(): Promise<void> {
  if (!client) {
    await connect();
    return;
  }
  try {
    buildInput.overview = (await client.invoke({ id: STACK_PRS_ID })) as PrOverview;
    buildInput.error = undefined;
  } catch (err) {
    buildInput.error = `stack.prs: ${errorMessage(err)}`;
  }
  pushState();
}

/**
 * Re-sync after the daemon hot-reloads `perch.json`: refresh the registry (Sync
 * availability) and re-subscribe to `stack.prs`, which may have been added or
 * removed by the config change.
 */
async function reloadFromRegistry(): Promise<void> {
  if (!client) return;
  try {
    const caps = await client.registryList();
    buildInput.syncAvailable = caps.some((c) => c.id === STACK_SYNC_ID);
    buildInput.resolveConflictsAvailable = caps.some((c) => c.id === STACK_RESOLVE_CONFLICTS_ID);
    buildInput.openAgentAvailable = caps.some((c) => c.id === STACK_OPEN_AGENT_ID);
    buildInput.mergePrAvailable = caps.some((c) => c.id === STACK_MERGE_PR_ID);
    if (caps.some((c) => c.id === STACK_PRS_ID)) {
      await subscribePrs();
    } else {
      // The stack plugin was disabled in config — clear its data.
      buildInput.overview = { repos: [] };
    }
    // Same for the services plugin: re-subscribe if present, else clear so the
    // Services section hides.
    if (caps.some((c) => c.id === SERVICES_LIST_ID)) {
      await subscribeServices();
    } else {
      buildInput.servicesList = undefined;
      servicesKey = undefined;
    }
    // Same for dex: re-subscribe if present (a config edit like `showCompleted`
    // stops the poller + clears the cache, so re-subscribing re-runs the read
    // with the new config and applies it immediately), else clear so it hides.
    buildInput.dexPresent = caps.some((c) => c.id === DEX_TASKS_ID);
    if (buildInput.dexPresent) {
      await subscribeDex();
    } else {
      buildInput.dexBoard = undefined;
      dexKey = undefined;
    }
    // Same for worktrees.
    if (caps.some((c) => c.id === WORKTREES_LIST_ID)) {
      await subscribeWorktrees();
    } else {
      buildInput.worktreesList = undefined;
      worktreesKey = undefined;
    }
    // Same for the agent fleet: re-subscribe if present, else clear so no agent
    // state joins the work-item.
    if (caps.some((c) => c.id === AGENTS_LIST_ID)) {
      await subscribeAgents();
    } else {
      buildInput.agentFleet = undefined;
      agentsKey = undefined;
    }
  } catch (err) {
    buildInput.error = `registry: ${errorMessage(err)}`;
  }
  pushState();
}

/** Pending auto-dismiss timer for the transient notice toast. */
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

/** Add/remove a repo from the in-flight set so its Sync button shows progress. */
function setSyncing(repo: string, on: boolean): void {
  const set = new Set(buildInput.syncing ?? []);
  if (on) set.add(repo);
  else set.delete(repo);
  buildInput.syncing = [...set];
}

/** Add/remove a branch from the in-flight set so its Resolve-conflicts button spins. */
function setResolvingConflicts(branch: string, on: boolean): void {
  const set = new Set(buildInput.resolvingConflicts ?? []);
  if (on) set.add(branch);
  else set.delete(branch);
  buildInput.resolvingConflicts = [...set];
}

/** Add/remove a branch from the in-flight set so its Open-agent button spins. */
function setOpeningAgent(branch: string, on: boolean): void {
  const set = new Set(buildInput.openingAgents ?? []);
  if (on) set.add(branch);
  else set.delete(branch);
  buildInput.openingAgents = [...set];
}

/** Add/remove a branch from the in-flight set so its Merge button spins. */
function setMergingPr(branch: string, on: boolean): void {
  const set = new Set(buildInput.mergingPrs ?? []);
  if (on) set.add(branch);
  else set.delete(branch);
  buildInput.mergingPrs = [...set];
}

/** Add/remove a service from the in-flight set so its row buttons spin. */
function setServiceActing(name: string, on: boolean): void {
  const set = new Set(buildInput.servicesActing ?? []);
  if (on) set.add(name);
  else set.delete(name);
  buildInput.servicesActing = [...set];
}

/**
 * Invoke a service lifecycle action (`services.start`/`stop`/`restart`) for a
 * row's button. Mirrors {@link sync}: mark the service in-flight (its buttons
 * spin + disable), invoke, then let the `services.list` subscription reflect the
 * new status. No-op if the daemon is down or an action is already running for it.
 * A failed/rejected action surfaces a toast (the row reverts on the next poll).
 */
async function serviceAction(request: ServiceActionRequest): Promise<void> {
  const { name, action } = request;
  if (!client) return;
  if (buildInput.servicesActing?.includes(name)) return;

  setServiceActing(name, true);
  pushState();

  try {
    const result = (await client.invoke({
      id: `services.${action}`,
      input: { name },
    })) as { ok?: boolean; message?: string } | null;
    if (result && result.ok === false) {
      showNotice({ tone: "bad", text: result.message ?? `Failed to ${action} ${name}.` });
    }
  } catch (err) {
    showNotice({ tone: "bad", text: `${action} ${name} failed: ${errorMessage(err)}` });
  } finally {
    setServiceActing(name, false);
    pushState();
  }
}

/** Human label for a whole-stack action, used in failure toasts. */
const BULK_ACTION_LABEL: Record<ServicesBulkAction, string> = {
  startAll: "Start all",
  stopAll: "Stop all",
  restartAll: "Restart all",
};

/**
 * Invoke a whole-stack action (Start/Stop/Restart all) from the Services header.
 * Marks the bulk action in flight (its header button spins + the cluster
 * disables), invokes `services.<action>`, then lets the `services.list`
 * subscription reflect the new statuses. Surfaces the action's own message as a
 * toast — "Started 3/3 services." or a failure — so the whole-stack outcome is
 * visible. No-op if the daemon is down or a bulk action is already running.
 */
async function servicesBulk(action: ServicesBulkAction): Promise<void> {
  if (!client) return;
  if (buildInput.servicesBulkActing) return;

  buildInput.servicesBulkActing = action;
  pushState();

  try {
    const result = (await client.invoke({ id: `services.${action}`, input: {} })) as {
      ok?: boolean;
      message?: string;
    } | null;
    if (result?.message) {
      showNotice({ tone: result.ok === false ? "bad" : "ok", text: result.message });
    }
  } catch (err) {
    showNotice({
      tone: "bad",
      text: `${BULK_ACTION_LABEL[action]} failed: ${errorMessage(err)}`,
    });
  } finally {
    buildInput.servicesBulkActing = undefined;
    pushState();
  }
}

/**
 * Open a terminal live-tailing a service's logs (Logs button, M3). Fire-and-
 * forget: invoke `services.logs` (the daemon spawns the configured terminal) and
 * surface only a failure toast — there's no in-flight state to track since the
 * terminal owns the tail. No-op if the daemon is down.
 */
async function serviceLogs(name: string): Promise<void> {
  if (!client) return;
  try {
    const result = (await client.invoke({
      id: "services.logs",
      input: { name },
    })) as { ok?: boolean; message?: string } | null;
    if (result && result.ok === false) {
      showNotice({ tone: "bad", text: result.message ?? `Failed to open logs for ${name}.` });
    }
  } catch (err) {
    showNotice({ tone: "bad", text: `Open logs for ${name} failed: ${errorMessage(err)}` });
  }
}

/** Open a worktree directory via the worktrees plugin's `open` action. */
async function openWorktree(path: string): Promise<void> {
  if (!client) return;
  try {
    await client.invoke({ id: "worktrees.open", input: { path } });
  } catch (err) {
    showNotice({ tone: "bad", text: `Open worktree failed: ${errorMessage(err)}` });
  }
}

/**
 * Remove a worktree via the worktrees plugin's `remove` action, then re-read the
 * list and toast the outcome. Removal is irreversible — and a forced one (a
 * dirty/conflicted/locked tree) discards uncommitted work — so we confirm with a
 * native dialog first, mirroring {@link deleteDex}: default button Cancel
 * (index 1), the renderer-computed `warning` (discarded changes, an orphaned
 * linked task) reading as the dialog detail. Awaited by the renderer (via
 * `ipcMain.handle`) so the row's trash control clears its in-progress state when
 * the work finishes (or the removal is declined). On success the list is re-read
 * immediately so the row disappears without waiting for the next poll. Removes
 * only the worktree — the `dex/<id>` branch and the linked task are left intact.
 */
async function removeWorktree(request: WorktreeRemoveRequest): Promise<void> {
  if (!client) return;
  const { path, force } = request;

  const confirmOptions = {
    type: "warning" as const,
    buttons: ["Remove", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Remove worktree "${request.name}"?`,
    detail: request.warning
      ? `This removes the worktree directory.\n\n${request.warning}`
      : "This removes the worktree directory.",
  };
  const { response } =
    panel && !panel.isDestroyed()
      ? await dialog.showMessageBox(panel, confirmOptions)
      : await dialog.showMessageBox(confirmOptions);
  if (response !== 0) return;

  try {
    const result = (await client.invoke({
      id: "worktrees.remove",
      input: { path, force },
    })) as { ok?: boolean; message?: string } | null;
    if (result && result.ok === false) {
      showNotice({
        tone: "bad",
        text: result.message ?? `Couldn't remove worktree ${request.name}.`,
      });
    } else {
      showNotice({ tone: "ok", text: result?.message ?? `Removed worktree ${request.name}.` });
      await refreshWorktreesBoard();
    }
  } catch (err) {
    showNotice({ tone: "bad", text: `Remove worktree failed: ${errorMessage(err)}` });
  } finally {
    pushState();
  }
}

/** Re-invoke `worktrees.list` so the section reflects a just-removed worktree immediately. */
async function refreshWorktreesBoard(): Promise<void> {
  if (!client) return;
  try {
    buildInput.worktreesList = (await client.invoke({ id: WORKTREES_LIST_ID })) as WorktreeList;
  } catch {
    // Best-effort: the subscription's next poll (≤10s) reconciles the list anyway.
  }
}

/**
 * Spawn an agent for a ready dex task via the dex plugin's `spawn` action, then
 * toast the outcome — success as well as failure, mirroring {@link spawnDexReady}
 * (worktree creation + terminal launch is otherwise silent on success). Awaited
 * by the renderer (via `ipcMain.handle`) so the start button clears its spinner
 * when the work finishes.
 */
async function spawnDex(id: string): Promise<void> {
  if (!client) return;
  try {
    await client.invoke({ id: "dex.spawn", input: { id } });
    showNotice({ tone: "ok", text: `Started agent for ${id}.` });
  } catch (err) {
    showNotice({ tone: "bad", text: `Spawn agent failed: ${errorMessage(err)}` });
  } finally {
    pushState();
  }
}

/**
 * Spawn an agent for every ready dex task at once via the dex plugin's
 * `spawn-all` action, then toast the rolled-up `{ spawned, failed }` summary
 * (the fleet launch is otherwise invisible until each terminal appears). An
 * optional `project` scopes the launch to one repo's store (the multi-repo
 * board's per-repo launch); omitted launches every store's ready tasks.
 */
async function spawnDexReady(project?: string): Promise<void> {
  if (!client) return;
  try {
    const result = (await client.invoke({ id: "dex.spawn-all", input: { project } })) as {
      spawned?: number;
      failed?: number;
      message?: string;
    } | null;
    const failed = result?.failed ?? 0;
    showNotice({
      tone: failed > 0 ? "warn" : "ok",
      text: result?.message ?? "Spawned agents for ready tasks.",
    });
  } catch (err) {
    showNotice({ tone: "bad", text: `Spawn all ready failed: ${errorMessage(err)}` });
  } finally {
    pushState();
  }
}

/**
 * Delete a dex task via the dex plugin's `delete` action, then refresh the board
 * and toast the outcome. A delete is irreversible and can cascade (subtasks) or
 * orphan a live worktree/agent, so we confirm with a native dialog first —
 * mirroring {@link mergePr} — defaulting to Cancel for the destructive action;
 * the renderer-computed `warning` rides along in the request and surfaces as the
 * dialog detail. Awaited by the renderer (via `ipcMain.handle`) so the task's
 * trash control clears its in-progress state when the work finishes (or the
 * delete is declined). On success the board is re-fetched immediately so the
 * deleted task disappears without waiting for the next poll.
 */
async function deleteDex(request: DexDeleteRequest): Promise<void> {
  if (!client) return;
  const { id } = request;

  // Confirm before deleting — the click alone shouldn't fire an irreversible,
  // cascading action. Default button is Cancel (index 1) for safety; the warning
  // (live worktree/agent, cascading subtasks) reads in the dialog detail.
  const confirmOptions = {
    type: "warning" as const,
    buttons: ["Delete", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Delete task "${request.name}"?`,
    detail: request.warning
      ? `This permanently deletes the task and can't be undone.\n\n${request.warning}`
      : "This permanently deletes the task and can't be undone.",
  };
  const { response } =
    panel && !panel.isDestroyed()
      ? await dialog.showMessageBox(panel, confirmOptions)
      : await dialog.showMessageBox(confirmOptions);
  if (response !== 0) return;

  try {
    const result = (await client.invoke({ id: "dex.delete", input: { id } })) as {
      ok?: boolean;
      message?: string;
    } | null;
    if (result && result.ok === false) {
      showNotice({ tone: "bad", text: result.message ?? `Delete task ${id} failed.` });
    } else {
      showNotice({ tone: "ok", text: result?.message ?? `Deleted task ${id}.` });
      await refreshDexBoard();
    }
  } catch (err) {
    showNotice({ tone: "bad", text: `Delete task ${id} failed: ${errorMessage(err)}` });
  } finally {
    pushState();
  }
}

/**
 * Edit a dex task's metadata via the dex plugin's `edit` action, then refresh the
 * board and toast the outcome. Driven by the detail screen's inline editor; the
 * request carries only the fields the user changed. Awaited by the renderer (via
 * `ipcMain.handle`) so the editor clears its in-flight state when the work
 * finishes. On success the board is re-fetched immediately so the detail view
 * reflects the new name/description without waiting for the next poll. The daemon
 * surfaces a rejected (blank) name as a clear `{ ok:false, message }`, toasted here.
 */
async function editDex(request: DexEditRequest): Promise<void> {
  if (!client) return;
  try {
    const result = (await client.invoke({ id: "dex.edit", input: request })) as {
      ok?: boolean;
      message?: string;
    } | null;
    if (result && result.ok === false) {
      showNotice({ tone: "bad", text: result.message ?? `Edit task ${request.id} failed.` });
    } else {
      showNotice({ tone: "ok", text: result?.message ?? `Updated task ${request.id}.` });
      await refreshDexBoard();
    }
  } catch (err) {
    showNotice({ tone: "bad", text: `Edit task ${request.id} failed: ${errorMessage(err)}` });
  } finally {
    pushState();
  }
}

/**
 * Add a dependency (blocker) edge between two dex tasks via the dex plugin's
 * `add-blocker` action — `blockedId` becomes blocked by `blockerId` — then refresh
 * the board and toast the outcome. Driven by the renderer's drag-and-drop (drop A
 * onto B ⇒ B blocked-by A). Awaited by the renderer (via `ipcMain.handle`) so the
 * drop target clears its in-flight state when the edit finishes. On success the
 * board is re-fetched immediately so the new blocked chip appears without waiting
 * for the next poll. The daemon surfaces dex's own self-block/cycle rejections as a
 * clear `{ ok:false, message }`, toasted here.
 */
async function addDexBlocker(request: DexBlockerRequest): Promise<void> {
  if (!client) return;
  try {
    const result = (await client.invoke({ id: "dex.add-blocker", input: request })) as {
      ok?: boolean;
      message?: string;
    } | null;
    if (result && result.ok === false) {
      showNotice({ tone: "bad", text: result.message ?? "Couldn't add the dependency." });
    } else {
      showNotice({ tone: "ok", text: result?.message ?? "Added the dependency." });
      await refreshDexBoard();
    }
  } catch (err) {
    showNotice({ tone: "bad", text: `Add dependency failed: ${errorMessage(err)}` });
  } finally {
    pushState();
  }
}

/**
 * Remove a dependency (blocker) edge between two dex tasks via the dex plugin's
 * `remove-blocker` action — `blockedId` stops being blocked by `blockerId` — then
 * refresh the board and toast the outcome. The inverse of {@link addDexBlocker};
 * driven by the renderer dragging a blocked graph node out of the blocker it's
 * nested under. Awaited by the renderer (via `ipcMain.handle`) so the drop target
 * clears its in-flight state when the edit finishes. Removing one edge leaves the
 * task's other blocker edges untouched (the dex action targets the single pair).
 * On success the board is re-fetched immediately so the task flips to ready (if
 * that was its last active blocker) without waiting for the next poll.
 */
async function removeDexBlocker(request: DexBlockerRequest): Promise<void> {
  if (!client) return;
  try {
    const result = (await client.invoke({ id: "dex.remove-blocker", input: request })) as {
      ok?: boolean;
      message?: string;
    } | null;
    if (result && result.ok === false) {
      showNotice({ tone: "bad", text: result.message ?? "Couldn't remove the dependency." });
    } else {
      showNotice({ tone: "ok", text: result?.message ?? "Removed the dependency." });
      await refreshDexBoard();
    }
  } catch (err) {
    showNotice({ tone: "bad", text: `Remove dependency failed: ${errorMessage(err)}` });
  } finally {
    pushState();
  }
}

/**
 * Author a new dex task from a free-form description via the dex plugin's `new`
 * action — it spawns an agent in the target repo to read the code and run `dex
 * create` — then toast the outcome. Awaited by the renderer (via `ipcMain.handle`)
 * so the composer clears its in-flight state when the launch finishes. The task is
 * authored asynchronously by that agent, so it appears on the next board poll
 * rather than immediately — no eager refresh here (it'd race the agent).
 */
async function newDexTask(request: DexNewRequest): Promise<void> {
  if (!client) return;
  try {
    const result = (await client.invoke({ id: "dex.new", input: request })) as {
      ok?: boolean;
      message?: string;
    } | null;
    if (result && result.ok === false) {
      showNotice({ tone: "bad", text: result.message ?? "Couldn't start the task author." });
    } else {
      showNotice({ tone: "ok", text: result?.message ?? "Spawned an agent to author the task." });
    }
  } catch (err) {
    showNotice({ tone: "bad", text: `New task failed: ${errorMessage(err)}` });
  } finally {
    pushState();
  }
}

/** Re-invoke `dex.tasks` so the board reflects a just-deleted task immediately. */
async function refreshDexBoard(): Promise<void> {
  if (!client) return;
  try {
    buildInput.dexBoard = (await client.invoke({ id: DEX_TASKS_ID })) as DexBoard;
  } catch {
    // Best-effort: the subscription's next poll will reconcile the board anyway.
  }
}

/** Show a transient status toast; auto-dismiss after a few seconds. */
function showNotice(notice: Notice): void {
  buildInput.notice = notice;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    buildInput.notice = undefined;
    pushState();
  }, 6000);
}

/**
 * Invoke `stack.sync` for a repo (Sync button). Shows progress on the button
 * while it runs, then a toast with the outcome (synced / conflict / failure) —
 * a cascading rebase can take a few seconds and may stop on a conflict, so the
 * feedback matters. No-op if Sync is unavailable or already running for the repo.
 */
async function sync(repo: string): Promise<void> {
  if (!client || !buildInput.syncAvailable) return;
  if (buildInput.syncing?.includes(repo)) return;

  setSyncing(repo, true);
  buildInput.notice = undefined;
  pushState();

  try {
    const result = (await client.invoke({ id: STACK_SYNC_ID, input: { repo } })) as {
      conflict?: boolean;
      message?: string;
    } | null;
    await refresh();
    if (result?.conflict) {
      showNotice({ tone: "warn", text: result.message ?? "Sync stopped on a conflict." });
    } else {
      showNotice({ tone: "ok", text: result?.message ?? "Stack synced." });
    }
  } catch (err) {
    showNotice({ tone: "bad", text: `Sync failed: ${errorMessage(err)}` });
  } finally {
    setSyncing(repo, false);
    pushState();
  }
}

/**
 * Invoke `stack.resolve-conflicts` for a conflicting PR (the per-row "Resolve
 * conflicts" button). Marks the branch in-flight so its button spins, spawns the
 * agent, then toasts the outcome — the worktree creation + terminal launch is
 * otherwise silent. Awaited by the renderer (via `ipcMain.handle`) so the button
 * clears its spinner once the work finishes. No-op if the action is unavailable
 * or already running for that branch.
 */
async function resolveConflicts(request: ResolveConflictsRequest): Promise<void> {
  if (!client || !buildInput.resolveConflictsAvailable) return;
  if (buildInput.resolvingConflicts?.includes(request.headRefName)) return;

  setResolvingConflicts(request.headRefName, true);
  pushState();
  try {
    const result = (await client.invoke({
      id: STACK_RESOLVE_CONFLICTS_ID,
      input: {
        repo: request.repo,
        headRefName: request.headRefName,
        baseRefName: request.baseRefName,
        number: request.number,
      },
    })) as { ok?: boolean; message?: string } | null;
    if (result?.ok === false) {
      showNotice({ tone: "bad", text: result.message ?? "Couldn't resolve conflicts." });
    } else {
      showNotice({
        tone: "ok",
        text: result?.message ?? `Spawned an agent to resolve conflicts on ${request.headRefName}.`,
      });
    }
  } catch (err) {
    showNotice({ tone: "bad", text: `Resolve conflicts failed: ${errorMessage(err)}` });
  } finally {
    setResolvingConflicts(request.headRefName, false);
    pushState();
  }
}

/**
 * Invoke `stack.open-agent` for a PR (the per-row "Open agent" button). Marks the
 * branch in-flight so its button spins, opens a free-form auto-mode Claude
 * session in the PR's worktree, then toasts the outcome — the worktree creation +
 * terminal launch is otherwise silent. Awaited by the renderer (via
 * `ipcMain.handle`) so the button clears its spinner once the work finishes.
 * No-op if the action is unavailable or already running for that branch.
 */
async function openAgent(request: OpenAgentRequest): Promise<void> {
  if (!client || !buildInput.openAgentAvailable) return;
  if (buildInput.openingAgents?.includes(request.headRefName)) return;

  setOpeningAgent(request.headRefName, true);
  pushState();
  try {
    const result = (await client.invoke({
      id: STACK_OPEN_AGENT_ID,
      input: {
        repo: request.repo,
        headRefName: request.headRefName,
        number: request.number,
      },
    })) as { ok?: boolean; message?: string } | null;
    if (result?.ok === false) {
      showNotice({ tone: "bad", text: result.message ?? "Couldn't open an agent." });
    } else {
      showNotice({
        tone: "ok",
        text: result?.message ?? `Opened an agent session on ${request.headRefName}.`,
      });
    }
  } catch (err) {
    showNotice({ tone: "bad", text: `Open agent failed: ${errorMessage(err)}` });
  } finally {
    setOpeningAgent(request.headRefName, false);
    pushState();
  }
}

/**
 * Invoke `stack.merge-pr` for a mergeable PR (the per-row "Merge" button). A
 * merge is outward-facing and hard to reverse, so we confirm with a native
 * dialog first; on confirm, marks the branch in-flight (its button spins),
 * merges, toasts the outcome, and refreshes the overview so the merged PR drops
 * out of the panel. Awaited by the renderer (via `ipcMain.handle`) so the button
 * clears its spinner once done. No-op if the action is unavailable or already
 * running for that branch.
 */
async function mergePr(request: MergePrRequest): Promise<void> {
  if (!client || !buildInput.mergePrAvailable) return;
  if (buildInput.mergingPrs?.includes(request.headRefName)) return;

  // Confirm before merging — the click alone shouldn't fire an irreversible,
  // outward-facing action. Default button is Cancel (index 1) for safety.
  const confirmOptions = {
    type: "question" as const,
    buttons: ["Merge", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: `Merge PR #${request.number}?`,
    detail: `This merges ${request.headRefName} on GitHub and can't be easily undone.`,
  };
  const { response } =
    panel && !panel.isDestroyed()
      ? await dialog.showMessageBox(panel, confirmOptions)
      : await dialog.showMessageBox(confirmOptions);
  if (response !== 0) return;

  setMergingPr(request.headRefName, true);
  pushState();
  try {
    const result = (await client.invoke({
      id: STACK_MERGE_PR_ID,
      input: {
        repo: request.repo,
        number: request.number,
        headRefName: request.headRefName,
      },
    })) as { ok?: boolean; message?: string } | null;
    if (result?.ok === false) {
      showNotice({ tone: "bad", text: result.message ?? `Couldn't merge PR #${request.number}.` });
    } else {
      showNotice({ tone: "ok", text: result?.message ?? `Merged PR #${request.number}.` });
      // The merged PR should drop out on the next read — refresh now so the
      // panel reflects it immediately rather than waiting for the poll.
      await refresh();
    }
  } catch (err) {
    showNotice({ tone: "bad", text: `Merge failed: ${errorMessage(err)}` });
  } finally {
    setMergingPr(request.headRefName, false);
    pushState();
  }
}

/** Open a PR's URL in the user's default browser. */
function openPr(url: string): void {
  void shell.openExternal(url);
}

/**
 * Display an incoming daemon notification as a native macOS banner. The daemon
 * already de-dupes; we only drop a stale backlog a reconnect might replay (older
 * than {@link appStartTime}) and skip entirely where the OS can't show banners.
 * A click opens the PR (`openUrl`) in the default browser. All shaping lives in
 * the Electron-free {@link toNotifyOptions}/{@link shouldShowNotification}.
 */
function showNativeNotification(note: NotificationPayload): void {
  if (!Notification.isSupported()) return;
  if (!shouldShowNotification(note, appStartTime)) return;

  const notification = new Notification({ ...toNotifyOptions(note), icon: notificationIcon() });
  const { openUrl } = note;
  if (openUrl) notification.on("click", () => void shell.openExternal(openUrl));
  notification.show();
}

/** The full-color Perch bird, used as the notification icon. Loaded once. */
let notifyIcon: ReturnType<typeof nativeImage.createFromPath> | undefined;
function notificationIcon(): ReturnType<typeof nativeImage.createFromPath> {
  notifyIcon ??= nativeImage.createFromPath(join(__dirname, "perch-icon.png"));
  return notifyIcon;
}

/** Best-effort human-readable message from an RPC/JS error. */
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/**
 * Persist the panel's current size to {@link windowStatePath} so it's sticky
 * across opens and restarts. Best-effort: a failed write shouldn't crash the
 * app, just log.
 */
function saveCurrentSize(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const { width, height } = win.getBounds();
  try {
    writeWindowSize(windowStatePath(), { width, height });
  } catch (err) {
    console.error(`[window-state] save failed: ${errorMessage(err)}`);
  }
}

/** Create the frameless, always-on-top, non-activating panel window (hidden). */
function createPanel(): BrowserWindow {
  // Restore the user's last size (or the default), clamped to the minimum, the
  // last-selected tab, and the Dex view mode (all seeded into the first pushed state).
  const { width, height } = readWindowSize(windowStatePath());
  savedActiveTab = readActiveTab(windowStatePath());
  savedDexViewMode = readDexViewMode(windowStatePath());
  const win = new BrowserWindow({
    width,
    height,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    show: false,
    frame: false,
    resizable: true,
    movable: true,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Non-activating: clicking the panel doesn't steal focus from the editor.
    focusable: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e1e1e" : "#f5f5f5",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Pin above normal windows including full-screen apps (menu-bar utility feel).
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Persist the size as the user drags the resize handle. Debounced so a single
  // drag (which fires many `resize` events) results in one write when it settles.
  win.on("resize", () => {
    if (saveSizeTimer) clearTimeout(saveSizeTimer);
    saveSizeTimer = setTimeout(() => {
      saveSizeTimer = null;
      saveCurrentSize(win);
    }, 300);
  });

  // Also flush on dismiss/close so the latest size is captured even if a resize
  // was still pending in the debounce window.
  const flushSize = (): void => {
    if (saveSizeTimer) {
      clearTimeout(saveSizeTimer);
      saveSizeTimer = null;
    }
    saveCurrentSize(win);
  };
  win.on("hide", flushSize);
  win.on("close", flushSize);

  win.on("blur", () => {
    // Behave like a menu-bar popover: dismiss when focus leaves.
    if (!win.webContents.isDevToolsOpened()) win.hide();
  });

  // Push the current state once the renderer is actually loaded. Without this,
  // the first pushState() (from showPanel, right after show()) races the
  // renderer registering its onState listener — the message is dropped and the
  // panel paints blank until the next refresh/poll.
  win.webContents.on("did-finish-load", () => pushState());

  // Surface renderer/preload failures in the main process log (otherwise a
  // renderer exception is silent and the panel just sits blank).
  win.webContents.on("preload-error", (_e, p, error) => {
    console.error(`[preload-error] ${p}: ${error?.stack ?? error}`);
  });
  win.webContents.on("console-message", (_e, _level, message, line, sourceId) => {
    console.error(`[renderer] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error(`[render-gone] ${details.reason}`);
  });

  void win.loadFile(join(__dirname, "renderer", "index.html"));
  return win;
}

/** Position the panel just below the tray icon and show it. */
function showPanel(): void {
  if (!panel) panel = createPanel();
  const bounds = tray?.getBounds();
  if (bounds) {
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
    // Center on the tray using the panel's live width (it may have been resized
    // or restored to a persisted size), not a fixed constant.
    const panelWidth = panel.getBounds().width;
    const x = Math.round(bounds.x + bounds.width / 2 - panelWidth / 2);
    const y = Math.round(bounds.y + bounds.height + 4);
    // Keep the panel on-screen horizontally.
    const maxX = display.workArea.x + display.workArea.width - panelWidth;
    panel.setPosition(Math.max(display.workArea.x, Math.min(x, maxX)), y, false);
  }
  panel.show();
  pushState();
}

function togglePanel(): void {
  if (panel?.isVisible()) panel.hide();
  else showPanel();
}

/**
 * The tray icon: the Perch bird as a monochrome **template image** (bundled at
 * `dist/perch-trayTemplate.png`, with a `@2x` retina variant Electron picks up
 * by filename convention). macOS tints a template image automatically — dark in
 * a light menu bar, white in a dark one — so it matches the system like a native
 * menu-bar icon. Falls back to a painted dot if the asset can't be loaded.
 *
 * (The full-color `perch-icon.png` is still bundled as an alternative.)
 */
function trayImage(): Electron.NativeImage {
  const iconPath = join(__dirname, "perch-trayTemplate.png");
  const img = nativeImage.createFromPath(iconPath);
  if (img.isEmpty()) return fallbackTrayImage();
  img.setTemplateImage(true);
  return img;
}

/**
 * Fallback: a generated filled dot template image, used only if the bundled
 * icon can't be loaded. A template image is defined by its alpha channel
 * (macOS tints it), so we paint a real shape — a transparent buffer is invisible.
 */
function fallbackTrayImage(): Electron.NativeImage {
  const size = 16;
  const center = (size - 1) / 2;
  const radius = 6.5;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - center, y - center);
      const alpha = d <= radius ? 255 : d <= radius + 1 ? Math.round(255 * (radius + 1 - d)) : 0;
      const i = (y * size + x) * 4;
      buf[i] = 0;
      buf[i + 1] = 0;
      buf[i + 2] = 0;
      buf[i + 3] = alpha;
    }
  }
  const img = nativeImage.createEmpty();
  img.addRepresentation({ width: size, height: size, scaleFactor: 1, buffer: buf });
  img.setTemplateImage(true);
  return img;
}

/**
 * The `perch.json` the GUI opens. Created with a sensible default (the stack
 * plugin enabled) if it doesn't exist yet, so "Open Config" always lands on a
 * real file. Returns its path.
 */
function ensureConfigFile(): string {
  const path = defaultConfigPath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ plugins: { stack: {} } }, null, 2)}\n`, "utf8");
  }
  return path;
}

/** Open `perch.json` in the user's default editor. */
function openConfig(): void {
  void shell.openPath(ensureConfigFile());
}

/** Reveal `perch.json` in Finder / the file manager. */
function revealConfig(): void {
  shell.showItemInFolder(ensureConfigFile());
}

/**
 * Ensure we have a connected {@link PerchClient}, reusing the one the panel
 * already established or connecting on demand (the Settings window may be opened
 * before the panel's connect resolves). Returns null when the daemon is down so
 * callers can render a read-only "daemon not running" state.
 */
async function ensureClient(): Promise<PerchClient | null> {
  if (client) return client;
  const socket = process.env.PERCH_SOCKET ?? defaultSocketPath();
  try {
    client = await PerchClient.connect(socket);
    return client;
  } catch (err) {
    if (err instanceof DaemonUnavailableError) return null;
    throw err;
  }
}

/** Read the current configured repos as display rows over a connected client. */
async function loadSettings(): Promise<SettingsResult> {
  const c = await ensureClient();
  if (!c) return { repos: [], daemonUp: false };
  const config = await c.configGet();
  return { repos: toEntries(reposFromConfig(config)), daemonUp: true };
}

/**
 * Persist a new repos array via `config.update` (the daemon hot-reloads and the
 * panel refreshes via `registry.changed`) and return the refreshed list.
 */
async function persistRepos(c: PerchClient, repos: string[]): Promise<SettingsResult> {
  const config = await c.configUpdate({ patch: { plugins: { stack: { repos } } } });
  return { repos: toEntries(reposFromConfig(config)), daemonUp: true };
}

/** Wrap a settings op so daemon/RPC failures surface inline rather than throw. */
async function settingsOp(
  fn: (c: PerchClient) => Promise<SettingsResult>,
): Promise<SettingsResult> {
  const c = await ensureClient();
  if (!c) return { repos: [], daemonUp: false };
  try {
    return await fn(c);
  } catch (err) {
    const config = await c.configGet().catch(() => null);
    const repos = config ? toEntries(reposFromConfig(config)) : [];
    return { repos, daemonUp: true, error: errorMessage(err) };
  }
}

/**
 * Add a repo: show a native folder picker, validate the chosen directory, and
 * (on success) append it + persist. A cancelled picker returns the current list
 * unchanged; a validation failure returns it with the reason as an inline error.
 */
async function addRepoFlow(c: PerchClient): Promise<SettingsResult> {
  const pickerOptions = {
    title: "Add a stack repository",
    properties: ["openDirectory" as const],
  };
  const picked =
    settingsWindow && !settingsWindow.isDestroyed()
      ? await dialog.showOpenDialog(settingsWindow, pickerOptions)
      : await dialog.showOpenDialog(pickerOptions);
  const config = await c.configGet();
  const current = reposFromConfig(config);
  if (picked.canceled || picked.filePaths.length === 0) {
    return { repos: toEntries(current), daemonUp: true };
  }

  const path = picked.filePaths[0]!;
  const valid = await c.validateRepoPath({ path });
  if (!valid.ok) {
    return {
      repos: toEntries(current),
      daemonUp: true,
      error: valid.reason ?? `Not a usable git repo: ${path}`,
    };
  }
  return persistRepos(c, addRepo(current, path));
}

/**
 * Fetch the per-plugin settings descriptors (`settings.describe`) as a
 * {@link PluginSettingsResult}. Returns an empty, read-only result when the
 * daemon is down so the renderer can render a "daemon not running" state.
 */
async function loadPluginSettings(): Promise<PluginSettingsResult> {
  const c = await ensureClient();
  if (!c) return { plugins: [], daemonUp: false };
  const plugins = await c.settingsDescribe();
  return { plugins, daemonUp: true };
}

/**
 * Wrap a per-plugin settings op so daemon/RPC failures surface inline (with the
 * last-known descriptors) rather than throwing across the IPC boundary.
 */
async function pluginSettingsOp(
  fn: (c: PerchClient) => Promise<PluginSettingsResult>,
): Promise<PluginSettingsResult> {
  const c = await ensureClient();
  if (!c) return { plugins: [], daemonUp: false };
  try {
    return await fn(c);
  } catch (err) {
    const plugins = await c.settingsDescribe().catch(() => []);
    return { plugins, daemonUp: true, error: errorMessage(err) };
  }
}

/**
 * Persist one plugin field via `config.update` (the daemon hot-reloads and the
 * panel refreshes via `registry.changed`), then re-describe so the returned
 * descriptors reflect the written value. `key` may be a dotted path; the patch
 * sets it nested under `plugins[pluginId]` (see {@link buildConfigPatch}).
 */
async function setFieldFlow(
  c: PerchClient,
  request: SetFieldRequest,
): Promise<PluginSettingsResult> {
  // The reserved "General" descriptor writes to the top-level `global` section;
  // every real plugin writes under `plugins[id]`.
  const patch =
    request.pluginId === GENERAL_TAB_ID
      ? buildGlobalConfigPatch(request.key, request.value)
      : buildConfigPatch(request.pluginId, request.key, request.value);
  await c.configUpdate({ patch });
  const plugins = await c.settingsDescribe();
  return { plugins, daemonUp: true };
}

/**
 * Read the configured managed processes (`plugins.services.procs`). Returns an
 * empty, read-only result when the daemon is down so the Services tab can render
 * a "daemon not running" state.
 */
async function loadProcs(): Promise<ServicesResult> {
  const c = await ensureClient();
  if (!c) return { procs: [], daemonUp: false };
  const config = await c.configGet();
  return { procs: procsFromConfig(config), daemonUp: true };
}

/**
 * Persist a new procs array via `config.update` (the daemon hot-reloads and the
 * panel's Services section + service list refresh via `registry.changed`) and
 * return the refreshed list.
 */
async function persistProcs(c: PerchClient, procs: Proc[]): Promise<ServicesResult> {
  const config = await c.configUpdate({ patch: { plugins: { services: { procs } } } });
  return { procs: procsFromConfig(config), daemonUp: true };
}

/**
 * Wrap a managed-process op so daemon/RPC failures — and the expected
 * {@link ProcValidationError} from {@link addProc} (blank field, duplicate
 * name) — surface inline (with the last-known procs) rather than throwing
 * across the IPC boundary.
 */
async function servicesOp(
  fn: (c: PerchClient) => Promise<ServicesResult>,
): Promise<ServicesResult> {
  const c = await ensureClient();
  if (!c) return { procs: [], daemonUp: false };
  try {
    return await fn(c);
  } catch (err) {
    const config = await c.configGet().catch(() => null);
    const procs = config ? procsFromConfig(config) : [];
    return { procs, daemonUp: true, error: errorMessage(err) };
  }
}

/** Create (or focus) the separate Settings window. */
function showSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  // Open on the display the tray/panel is on (not always the primary): a window
  // created without x/y defaults to the primary display, wrong on multi-monitor.
  const settingsSize = { width: 620, height: 460 };
  const anchor = tray?.getBounds() ?? panel?.getBounds();
  const display = anchor
    ? screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y })
    : screen.getPrimaryDisplay();
  const { x, y } = centeredPosition(display.workArea, settingsSize);

  const win = new BrowserWindow({
    x,
    y,
    width: settingsSize.width,
    height: settingsSize.height,
    title: "Perch Settings",
    show: false,
    resizable: true,
    fullscreenable: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e1e1e" : "#f5f5f5",
    webPreferences: {
      preload: join(__dirname, "settings-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.on("ready-to-show", () => win.show());
  win.on("closed", () => {
    settingsWindow = null;
  });
  win.webContents.on("preload-error", (_e, p, error) => {
    console.error(`[settings preload-error] ${p}: ${error?.stack ?? error}`);
  });
  win.webContents.on("console-message", (_e, _level, message, line, sourceId) => {
    console.error(`[settings renderer] ${message} (${sourceId}:${line})`);
  });

  void win.loadFile(join(__dirname, "settings", "index.html"));
  settingsWindow = win;
}

function createTray(): void {
  tray = new Tray(trayImage());
  tray.setToolTip("Perch");
  // Start with no badge; pushState updates it from the landable decision count.
  tray.setTitle("");
  const menu = Menu.buildFromTemplate([
    { label: "Show / Hide", click: () => togglePanel() },
    { type: "separator" },
    { label: "Settings…", click: () => showSettingsWindow() },
    { label: "Open Config", click: () => openConfig() },
    { label: "Reveal Config in Finder", click: () => revealConfig() },
    { type: "separator" },
    { label: "Quit", role: "quit" },
  ]);
  // Left-click toggles the panel; right-click opens the menu.
  tray.on("click", () => togglePanel());
  tray.on("right-click", () => tray?.popUpContextMenu(menu));
}

function registerIpc(): void {
  ipcMain.on(Channels.refresh, () => void refresh());
  ipcMain.on(Channels.sync, (_event, repo: string) => void sync(repo));
  ipcMain.on(Channels.openPr, (_event, url: string) => openPr(url));
  ipcMain.on(
    Channels.serviceAction,
    (_event, request: ServiceActionRequest) => void serviceAction(request),
  );
  ipcMain.on(
    Channels.servicesBulk,
    (_event, action: ServicesBulkAction) => void servicesBulk(action),
  );
  ipcMain.on(Channels.serviceLogs, (_event, name: string) => void serviceLogs(name));
  ipcMain.on(Channels.worktreeOpen, (_event, path: string) => void openWorktree(path));
  ipcMain.handle(Channels.worktreeRemove, (_event, request: WorktreeRemoveRequest) =>
    removeWorktree(request),
  );
  // Spawns use `handle` (not `send`) so the renderer can await completion and
  // clear the button's in-progress state when the worktree/terminal work finishes.
  ipcMain.handle(Channels.dexSpawn, (_event, id: string) => spawnDex(id));
  ipcMain.handle(Channels.dexSpawnReady, (_event, project?: string) => spawnDexReady(project));
  ipcMain.handle(Channels.dexDelete, (_event, request: DexDeleteRequest) => deleteDex(request));
  ipcMain.handle(Channels.dexEdit, (_event, request: DexEditRequest) => editDex(request));
  ipcMain.handle(Channels.dexAddBlocker, (_event, request: DexBlockerRequest) =>
    addDexBlocker(request),
  );
  ipcMain.handle(Channels.dexRemoveBlocker, (_event, request: DexBlockerRequest) =>
    removeDexBlocker(request),
  );
  ipcMain.handle(Channels.dexNew, (_event, request: DexNewRequest) => newDexTask(request));
  ipcMain.handle(Channels.resolveConflicts, (_event, request: ResolveConflictsRequest) =>
    resolveConflicts(request),
  );
  ipcMain.handle(Channels.openAgent, (_event, request: OpenAgentRequest) => openAgent(request));
  ipcMain.handle(Channels.mergePr, (_event, request: MergePrRequest) => mergePr(request));
  // Clipboard writes go through main (Electron's clipboard) rather than the
  // renderer's navigator.clipboard, which a non-activating panel can't rely on.
  ipcMain.on(Channels.copyText, (_event, text: string) => {
    if (typeof text === "string" && text.length > 0) clipboard.writeText(text);
  });
  // Persist the renderer's tab selection so it's restored on the next open.
  ipcMain.on(Channels.setActiveTab, (_event, id: string) => {
    if (typeof id !== "string" || id.length === 0 || id === savedActiveTab) return;
    savedActiveTab = id;
    try {
      writeActiveTab(windowStatePath(), id);
    } catch (err) {
      console.error(`[window-state] save active tab failed: ${errorMessage(err)}`);
    }
  });
  // Persist the renderer's Dex view mode so it's restored on the next open.
  ipcMain.on(Channels.setDexViewMode, (_event, mode: DexViewMode) => {
    if ((mode !== "tree" && mode !== "graph") || mode === savedDexViewMode) return;
    savedDexViewMode = mode;
    try {
      writeDexViewMode(windowStatePath(), mode);
    } catch (err) {
      console.error(`[window-state] save dex view mode failed: ${errorMessage(err)}`);
    }
  });

  // Settings window: request/response handlers returning the refreshed repo list.
  ipcMain.handle(SettingsChannels.list, () => loadSettings());
  ipcMain.handle(SettingsChannels.add, () => settingsOp((c) => addRepoFlow(c)));
  ipcMain.handle(SettingsChannels.remove, (_event, path: string) =>
    settingsOp(async (c) =>
      persistRepos(c, removeRepo(reposFromConfig(await c.configGet()), path)),
    ),
  );
  ipcMain.handle(SettingsChannels.setDefault, (_event, path: string) =>
    settingsOp(async (c) =>
      persistRepos(c, setDefault(reposFromConfig(await c.configGet()), path)),
    ),
  );

  // Settings window: per-plugin schema-driven settings (describe + write-back).
  ipcMain.handle(SettingsChannels.describePlugins, () => loadPluginSettings());
  ipcMain.handle(SettingsChannels.setField, (_event, request: SetFieldRequest) =>
    pluginSettingsOp((c) => setFieldFlow(c, request)),
  );

  // Settings window: managed processes on the Services tab (list / add / remove).
  ipcMain.handle(SettingsChannels.listProcs, () => loadProcs());
  ipcMain.handle(SettingsChannels.addProc, (_event, proc: Proc) =>
    servicesOp(async (c) => persistProcs(c, addProc(procsFromConfig(await c.configGet()), proc))),
  );
  ipcMain.handle(SettingsChannels.removeProc, (_event, name: string) =>
    servicesOp(async (c) =>
      persistProcs(c, removeProc(procsFromConfig(await c.configGet()), name)),
    ),
  );
}

// Single instance: if a Perch GUI is already running, quit immediately so a
// second launch (e.g. `perch app`) just focuses the existing one. Everything
// else MUST be guarded behind the lock — otherwise the second instance still
// runs `whenReady` and builds a duplicate tray before quitting.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showPanel());

  app.whenReady().then(() => {
    // macOS: set the app icon (which notification banners use) to the bird,
    // then keep the app out of the Dock — it's a menu-bar utility.
    app.dock?.setIcon(notificationIcon());
    app.dock?.hide();
    registerIpc();
    createTray();
    // Preload the (hidden) panel so its renderer is ready before the first open
    // (instant first paint) and so renderer errors surface immediately.
    panel = createPanel();
    void connect();
  });

  // A menu-bar app stays resident when all windows close.
  app.on("window-all-closed", () => {
    /* keep running in the tray */
  });

  app.on("before-quit", () => {
    client?.close();
    client = null;
  });
}
