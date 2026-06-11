/**
 * esbuild step for @perch/gui.
 *
 * `tsc -b` type-checks everything and emits the Node main process. This script
 * bundles the two pieces that run outside the Node main context into plain,
 * dependency-free JS:
 *
 *   - `preload.ts`  → `dist/preload.js` (CJS; runs in Electron's preload context)
 *   - `renderer.ts` → `dist/renderer/renderer.js` (IIFE; runs in the sandboxed
 *                      browser renderer with no module loader)
 *
 * It also copies the static renderer assets (HTML + CSS) into `dist/renderer`.
 */
import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, "src");
const dist = join(root, "dist");

await mkdir(join(dist, "renderer"), { recursive: true });

await build({
  entryPoints: [join(src, "preload.ts")],
  // MUST be .cjs: the preload is CommonJS, but this package is `"type":
  // "module"`, so a `.js` preload is treated as ESM and Electron's require() of
  // it fails (ERR_REQUIRE_ESM) — leaving `window.perch` undefined.
  outfile: join(dist, "preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // Electron provides `electron` at runtime; don't bundle it.
  external: ["electron"],
});

await build({
  entryPoints: [join(src, "renderer", "renderer.ts")],
  outfile: join(dist, "renderer", "renderer.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
});

await cp(join(src, "renderer", "index.html"), join(dist, "renderer", "index.html"));
await cp(join(src, "renderer", "renderer.css"), join(dist, "renderer", "renderer.css"));

// Tray icons, loaded by the main process relative to dist/main.js. The
// monochrome template (+ @2x) is the default menu-bar icon; the color PNG is
// kept as an alternative.
await cp(join(root, "assets", "perch-trayTemplate.png"), join(dist, "perch-trayTemplate.png"));
await cp(
  join(root, "assets", "perch-trayTemplate@2x.png"),
  join(dist, "perch-trayTemplate@2x.png"),
);
await cp(join(root, "assets", "perch-icon.png"), join(dist, "perch-icon.png"));
