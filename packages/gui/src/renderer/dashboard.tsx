/**
 * The Dashboard pane: a dumb host for plugin-raised alerts. It polls `alerts.list`
 * on an interval, sorts the result newest-first, and routes each alert to its
 * plugin's registered {@link AlertWidget} (resolved by `pluginId` from the shared
 * {@link alertWidgets} registry), handing the widget an `onDismiss` wired to the
 * `alerts.dismiss` IPC.
 *
 * It is deliberately ignorant of every plugin's alert shape: an {@link Alert}'s
 * `payload` is `unknown` here and only the resolving widget reads it. A plugin
 * with no registered widget falls back to {@link UnregisteredAlert} — a bare,
 * payload-agnostic row — so an alert is never silently dropped and stays
 * dismissable.
 *
 * Unlike the other panes (which read the main-process-derived `PanelState`), this
 * one owns its own polling: keeping the plugin-opaque payload out of the
 * `PanelState` builder is the whole point of resolving widgets renderer-side.
 */
import { useEffect, useState } from "react";
import { alertWidgets, type Alert } from "./alert-widgets.js";
import { useActions } from "./actions.js";
import { Loading, Message } from "./components.js";

/** How often the pane re-polls `alerts.list` while it's mounted (the active tab). */
const POLL_INTERVAL_MS = 5_000;

/** Newest-first by `raisedAt` — the only ordering the dashboard imposes. */
function byRaisedAtDesc(a: Alert, b: Alert): number {
  return b.raisedAt - a.raisedAt;
}

/**
 * Poll `alerts.list` every `pollMs` (and once immediately on mount), exposing the
 * sorted alerts plus a `dismiss`. `alerts` is `undefined` until the first poll
 * resolves (render a spinner), then an array (possibly empty). `dismiss` removes
 * the alert optimistically so it disappears at once, then fires the `alerts.dismiss`
 * IPC; the next poll reconciles either outcome.
 */
function useAlerts(pollMs: number): {
  alerts: Alert[] | undefined;
  dismiss: (id: string) => void;
} {
  const actions = useActions();
  const [alerts, setAlerts] = useState<Alert[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    async function poll(): Promise<void> {
      try {
        const next = await actions.alertsList();
        if (!cancelled) setAlerts([...next].sort(byRaisedAtDesc));
      } catch {
        // Best-effort: keep the last good list, or fall to empty on the first
        // failure so we leave the loading state. The next tick retries.
        if (!cancelled) setAlerts((prev) => prev ?? []);
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [actions, pollMs]);

  function dismiss(id: string): void {
    setAlerts((prev) => prev?.filter((alert) => alert.id !== id));
    void actions.alertsDismiss(id);
  }

  return { alerts, dismiss };
}

/**
 * The dashboard's fallback for an alert whose plugin registered no widget. Stays a
 * dumb host — it shows the alert's id and raising plugin (never its opaque
 * payload) and offers a dismiss control, so an unrendered alert is still visible
 * and clearable rather than lost.
 */
function UnregisteredAlert({
  alert,
  onDismiss,
}: {
  alert: Alert;
  onDismiss: () => void;
}): JSX.Element {
  return (
    <div className="row alert-fallback" title={`${alert.id} — no widget for ${alert.pluginId}`}>
      <i className="fa-solid fa-bell" />
      <span className="branch">{alert.id}</span>
      <span className="alert-fallback-plugin">{alert.pluginId}</span>
      <button
        className="btn btn-sm"
        title="Dismiss"
        aria-label={`Dismiss ${alert.id}`}
        onClick={onDismiss}
      >
        <i className="fa-solid fa-xmark" />
      </button>
    </div>
  );
}

/** Route one alert to its plugin's widget, or the fallback when none is registered. */
function AlertCard({ alert, onDismiss }: { alert: Alert; onDismiss: () => void }): JSX.Element {
  const Widget = alertWidgets.get(alert.pluginId);
  if (Widget) return <Widget alert={alert} onDismiss={onDismiss} />;
  return <UnregisteredAlert alert={alert} onDismiss={onDismiss} />;
}

/**
 * The Dashboard pane the panel body renders for the Dashboard tab. Polls alerts,
 * shows a spinner until the first list lands, a clean empty state when none are
 * active, else one routed widget per alert (newest first). `pollMs` is overridable
 * for tests; the app uses the {@link POLL_INTERVAL_MS} default.
 */
export function DashboardPane({
  pollMs = POLL_INTERVAL_MS,
}: { pollMs?: number } = {}): JSX.Element {
  const { alerts, dismiss } = useAlerts(pollMs);
  if (alerts === undefined) return <Loading text="Loading alerts…" />;
  if (alerts.length === 0) return <Message text="No active alerts." />;
  return (
    <>
      {alerts.map((alert) => (
        <AlertCard key={alert.id} alert={alert} onDismiss={() => dismiss(alert.id)} />
      ))}
    </>
  );
}
