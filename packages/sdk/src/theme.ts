/**
 * Shared GUI theme preference — the cross-plugin `global.theme` setting that
 * forces the app's color scheme to System / Light / Dark, overriding the OS
 * `prefers-color-scheme`. The GUI main process maps the stored string onto
 * Electron's `nativeTheme.themeSource`; "system" (the default) tracks the OS
 * live, exactly as the app behaved before this setting existed.
 */
import type { SettingsField } from "./index.js";

/** The theme-mode values — they mirror Electron's `nativeTheme.themeSource`. */
export type ThemeMode = "system" | "light" | "dark";

/** The default theme mode — "system", preserving the OS-tracking behavior. */
export const THEME_DEFAULT: ThemeMode = "system";

/**
 * The settings field the "General" tab renders for the theme preference. Keyed
 * under `theme` (the General tab writes the chosen value to `global.theme`).
 */
export const THEME_SETTINGS_FIELDS: SettingsField[] = [
  {
    key: "theme",
    type: "enum",
    label: "Theme",
    description:
      "The color scheme for every Perch window. System follows your OS appearance; " +
      "Light and Dark force that scheme regardless of the OS setting.",
    default: THEME_DEFAULT,
    options: [
      { value: "system", label: "System" },
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ],
  },
];

/** Map a config `global` section to a {@link ThemeMode}; default on miss/unknown. */
export function themeModeOf(global: unknown): ThemeMode {
  const g = global && typeof global === "object" ? (global as Record<string, unknown>) : {};
  const value = g.theme;
  return value === "light" || value === "dark" || value === "system" ? value : THEME_DEFAULT;
}
