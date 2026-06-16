/**
 * Unit tests for the Electron-free Settings tab-model builder. The window/DOM
 * (left nav, right pane, controls) needs a display + a daemon and is verified by
 * manual launch; the pure transform that folds the per-plugin descriptors into
 * an ordered tab list — including the two always-present pinned tabs and the
 * Repositories ownership flag — is the testable part.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginSettingsDescription } from "@perch/core";
import {
  buildSettingsTabs,
  resolveActiveTab,
  GENERAL_TAB_ID,
  PRS_TAB_ID,
  SERVICES_TAB_ID,
} from "./settings-tabs.js";

/** A minimal descriptor for `id` with `fieldKeys` string fields. */
function desc(id: string, name: string, fieldKeys: string[] = []): PluginSettingsDescription {
  return {
    pluginId: id,
    name,
    fields: fieldKeys.map((key) => ({ key, type: "string", label: key, value: "" })),
  };
}

test("buildSettingsTabs: pins General + Pull Requests + Services even with no descriptors", () => {
  const tabs = buildSettingsTabs([]);
  assert.deepEqual(
    tabs.map((t) => t.id),
    [GENERAL_TAB_ID, PRS_TAB_ID, SERVICES_TAB_ID],
  );
  assert.deepEqual(
    tabs.map((t) => t.label),
    ["General", "Pull Requests", "Services"],
  );
  // No descriptors → no plugin attached, but the tabs still exist.
  assert.equal(tabs[0]!.plugin, undefined);
  assert.equal(tabs[1]!.plugin, undefined);
});

test("buildSettingsTabs: only the Pull Requests tab owns the repos list", () => {
  const tabs = buildSettingsTabs([]);
  assert.equal(tabs.find((t) => t.id === PRS_TAB_ID)!.showRepos, true);
  assert.equal(tabs.find((t) => t.id === SERVICES_TAB_ID)!.showRepos, false);
});

test("buildSettingsTabs: only the Services tab owns the managed-process list", () => {
  const tabs = buildSettingsTabs([]);
  assert.equal(tabs.find((t) => t.id === SERVICES_TAB_ID)!.showServices, true);
  assert.equal(tabs.find((t) => t.id === PRS_TAB_ID)!.showServices, false);
});

test("buildSettingsTabs: attaches the stack + services descriptors to their tabs", () => {
  const tabs = buildSettingsTabs([
    desc(SERVICES_TAB_ID, "Services", ["logTerminal"]),
    desc(PRS_TAB_ID, "Stack", ["stackDirection"]),
  ]);
  const prs = tabs.find((t) => t.id === PRS_TAB_ID)!;
  const services = tabs.find((t) => t.id === SERVICES_TAB_ID)!;
  assert.equal(prs.plugin?.fields[0]!.key, "stackDirection");
  assert.equal(services.plugin?.fields[0]!.key, "logTerminal");
  // Pinned order is fixed regardless of descriptor arrival order.
  assert.deepEqual(
    tabs.map((t) => t.id),
    [GENERAL_TAB_ID, PRS_TAB_ID, SERVICES_TAB_ID],
  );
});

test("buildSettingsTabs: prefers the descriptor's friendly name as the label", () => {
  const tabs = buildSettingsTabs([desc(PRS_TAB_ID, "Pull Request Stack")]);
  assert.equal(tabs.find((t) => t.id === PRS_TAB_ID)!.label, "Pull Request Stack");
});

test("buildSettingsTabs: appends other plugins after the pinned tabs in order", () => {
  const tabs = buildSettingsTabs([
    desc("zeta", "Zeta", ["a"]),
    desc(PRS_TAB_ID, "Stack"),
    desc("alpha", "Alpha", ["b"]),
  ]);
  assert.deepEqual(
    tabs.map((t) => t.id),
    [GENERAL_TAB_ID, PRS_TAB_ID, SERVICES_TAB_ID, "zeta", "alpha"],
  );
});

test("buildSettingsTabs: does not duplicate a pinned plugin as an extra tab", () => {
  const tabs = buildSettingsTabs([desc(SERVICES_TAB_ID, "Services"), desc(PRS_TAB_ID, "Stack")]);
  assert.equal(tabs.filter((t) => t.id === SERVICES_TAB_ID).length, 1);
  assert.equal(tabs.filter((t) => t.id === PRS_TAB_ID).length, 1);
});

test("resolveActiveTab: keeps the current selection when it still exists", () => {
  const tabs = buildSettingsTabs([]);
  assert.equal(resolveActiveTab(tabs, SERVICES_TAB_ID), SERVICES_TAB_ID);
});

test("resolveActiveTab: falls back to the first tab (General) when the selection is gone", () => {
  const tabs = buildSettingsTabs([]);
  assert.equal(resolveActiveTab(tabs, "nope"), GENERAL_TAB_ID);
  assert.equal(resolveActiveTab(tabs, undefined), GENERAL_TAB_ID);
});

test("resolveActiveTab: returns undefined when there are no tabs", () => {
  assert.equal(resolveActiveTab([], "x"), undefined);
});
