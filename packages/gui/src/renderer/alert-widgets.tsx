/**
 * Renderer-side AlertWidget registry.
 *
 * An {@link Alert} carries an opaque, plugin-defined `payload` (see core's
 * `alerts.ts`): only the plugin that raised it knows how to render it. So rather
 * than the dashboard interpreting payloads, each plugin registers an
 * {@link AlertWidget} — a React component that owns *all* of its alert's
 * rendering (icons, layout, buttons, copy) — keyed by its plugin id. The
 * dashboard resolves `alert.pluginId` → widget via {@link AlertWidgetRegistry.get}
 * and hands the widget the alert plus an {@link AlertWidgetProps.onDismiss}
 * callback.
 *
 * This lives in the renderer rather than the node-only plugin/SDK layer because
 * a widget is a React component, which can't cross the daemon's serializable RPC
 * boundary — unlike a plugin's capabilities, which the core {@link Registry}
 * indexes and projects over RPC. Plugins register their widget into the shared
 * {@link alertWidgets} instance at renderer module load; the dashboard reads
 * from the same instance. Tests construct their own {@link AlertWidgetRegistry}
 * so registrations don't leak across suites.
 */

/**
 * A plugin-raised alert as it reaches the renderer — the wire shape of core's
 * `Alert`. Duplicated here (rather than importing `@perch/core`) because the
 * renderer is a thin browser client that only knows the daemon's wire shapes,
 * not its node internals. `payload` stays `unknown`: it is opaque to the
 * dashboard and read only by the raising plugin's {@link AlertWidget}.
 */
export interface Alert {
  /** Stable, caller-chosen id (e.g. `services:perch:api-server:crashed`). */
  id: string;
  /** The plugin that raised the alert; the key its widget is registered under. */
  pluginId: string;
  /** Wall-clock time the alert was (re-)raised (ms since epoch). */
  raisedAt: number;
  /** Opaque, plugin-defined detail — only the plugin's own widget reads it. */
  payload: unknown;
}

/** What every {@link AlertWidget} receives from the dashboard. */
export interface AlertWidgetProps {
  /** The alert to render, with its opaque plugin-defined {@link Alert.payload}. */
  alert: Alert;
  /** Dismiss this alert (wired by the dashboard to the `alerts.dismiss` action). */
  onDismiss: () => void;
}

/**
 * A plugin-supplied React component that renders one of its own alerts in full.
 * The plugin owns every rendering choice — there is no schema imposed on the
 * payload and no shared chrome forced around the widget.
 */
export type AlertWidget = (props: AlertWidgetProps) => JSX.Element;

/**
 * Maps `pluginId` → the plugin's {@link AlertWidget}. The dashboard looks a
 * widget up by an alert's `pluginId`; a plugin with no registered widget simply
 * has its alerts rendered by the dashboard's fallback (resolved by the consumer,
 * not here — {@link get} returns `undefined`).
 */
export class AlertWidgetRegistry {
  readonly #byPluginId = new Map<string, AlertWidget>();

  /**
   * Register `pluginId`'s widget. Throws on a duplicate id — two widgets for one
   * plugin is a declaration mistake, surfaced eagerly the way the core
   * {@link Registry} rejects duplicate capability ids.
   */
  register(pluginId: string, widget: AlertWidget): void {
    if (this.#byPluginId.has(pluginId)) {
      throw new Error(`perch: duplicate AlertWidget for plugin ${JSON.stringify(pluginId)}`);
    }
    this.#byPluginId.set(pluginId, widget);
  }

  /** Resolve `pluginId`'s widget, or `undefined` when none is registered. */
  get(pluginId: string): AlertWidget | undefined {
    return this.#byPluginId.get(pluginId);
  }

  /** Whether `pluginId` has a registered widget. */
  has(pluginId: string): boolean {
    return this.#byPluginId.has(pluginId);
  }
}

/**
 * The renderer's shared registry. Plugins register into it at module load and
 * the dashboard resolves widgets from it, so the two sides meet without a direct
 * import. Tests should construct a fresh {@link AlertWidgetRegistry} instead of
 * mutating this singleton.
 */
export const alertWidgets = new AlertWidgetRegistry();
