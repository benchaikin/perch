/**
 * Electron main process for @perch/gui.
 *
 * Owns a menu-bar (tray) entry that toggles a frameless, always-on-top,
 * non-activating pinned panel. Connects to `perchd` over JSON-RPC (reusing
 * {@link PerchClient} from `@perch/cli`), subscribes to `stack.view`, and
 * forwards derived {@link PanelState} to the renderer via IPC. All data-shaping
 * lives in the Electron-free {@link buildPanelState}; this file is wiring only.
 *
 * NOTE: a visible launch is not verified in CI (no display). See README.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray, screen } from "electron";
import { configPath as defaultConfigPath, socketPath as defaultSocketPath } from "@perch/core";
import { DaemonUnavailableError, PerchClient } from "@perch/cli";
import { Channels } from "./ipc.js";
import {
  buildPanelState,
  STACK_REPOS_ID,
  STACK_SYNC_ID,
  STACK_VIEW_ID,
  type BuildInput,
  type PanelState,
  type ReposResult,
  type StackGraph,
} from "./panel-state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 320;

let tray: Tray | null = null;
let panel: BrowserWindow | null = null;
let client: PerchClient | null = null;

/** Latest inputs to the view-model; updated piecemeal then rebuilt + pushed. */
const buildInput: BuildInput = { daemonUp: false, syncAvailable: false };
/** Subscription key echoed on `capability.update` notifications. */
let subscriptionKey: string | undefined;

/** Recompute the panel state from current inputs and push it to the renderer. */
function pushState(): void {
  const state = buildPanelState(buildInput);
  panel?.webContents.send(Channels.stateFromMain, state satisfies PanelState);
}

/** The `stack.view` input for the currently-selected repo (omit when none). */
function viewInput(): { repo: string } | undefined {
  return buildInput.selectedRepo ? { repo: buildInput.selectedRepo } : undefined;
}

/**
 * Fetch the configured repos (`stack.repos`) and reconcile `selectedRepo`:
 * keep the current selection if it still exists, else fall back to the read's
 * default. Tolerant — if the read is absent (older plugin) repos stay empty.
 */
async function loadRepos(): Promise<void> {
  if (!client) return;
  try {
    const result = (await client.invoke({ id: STACK_REPOS_ID })) as ReposResult;
    buildInput.repos = result.repos;
    const names = new Set(result.repos.map((r) => r.name));
    if (!buildInput.selectedRepo || !names.has(buildInput.selectedRepo)) {
      buildInput.selectedRepo = result.default;
    }
  } catch {
    // `stack.repos` not available (stack plugin disabled / older) — no switcher.
    buildInput.repos = [];
    buildInput.selectedRepo = undefined;
  }
}

/**
 * (Re)subscribe to `stack.view` for the current `selectedRepo` and seed the
 * graph from the subscription's current value. The subscription key is tracked
 * so live `capability.update` notes for this exact (id, input) are matched.
 */
async function subscribeView(): Promise<void> {
  if (!client) return;
  const sub = await client.subscribe({ id: STACK_VIEW_ID, input: viewInput() });
  subscriptionKey = sub.inputKey;
  if (sub.current !== undefined) buildInput.graph = sub.current as StackGraph;
  buildInput.error = undefined;
}

/** Connect to perchd, subscribe to `stack.view`, and detect Sync availability. */
async function connect(): Promise<void> {
  const socket = process.env.PERCH_SOCKET ?? defaultSocketPath();
  try {
    client = await PerchClient.connect(socket);
  } catch (err) {
    if (err instanceof DaemonUnavailableError) {
      buildInput.daemonUp = false;
      pushState();
      return;
    }
    throw err;
  }

  buildInput.daemonUp = true;

  // Live updates: refresh the view-model whenever a matching update arrives.
  client.onUpdate((note) => {
    if (note.id === STACK_VIEW_ID && note.inputKey === subscriptionKey) {
      buildInput.graph = note.data as StackGraph;
      buildInput.error = undefined;
      pushState();
    }
  });

  // The daemon hot-reloads perch.json — re-sync when the registry changes.
  client.onRegistryChanged(() => void reloadFromRegistry());

  // Sync is added in parallel by M6 and may be absent here — gate the button on
  // the registry rather than assuming it exists.
  try {
    const caps = await client.registryList();
    buildInput.syncAvailable = caps.some((c) => c.id === STACK_SYNC_ID);
  } catch {
    buildInput.syncAvailable = false;
  }

  // Populate the repo switcher, then subscribe for the selected repo's value +
  // live deltas.
  await loadRepos();
  try {
    await subscribeView();
  } catch (err) {
    buildInput.error = `stack.view: ${errorMessage(err)}`;
  }
  pushState();
}

/** Re-invoke `stack.view` on demand (Refresh button). */
async function refresh(): Promise<void> {
  if (!client) {
    await connect();
    return;
  }
  try {
    buildInput.graph = (await client.invoke({
      id: STACK_VIEW_ID,
      input: viewInput(),
    })) as StackGraph;
    buildInput.error = undefined;
  } catch (err) {
    buildInput.error = `stack.view: ${errorMessage(err)}`;
  }
  pushState();
}

/**
 * Re-sync after the daemon hot-reloads `perch.json`: refresh the registry (Sync
 * availability) and re-subscribe to `stack.view`, which may have been added or
 * removed by the config change.
 */
async function reloadFromRegistry(): Promise<void> {
  if (!client) return;
  try {
    const caps = await client.registryList();
    buildInput.syncAvailable = caps.some((c) => c.id === STACK_SYNC_ID);
    if (caps.some((c) => c.id === STACK_VIEW_ID)) {
      // The repo list can change with the config — refresh it (reconciling the
      // selection), then re-subscribe to `stack.view` for the selected repo.
      await loadRepos();
      await subscribeView();
    } else {
      // The stack plugin was disabled in config — clear its data + switcher.
      buildInput.graph = { layers: [] };
      buildInput.repos = [];
      buildInput.selectedRepo = undefined;
    }
  } catch (err) {
    buildInput.error = `registry: ${errorMessage(err)}`;
  }
  pushState();
}

/**
 * Switch the targeted repo from the renderer's dropdown: unsubscribe the old
 * `stack.view` input, update the selection, and re-subscribe for the new repo.
 * Ignores a no-op (same repo) or an unknown name.
 */
async function selectRepo(name: string): Promise<void> {
  if (!client || name === buildInput.selectedRepo) return;
  if (!buildInput.repos?.some((r) => r.name === name)) return;
  const previous = viewInput();
  buildInput.selectedRepo = name;
  buildInput.graph = undefined; // show "Loading…" until the new repo's view lands.
  pushState();
  try {
    // Drop the old subscription so the daemon can stop polling that repo.
    void client.unsubscribe({ id: STACK_VIEW_ID, input: previous }).catch(() => {});
    await subscribeView();
  } catch (err) {
    buildInput.error = `stack.view: ${errorMessage(err)}`;
  }
  pushState();
}

/** Invoke `stack.sync` (Sync button); no-op if the action is unavailable. */
async function sync(): Promise<void> {
  if (!client || !buildInput.syncAvailable) return;
  try {
    await client.invoke({ id: STACK_SYNC_ID, input: viewInput() });
    await refresh();
  } catch (err) {
    buildInput.error = `stack.sync: ${errorMessage(err)}`;
    pushState();
  }
}

/** Best-effort human-readable message from an RPC/JS error. */
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/** Create the frameless, always-on-top, non-activating panel window (hidden). */
function createPanel(): BrowserWindow {
  const win = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Non-activating: clicking the panel doesn't steal focus from the editor.
    focusable: true,
    backgroundColor: "#1e1e1e",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Pin above normal windows including full-screen apps (menu-bar utility feel).
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.on("blur", () => {
    // Behave like a menu-bar popover: dismiss when focus leaves.
    if (!win.webContents.isDevToolsOpened()) win.hide();
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
    const x = Math.round(bounds.x + bounds.width / 2 - PANEL_WIDTH / 2);
    const y = Math.round(bounds.y + bounds.height + 4);
    // Keep the panel on-screen horizontally.
    const maxX = display.workArea.x + display.workArea.width - PANEL_WIDTH;
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

function createTray(): void {
  tray = new Tray(trayImage());
  tray.setToolTip("Perch");
  const menu = Menu.buildFromTemplate([
    { label: "Show / Hide", click: () => togglePanel() },
    { type: "separator" },
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
  ipcMain.on(Channels.sync, () => void sync());
  ipcMain.on(Channels.selectRepo, (_event, name: string) => void selectRepo(name));
}

app.whenReady().then(() => {
  // macOS: keep the app out of the Dock — it's a menu-bar utility.
  app.dock?.hide();
  registerIpc();
  createTray();
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
