/**
 * Unit tests for the Electron-free Services-section view-model derivation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildServicesSection,
  serviceHealth,
  toServiceRow,
  type ServiceList,
} from "./services-state.js";

test("serviceHealth maps each status to a marker color", () => {
  assert.equal(serviceHealth("running"), "ok");
  assert.equal(serviceHealth("completed"), "ok");
  assert.equal(serviceHealth("starting"), "warn");
  assert.equal(serviceHealth("crashed"), "bad");
  assert.equal(serviceHealth("stopped"), "muted");
});

test("toServiceRow surfaces exit code for crashed, pid for running", () => {
  assert.equal(toServiceRow({ name: "db", status: "crashed", exitCode: 1 }).detail, "exit 1");
  assert.equal(toServiceRow({ name: "api", status: "running", pid: 42 }).detail, "pid 42");
  // A stopped service has no detail suffix.
  assert.equal(toServiceRow({ name: "x", status: "stopped" }).detail, undefined);
});

test("buildServicesSection hides when no list / unreachable / empty", () => {
  assert.deepEqual(buildServicesSection(undefined), { visible: false, rows: [] });
  assert.deepEqual(buildServicesSection({ services: [], available: false }), {
    visible: false,
    rows: [],
  });
  // Reachable but empty → still hidden (nothing to show).
  assert.deepEqual(buildServicesSection({ services: [], available: true }), {
    visible: false,
    rows: [],
  });
});

test("buildServicesSection shows rows when available with services", () => {
  const list: ServiceList = {
    available: true,
    services: [
      { name: "api", status: "running", pid: 1 },
      { name: "db", status: "crashed", exitCode: 1 },
    ],
  };
  const section = buildServicesSection(list);
  assert.equal(section.visible, true);
  assert.equal(section.rows.length, 2);
  assert.equal(section.rows[0]!.health, "ok");
  assert.equal(section.rows[1]!.health, "bad");
  assert.equal(section.rows[1]!.detail, "exit 1");
});
