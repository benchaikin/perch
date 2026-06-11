/**
 * JSON-RPC contract types shared between `perchd` and its clients (CLI, GUI,
 * MCP). These describe the wire shapes only; the server lives in
 * {@link ./server.ts}.
 *
 * Transport: JSON-RPC 2.0 over a Unix domain socket via `vscode-jsonrpc`.
 */
import type { SettingsField } from "@perch/sdk";
import type { PerchConfig } from "./config.js";
import type { DeliveredNotification } from "./notifications.js";
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
  /** `config.get` → {@link ConfigGetResult} (the current `perch.json`). No params. */
  configGet: "config.get",
  /** `config.update` → {@link ConfigUpdateResult} (the new config). Params: {@link ConfigUpdateParams}. */
  configUpdate: "config.update",
  /** `config.validateRepoPath` → {@link ValidateRepoPathResult}. Params: {@link ValidateRepoPathParams}. */
  configValidateRepoPath: "config.validateRepoPath",
  /**
   * `settings.describe` → {@link SettingsDescribeResult}. No params. Returns, per
   * loaded plugin that declares a settings descriptor, its id/name/fields with the
   * current config value (or the field's default) merged into each field.
   */
  settingsDescribe: "settings.describe",
  /**
   * `notifications.subscribe` → void. No params. Opts this connection into the
   * `notification` stream (all sources; filtering is a client concern).
   */
  notificationsSubscribe: "notifications.subscribe",
  /** `notifications.unsubscribe` → void. No params. Opts back out. */
  notificationsUnsubscribe: "notifications.unsubscribe",
} as const;

/** Notification methods (server → client). */
export const Notifications = {
  /** `capability.update` — fresh read data for a subscription. Payload: {@link UpdateNotification}. */
  capabilityUpdate: "capability.update",
  /**
   * `registry.changed` — the set of capabilities changed (a config reload added,
   * removed, or reconfigured plugins). Clients should re-fetch `registry.list`
   * and refresh their UI. Payload: {@link RegistryChangedNotification}.
   */
  registryChanged: "registry.changed",
  /**
   * `notification` — a change-driven notification produced by a read's `notify`
   * hook, pushed to connections that called `notifications.subscribe`. Payload:
   * {@link NotificationPayload}.
   */
  notification: "notification",
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

/**
 * Payload of a `registry.changed` notification. Summarizes which plugins were
 * affected so clients can log/diff; the authoritative new state is obtained by
 * re-calling `registry.list`.
 */
export interface RegistryChangedNotification {
  /** Plugin ids newly enabled by the reload. */
  added: string[];
  /** Plugin ids newly disabled by the reload. */
  removed: string[];
  /** Plugin ids whose per-plugin config changed (still enabled). */
  updated: string[];
}

/** Result of `registry.list`. */
export type RegistryListResult = CapabilityMeta[];

/** Result of `config.get`: the current parsed `perch.json` (defaults when absent). */
export type ConfigGetResult = PerchConfig;

/** Params for `config.update`. */
export interface ConfigUpdateParams {
  /**
   * A partial config deep-merged into the current one. A `null` value at a key
   * deletes that key; any non-object value (including arrays) replaces wholesale.
   * The GUI computes the full `plugins.stack.repos` array and sends it here.
   */
  patch: Record<string, unknown>;
}

/** Result of `config.update`: the new, validated config after the merge + write. */
export type ConfigUpdateResult = PerchConfig;

/** Params for `config.validateRepoPath`. */
export interface ValidateRepoPathParams {
  /** Absolute local filesystem path to check. */
  path: string;
}

/** Result of `config.validateRepoPath`: whether the path is a usable git repo. */
export interface ValidateRepoPathResult {
  /** True iff the path exists, is a directory, and contains a `.git` entry. */
  ok: boolean;
  /** Human-readable explanation when `ok` is false. */
  reason?: string;
}

/**
 * One field of a `settings.describe` result: the plugin-declared
 * {@link SettingsField} metadata plus the field's **current value**, resolved by
 * the server (the value at `plugins[pluginId].{key}` in `perch.json`, or the
 * field's `default` when unset). Clients render the control from the metadata and
 * seed it with `value`.
 */
export interface SettingsFieldState extends SettingsField {
  /** Current value: the configured value, or {@link SettingsField.default} when unset. */
  value: unknown;
}

/** One plugin's section in a `settings.describe` result. */
export interface PluginSettingsDescription {
  /** The plugin id; its config lives at `plugins[pluginId]`. */
  pluginId: string;
  /** Display name (falls back to `pluginId`). */
  name: string;
  /** The plugin's fields, each with its current {@link SettingsFieldState.value}. */
  fields: SettingsFieldState[];
}

/**
 * Result of `settings.describe`: one entry per loaded plugin that declares a
 * settings descriptor, in registration order. A client can render a full settings
 * form from this and write edits back via `config.update`.
 */
export type SettingsDescribeResult = PluginSettingsDescription[];

export type { SettingsField };

/**
 * Payload of a `notification` notification: a {@link DeliveredNotification}
 * (the plugin's {@link Notification} plus the daemon's id/source/timestamp
 * stamps). Re-exported as the wire name so clients import it from one place.
 */
export type NotificationPayload = DeliveredNotification;
export type { DeliveredNotification };
