/**
 * @perch/sdk — the plugin authoring contract.
 *
 * A plugin declares **capabilities** (reads + actions) once; the core projects
 * each onto the surfaces it opts into. Defaults: CLI always on, GUI on if a
 * view/button is declared, MCP off.
 *
 * This module is the authoring contract: type definitions, the `read`/`action`/
 * `definePlugin` constructors, and runtime validation helpers. Expose-resolution
 * (computing those defaults) lives in `@perch/core`, which owns the projection.
 */
import { z } from "zod";

/** How often a read's data should be refreshed. */
export type RefreshPolicy = {
  /** Poll interval, e.g. "60s", "5m". */
  every?: string;
  /**
   * Slower poll interval used when only a persistent (notify-driven) interest
   * holds the poller open — i.e. no GUI client is subscribed (panel closed or
   * hidden). The daemon swaps back to {@link every} the moment a client
   * subscribes. Omit to keep one interval regardless of subscribers.
   */
  idleEvery?: string;
  /** Event triggers that force a refresh. */
  on?: Array<"focus" | "manual">;
};

/** Which surfaces a capability projects onto. Unset fields fall back to the
 *  core's computed defaults (CLI: true; GUI: true iff a view exists; MCP: false). */
export type Expose = {
  cli?: boolean;
  gui?: boolean;
  mcp?: boolean;
};

/** A hint to the GUI for how to render a read. Refined per-widget in M5. */
export type ViewHint = {
  kind: "list" | "graph" | "custom";
  title?: string;
} & Record<string, unknown>;

/** Severity of a notification, used by surfaces for styling/iconography. */
export type NotificationLevel = "info" | "success" | "warning" | "error";

/**
 * A notification a read emits when its data changes. Produced by a read's
 * {@link ReadDef.notify} hook and routed by the daemon to its sinks (the GUI,
 * desktop notifications, etc.).
 */
export interface Notification {
  /** Short headline. */
  title: string;
  /** Optional longer detail. */
  body?: string;
  /** Severity hint for the surface. Defaults to `"info"` when unset. */
  level?: NotificationLevel;
  /**
   * Optional stable key for de-duplication. The daemon suppresses a repeat of
   * the same `dedupeKey` within a short window; notifications without a
   * `dedupeKey` always pass through.
   */
  dedupeKey?: string;
  /** Optional URL a surface may open when the notification is activated. */
  openUrl?: string;
}

/** Runtime services handed to a capability's `run`. Expanded in M1/M2. */
export interface CapabilityContext<Cfg = unknown> {
  config: Cfg;
  log: (message: string) => void;
  /** Cancellation signal, fulfilled by the daemon when a call is aborted
   *  (client disconnect, superseding refresh, shutdown). Optional so existing
   *  call sites and tests need not provide one. */
  signal?: AbortSignal;
  /**
   * Cross-plugin "global" settings from `perch.json`'s `global` section (opaque
   * to core). Optional and `unknown`: a plugin that wants it narrows with its own
   * zod schema, exactly as it does {@link config}. Undefined when none is set.
   */
  global?: unknown;
}

export type ReadDef<I, O, Cfg> = {
  kind: "read";
  summary: string;
  input?: z.ZodType<I>;
  output?: z.ZodType<O>;
  refresh?: RefreshPolicy;
  view?: ViewHint;
  expose?: Expose;
  run: (args: { input: I; ctx: CapabilityContext<Cfg> }) => Promise<O> | O;
  /**
   * Optional change-detection hook. After each successful poll the daemon calls
   * `notify` with the previous cached output (`prev`) and the fresh output
   * (`next`), and routes the returned notifications to its sinks. Diff `next`
   * against `prev` to decide what (if anything) to announce.
   *
   * `prev` is `undefined` on the very first poll (nothing cached yet); return
   * `[]` in that case so an initial load doesn't spam notifications. May be sync
   * or async; a throw/rejection is caught by the daemon and does not break
   * polling.
   */
  notify?: (args: {
    prev: O | undefined;
    next: O;
    ctx: CapabilityContext<Cfg>;
  }) => Notification[] | Promise<Notification[]>;
};

export type ActionDef<I, Cfg, R = void> = {
  kind: "action";
  summary: string;
  input?: z.ZodType<I>;
  view?: ViewHint;
  expose?: Expose;
  /**
   * Read capability ids to refresh immediately after this action succeeds. The
   * daemon pokes each (an out-of-band poll) so a read that depends on this
   * mutation's outcome updates in seconds rather than waiting for its next timer
   * tick. Declarative and co-located with the action so the action→read
   * relationship lives in one place. Unknown ids and reads with no active poller
   * are simply ignored.
   */
  invalidates?: string[];
  /** May return a small result (e.g. an outcome) for clients to surface. */
  run: (args: { input: I; ctx: CapabilityContext<Cfg> }) => Promise<R> | R;
};

/**
 * A capability of any input/output/config shape — the type used wherever
 * capabilities are stored heterogeneously (the `capabilities` map, the registry).
 *
 * The `any` parameters are deliberate and load-bearing: precisely-typed
 * `read`/`action` definitions only co-exist in one `Record` without per-entry
 * casts when the element type is bivariant. `unknown` fails under strict
 * function-parameter variance — a `run` taking a concrete input is not
 * assignable to one taking `unknown`. The `read`/`action` constructors below
 * stay fully precise, so authoring keeps complete type-safety.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Capability = ReadDef<any, any, any> | ActionDef<any, any, any>;

/** Declare a read (query) capability. */
export function read<I = void, O = unknown, Cfg = unknown>(
  def: Omit<ReadDef<I, O, Cfg>, "kind">,
): ReadDef<I, O, Cfg> {
  return { ...def, kind: "read" };
}

/** Declare an action (mutation) capability. */
export function action<I = void, Cfg = unknown, R = void>(
  def: Omit<ActionDef<I, Cfg, R>, "kind">,
): ActionDef<I, Cfg, R> {
  return { ...def, kind: "action" };
}

/**
 * The kinds of user-facing setting a plugin can declare. Starts small; widen as
 * surfaces learn to render more controls. Each maps to a primitive the GUI knows
 * how to edit (a select, a checkbox, a text input, a number input, or — for
 * `"list"` — an editable list of text rows whose value is a `string[]`).
 */
export type SettingsFieldType = "enum" | "boolean" | "string" | "number" | "list";

/** One selectable choice for an `"enum"` field: the stored `value` + its `label`. */
export interface SettingsFieldOption {
  /** The value written to config when this option is chosen. */
  value: string;
  /** Human-readable label shown in the UI. */
  label: string;
}

/**
 * A single user-facing setting a plugin exposes. This is **metadata describing
 * the plugin's existing config** — it does not replace the plugin's `config` zod
 * schema; it tells a generic UI how to render and edit one slice of it.
 */
export interface SettingsField {
  /**
   * The config path within `plugins[id]` this field reads/writes, e.g.
   * `"stackDirection"`. Dotted paths address nested keys (`"a.b"`).
   */
  key: string;
  /** Which control to render. */
  type: SettingsFieldType;
  /** Short label shown next to the control. */
  label: string;
  /** Optional longer help text. */
  description?: string;
  /** Value used when the config has nothing set at `key`. */
  default?: unknown;
  /** Choices for an `"enum"` field; required when `type` is `"enum"`. */
  options?: SettingsFieldOption[];
  /**
   * Optional conditional-visibility rule: render this field only when the sibling
   * field at `key` (within the same descriptor) currently equals `equals`. Lets a
   * plugin reveal a dependent control (e.g. a free-text "Custom" command) only when
   * a controlling enum is set to a particular value. Generic — any plugin can use
   * it. The compared value is the controlling field's resolved current value (its
   * `default` when unset).
   */
  showWhen?: { key: string; equals: string };
}

/** An ordered list of {@link SettingsField}s a plugin exposes for editing. */
export type SettingsDescriptor = SettingsField[];

export type PluginDef<Cfg = unknown> = {
  id: string;
  /** Optional human-readable display name; surfaces fall back to {@link id}. */
  name?: string;
  config?: z.ZodType<Cfg>;
  capabilities: Record<string, Capability>;
  /**
   * Optional user-facing settings descriptor: an ordered list of fields a
   * generic UI can render to edit this plugin's config (see {@link SettingsField}).
   * Purely additive metadata — the authoritative validation stays in {@link config}.
   */
  settings?: SettingsDescriptor;
};

/** Define a Perch plugin. */
export function definePlugin<Cfg = unknown>(def: PluginDef<Cfg>): PluginDef<Cfg> {
  return def;
}

/**
 * Validate a {@link SettingsDescriptor}'s structural invariants, throwing on the
 * first problem. Checks: unique non-empty `key`s, and that every `"enum"` field
 * carries a non-empty `options` array. Returns the descriptor unchanged so it can
 * be used inline. Mirrors the `parse*` helpers: a thin, throwing guard surfaces
 * declaration mistakes early rather than at render time.
 */
export function validateSettingsDescriptor(descriptor: SettingsDescriptor): SettingsDescriptor {
  const seen = new Set<string>();
  for (const field of descriptor) {
    if (!field.key) {
      throw new Error("perch: settings field is missing a `key`");
    }
    if (seen.has(field.key)) {
      throw new Error(`perch: duplicate settings field key ${JSON.stringify(field.key)}`);
    }
    seen.add(field.key);
    if (field.type === "enum" && (!field.options || field.options.length === 0)) {
      throw new Error(
        `perch: enum settings field ${JSON.stringify(field.key)} requires non-empty \`options\``,
      );
    }
  }
  return descriptor;
}

/** The canonical registry id for a capability: `${pluginId}.${capName}`. */
export type CapabilityId = string;

/** Build the canonical registry id for a capability. */
export function capabilityId(pluginId: string, capName: string): CapabilityId {
  return `${pluginId}.${capName}`;
}

/**
 * Validate `raw` against a capability's `input` schema if present, otherwise
 * pass it through unchanged. Lets zod throw on validation failure.
 *
 * Accepts any capability shape carrying an optional `input` schema (reads and
 * actions of any `I`); the result type follows the schema when known.
 */
export function parseInput<I>(cap: { input?: z.ZodType<I> }, raw: unknown): I {
  if (cap.input) {
    return cap.input.parse(raw);
  }
  return raw as I;
}

/**
 * Validate a read's produced `value` against its `output` schema if present,
 * otherwise pass it through unchanged. Actions declare no `output`, so this is
 * a pass-through for them. Lets zod throw on validation failure.
 */
export function parseOutput<O>(cap: { output?: z.ZodType<O> }, value: unknown): O {
  if (cap.output) {
    return cap.output.parse(value);
  }
  return value as O;
}

/**
 * Validate a plugin's `raw` config against its `config` schema if present,
 * otherwise pass it through unchanged. Lets zod throw on validation failure.
 */
export function parseConfig<Cfg>(plugin: { config?: z.ZodType<Cfg> }, raw: unknown): Cfg {
  if (plugin.config) {
    return plugin.config.parse(raw);
  }
  return raw as Cfg;
}

const REFRESH_UNITS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
} as const;

/**
 * Convert a refresh interval string (e.g. "500ms", "60s", "5m", "2h") to
 * milliseconds. Throws on malformed input. The unit suffix is required;
 * `ms` is matched before `s` so it is never misread as seconds.
 */
export function parseRefreshInterval(every: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(every);
  if (!match) {
    throw new Error(
      `Invalid refresh interval: ${JSON.stringify(every)} (expected e.g. "500ms", "60s", "5m", "2h")`,
    );
  }
  const value = Number(match[1]);
  const unit = match[2] as keyof typeof REFRESH_UNITS;
  return value * REFRESH_UNITS[unit];
}

/** Re-exported so plugin authors don't depend on zod directly. */
export { z };

/** Shared repo list + the cross-plugin `global.repos` setting. */
export { GlobalReposConfig, reposOf } from "./repos.js";

/**
 * Shared dex-task identity colors (stable id → color). Also published as the
 * dependency-free `@perch/sdk/dex-color` subpath, so the browser renderer can
 * import it without pulling the node-only parts of this index into its bundle.
 */
export {
  DEX_TASK_PALETTE,
  dexTaskColor,
  dexTaskColorCss,
  dexTaskColorRgb,
  type DexRgb,
  type DexTaskColor,
} from "./dex-color.js";

/** Shared terminal launcher + the cross-plugin terminal setting. */
export {
  AGENT_MODEL_DEFAULT,
  AGENT_MODEL_OPTIONS,
  AGENT_PERMISSION_MODE_DEFAULT,
  AGENT_PERMISSION_MODE_OPTIONS,
  AGENT_SETTINGS_FIELDS,
  agentConfigOf,
  applyTemplate,
  buildAgentLaunchCommand,
  DEFAULT_TERMINAL,
  focusableApp,
  FOCUS_OR_SPAWN_TEMPLATES,
  focusTitleLiteral,
  GlobalAgentConfig,
  GlobalTerminalConfig,
  resolveSpawnTemplate,
  resolveTabColorCommand,
  resolveTerminalTemplate,
  resolveTitleCommand,
  shellQuote,
  spawnInTerminal,
  TERMINAL_APP_TEMPLATES,
  TERMINAL_SETTINGS_FIELDS,
  TERMINAL_TAB_COLOR,
  TERMINAL_TITLE,
  terminalConfigOf,
  type SpawnInTerminalOptions,
  type TerminalApp,
} from "./terminal.js";
