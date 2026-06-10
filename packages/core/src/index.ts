/**
 * @perch/core — `perchd`, the headless daemon.
 *
 * Owns the capability registry, scheduler/poller, cache, credential store,
 * event bus, and the JSON-RPC server (over a Unix socket). All frontends are
 * thin clients of this.
 *
 * M1 implements the registry + RPC server + plugin host.
 */
export const VERSION = "0.0.0";

/** Boot the daemon. Implemented in M1. */
export async function startDaemon(): Promise<void> {
  // TODO(M1): registry, Unix-socket JSON-RPC server, scheduler, event bus.
  throw new Error("perchd: not yet implemented (M1)");
}
