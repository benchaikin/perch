/**
 * Unit tests for the Electron-free per-plugin settings logic. The Settings
 * window's Electron wiring (window, IPC, `settings.describe` / `config.update`
 * RPCs, DOM controls) needs a display + a daemon and is verified by manual
 * launch; the pure transforms here — value coercion and the `config.update`
 * patch builder (including nested dotted keys) — are the testable part.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildConfigPatch,
  buildGlobalConfigPatch,
  coerceFieldValue,
  coerceListValue,
} from "./settings-fields.js";

test("coerceFieldValue: boolean passes a real boolean through", () => {
  assert.equal(coerceFieldValue("boolean", true), true);
  assert.equal(coerceFieldValue("boolean", false), false);
});

test("coerceFieldValue: boolean reads checkbox-style strings as truthy", () => {
  assert.equal(coerceFieldValue("boolean", "true"), true);
  assert.equal(coerceFieldValue("boolean", "on"), true);
  assert.equal(coerceFieldValue("boolean", "false"), false);
  assert.equal(coerceFieldValue("boolean", ""), false);
});

test("coerceFieldValue: number parses a numeric string to a finite number", () => {
  assert.equal(coerceFieldValue("number", "42"), 42);
  assert.equal(coerceFieldValue("number", " 3.5 "), 3.5);
  assert.equal(coerceFieldValue("number", -7), -7);
  assert.equal(coerceFieldValue("number", "0"), 0);
});

test("coerceFieldValue: number yields undefined for blank/invalid (skip the write)", () => {
  assert.equal(coerceFieldValue("number", ""), undefined);
  assert.equal(coerceFieldValue("number", "   "), undefined);
  assert.equal(coerceFieldValue("number", "abc"), undefined);
});

test("coerceFieldValue: enum/string stringify the value", () => {
  assert.equal(coerceFieldValue("enum", "down"), "down");
  assert.equal(coerceFieldValue("string", "hello"), "hello");
  assert.equal(coerceFieldValue("string", 12), "12");
  assert.equal(coerceFieldValue("string", null), "");
  assert.equal(coerceFieldValue("enum", undefined), "");
});

test("coerceFieldValue: list trims entries and drops blanks", () => {
  assert.deepEqual(coerceFieldValue("list", ["/a", "  /b  ", "", "   "]), ["/a", "/b"]);
});

test("coerceFieldValue: list on a non-array (or unset) yields []", () => {
  assert.deepEqual(coerceFieldValue("list", undefined), []);
  assert.deepEqual(coerceFieldValue("list", "nope"), []);
});

test("coerceListValue: stringifies entries, trims, and drops blanks", () => {
  assert.deepEqual(coerceListValue(["/a", "  /b  ", 12, null, "  "]), ["/a", "/b", "12"]);
  assert.deepEqual(coerceListValue([]), []);
  assert.deepEqual(coerceListValue("nope"), []);
});

test("buildGlobalConfigPatch: sets an array value at global.{key}", () => {
  assert.deepEqual(buildGlobalConfigPatch("repos", ["/a", "/b"]), {
    global: { repos: ["/a", "/b"] },
  });
});

test("buildConfigPatch: a flat key nests under plugins[pluginId]", () => {
  assert.deepEqual(buildConfigPatch("stack", "stackDirection", "up"), {
    plugins: { stack: { stackDirection: "up" } },
  });
});

test("buildConfigPatch: a dotted key expands into nested objects", () => {
  assert.deepEqual(buildConfigPatch("stack", "render.direction", "up"), {
    plugins: { stack: { render: { direction: "up" } } },
  });
});

test("buildConfigPatch: a deeply dotted key nests all the way down", () => {
  assert.deepEqual(buildConfigPatch("p", "a.b.c", 3), {
    plugins: { p: { a: { b: { c: 3 } } } },
  });
});

test("buildConfigPatch: preserves boolean / number / array leaf values", () => {
  assert.deepEqual(buildConfigPatch("p", "flag", false), {
    plugins: { p: { flag: false } },
  });
  assert.deepEqual(buildConfigPatch("p", "n", 0), { plugins: { p: { n: 0 } } });
  assert.deepEqual(buildConfigPatch("p", "list", [1, 2]), {
    plugins: { p: { list: [1, 2] } },
  });
});

test("buildConfigPatch: tolerates stray dots in the key path", () => {
  assert.deepEqual(buildConfigPatch("p", ".a.b.", "v"), {
    plugins: { p: { a: { b: "v" } } },
  });
});

test("buildConfigPatch: throws on an empty key", () => {
  assert.throws(() => buildConfigPatch("p", "", "v"), /non-empty/);
  assert.throws(() => buildConfigPatch("p", "...", "v"), /non-empty/);
});
