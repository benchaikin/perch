/**
 * Thin JSON-RPC client of `perchd`.
 *
 * Wraps a `vscode-jsonrpc` MessageConnection over the daemon's Unix domain
 * socket and exposes the four registry/capability methods plus
 * `capability.update` subscription. Frontends other than the CLI (e.g. the M5
 * GUI) can reuse this directly.
 */
import { connect, type Socket } from "node:net";
import {
  createMessageConnection,
  SocketMessageReader,
  SocketMessageWriter,
  type Disposable,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import {
  Methods,
  Notifications,
  type ConfigGetResult,
  type ConfigUpdateParams,
  type ConfigUpdateResult,
  type InvokeParams,
  type NotificationPayload,
  type RegistryChangedNotification,
  type RegistryListResult,
  type SubscribeParams,
  type SubscribeResult,
  type UpdateNotification,
  type ValidateRepoPathParams,
  type ValidateRepoPathResult,
} from "@perch/core";

/** Raised when the daemon socket cannot be reached. */
export class DaemonUnavailableError extends Error {
  constructor(
    readonly socketPath: string,
    cause: NodeJS.ErrnoException,
  ) {
    super(`perchd is not running (could not connect to ${socketPath})`, { cause });
    this.name = "DaemonUnavailableError";
  }
}

/** A connected client of `perchd`. Call {@link PerchClient.close} when done. */
export class PerchClient {
  readonly #socket: Socket;
  readonly #conn: MessageConnection;

  private constructor(socket: Socket, conn: MessageConnection) {
    this.#socket = socket;
    this.#conn = conn;
  }

  /**
   * Connect to the daemon at `socketPath`. Rejects with a
   * {@link DaemonUnavailableError} when no daemon is listening.
   */
  static connect(socketPath: string): Promise<PerchClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      const onError = (err: NodeJS.ErrnoException): void => {
        reject(new DaemonUnavailableError(socketPath, err));
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        const conn = createMessageConnection(
          new SocketMessageReader(socket),
          new SocketMessageWriter(socket),
        );
        conn.listen();
        resolve(new PerchClient(socket, conn));
      });
    });
  }

  /** `registry.list` — every capability the daemon exposes. */
  registryList(): Promise<RegistryListResult> {
    return this.#conn.sendRequest(Methods.registryList);
  }

  /** `capability.invoke` — run a read or action, returning its result. */
  invoke(params: InvokeParams): Promise<unknown> {
    return this.#conn.sendRequest(Methods.capabilityInvoke, params);
  }

  /** `capability.subscribe` — begin a subscription; returns the current value. */
  subscribe(params: SubscribeParams): Promise<SubscribeResult> {
    return this.#conn.sendRequest(Methods.capabilitySubscribe, params);
  }

  /** `capability.unsubscribe` — stop a subscription. */
  unsubscribe(params: SubscribeParams): Promise<void> {
    return this.#conn.sendRequest(Methods.capabilityUnsubscribe, params);
  }

  /**
   * Register a handler for `capability.update` notifications. Returns a
   * {@link Disposable} to remove it.
   */
  onUpdate(handler: (note: UpdateNotification) => void): Disposable {
    return this.#conn.onNotification(Notifications.capabilityUpdate, handler);
  }

  /**
   * Register a handler for `registry.changed` notifications (fired when the
   * daemon hot-reloads `perch.json`). Returns a {@link Disposable}.
   */
  onRegistryChanged(handler: (note: RegistryChangedNotification) => void): Disposable {
    return this.#conn.onNotification(Notifications.registryChanged, handler);
  }

  /** `notifications.subscribe` — begin receiving `notification` pushes. */
  subscribeNotifications(): Promise<void> {
    return this.#conn.sendRequest(Methods.notificationsSubscribe);
  }

  /** `notifications.unsubscribe` — stop receiving `notification` pushes. */
  unsubscribeNotifications(): Promise<void> {
    return this.#conn.sendRequest(Methods.notificationsUnsubscribe);
  }

  /** Register a handler for `notification` pushes. Returns a {@link Disposable}. */
  onNotification(handler: (note: NotificationPayload) => void): Disposable {
    return this.#conn.onNotification(Notifications.notification, handler);
  }

  /** `config.get` — the current `perch.json`. */
  configGet(): Promise<ConfigGetResult> {
    return this.#conn.sendRequest(Methods.configGet);
  }

  /** `config.update` — deep-merge a patch into `perch.json`; returns the new config. */
  configUpdate(params: ConfigUpdateParams): Promise<ConfigUpdateResult> {
    return this.#conn.sendRequest(Methods.configUpdate, params);
  }

  /** `config.validateRepoPath` — check a path is an existing git repo. */
  validateRepoPath(params: ValidateRepoPathParams): Promise<ValidateRepoPathResult> {
    return this.#conn.sendRequest(Methods.configValidateRepoPath, params);
  }

  /** Tear down the connection and underlying socket. */
  close(): void {
    this.#conn.dispose();
    this.#socket.destroy();
  }
}
