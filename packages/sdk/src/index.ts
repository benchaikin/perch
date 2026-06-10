/**
 * @perch/sdk — the plugin authoring contract.
 *
 * A plugin declares **capabilities** (reads + actions) once; the core projects
 * each onto the surfaces it opts into. Defaults: CLI always on, GUI on if a
 * view/button is declared, MCP off.
 *
 * NOTE (M0 skeleton): these are the stable type signatures M1 (daemon/registry)
 * and M2 (full SDK) build against. M2 fleshes out expose-resolution, the `ctx`
 * service surface, and runtime input/output validation.
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

export type Capability = ReadDef<unknown, unknown, unknown> | ActionDef<unknown, unknown>;

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

/** Re-exported so plugin authors don't depend on zod directly. */
export { z };
