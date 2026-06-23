/**
 * The "global" (cross-plugin) settings descriptor — the fields the GUI's
 * General tab renders, edited into perch.json's top-level `global` section
 * (rather than any `plugins[id]`). Today that's just the shared terminal
 * preference (defined in `@perch/sdk`); more global settings slot in here.
 */
import {
  AGENT_SETTINGS_FIELDS,
  TERMINAL_SETTINGS_FIELDS,
  THEME_SETTINGS_FIELDS,
  type SettingsField,
} from "@perch/sdk";

/**
 * Reserved descriptor id for the global section. Not a real plugin — the GUI
 * pins it as the "General" tab and routes its writes to `global.*` instead of
 * `plugins[id].*`.
 */
export const GLOBAL_SETTINGS_ID = "__global__";

/** Friendly name for the General tab. */
export const GLOBAL_SETTINGS_NAME = "General";

/** The ordered fields shown on the General tab (keyed under `global.*`). */
export function globalSettingsFields(): SettingsField[] {
  return [
    {
      key: "repos",
      type: "list",
      label: "Repositories",
      description:
        "Local repo directories Perch watches (shared by the PRs, Worktrees, and Dex panels).",
    },
    ...THEME_SETTINGS_FIELDS,
    ...TERMINAL_SETTINGS_FIELDS,
    ...AGENT_SETTINGS_FIELDS,
  ];
}
