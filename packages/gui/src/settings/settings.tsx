/**
 * Settings renderer entry. Runs in the sandboxed browser context with only the
 * typed `window.perchSettings` bridge (no Node/Electron). It builds the external
 * {@link createSettingsStore store} over that bridge, mounts the {@link Settings}
 * shell into `#root`, and kicks off the initial loads (the store re-renders the
 * shell as each result arrives). Bundled to plain browser JS by esbuild with the
 * production React transform (the window's CSP blocks eval/CDN).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Settings } from "./app.js";
import { createSettingsStore } from "./settings-store.js";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing element #root");

const store = createSettingsStore(window.perchSettings);

createRoot(rootEl).render(
  <StrictMode>
    <Settings store={store} />
  </StrictMode>,
);

void store.init();
