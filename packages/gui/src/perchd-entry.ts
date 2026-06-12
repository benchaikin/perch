/**
 * Self-contained `perchd` bootstrap, bundled into `dist/perchd.cjs` and spawned
 * by the Electron main process when the socket is unreachable (see `main.ts`).
 *
 * A packaged Perch.app ships no `node_modules` and no workspace `plugins/` dir,
 * so the daemon's normal dynamic/filesystem plugin discovery (`loadPluginsByIds`
 * walking up to `pnpm-workspace.yaml`) can't run. Instead we **statically import**
 * the stack plugin and hand it to {@link startDaemon} as a pre-loaded `PluginDef`,
 * so esbuild inlines it into the bundle and no filesystem discovery happens.
 *
 * We still want a REAL daemon (not the test-mode daemon `pluginDefs` implies):
 * it must read the user's `perch.json` for the stack plugin's per-repo config,
 * write a pidfile, and hot-reload on config edits. So we:
 *
 *   - pass `pluginDefs: [stackPlugin]`             — no plugin discovery,
 *   - derive `configs` from `perch.json`           — the stack repos load,
 *   - set `pidFile: true` and `watch: true`        — `pluginDefs` flips these
 *                                                     to test-mode defaults
 *                                                     (off), so re-enable them,
 *   - inject `loadPlugins: () => [stackPlugin]`     — live reloads resolve the
 *                                                     statically-imported plugin
 *                                                     by id too, and
 *   - install SIGTERM/SIGINT handlers calling stop  — `pluginDefs` also skips
 *                                                     core's own signal handlers.
 */
import {
  configPath as defaultConfigPath,
  loadConfig,
  pluginsFromConfig,
  socketPath as defaultSocketPath,
  startDaemon,
} from "@perch/core";
import stackPlugin from "@perch/plugin-stack";
// TODO: bundle services plugin for packaged daemon (Dev services M1 ships the
// @perch/plugin-services package + the GUI Services section; the packaged
// perchd.cjs still only statically imports the stack plugin, so process-compose
// status won't surface in a packaged build until this entry also bundles it).

/** Boot the bundled daemon, then keep the process alive for the RPC server. */
async function main(): Promise<void> {
  // The GUI connects on `PERCH_SOCKET ?? defaultSocketPath()`; honor the same
  // override here so a spawned daemon binds the socket the GUI will dial (and so
  // the node-level boot test can point both at a throwaway path).
  const socketPath = process.env.PERCH_SOCKET ?? defaultSocketPath();
  const configPath = process.env.PERCH_CONFIG ?? defaultConfigPath();

  // Resolve the stack plugin's config from `perch.json` (keyed by plugin id —
  // `"stack"` — which matches the static plugin's `id`). A missing file yields an
  // empty config and the plugin operates on its defaults.
  const { configs } = pluginsFromConfig(await loadConfig(configPath));

  const daemon = await startDaemon({
    socketPath,
    configPath,
    // Pre-loaded plugin: esbuild inlines it; no `plugins/`-dir discovery.
    pluginDefs: [stackPlugin],
    configs,
    // `pluginDefs` defaults these off (test mode) — we want the real behavior.
    pidFile: true,
    watch: true,
    // Live reloads ask for plugins by id; resolve every id to the static plugin
    // so a re-enabled stack plugin doesn't fall back to filesystem discovery.
    loadPlugins: async () => [stackPlugin],
  });

  // `pluginDefs` also suppresses core's own SIGINT/SIGTERM handlers; install our
  // own so the GUI quitting (or `kill`) shuts the daemon down gracefully (which
  // unlinks the socket and removes the pidfile).
  const onSignal = (): void => {
    void daemon.stop().then(() => process.exit(0));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  console.error(`perchd listening on ${daemon.socketPath}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
