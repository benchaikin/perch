/**
 * Capability registry.
 *
 * Ingests loaded {@link PluginDef}s and indexes every capability under its
 * canonical id `` `${pluginId}.${capName}` ``. Owns expose-resolution (the
 * projection-defaults logic lives here in core, not the SDK).
 */
import type { Capability, Expose, PluginDef, ViewHint } from "@perch/sdk";

/**
 * A capability indexed under its canonical id, paired with the plugin that
 * declared it. This is the registry's internal record; clients see
 * {@link CapabilityMeta} over RPC.
 */
export interface RegisteredCapability {
  /** Canonical id, `${pluginId}.${name}`. */
  id: string;
  /** Owning plugin id. */
  pluginId: string;
  /** Capability name within the plugin. */
  name: string;
  /** The capability definition from the plugin. */
  cap: Capability;
  /** Resolved expose flags (defaults applied). */
  expose: Required<Expose>;
}

/**
 * Serializable description of a capability, sent to clients via `registry.list`.
 * Contains no functions or zod schemas — only metadata frontends need to mount
 * and describe the capability.
 */
export interface CapabilityMeta {
  /** Canonical id, `${pluginId}.${name}`. */
  id: string;
  pluginId: string;
  name: string;
  kind: Capability["kind"];
  summary: string;
  /** Whether the capability declares an input schema. */
  hasInput: boolean;
  /** Whether the capability declares an output schema (reads only). */
  hasOutput: boolean;
  /** Refresh policy, if any (reads only). */
  refresh?: { every?: string; on?: Array<"focus" | "manual"> };
  /** GUI view hint, if any. */
  view?: ViewHint;
  /** Resolved expose flags after defaults. */
  expose: Required<Expose>;
}

/**
 * Resolve the surfaces a capability projects onto, applying core's defaults.
 *
 * Defaults:
 * - `cli`: `true`
 * - `mcp`: `false`
 * - `gui`: `true` for actions; for reads, `true` iff a `view` is declared.
 *
 * Any explicit field on `cap.expose` overrides the corresponding default.
 */
export function resolveExpose(cap: Capability): Required<Expose> {
  const guiDefault = cap.kind === "action" ? true : cap.view != null;
  const explicit = cap.expose ?? {};
  return {
    cli: explicit.cli ?? true,
    gui: explicit.gui ?? guiDefault,
    mcp: explicit.mcp ?? false,
  };
}

/** Derive the serializable {@link CapabilityMeta} for a registered capability. */
function toMeta(entry: RegisteredCapability): CapabilityMeta {
  const { cap } = entry;
  const refresh = cap.kind === "read" ? cap.refresh : undefined;
  return {
    id: entry.id,
    pluginId: entry.pluginId,
    name: entry.name,
    kind: cap.kind,
    summary: cap.summary,
    hasInput: cap.input != null,
    hasOutput: cap.kind === "read" && cap.output != null,
    refresh,
    view: cap.view,
    expose: entry.expose,
  };
}

/** In-memory index of all capabilities across loaded plugins. */
export class Registry {
  readonly #byId = new Map<string, RegisteredCapability>();

  /** Ingest a plugin's capabilities, indexing each under its canonical id. */
  register(plugin: PluginDef): void {
    for (const [name, cap] of Object.entries(plugin.capabilities)) {
      const id = `${plugin.id}.${name}`;
      if (this.#byId.has(id)) {
        throw new Error(`perchd: duplicate capability id ${JSON.stringify(id)}`);
      }
      this.#byId.set(id, {
        id,
        pluginId: plugin.id,
        name,
        cap,
        expose: resolveExpose(cap),
      });
    }
  }

  /**
   * Remove every capability owned by `pluginId` (runtime reload: a plugin was
   * disabled). Returns the canonical ids that were removed (empty if the plugin
   * had no registered capabilities). Safe to call for an unknown plugin.
   */
  unregister(pluginId: string): string[] {
    const removed: string[] = [];
    for (const [id, entry] of this.#byId) {
      if (entry.pluginId === pluginId) {
        this.#byId.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  /** The ids of every plugin with at least one registered capability. */
  pluginIds(): string[] {
    const ids = new Set<string>();
    for (const entry of this.#byId.values()) {
      ids.add(entry.pluginId);
    }
    return [...ids];
  }

  /** Registered capabilities owned by `pluginId` (empty if none). */
  byPlugin(pluginId: string): RegisteredCapability[] {
    return this.all().filter((entry) => entry.pluginId === pluginId);
  }

  /** Look up a registered capability by canonical id. */
  get(id: string): RegisteredCapability | undefined {
    return this.#byId.get(id);
  }

  /** All registered capabilities. */
  all(): RegisteredCapability[] {
    return [...this.#byId.values()];
  }

  /** Serializable metadata for every capability, for `registry.list`. */
  list(): CapabilityMeta[] {
    return this.all().map(toMeta);
  }
}
