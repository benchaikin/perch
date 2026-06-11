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
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, "src");
const dist = join(root, "dist");

// Font Awesome (bundled locally — the renderer CSP blocks any CDN). The CSS and
// webfonts keep their sibling layout so the @font-face `../webfonts/` urls resolve.
const faDir = dirname(
  createRequire(import.meta.url).resolve("@fortawesome/fontawesome-free/package.json"),
);

await mkdir(join(dist, "renderer"), { recursive: true });
await mkdir(join(dist, "settings"), { recursive: true });

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

// The Settings window's preload — same .cjs requirement as the panel preload
// (this package is `"type": "module"`, so a `.js` preload fails ERR_REQUIRE_ESM
// and `window.perchSettings` is never exposed).
await build({
  entryPoints: [join(src, "settings-preload.ts")],
  outfile: join(dist, "settings-preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
});

// The Settings window's renderer (sandboxed browser context).
await build({
  entryPoints: [join(src, "settings", "settings.ts")],
  outfile: join(dist, "settings", "settings.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
});

await cp(join(src, "renderer", "index.html"), join(dist, "renderer", "index.html"));
await cp(join(src, "renderer", "renderer.css"), join(dist, "renderer", "renderer.css"));

// Font Awesome assets for the panel renderer (css/ + webfonts/ siblings).
await cp(join(faDir, "css", "all.min.css"), join(dist, "renderer", "css", "all.min.css"));
await cp(join(faDir, "webfonts"), join(dist, "renderer", "webfonts"), { recursive: true });
await cp(join(src, "settings", "index.html"), join(dist, "settings", "index.html"));
await cp(join(src, "settings", "settings.css"), join(dist, "settings", "settings.css"));

// Tray icons, loaded by the main process relative to dist/main.js. The
// monochrome template (+ @2x) is the default menu-bar icon; the color PNG is
// kept as an alternative.
await cp(join(root, "assets", "perch-trayTemplate.png"), join(dist, "perch-trayTemplate.png"));
await cp(
  join(root, "assets", "perch-trayTemplate@2x.png"),
  join(dist, "perch-trayTemplate@2x.png"),
);
await cp(join(root, "assets", "perch-icon.png"), join(dist, "perch-icon.png"));
