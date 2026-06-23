/**
 * The cross-plugin GUI theme preference — System / Light / Dark — stored at the
 * top-level `global.theme`. The GUI's Electron main process maps it onto
 * `nativeTheme.themeSource`, which forces `prefers-color-scheme` for every
 * renderer; the centralized Nord tokens (theme.css) then resolve under the
 * chosen mode. "System" keeps the default behavior: track the OS appearance live.
 *
 * Kept in the SDK so the descriptor (the General-tab field) and the value
 * resolver ({@link themeSourceOf}) never drift, mirroring the terminal/agent
 * global settings.
 */
import type { SettingsField } from "./index.js";

/** The theme modes, which double as the `nativeTheme.themeSource` values. */
export type ThemeSource = "system" | "light" | "dark";

/** Default theme — "system", preserving today's OS-following behavior. */
export const THEME_DEFAULT: ThemeSource = "system";

/**
 * The General-tab field for the theme preference. Keyed `theme` (a flat key), so
 * the General tab persists it straight to `global.theme`.
 */
export const THEME_SETTINGS_FIELDS: SettingsField[] = [
  {
    key: "theme",
    type: "enum",
    label: "Theme",
    description:
      "The appearance of every Perch window. System follows your OS setting (and " +
      "switches live with it); Light or Dark forces that mode regardless of the OS.",
    default: THEME_DEFAULT,
    options: [
      { value: "system", label: "System" },
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ],
  },
];

/**
 * Resolve the `nativeTheme.themeSource` value from a parsed config's `global`
 * section. Missing/unknown → "system" (back-compat: existing perch.json has no
 * theme key).
 */
export function themeSourceOf(global: unknown): ThemeSource {
  const g = global && typeof global === "object" ? (global as Record<string, unknown>) : {};
  return g.theme === "light" || g.theme === "dark" ? g.theme : "system";
}
