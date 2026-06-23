/**
 * Side-effect-free construction of the bundled daemon's {@link StartDaemonOptions}
 * from a loaded `perch.yaml`. Split out of `perchd-entry.ts` (which calls
 * `main()` on import) so the wiring is unit-testable without booting a daemon.
 */
import type { PerchConfig, StartDaemonOptions } from "@perch/core";
import { pluginsFromConfig } from "@perch/core";
import type { PluginDef } from "@perch/sdk";
import stackPlugin from "@perch/plugin-stack";
import servicesPlugin from "@perch/plugin-services";
import dexPlugin from "@perch/plugin-dex";
import worktreesPlugin from "@perch/plugin-worktrees";
import agentsPlugin from "@perch/plugin-agents";

/** The plugins bundled into the packaged daemon (statically imported above). */
export const BUNDLED_PLUGINS: PluginDef[] = [
  stackPlugin,
  servicesPlugin,
  dexPlugin,
  worktreesPlugin,
  agentsPlugin,
];

/**
 * Build the {@link StartDaemonOptions} for the bundled daemon from a loaded
 * `perch.yaml`.
 *
 * The critical bit: with `pluginDefs` set, startDaemon runs in **pre-loaded
 * mode** — it takes BOTH `configs` (per-plugin) AND `global` (the cross-plugin
 * block: `global.repos`, the shared terminal) ONLY from these options; it does
 * NOT read them back from `configPath`. So both must be forwarded explicitly.
 * Omitting `global` is what left `ctx.global` empty, so `reposOf()` saw no repos
 * and every repo-aware capability (dex.spawn, stack.prs, worktrees, dex) fell
 * back to the daemon's cwd instead of the user's configured `global.repos` —
 * which is why agents couldn't be spawned from the packaged app.
 */
export function bundledDaemonOptions(
  loaded: PerchConfig,
  paths: { socketPath: string; configPath: string },
): StartDaemonOptions {
  return {
    socketPath: paths.socketPath,
    configPath: paths.configPath,
    // Pre-loaded plugins: esbuild inlines them; no `plugins/`-dir discovery.
    pluginDefs: BUNDLED_PLUGINS,
    configs: pluginsFromConfig(loaded).configs,
    // The shared global block (repos, terminal); without it ctx.global is empty.
    global: loaded.global,
    // `pluginDefs` defaults these off (test mode) — we want the real behavior.
    pidFile: true,
    watch: true,
    // Live reloads ask for plugins by id; resolve to the static plugins so a
    // re-enabled plugin doesn't fall back to filesystem discovery.
    loadPlugins: async () => BUNDLED_PLUGINS,
  };
}
