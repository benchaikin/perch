/**
 * The canonical model + permission-mode CHOICES a Perch-spawned agent can launch
 * with — the single source of truth shared by three surfaces: the General-tab
 * settings descriptor ({@link AGENT_SETTINGS_FIELDS} in `terminal.ts`), the
 * shell-side whitelist that guards `exec claude --model …` ({@link resolveAgentModel}),
 * and the new-task dialog's per-spawn model `<select>` in the GUI renderer. So the
 * three never drift, they all read these lists.
 *
 * This module is deliberately node-free (only a type-only import, fully erased at
 * build) so the browser renderer can import it via the `@perch/sdk/agent-options`
 * subpath without pulling in `terminal.ts`'s `node:child_process` dependency —
 * the same pattern `dex-color.ts` uses.
 */
import type { SettingsFieldOption } from "./index.js";

/**
 * The sentinel `agent.model` value meaning "inherit the user's own Claude
 * config" — the default option in {@link AGENT_MODEL_OPTIONS}. When this (or any
 * value outside the whitelist) is resolved, the launcher emits NO `--model` flag,
 * leaving model selection to Claude's own config.
 */
export const AGENT_MODEL_DEFAULT = "";

/**
 * The model choices a spawned agent can launch with. The empty-value entry is the
 * "inherit Claude config" sentinel ({@link AGENT_MODEL_DEFAULT}); the rest are
 * documented `claude --model` aliases. Values are WHITELISTED before reaching the
 * shell (see `resolveAgentModel`).
 */
export const AGENT_MODEL_OPTIONS: SettingsFieldOption[] = [
  { value: AGENT_MODEL_DEFAULT, label: "Use default (inherit Claude config)" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
  { value: "fable", label: "Fable" },
];

/** The default `agent.permissionMode` — preserves today's spawn behavior. */
export const AGENT_PERMISSION_MODE_DEFAULT = "auto";

/**
 * The permission-mode choices, matching `claude --permission-mode`'s accepted
 * values. Whitelisted before reaching the shell (see `resolveAgentPermissionMode`);
 * an unset/unknown value falls back to {@link AGENT_PERMISSION_MODE_DEFAULT}.
 */
export const AGENT_PERMISSION_MODE_OPTIONS: SettingsFieldOption[] = [
  { value: "auto", label: "Auto" },
  { value: "plan", label: "Plan" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "default", label: "Default (ask)" },
  { value: "dontAsk", label: "Don't ask" },
  { value: "bypassPermissions", label: "Bypass permissions" },
];
