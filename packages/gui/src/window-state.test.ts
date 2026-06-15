/**
 * Unit tests for the Electron-free window-size persistence. The Electron wiring
 * that calls these (resize/hide/close handlers, panel sizing) needs a display
 * and is verified by manual launch (see README); the read/write/clamp logic
 * here is the testable part.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  centeredPosition,
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  readActiveTab,
  readWindowSize,
  writeActiveTab,
  writeWindowSize,
} from "./window-state.js";

test("centeredPosition centers a window within a display work area", () => {
  // Primary display at origin.
  assert.deepEqual(
    centeredPosition({ x: 0, y: 0, width: 1440, height: 900 }, { width: 480, height: 420 }),
    {
      x: 480,
      y: 240,
    },
  );
  // A second display offset to the right uses its own origin → window lands there.
  assert.deepEqual(
    centeredPosition({ x: 1440, y: 0, width: 1920, height: 1080 }, { width: 480, height: 420 }),
    { x: 2160, y: 330 },
  );
});

/** Run `fn` against a fresh temp dir, cleaned up afterward. */
function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "perch-window-state-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("readWindowSize returns the default when the file is missing", () => {
  withTempDir((dir) => {
    assert.deepEqual(readWindowSize(join(dir, "absent.json")), DEFAULT_WINDOW_SIZE);
  });
});

test("writeWindowSize then readWindowSize round-trips a size", () => {
  withTempDir((dir) => {
    const file = join(dir, "window-state.json");
    const size = { width: 480, height: 360 };
    writeWindowSize(file, size);
    assert.deepEqual(readWindowSize(file), size);
  });
});

test("readWindowSize returns the default on corrupt JSON", () => {
  withTempDir((dir) => {
    const file = join(dir, "window-state.json");
    writeFileSync(file, "{ not valid json", "utf8");
    assert.deepEqual(readWindowSize(file), DEFAULT_WINDOW_SIZE);
  });
});

test("readWindowSize returns the default when dimensions are missing/invalid", () => {
  withTempDir((dir) => {
    const file = join(dir, "window-state.json");
    writeFileSync(file, JSON.stringify({ width: "wide", height: -5 }), "utf8");
    assert.deepEqual(readWindowSize(file), DEFAULT_WINDOW_SIZE);
  });
});

test("readWindowSize clamps a saved size below the minimum up to the minimum", () => {
  withTempDir((dir) => {
    const file = join(dir, "window-state.json");
    writeFileSync(file, JSON.stringify({ width: 100, height: 50 }), "utf8");
    assert.deepEqual(readWindowSize(file), MIN_WINDOW_SIZE);
  });
});

test("writeWindowSize clamps a too-small size before persisting", () => {
  withTempDir((dir) => {
    const file = join(dir, "window-state.json");
    writeWindowSize(file, { width: 10, height: 10 });
    assert.deepEqual(readWindowSize(file), MIN_WINDOW_SIZE);
  });
});

test("readActiveTab returns undefined when absent / invalid, else the id", () => {
  withTempDir((dir) => {
    const file = join(dir, "window-state.json");
    assert.equal(readActiveTab(join(dir, "absent.json")), undefined);
    writeFileSync(file, JSON.stringify({ width: 320, height: 320 }), "utf8");
    assert.equal(readActiveTab(file), undefined); // no activeTab key
    writeActiveTab(file, "dex.tasks");
    assert.equal(readActiveTab(file), "dex.tasks");
  });
});

test("size and active-tab writers preserve each other (no clobbering)", () => {
  withTempDir((dir) => {
    const file = join(dir, "window-state.json");
    writeWindowSize(file, { width: 480, height: 360 });
    writeActiveTab(file, "services.list");
    // Writing the tab kept the size...
    assert.deepEqual(readWindowSize(file), { width: 480, height: 360 });
    assert.equal(readActiveTab(file), "services.list");
    // ...and writing a new size keeps the tab.
    writeWindowSize(file, { width: 500, height: 400 });
    assert.equal(readActiveTab(file), "services.list");
    assert.deepEqual(readWindowSize(file), { width: 500, height: 400 });
  });
});
