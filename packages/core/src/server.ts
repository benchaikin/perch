/**
 * JSON-RPC server over a Unix domain socket.
 *
 * Each socket connection gets its own `vscode-jsonrpc` MessageConnection. The
 * server answers `registry.list` / `capability.invoke` / `capability.subscribe`
 * / `capability.unsubscribe`, and pushes `capability.update` notifications to
 * subscribed connections as the scheduler emits fresh read data.
 */
import { createServer, type Server, type Socket } from "node:net";
import { mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createMessageConnection,
  SocketMessageReader,
  SocketMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import { Cache, inputKey } from "./cache.js";
import { getConfig, updateConfig, validateRepoPath } from "./config-store.js";
import type { EventBus } from "./event-bus.js";
import { invokeCapability, type InvokerDeps } from "./invoker.js";
import { Registry, type RegisteredCapability } from "./registry.js";
import type { DeliveredNotification } from "./notifications.js";
import {
  Methods,
  Notifications,
  type ConfigGetResult,
  type ConfigUpdateParams,
  type ConfigUpdateResult,
  type InvokeParams,
  type RegistryChangedNotification,
  type RegistryListResult,
  type SubscribeParams,
  type SubscribeResult,
  type UpdateNotification,
  type ValidateRepoPathParams,
  type ValidateRepoPathResult,
} from "./rpc.js";
import type { Scheduler } from "./scheduler.js";

/** Dependencies the RPC server wires together. */
export interface ServerDeps {
  registry: Registry;
  scheduler: Scheduler;
  cache: Cache;
  bus: EventBus;
  invoker: InvokerDeps;
  socketPath: string;
  /**
   * Path to `perch.json` the `config.*` methods read and mutate. Writes are
   * atomic; the daemon's config watcher picks them up and drives the reload —
   * the server never triggers a reload itself.
   */
  configPath: string;
}

/** A running RPC server; call {@link RpcServer.close} to shut down. */
export class RpcServer {
  readonly #server: Server;
  readonly #deps: ServerDeps;
  /** Live connections, each with the set of (id, inputKey) it subscribes to. */
  readonly #connections = new Set<ClientConnection>();
  #busOff: (() => void) | undefined;

  constructor(deps: ServerDeps) {
    this.#deps = deps;
    this.#server = createServer((socket) => this.#onConnection(socket));
  }

  /** Bind the Unix socket and start accepting clients. */
  async listen(): Promise<void> {
    const path = this.#deps.socketPath;
    await mkdir(dirname(path), { recursive: true });
    await removeStaleSocket(path);

    // Forward bus updates to subscribed connections.
    this.#busOff = this.#deps.bus.on((event) => {
      const notification: UpdateNotification = {
        id: event.id,
        inputKey: event.inputKey,
        data: event.data,
      };
      for (const conn of this.#connections) {
        conn.notifyIfSubscribed(notification);
      }
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.#server.once("error", onError);
      this.#server.listen(path, () => {
        this.#server.off("error", onError);
        resolve();
      });
    });
  }

  /** The socket path the server is (or will be) bound to. */
  get socketPath(): string {
    return this.#deps.socketPath;
  }

  /**
   * Push a `registry.changed` notification to every connected client (after a
   * config reload added/removed/reconfigured plugins). Clients re-fetch
   * `registry.list` in response. Best-effort: failures to a single connection
   * are swallowed so one dead socket can't block the rest.
   */
  broadcastRegistryChanged(payload: RegistryChangedNotification): void {
    for (const conn of this.#connections) {
      conn.notifyRegistryChanged(payload);
    }
  }

  /**
   * Push a `notification` to every connection that opted in via
   * `notifications.subscribe`. Mirrors {@link broadcastRegistryChanged};
   * best-effort per connection. This is what the {@link NotificationSink}
   * registered in `startDaemon` calls.
   */
  broadcastNotification(payload: DeliveredNotification): void {
    for (const conn of this.#connections) {
      conn.notifyNotification(payload);
    }
  }

  #onConnection(socket: Socket): void {
    const conn = new ClientConnection(socket, this.#deps);
    this.#connections.add(conn);
    conn.onClose(() => this.#connections.delete(conn));
    conn.listen();
  }

  /** Stop listening, close all connections, and unlink the socket. */
  async close(): Promise<void> {
    this.#busOff?.();
    this.#busOff = undefined;
    for (const conn of this.#connections) {
      conn.dispose();
    }
    this.#connections.clear();
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
    });
    await removeStaleSocket(this.#deps.socketPath);
  }
}

/** Per-socket JSON-RPC connection plus its subscription set. */
class ClientConnection {
  readonly #conn: MessageConnection;
  readonly #socket: Socket;
  readonly #deps: ServerDeps;
  /** Map of subscription composite key → { id, inputKey } for fan-out + cleanup. */
  readonly #subs = new Map<string, { id: string; inputKey: string }>();
  /** Whether this connection opted into the `notification` stream. */
  #notificationsSubscribed = false;
  #closeCb: (() => void) | undefined;

  constructor(socket: Socket, deps: ServerDeps) {
    this.#socket = socket;
    this.#deps = deps;
    this.#conn = createMessageConnection(
      new SocketMessageReader(socket),
      new SocketMessageWriter(socket),
    );
    this.#register();
  }

  #register(): void {
    this.#conn.onRequest(Methods.registryList, (): RegistryListResult => {
      return this.#deps.registry.list();
    });

    this.#conn.onRequest(Methods.capabilityInvoke, (params: InvokeParams): Promise<unknown> => {
      const entry = this.#requireCapability(params.id);
      return invokeCapability(this.#deps.invoker, entry, params.input);
    });

    this.#conn.onRequest(
      Methods.capabilitySubscribe,
      async (params: SubscribeParams): Promise<SubscribeResult> => {
        const entry = this.#requireCapability(params.id);
        if (entry.cap.kind !== "read") {
          throw new Error(`perchd: cannot subscribe to action ${JSON.stringify(params.id)}`);
        }
        // Validate input (inline) and prime the cache before subscribing.
        const inputKey = this.#deps.scheduler.subscribe(entry, params.input);
        this.#subs.set(subKey(entry.id, inputKey), { id: entry.id, inputKey });

        // Return cached value instantly if present; otherwise fetch once now.
        let current = this.#deps.cache.get(entry.id, inputKey)?.data;
        if (current === undefined) {
          current = await invokeCapability(this.#deps.invoker, entry, params.input);
          this.#deps.bus.emit({ id: entry.id, inputKey, data: current });
        }
        return { id: entry.id, inputKey, current };
      },
    );

    this.#conn.onRequest(Methods.capabilityUnsubscribe, (params: SubscribeParams): void => {
      const entry = this.#requireCapability(params.id);
      // Re-derive the key the same way subscribe did.
      const inputKey = keyFor(entry, params.input);
      this.#deps.scheduler.unsubscribe(entry.id, inputKey);
      this.#subs.delete(subKey(entry.id, inputKey));
    });

    this.#conn.onRequest(Methods.notificationsSubscribe, (): void => {
      this.#notificationsSubscribed = true;
    });

    this.#conn.onRequest(Methods.notificationsUnsubscribe, (): void => {
      this.#notificationsSubscribed = false;
    });

    this.#conn.onRequest(Methods.configGet, (): Promise<ConfigGetResult> => {
      return getConfig(this.#deps.configPath);
    });

    // Deep-merge + validate + atomic write. We deliberately do NOT reload here:
    // the atomic rename is a watcher event, so the daemon's watch → reload →
    // `registry.changed` path applies the change (single source of truth).
    this.#conn.onRequest(
      Methods.configUpdate,
      (params: ConfigUpdateParams): Promise<ConfigUpdateResult> => {
        return updateConfig(params.patch, this.#deps.configPath);
      },
    );

    this.#conn.onRequest(
      Methods.configValidateRepoPath,
      (params: ValidateRepoPathParams): Promise<ValidateRepoPathResult> => {
        return validateRepoPath(params.path);
      },
    );

    this.#conn.onClose(() => this.#cleanup());
    this.#socket.on("close", () => this.#cleanup());
    this.#socket.on("error", () => this.#cleanup());
  }

  #requireCapability(id: string): RegisteredCapability {
    const entry = this.#deps.registry.get(id);
    if (!entry) {
      throw new Error(`perchd: unknown capability ${JSON.stringify(id)}`);
    }
    return entry;
  }

  /** Send a `capability.update` if this connection subscribes to its key. */
  notifyIfSubscribed(notification: UpdateNotification): void {
    if (this.#subs.has(subKey(notification.id, notification.inputKey))) {
      void this.#conn.sendNotification(Notifications.capabilityUpdate, notification);
    }
  }

  /** Send a `registry.changed` notification (unconditional fan-out). */
  notifyRegistryChanged(payload: RegistryChangedNotification): void {
    void this.#conn.sendNotification(Notifications.registryChanged, payload);
  }

  /** Send a `notification` if this connection opted into the stream. */
  notifyNotification(payload: DeliveredNotification): void {
    if (this.#notificationsSubscribed) {
      void this.#conn.sendNotification(Notifications.notification, payload);
    }
  }

  listen(): void {
    this.#conn.listen();
  }

  onClose(cb: () => void): void {
    this.#closeCb = cb;
  }

  #cleanup(): void {
    // Drop scheduler refs for everything this connection subscribed to.
    for (const { id, inputKey } of this.#subs.values()) {
      this.#deps.scheduler.unsubscribe(id, inputKey);
    }
    this.#subs.clear();
    this.#closeCb?.();
    this.#closeCb = undefined;
  }

  dispose(): void {
    this.#cleanup();
    this.#conn.dispose();
    this.#socket.destroy();
  }
}

function subKey(id: string, inputKey: string): string {
  return `${id} ${inputKey}`;
}

/** Re-derive a subscription key from raw input (matches Scheduler/Cache). */
function keyFor(entry: RegisteredCapability, rawInput: unknown): string {
  const cap = entry.cap;
  const input: unknown = cap.input ? cap.input.parse(rawInput) : rawInput;
  return inputKey(input);
}

/** Unlink a socket path if it exists (stale from a prior run). */
async function removeStaleSocket(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}
