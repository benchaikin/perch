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

/** Runtime services handed to a capability's `run`. Expanded in M1/M2. */
export interface CapabilityContext<Cfg = unknown> {
  config: Cfg;
  log: (message: string) => void;
  /** Cancellation signal, fulfilled by the daemon when a call is aborted
   *  (client disconnect, superseding refresh, shutdown). Optional so existing
   *  call sites and tests need not provide one. */
  signal?: AbortSignal;
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
};

export type ActionDef<I, Cfg> = {
  kind: "action";
  summary: string;
  input?: z.ZodType<I>;
  view?: ViewHint;
  expose?: Expose;
  run: (args: { input: I; ctx: CapabilityContext<Cfg> }) => Promise<void> | void;
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
export type Capability = ReadDef<any, any, any> | ActionDef<any, any>;

/** Declare a read (query) capability. */
export function read<I = void, O = unknown, Cfg = unknown>(
  def: Omit<ReadDef<I, O, Cfg>, "kind">,
): ReadDef<I, O, Cfg> {
  return { ...def, kind: "read" };
}

/** Declare an action (mutation) capability. */
export function action<I = void, Cfg = unknown>(
  def: Omit<ActionDef<I, Cfg>, "kind">,
): ActionDef<I, Cfg> {
  return { ...def, kind: "action" };
}

export type PluginDef<Cfg = unknown> = {
  id: string;
  config?: z.ZodType<Cfg>;
  capabilities: Record<string, Capability>;
};

/** Define a Perch plugin. */
export function definePlugin<Cfg = unknown>(def: PluginDef<Cfg>): PluginDef<Cfg> {
  return def;
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
