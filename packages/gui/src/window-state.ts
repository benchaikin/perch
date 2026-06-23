/**
 * Persistence for the panel's user-chosen size, kept Electron-free so it's unit
 * testable without a display. The main process reads the saved size when
 * creating the panel and writes it back (debounced) as the user resizes, making
 * the panel "sticky" across opens and restarts.
 *
 * Stored as a tiny JSON `{ width, height }` file in the app's userData dir
 * rather than in `perch.yaml` — it's GUI-local UI state, not user-facing
 * configuration, so it shouldn't clutter the config the user hand-edits.
 */
import { readFileSync, writeFileSync } from "node:fs";

/** A panel size in logical pixels. */
export interface WindowSize {
  width: number;
  height: number;
}

/** Size used when no valid saved size exists. */
export const DEFAULT_WINDOW_SIZE: WindowSize = { width: 320, height: 320 };

/** Floor the panel is never allowed to shrink below (also enforced by Electron). */
export const MIN_WINDOW_SIZE: WindowSize = { width: 280, height: 200 };

/** Clamp a size up to the minimum on each axis. */
function clampToMinimum(size: WindowSize): WindowSize {
  return {
    width: Math.max(MIN_WINDOW_SIZE.width, size.width),
    height: Math.max(MIN_WINDOW_SIZE.height, size.height),
  };
}

/** True for a finite, positive number we'd accept as a dimension. */
function isValidDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Read the saved panel size from `file`, clamped to the minimum. Falls back to
 * {@link DEFAULT_WINDOW_SIZE} when the file is missing, unreadable, not valid
 * JSON, or doesn't contain two positive numeric dimensions.
 */
export function readWindowSize(file: string): WindowSize {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { ...DEFAULT_WINDOW_SIZE };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_WINDOW_SIZE };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ...DEFAULT_WINDOW_SIZE };
  }

  const { width, height } = parsed as Record<string, unknown>;
  if (!isValidDimension(width) || !isValidDimension(height)) {
    return { ...DEFAULT_WINDOW_SIZE };
  }

  return clampToMinimum({ width, height });
}

/** Read `file` as a JSON object, or `{}` when missing/unreadable/not an object. */
function readObject(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
  } catch {
    /* missing or invalid — treat as empty */
  }
  return {};
}

/**
 * Write `size` to `file` as JSON (clamped to the minimum), preserving any other
 * keys already in the file (e.g. {@link readActiveTab}'s `activeTab`) so the two
 * independent writers don't clobber each other.
 */
export function writeWindowSize(file: string, size: WindowSize): void {
  const clamped = clampToMinimum(size);
  const merged = { ...readObject(file), ...clamped };
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

/** Read the saved active-tab id from `file`, or `undefined` if absent/invalid. */
export function readActiveTab(file: string): string | undefined {
  const activeTab = readObject(file).activeTab;
  return typeof activeTab === "string" && activeTab.length > 0 ? activeTab : undefined;
}

/** Persist `activeTab` to `file`, preserving any saved window size. */
export function writeActiveTab(file: string, activeTab: string): void {
  const merged = { ...readObject(file), activeTab };
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

/** How the Dex tab renders its tasks: a list/tree or a dependency graph. */
export type DexViewMode = "tree" | "graph";

/** The Dex view mode used when none is saved (or a saved value is invalid). */
export const DEFAULT_DEX_VIEW_MODE: DexViewMode = "tree";

/**
 * Read the saved Dex view mode from `file`, falling back to
 * {@link DEFAULT_DEX_VIEW_MODE} when absent or not a recognized mode.
 */
export function readDexViewMode(file: string): DexViewMode {
  const mode = readObject(file).dexViewMode;
  return mode === "tree" || mode === "graph" ? mode : DEFAULT_DEX_VIEW_MODE;
}

/** Persist the Dex view `mode` to `file`, preserving any other saved keys. */
export function writeDexViewMode(file: string, mode: DexViewMode): void {
  const merged = { ...readObject(file), dexViewMode: mode };
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

/** The user-chosen size of the New-task composer dialog, in logical pixels. */
export interface DialogSize {
  width: number;
  height: number;
}

/**
 * Read the saved New-task dialog size from `file`, or `undefined` when absent,
 * unreadable, or missing two positive numeric dimensions. Unlike the panel size
 * there's no default to fall back to — when none is saved the renderer keeps the
 * dialog's CSS default size, so absence is reported as `undefined` rather than a
 * substitute. The restored size is clamped to the viewport renderer-side (the
 * window may be smaller now), so no clamp is applied here.
 */
export function readNewTaskDialogSize(file: string): DialogSize | undefined {
  const value = readObject(file).newTaskDialogSize;
  if (typeof value !== "object" || value === null) return undefined;
  const { width, height } = value as Record<string, unknown>;
  if (!isValidDimension(width) || !isValidDimension(height)) return undefined;
  return { width, height };
}

/** Persist the New-task dialog `size` to `file`, preserving any other saved keys. */
export function writeNewTaskDialogSize(file: string, size: DialogSize): void {
  const merged = {
    ...readObject(file),
    newTaskDialogSize: { width: size.width, height: size.height },
  };
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

/** A display work area (logical pixels), matching Electron's `Display.workArea`. */
export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Center a `size` window within a display's `workArea`. Used to open the
 * Settings window on the same display as the tray/panel (multi-monitor): Electron
 * defaults a window with no x/y to the primary display, which is often the wrong
 * one. Pure so it's unit-testable without a display.
 */
export function centeredPosition(workArea: WorkArea, size: WindowSize): { x: number; y: number } {
  return {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + (workArea.height - size.height) / 2),
  };
}
