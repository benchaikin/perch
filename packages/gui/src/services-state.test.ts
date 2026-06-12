/**
 * Unit tests for the Electron-free Services-section view-model derivation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildServicesSection,
  serviceButtons,
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
  const empty = new Set<string>();
  assert.equal(
    toServiceRow({ name: "db", status: "crashed", exitCode: 1 }, empty).detail,
    "exit 1",
  );
  assert.equal(toServiceRow({ name: "api", status: "running", pid: 42 }, empty).detail, "pid 42");
  // A stopped service has no detail suffix.
  assert.equal(toServiceRow({ name: "x", status: "stopped" }, empty).detail, undefined);
});

test("serviceButtons: Restart always; Stop when up, Start when down", () => {
  // Running / starting → Restart + Stop.
  for (const status of ["running", "starting"] as const) {
    assert.deepEqual(
      serviceButtons(status).map((b) => b.action),
      ["restart", "stop"],
    );
  }
  // Stopped / crashed / completed → Restart + Start.
  for (const status of ["stopped", "crashed", "completed"] as const) {
    assert.deepEqual(
      serviceButtons(status).map((b) => b.action),
      ["restart", "start"],
    );
  }
  // Labels are human-readable.
  assert.deepEqual(
    serviceButtons("running").map((b) => b.label),
    ["Restart", "Stop"],
  );
});

test("toServiceRow flags in-flight services and attaches buttons", () => {
  const acting = new Set(["api"]);
  const row = toServiceRow({ name: "api", status: "running", pid: 1 }, acting);
  assert.equal(row.inFlight, true);
  assert.deepEqual(
    row.buttons.map((b) => b.action),
    ["restart", "stop"],
  );
  const idle = toServiceRow({ name: "db", status: "stopped" }, acting);
  assert.equal(idle.inFlight, false);
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
  const section = buildServicesSection(list, ["db"]);
  assert.equal(section.visible, true);
  assert.equal(section.rows.length, 2);
  assert.equal(section.rows[0]!.health, "ok");
  assert.equal(section.rows[1]!.health, "bad");
  assert.equal(section.rows[1]!.detail, "exit 1");
  // `acting` marks only the named service in-flight.
  assert.equal(section.rows[0]!.inFlight, false);
  assert.equal(section.rows[1]!.inFlight, true);
});
