/**
 * Renderer entry. Runs in the sandboxed browser context: no Node/Electron
 * access, only the typed `window.perch` bridge from the preload. It mounts the
 * React {@link App} onto the static `#panel` container; the component tree reads
 * the main-process-derived {@link PanelState} via the `useSyncExternalStore`
 * store (`store.ts`) and draws the panel — the tab strip, the active plugin's
 * pane, the refresh control, and the notice toast (see `panel.tsx`).
 *
 * This replaces the old imperative top-level render + `window.perch.onState`
 * subscription: the store owns the main→renderer channel now, and a state push
 * re-renders the component tree. Bundled to plain browser JS by esbuild; this
 * file stays plain `.ts` (no JSX) so it can be the esbuild entry while the
 * component tree lives in `.tsx` siblings.
 */
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { byId } from "./common.js";
import { App } from "./panel.js";
// Side-effect import: registers each plugin's AlertWidget into the shared
// `alertWidgets` registry at load, so the dashboard can resolve an alert's
// `pluginId` → widget. One line per plugin that raises alerts.
import "./agents-alert-widget.js";

createRoot(byId("panel")).render(createElement(App));
