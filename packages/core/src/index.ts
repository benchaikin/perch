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
import { pidPath as defaultPidPath, socketPath as defaultSocketPath } from "./paths.js";
import { removePidFile, writePidFile } from "./pidfile.js";
import { Registry } from "./registry.js";
import { Scheduler } from "./scheduler.js";
import { RpcServer } from "./server.js";

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
export { Methods, Notifications } from "./rpc.js";
export type {
  InvokeParams,
  SubscribeParams,
  SubscribeResult,
  UpdateNotification,
  RegistryListResult,
} from "./rpc.js";

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
}

/** A running daemon. Call {@link RunningDaemon.stop} for graceful shutdown. */
export interface RunningDaemon {
  /** The RPC server. */
  server: RpcServer;
  /** The capability registry. */
  registry: Registry;
  /** Absolute path of the bound Unix socket. */
  socketPath: string;
  /** Stop timers, close the server, unlink the socket, and abort capability ctx. */
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
  const scheduler = new Scheduler(invoker, bus);
  const server = new RpcServer({ registry, scheduler, cache, bus, invoker, socketPath: path });

  await server.listen();

  // Write a pidfile so `perch daemon status/stop` can find and signal us.
  // Defaults on for the real daemon, off in test mode (injected pluginDefs).
  const wantPidFile = options.pidFile ?? options.pluginDefs === undefined;
  const pidFilePath = typeof options.pidFile === "string" ? options.pidFile : defaultPidPath();
  if (wantPidFile) {
    await writePidFile(process.pid, pidFilePath);
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    scheduler.stop();
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

  return { server, registry, socketPath: path, stop };
}
