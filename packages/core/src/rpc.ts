/**
 * JSON-RPC contract types shared between `perchd` and its clients (CLI, GUI,
 * MCP). These describe the wire shapes only; the server lives in
 * {@link ./server.ts}.
 *
 * Transport: JSON-RPC 2.0 over a Unix domain socket via `vscode-jsonrpc`.
 */
import type { CapabilityMeta } from "./registry.js";

/** Request methods (client → server). */
export const Methods = {
  /** `registry.list` → {@link CapabilityMeta}[]. No params. */
  registryList: "registry.list",
  /** `capability.invoke` → result. Params: {@link InvokeParams}. */
  capabilityInvoke: "capability.invoke",
  /** `capability.subscribe` → {@link SubscribeResult}. Params: {@link SubscribeParams}. */
  capabilitySubscribe: "capability.subscribe",
  /** `capability.unsubscribe` → void. Params: {@link SubscribeParams}. */
  capabilityUnsubscribe: "capability.unsubscribe",
} as const;

/** Notification methods (server → client). */
export const Notifications = {
  /** `capability.update` — fresh read data for a subscription. Payload: {@link UpdateNotification}. */
  capabilityUpdate: "capability.update",
} as const;

/** Params for `capability.invoke`, `capability.subscribe`, `capability.unsubscribe`. */
export interface InvokeParams {
  /** Canonical capability id, `${pluginId}.${name}`. */
  id: string;
  /** Raw input, validated server-side against the capability's schema. */
  input?: unknown;
}

/** Alias: subscribe/unsubscribe take the same shape as invoke. */
export type SubscribeParams = InvokeParams;

/** Result of `capability.subscribe`. */
export interface SubscribeResult {
  /** The capability id subscribed to. */
  id: string;
  /** Stable key for the (id, input) pair; echoed back on updates. */
  inputKey: string;
  /** Cached current value, if any (clients render instantly). */
  current?: unknown;
}

/** Payload of a `capability.update` notification. */
export interface UpdateNotification {
  /** Canonical capability id. */
  id: string;
  /** The (id, input) key this update is for; matches {@link SubscribeResult.inputKey}. */
  inputKey: string;
  /** Fresh, output-validated data. */
  data: unknown;
}

/** Result of `registry.list`. */
export type RegistryListResult = CapabilityMeta[];
