/**
 * Persistence for the panel's user-chosen size, kept Electron-free so it's unit
 * testable without a display. The main process reads the saved size when
 * creating the panel and writes it back (debounced) as the user resizes, making
 * the panel "sticky" across opens and restarts.
 *
 * Stored as a tiny JSON `{ width, height }` file in the app's userData dir
 * rather than in `perch.json` — it's GUI-local UI state, not user-facing
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

/** Write `size` to `file` as JSON (clamped to the minimum). */
export function writeWindowSize(file: string, size: WindowSize): void {
  const clamped = clampToMinimum(size);
  writeFileSync(file, `${JSON.stringify(clamped, null, 2)}\n`, "utf8");
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
