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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray, screen } from "electron";
import { socketPath as defaultSocketPath } from "@perch/core";
import { DaemonUnavailableError, PerchClient } from "@perch/cli";
import { Channels } from "./ipc.js";
import {
  buildPanelState,
  STACK_SYNC_ID,
  STACK_VIEW_ID,
  type BuildInput,
  type PanelState,
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

  // Sync is added in parallel by M6 and may be absent here — gate the button on
  // the registry rather than assuming it exists.
  try {
    const caps = await client.registryList();
    buildInput.syncAvailable = caps.some((c) => c.id === STACK_SYNC_ID);
  } catch {
    buildInput.syncAvailable = false;
  }

  // Subscribe for the current value + live deltas.
  try {
    const sub = await client.subscribe({ id: STACK_VIEW_ID });
    subscriptionKey = sub.inputKey;
    if (sub.current !== undefined) buildInput.graph = sub.current as StackGraph;
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
    buildInput.graph = (await client.invoke({ id: STACK_VIEW_ID })) as StackGraph;
    buildInput.error = undefined;
  } catch (err) {
    buildInput.error = `stack.view: ${errorMessage(err)}`;
  }
  pushState();
}

/** Invoke `stack.sync` (Sync button); no-op if the action is unavailable. */
async function sync(): Promise<void> {
  if (!client || !buildInput.syncAvailable) return;
  try {
    await client.invoke({ id: STACK_SYNC_ID });
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

/** A minimal 1px transparent template image; replace with a real icon later. */
function trayImage(): Electron.NativeImage {
  // 16x16 empty template image keeps the tray slot without bundling an asset.
  const img = nativeImage.createEmpty();
  img.addRepresentation({
    width: 16,
    height: 16,
    scaleFactor: 1,
    buffer: Buffer.alloc(16 * 16 * 4),
  });
  img.setTemplateImage(true);
  return img;
}

function createTray(): void {
  tray = new Tray(trayImage());
  tray.setToolTip("Perch");
  const menu = Menu.buildFromTemplate([
    { label: "Show / Hide", click: () => togglePanel() },
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
