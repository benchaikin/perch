/**
 * Self-contained `perchd` bootstrap, bundled into `dist/perchd.cjs` and spawned
 * by the Electron main process when the socket is unreachable (see `main.ts`).
 *
 * A packaged Perch.app ships no `node_modules` and no workspace `plugins/` dir,
 * so the daemon's normal dynamic/filesystem plugin discovery (`loadPluginsByIds`
 * walking up to `pnpm-workspace.yaml`) can't run. Instead {@link bundledDaemonOptions}
 * (in `perchd-options.ts`) **statically imports** the bundled plugins and hands
 * them to {@link startDaemon} as pre-loaded `PluginDef`s, so esbuild inlines them
 * into the bundle and no filesystem discovery happens.
 *
 * We still want a REAL daemon (not the test-mode daemon `pluginDefs` implies): it
 * must read the user's `perch.yaml` (per-plugin `configs` AND the cross-plugin
 * `global` block — `global.repos`, the shared terminal), write a pidfile, and
 * hot-reload on config edits. The option-building lives in `perchd-options.ts`
 * (side-effect-free, so it's unit-testable); this entry just resolves the paths,
 * loads the config, boots the daemon, and installs signal handlers (`pluginDefs`
 * suppresses core's own).
 */
import {
  configPath as defaultConfigPath,
  loadConfig,
  socketPath as defaultSocketPath,
  startDaemon,
} from "@perch/core";

import { bundledDaemonOptions } from "./perchd-options.js";

/** Boot the bundled daemon, then keep the process alive for the RPC server. */
async function main(): Promise<void> {
  // The GUI connects on `PERCH_SOCKET ?? defaultSocketPath()`; honor the same
  // override here so a spawned daemon binds the socket the GUI will dial (and so
  // the node-level boot test can point both at a throwaway path).
  const socketPath = process.env.PERCH_SOCKET ?? defaultSocketPath();
  const configPath = process.env.PERCH_CONFIG ?? defaultConfigPath();

  // A missing file yields empty config and the plugins operate on their defaults.
  const loaded = await loadConfig(configPath);
  const daemon = await startDaemon(bundledDaemonOptions(loaded, { socketPath, configPath }));

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
