# @perch/gui

The Perch Electron app: a **menu-bar (tray) entry** that toggles a **frameless,
always-on-top, pinned floating panel** rendering the current PR stack live from
`perchd`.

## Process structure

- **`src/main.ts`** — Electron main process. Owns the tray icon (left-click
  toggles the panel; right-click → Show/Hide, Quit), creates the frameless
  always-on-top non-activating panel `BrowserWindow`, connects to `perchd` over
  JSON-RPC, subscribes to `stack.view`, and pushes derived state to the renderer
  over IPC. Reuses `PerchClient` from `@perch/cli` (no re-implemented client).
- **`src/preload.ts`** — `contextBridge` bridge exposing a narrow, typed
  `window.perch` API. `contextIsolation` on, `nodeIntegration` off — the
  renderer never touches Node/Electron.
- **`src/renderer/`** — `index.html` + `renderer.css` + `renderer.ts`. Renders
  the panel from a fully-derived `PanelState`; contains no business logic.
- **`src/panel-state.ts`** — Electron-free view-model derivation: `StackGraph` →
  rows, status → chips/badges, daemon-down / empty / error states. This is the
  unit-tested core (`src/panel-state.test.ts`).
- **`src/ipc.ts`** — shared IPC channel + type contract.

## Build

```sh
pnpm --filter @perch/gui build
```

`tsc -b` type-checks everything and emits the Node main process; `esbuild.mjs`
then bundles `preload.ts` (CJS) and `renderer.ts` (browser IIFE) and copies the
HTML/CSS into `dist/renderer`.

## Run

Start `perchd` first (so the panel has data), then:

```sh
pnpm --filter @perch/gui start
```

Left-click the menu-bar icon to toggle the panel. If `perchd` isn't running the
panel shows a "perchd not running" state rather than crashing. The Sync button
is enabled only when `stack.sync` is present in the registry (it ships in M6).

> **Verification note:** the interactive Electron launch was **not** verified in
> CI (headless, no display). The build, type-check, lint, and the
> `panel-state` unit tests all pass; the tray/window/IPC wiring needs a manual
> launch on a machine with a display.
```
