/**
 * The dashboard alert bar: renders the pushed {@link AlertView}s (newest first)
 * above the active pane, each through its plugin's registered {@link AlertWidget}.
 *
 * The bar is plugin-agnostic — it resolves `alert.pluginId` to a widget via the
 * shared {@link alertWidgets} registry and hands it the alert plus a dismiss
 * callback wired to the `alerts.dismiss` action. An alert whose plugin has no
 * registered widget is skipped (it can't be rendered). Importing this module also
 * pulls in the bundled plugin widgets (the stack widget) for their registration
 * side effect, so they're available the moment the bar mounts.
 */
import type { AlertView } from "../panel-state.js";
import { alertWidgets } from "./alert-widgets.js";
import { useActions } from "./actions.js";
// Side-effect import: registers the stack plugin's widget into `alertWidgets`.
import "./stack-alert-widget.js";

/**
 * The alert bar. Renders nothing (no wrapper) when there are no renderable alerts,
 * so the panel layout is unchanged when the dashboard is clean.
 */
export function AlertsBar({ alerts }: { alerts: AlertView[] }): JSX.Element | null {
  const actions = useActions();
  const renderable = alerts.filter((a) => alertWidgets.has(a.pluginId));
  if (renderable.length === 0) return null;

  return (
    <div className="alerts-bar">
      {renderable.map((alert) => {
        const Widget = alertWidgets.get(alert.pluginId)!;
        return (
          <Widget
            key={alert.id}
            alert={alert}
            onDismiss={() => void actions.dismissAlert(alert.id)}
          />
        );
      })}
    </div>
  );
}
