/**
 * esbuild step for @perch/gui.
 *
 * `tsc -b` type-checks everything and emits the Node main process. This script
 * bundles the pieces that run outside the Node main context (preload, renderer,
 * settings) into plain, dependency-free JS, re-bundles the main process + daemon
 * as self-contained files, and copies the static renderer/settings assets.
 *
 * Two modes:
 *   - one-shot (default): build every entrypoint once, then copy assets. This is
 *     the production path `pnpm build` runs (after `tsc -b`); UNCHANGED.
 *   - watch (`--watch`, used by `pnpm dev`): turn each build into an esbuild
 *     `context` and `.watch()` it, so a save re-bundles just the affected
 *     entrypoint (esbuild tracks the full import graph incl. inlined @perch/core).
 *     Static assets aren't in any import graph, so they're re-copied via a
 *     filesystem watcher. electronmon (launched alongside) then restarts the
 *     main process on a dist/main.js change and reloads the renderer otherwise.
 */
import process from "node:process";
import { build, context } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { watch as watchDir } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const log = (msg) => process.stdout.write(`${msg}\n`);
const logErr = (msg) => process.stderr.write(`${msg}\n`);

const watchMode = process.argv.includes("--watch");

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

/**
 * The bundle configs, one per entrypoint. Each is a plain esbuild options object
 * reused by both `build()` (one-shot) and `context()` (watch), so the two modes
 * stay in lockstep.
 */
const configs = [
  // The Electron main process, bundled into one self-contained file (inlining
  // @perch/core, @perch/cli, etc.). This makes the packaged .app independent of
  // node_modules — sidestepping pnpm symlink issues with electron-builder — and
  // removes the sibling-import (`./notify.js`) that a stale tsc cache could drop.
  // tsc -b still type-checks + emits; this overwrites its dist/main.js.
  {
    entryPoints: [join(src, "main.ts")],
    outfile: join(dist, "main.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["electron"],
    // ESM output has no `require`, but bundled CJS deps (e.g. vscode-jsonrpc)
    // do a runtime `require("util")`. esbuild's `__require` shim uses the
    // ambient `require` if one exists, else throws "Dynamic require ... not
    // supported". Provide a real one via createRequire so those calls resolve.
    banner: {
      js: "import { createRequire as __perchCreateRequire } from 'node:module';\nconst require = __perchCreateRequire(import.meta.url);",
    },
  },

  // The bundled daemon the main process self-starts when the socket is down
  // (dev and packaged). Inline EVERYTHING (@perch/core, @perch/plugin-stack, zod,
  // vscode-jsonrpc) so the packaged .app needs no node_modules and no workspace
  // `plugins/` dir. CJS so it runs cleanly as a child process under
  // ELECTRON_RUN_AS_NODE (no ESM loader quirks), unpacked from the asar via the
  // `asarUnpack` build config (see package.json) so it's a real on-disk script.
  {
    entryPoints: [join(src, "perchd-entry.ts")],
    outfile: join(dist, "perchd.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
  },

  {
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
  },

  {
    entryPoints: [join(src, "renderer", "renderer.ts")],
    outfile: join(dist, "renderer", "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
  },

  // The Settings window's preload — same .cjs requirement as the panel preload
  // (this package is `"type": "module"`, so a `.js` preload fails ERR_REQUIRE_ESM
  // and `window.perchSettings` is never exposed).
  {
    entryPoints: [join(src, "settings-preload.ts")],
    outfile: join(dist, "settings-preload.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
  },

  // The Settings window's renderer (sandboxed browser context).
  {
    entryPoints: [join(src, "settings", "settings.ts")],
    outfile: join(dist, "settings", "settings.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
  },
];

/**
 * Copy the static (non-bundled) assets into dist: the renderer + settings HTML/
 * CSS, Font Awesome's css/ + webfonts/ siblings, and the tray icons. These live
 * outside any JS import graph, so esbuild never touches them — the one-shot
 * build runs this once; watch mode re-runs it when a source asset changes.
 */
async function copyAssets() {
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
}

/**
 * A watch-mode esbuild plugin that logs each (re)build of an output file, so the
 * `pnpm dev` console shows what rebuilt on save (esbuild is otherwise silent on
 * rebuild). Named by the config's outfile basename.
 */
function rebuildLogger(label) {
  return {
    name: "perch-rebuild-logger",
    setup(pluginBuild) {
      pluginBuild.onEnd((result) => {
        const errors = result.errors.length;
        log(errors ? `[esbuild] ${label}: ${errors} error(s)` : `[esbuild] rebuilt ${label}`);
      });
    },
  };
}

if (watchMode) {
  // Watch: each config becomes a context whose .watch() does an initial build
  // then re-bundles on save. Assets aren't in any import graph, so a filesystem
  // watcher over the renderer/settings source dirs re-copies them on change.
  const contexts = await Promise.all(
    configs.map((config) =>
      context({
        ...config,
        plugins: [...(config.plugins ?? []), rebuildLogger(basename(config.outfile))],
      }),
    ),
  );
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  await copyAssets();
  for (const dir of [join(src, "renderer"), join(src, "settings")]) {
    watchDir(dir, { recursive: true }, () => {
      copyAssets().catch((err) => logErr(`[esbuild] asset copy failed: ${err.message}`));
    });
  }
  log("[esbuild] watching for changes…");
} else {
  await Promise.all(configs.map(build));
  await copyAssets();
}
