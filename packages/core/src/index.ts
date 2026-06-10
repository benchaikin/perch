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
import { createEventBus } from "./event-bus.js";
import type { InvokerDeps, PluginConfigs } from "./invoker.js";
import { loadPlugins } from "./loader.js";
import { socketPath as defaultSocketPath } from "./paths.js";
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
  /** Plugin package ids to load (e.g. `["@perch/plugin-stack"]`). */
  plugins?: string[];
  /** Pre-loaded plugin definitions (skips dynamic import; used in tests). */
  pluginDefs?: PluginDef[];
  /** Per-plugin resolved config, keyed by plugin id. */
  configs?: PluginConfigs;
  /** Override the Unix socket path (defaults to the platform paths shim). */
  socketPath?: string;
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
  const configs: PluginConfigs = options.configs ?? {};

  const defs = options.pluginDefs ?? (await loadPlugins(options.plugins ?? []));

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

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    scheduler.stop();
    await server.close();
    bus.clear();
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
