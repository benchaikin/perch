/**
 * Electron-free logic for the Settings window's schema-driven per-plugin forms.
 *
 * A plugin declares an ordered list of {@link SettingsField}s (via `@perch/sdk`),
 * and the daemon's `settings.describe` RPC returns those fields plus each field's
 * current value. The Settings window auto-renders one control per field; when the
 * user changes a control it writes back through `config.update` with a patch
 * deep-merged into `plugins[pluginId]`.
 *
 * This module holds the two pure transforms that are worth unit-testing without a
 * display:
 *
 *   - {@link coerceFieldValue}: turn a raw control value (a checkbox's boolean, a
 *     number input's string) into the typed value to persist.
 *   - {@link buildConfigPatch}: build the `{ plugins: { [id]: { …nested } } }`
 *     patch for `config.update` from a (pluginId, dotted-key, value), expanding a
 *     dotted `key` into nested objects.
 */
import type { SettingsFieldType } from "@perch/sdk";

/**
 * Coerce a raw control value into the typed value to persist for a field of the
 * given `type`:
 *
 *   - `boolean` → a real boolean (a checkbox's `checked`, or a truthy string).
 *   - `number`  → a finite number; a blank/invalid input yields `undefined` so the
 *     caller can skip the write rather than persist `NaN`.
 *   - `enum`/`string` → the value as a string.
 */
export function coerceFieldValue(type: SettingsFieldType, raw: unknown): unknown {
  switch (type) {
    case "boolean":
      return typeof raw === "boolean" ? raw : raw === "true" || raw === "on";
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      return String(raw).trim() === "" || !Number.isFinite(n) ? undefined : n;
    }
    case "enum":
    case "string":
      return raw == null ? "" : String(raw);
  }
}

/**
 * Build a `config.update` patch that sets `value` at `plugins[pluginId].{key}`,
 * where `key` may be a dotted path (`"a.b.c"`) addressing nested keys.
 *
 * Example: `buildConfigPatch("stack", "render.direction", "up")` →
 * `{ plugins: { stack: { render: { direction: "up" } } } }`.
 *
 * The daemon deep-merges the patch, so only the touched leaf is changed. Empty
 * `key` segments are dropped (a stray leading/trailing dot is tolerated).
 */
export function buildConfigPatch(
  pluginId: string,
  key: string,
  value: unknown,
): { plugins: Record<string, Record<string, unknown>> } {
  const segments = key.split(".").filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new Error(`settings field key must be non-empty (plugin "${pluginId}")`);
  }

  // Build the nested object from the leaf up: { last: value } then wrap outward.
  let nested: unknown = value;
  for (let i = segments.length - 1; i >= 0; i--) {
    nested = { [segments[i]!]: nested };
  }

  return { plugins: { [pluginId]: nested as Record<string, unknown> } };
}
