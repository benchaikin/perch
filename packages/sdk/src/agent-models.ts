/**
 * The canonical agent-model choices, kept in a dependency-free module (no
 * `node:*` imports) so the browser renderer can pull the list via the
 * `@perch/sdk/agent-models` subpath without dragging the node-only terminal
 * launcher into its bundle — the same split {@link ./dex-color} uses.
 *
 * {@link ./terminal} re-exports these and whitelists against them; the GUI's
 * Settings descriptor and the dex new-task dialog render from the SAME list, so
 * the choices can never drift between where they're offered and where they're
 * validated.
 */
import type { SettingsFieldOption } from "./index.js";

/**
 * The empty sentinel meaning "emit no `--model`" — the spawned `claude` inherits
 * whatever model the user's own Claude config defaults to. The default choice in
 * {@link AGENT_MODEL_OPTIONS} so today's behavior (no `--model`) is preserved.
 */
export const AGENT_MODEL_DEFAULT = "";

/**
 * The canonical model choices for a spawned agent — the documented `claude --model`
 * aliases (the CLI accepts these or a full model id; we offer the stable aliases).
 * Shared so Settings and the new-task dialog pick from the exact same list, and so
 * `buildAgentLaunchCommand` can whitelist against it. The empty sentinel
 * ({@link AGENT_MODEL_DEFAULT}) emits no flag.
 */
export const AGENT_MODEL_OPTIONS: SettingsFieldOption[] = [
  { value: AGENT_MODEL_DEFAULT, label: "Use default (inherit Claude config)" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
  { value: "fable", label: "Fable" },
];
