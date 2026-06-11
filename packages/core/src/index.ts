/**
 * @perch/core — `perchd`, the headless daemon.
 *
 * Owns the capability registry, scheduler/poller, in-memory cache, event bus,
 * plugin host, and the JSON-RPC server (over a Unix domain socket). All
 * frontends (GUI, CLI, MCP) are thin JSON-RPC clients of this.
 *
 * M1 implements: capability registry + expose-resolution, the RPC server,
 * scheduler, cache, event bus, and plugin loader.
 */
import type { PluginDef } from "@perch/sdk";
import { Cache } from "./cache.js";
import { loadConfig, pluginsFromConfig } from "./config.js";
import { createEventBus } from "./event-bus.js";
import type { InvokerDeps, PluginConfigs } from "./invoker.js";
import { loadPlugins, loadPluginsByIds } from "./loader.js";
import { NotificationService, type NotificationSink } from "./notifications.js";
import {
  configPath as defaultConfigPath,
  pidPath as defaultPidPath,
  socketPath as defaultSocketPath,
} from "./paths.js";
import { removePidFile, writePidFile } from "./pidfile.js";
import { applyReload, diffConfigs, isEmptyDiff } from "./reload.js";
import { Registry } from "./registry.js";
import { Scheduler } from "./scheduler.js";
import { RpcServer } from "./server.js";
import { ConfigWatcher } from "./watcher.js";

export const VERSION = "0.0.0";

// Public surface for clients and other packages (CLI/GUI/MCP build against these).
export { resolveExpose, Registry } from "./registry.js";
export type { CapabilityMeta, RegisteredCapability } from "./registry.js";
export { parseDuration } from "./duration.js";
export { socketPath } from "./paths.js";
export { loadPlugins, buildContext } from "./loader.js";
export type { CoreContext } from "./loader.js";
export { loadConfig, pluginsFromConfig, defaultConfig, configSchema } from "./config.js";
export type { PerchConfig } from "./config.js";
export { configPath, pidPath } from "./paths.js";
export { readPidFile, writePidFile, removePidFile, isProcessAlive } from "./pidfile.js";
export {
  launchdPlist,
  systemdUnit,
  launchdPlistPath,
  systemdUnitPath,
  resolvePerchdEntry,
  installAutostart,
  uninstallAutostart,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
} from "./autostart.js";
export type { AutostartArgs, AutostartResult } from "./autostart.js";
export { Cache, inputKey } from "./cache.js";
export { createEventBus, TypedEmitter } from "./event-bus.js";
export type { EventBus, CapabilityUpdate } from "./event-bus.js";
export { Scheduler } from "./scheduler.js";
export { RpcServer } from "./server.js";
export { NotificationService } from "./notifications.js";
export type {
  Notification,
  NotificationLevel,
  DeliveredNotification,
  NotificationSink,
  NotificationServiceOptions,
} from "./notifications.js";
export { Methods, Notifications } from "./rpc.js";
export type {
  InvokeParams,
  SubscribeParams,
  SubscribeResult,
  UpdateNotification,
  RegistryChangedNotification,
  RegistryListResult,
  ConfigGetResult,
  ConfigUpdateParams,
  ConfigUpdateResult,
  ValidateRepoPathParams,
  ValidateRepoPathResult,
  NotificationPayload,
} from "./rpc.js";
export { getConfig, updateConfig, validateRepoPath } from "./config-store.js";
export type { ConfigPatch, RepoPathValidation } from "./config-store.js";
export { diffConfigs, applyReload, isEmptyDiff } from "./reload.js";
export type { ConfigDiff, ReloadState, LoadPlugins } from "./reload.js";
export { ConfigWatcher } from "./watcher.js";
export type { ConfigWatcherOptions } from "./watcher.js";

/** Options for {@link startDaemon}. */
export interface StartDaemonOptions {
  /**
   * Plugin package ids to load (e.g. `["@perch/plugin-stack"]`). When provided,
   * overrides the config file's plugin selection (precedence: explicit > config
   * > empty). When omitted, plugins are derived from `perch.json`.
   */
  plugins?: string[];
  /** Pre-loaded plugin definitions (skips dynamic import; used in tests). */
  pluginDefs?: PluginDef[];
  /**
   * Per-plugin resolved config, keyed by plugin id. When provided, overrides the
   * config file's per-plugin sections; otherwise derived from `perch.json`.
   */
  configs?: PluginConfigs;
  /** Override the Unix socket path (defaults to the platform paths shim). */
  socketPath?: string;
  /** Override the config file path (defaults to the platform paths shim). */
  configPath?: string;
  /**
   * Write a pidfile on startup and remove it on `stop()`. Defaults to `true`
   * unless `pluginDefs` is provided (test mode), to keep tests side-effect free.
   * Set a string to override the pidfile path.
   */
  pidFile?: boolean | string;
  /**
   * Watch `perch.json` and hot-apply changes (add/remove/reconfigure plugins)
   * without restarting. Defaults to `true` unless `pluginDefs` is provided (test
   * mode), so tests never depend on fs-watch timing. The watcher is stopped on
   * `stop()`.
   */
  watch?: boolean;
  /** Debounce window (ms) for coalescing rapid config writes. Default 200. */
  reloadDebounceMs?: number;
  /**
   * Loader used by live reloads to resolve newly-enabled plugins by id. Defaults
   * to {@link loadPluginsByIds} (workspace discovery). Injectable so tests can
   * supply pre-built {@link PluginDef}s without dynamic import.
   */
  loadPlugins?: (ids: string[]) => Promise<PluginDef[]>;
  /**
   * Enable the notification subsystem: run reads' `notify` hooks after each
   * poll, arm persistent pollers for notify-reads, and route notifications to
   * subscribed clients. Defaults to `true`. Set `false` to disable in tests that
   * don't exercise notifications.
   */
  notifications?: boolean;
}

/** A running daemon. Call {@link RunningDaemon.stop} for graceful shutdown. */
export interface RunningDaemon {
  /** The RPC server. */
  server: RpcServer;
  /** The capability registry. */
  registry: Registry;
  /** Absolute path of the bound Unix socket. */
  socketPath: string;
  /**
   * Re-read `perch.json` and hot-apply any plugin add/remove/reconfigure. This
   * is what the config watcher invokes; exposed so callers/tests can trigger a
   * reload deterministically. Invalid config is logged and ignored (current
   * state preserved). Resolves once the reload (if any) has been applied.
   */
  reload: () => Promise<void>;
  /** Stop timers, the config watcher, close the server, unlink the socket. */
  stop: () => Promise<void>;
}

/**
 * Boot the daemon: load plugins, build the registry, wire the cache, event bus,
 * scheduler, and JSON-RPC server, then listen on the Unix socket. Resolves once
 * the server is accepting connections.
 *
 * The returned {@link RunningDaemon} exposes a `stop()` for graceful shutdown.
 * SIGINT/SIGTERM handlers that call it are installed unless `pluginDefs` is
 * provided (test mode), to keep tests free of process-level side effects.
 */
export async function startDaemon(options: StartDaemonOptions = {}): Promise<RunningDaemon> {
  const path = options.socketPath ?? defaultSocketPath();

  // Resolve plugins + configs with precedence: explicit options > config > empty.
  // When tests inject `pluginDefs`, skip the config file entirely.
  let defs: PluginDef[];
  let configs: PluginConfigs;
  if (options.pluginDefs !== undefined) {
    defs = options.pluginDefs;
    configs = options.configs ?? {};
  } else if (options.plugins !== undefined) {
    // Explicit package-id override (argv). Still allow config-file configs.
    defs = await loadPlugins(options.plugins);
    configs = options.configs ?? pluginsFromConfig(await loadConfig(options.configPath)).configs;
  } else {
    // Derive both enabled plugins and their configs from `perch.json`.
    const { ids, configs: fromConfig } = pluginsFromConfig(await loadConfig(options.configPath));
    defs = await loadPluginsByIds(ids);
    configs = options.configs ?? fromConfig;
  }

  const registry = new Registry();
  const plugins = new Map<string, PluginDef>();
  for (const def of defs) {
    registry.register(def);
    plugins.set(def.id, def);
  }

  const cache = new Cache();
  const bus = createEventBus();
  const controller = new AbortController();
  const invoker: InvokerDeps = { cache, configs, plugins, signal: controller.signal };

  // Notification subsystem (on by default). The scheduler runs reads' `notify`
  // hooks and emits into the service; the RPC sink (wired after the server is
  // built) fans surviving notifications out to subscribed clients.
  const notificationsEnabled = options.notifications ?? true;
  const notifications = notificationsEnabled ? new NotificationService() : undefined;
  const scheduler = new Scheduler(invoker, bus, notifications);

  // The config path the `config.*` RPC methods read/mutate and the watcher
  // watches — one path, so an RPC write flows back through the normal reload.
  const reloadConfigPath = options.configPath ?? defaultConfigPath();

  const server = new RpcServer({
    registry,
    scheduler,
    cache,
    bus,
    invoker,
    socketPath: path,
    configPath: reloadConfigPath,
  });

  await server.listen();

  // Wire the RPC sink now that the server exists, then arm persistent pollers
  // for every registered notify-read so notifications fire with no client
  // attached. (Persistent pollers are re-armed after each reload below.)
  if (notifications) {
    const rpcSink: NotificationSink = {
      deliver: (n) => server.broadcastNotification(n),
    };
    notifications.addSink(rpcSink);
    scheduler.armNotifyReads(registry.all());
  }

  // Write a pidfile so `perch daemon status/stop` can find and signal us.
  // Defaults on for the real daemon, off in test mode (injected pluginDefs).
  const wantPidFile = options.pidFile ?? options.pluginDefs === undefined;
  const pidFilePath = typeof options.pidFile === "string" ? options.pidFile : defaultPidPath();
  if (wantPidFile) {
    await writePidFile(process.pid, pidFilePath);
  }

  // `reloadConfigPath` (computed above for the RPC server) is the path live
  // reloads read. Reload only makes sense when booting from the config file (not
  // when tests inject pluginDefs), so the watcher defaults off in test mode. An
  // explicit `plugins` override still reloads from the file: argv selects the
  // initial set, the file drives changes.

  // Serialize reloads so overlapping fs events can't interleave registry edits.
  let reloadChain: Promise<void> = Promise.resolve();
  const reload = (): Promise<void> => {
    const next = reloadChain.then(() => runReload());
    // Swallow rejections on the chain itself; runReload already handles errors.
    reloadChain = next.catch(() => {});
    return next;
  };

  async function runReload(): Promise<void> {
    let parsed;
    try {
      parsed = pluginsFromConfig(await loadConfig(reloadConfigPath));
    } catch (err) {
      // Invalid JSON/schema: keep running with the current config.
      console.error(`perchd: reload skipped, config invalid: ${errorMessage(err)}`);
      return;
    }

    const diff = diffConfigs({
      desiredIds: parsed.ids,
      desiredConfigs: parsed.configs,
      currentIds: registry.pluginIds(),
      currentConfigs: configs,
    });
    if (isEmptyDiff(diff)) return;

    const applied = await applyReload(
      {
        registry,
        scheduler,
        cache,
        configs,
        plugins,
        load: options.loadPlugins ?? loadPluginsByIds,
      },
      diff,
      parsed.configs,
    );
    // Newly-added plugins may carry notify-reads; arm persistent pollers for
    // them. (Removed/updated plugins had their pollers stopped by applyReload.)
    if (notifications) scheduler.armNotifyReads(registry.all());
    server.broadcastRegistryChanged(applied);
    console.error(
      `perchd: reloaded config — added [${applied.added.join(", ")}] ` +
        `removed [${applied.removed.join(", ")}] updated [${applied.updated.join(", ")}]`,
    );
  }

  // Watch `perch.json` and hot-apply changes. Default on for the real daemon,
  // off in test mode (injected pluginDefs) so the suite stays deterministic.
  const wantWatch = options.watch ?? options.pluginDefs === undefined;
  let watcher: ConfigWatcher | undefined;
  if (wantWatch) {
    watcher = new ConfigWatcher({
      configPath: reloadConfigPath,
      debounceMs: options.reloadDebounceMs,
      onChange: () => {
        void reload();
      },
    });
    watcher.start();
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    watcher?.stop();
    controller.abort();
    scheduler.stop();
    notifications?.stop();
    await server.close();
    bus.clear();
    if (wantPidFile) {
      await removePidFile(pidFilePath);
    }
  };

  // Install signal handlers only when loading real plugins (daemon process),
  // not when tests inject pluginDefs.
  const installSignals = options.pluginDefs === undefined;
  if (installSignals) {
    const onSignal = (): void => {
      void stop().then(() => process.exit(0));
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  return { server, registry, socketPath: path, reload, stop };
}

/** Structured `unknown`-error → message. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
