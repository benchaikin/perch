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
  worstServiceHealth,
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

test("toServiceRow offers the Logs button on every status (M3)", () => {
  const empty = new Set<string>();
  for (const status of ["running", "starting", "stopped", "crashed", "completed"] as const) {
    assert.equal(toServiceRow({ name: "svc", status }, empty).logs, true);
  }
});

test("buildServicesSection gives every row a Logs affordance", () => {
  const list: ServiceList = {
    available: true,
    services: [
      { name: "api", status: "running" },
      { name: "db", status: "crashed", exitCode: 1 },
    ],
  };
  const section = buildServicesSection(list);
  assert.ok(section.rows.every((r) => r.logs === true));
});

test("buildServicesSection hides when no list / unreachable / empty", () => {
  assert.deepEqual(buildServicesSection(undefined), { visible: false, rows: [], controls: [] });
  assert.deepEqual(buildServicesSection({ services: [], available: false }), {
    visible: false,
    rows: [],
    controls: [],
  });
  // Reachable but empty → still hidden (nothing to show).
  assert.deepEqual(buildServicesSection({ services: [], available: true }), {
    visible: false,
    rows: [],
    controls: [],
  });
});

test("buildServicesSection shows configured procs (stopped) when the server is down", () => {
  // process-compose down but procs configured: the daemon surfaces them as
  // stopped rows with available:false. The section shows, offering Start all.
  const list: ServiceList = {
    available: false,
    services: [
      { name: "api", status: "stopped" },
      { name: "db", status: "stopped" },
    ],
  };
  const section = buildServicesSection(list);
  assert.equal(section.visible, true);
  assert.equal(section.rows.length, 2);
  // Only Start all is offered while the server is down.
  assert.deepEqual(
    section.controls.map((c) => c.action),
    ["startAll"],
  );
});

test("buildServicesSection offers the full bulk trio when the server is up", () => {
  const section = buildServicesSection({
    available: true,
    services: [{ name: "api", status: "running" }],
  });
  assert.deepEqual(
    section.controls.map((c) => c.action),
    ["startAll", "stopAll", "restartAll"],
  );
});

test("buildServicesSection threads the in-flight bulk action through", () => {
  const section = buildServicesSection(
    { available: true, services: [{ name: "api", status: "running" }] },
    [],
    "restartAll",
  );
  assert.equal(section.bulkActing, "restartAll");
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

test("worstServiceHealth picks the most severe row (bad > warn > ok > muted)", () => {
  const sec = (...statuses: ServiceList["services"][number]["status"][]) =>
    buildServicesSection({ available: true, services: statuses.map((s, i) => ({ name: `s${i}`, status: s })) });
  // A crash dominates everything.
  assert.equal(worstServiceHealth(sec("running", "crashed", "stopped")), "bad");
  // Starting (warn) outranks running/stopped but not a crash.
  assert.equal(worstServiceHealth(sec("running", "starting")), "warn");
  // Any running with nothing worse → ok.
  assert.equal(worstServiceHealth(sec("running", "stopped", "completed")), "ok");
  // All stopped → muted (nothing notable).
  assert.equal(worstServiceHealth(sec("stopped", "stopped")), "muted");
  // No rows (hidden section) → muted.
  assert.equal(worstServiceHealth({ visible: false, rows: [], controls: [] }), "muted");
});
