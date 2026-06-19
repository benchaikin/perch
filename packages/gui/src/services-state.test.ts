/**
 * Unit tests for the Electron-free Services-section view-model derivation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildServicesSection,
  serviceButtons,
  serviceHealth,
  SERVICES_PANE_SCOPE,
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

test("toServiceRow puts the exit code in detail (crashed) and the pid on its own field (running)", () => {
  const empty = new Set<string>();
  const crashed = toServiceRow({ name: "db", status: "crashed", exitCode: 1 }, empty);
  assert.equal(crashed.detail, "exit 1");
  assert.equal(crashed.pid, undefined);
  // A running service's pid rides `row.pid` (badged), NOT the plain-text detail.
  const running = toServiceRow({ name: "api", status: "running", pid: 42 }, empty);
  assert.equal(running.pid, 42);
  assert.equal(running.detail, undefined);
  // A stopped service has neither a detail suffix nor a pid badge.
  const stopped = toServiceRow({ name: "x", status: "stopped", pid: 7 }, empty);
  assert.equal(stopped.detail, undefined);
  assert.equal(stopped.pid, undefined);
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
  const hidden = { visible: false, rows: [], controls: [], grouped: false, repoGroups: [] };
  assert.deepEqual(buildServicesSection(undefined), hidden);
  assert.deepEqual(buildServicesSection({ services: [], available: false }), hidden);
  // Reachable but empty → still hidden (nothing to show).
  assert.deepEqual(buildServicesSection({ services: [], available: true }), hidden);
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

test("buildServicesSection threads the flat-fallback bulk action through (pane scope)", () => {
  // No projects[] → flat fallback; the unscoped pane cluster reads its in-flight
  // action from the pane-scope key.
  const section = buildServicesSection(
    { available: true, services: [{ name: "api", status: "running" }] },
    [],
    new Map([[SERVICES_PANE_SCOPE, "restartAll"]]),
  );
  assert.equal(section.bulkActing, "restartAll");
});

test("buildServicesSection: per-group controls + per-scope bulkActing", () => {
  const list: ServiceList = {
    available: true,
    projects: ["ashby", "web"],
    services: [
      { name: "api", status: "running", project: "ashby" },
      { name: "ui", status: "running", project: "web" },
    ],
  };
  // Only `ashby`'s stopAll is in flight.
  const section = buildServicesSection(list, [], new Map([["ashby", "stopAll"]]));
  const byProject = new Map(section.repoGroups.map((g) => [g.project, g]));
  // Every named group carries the full trio (server up); only ashby spins.
  assert.deepEqual(
    byProject.get("ashby")!.controls.map((c) => c.action),
    ["startAll", "stopAll", "restartAll"],
  );
  assert.equal(byProject.get("ashby")!.bulkActing, "stopAll");
  assert.deepEqual(
    byProject.get("web")!.controls.map((c) => c.action),
    ["startAll", "stopAll", "restartAll"],
  );
  assert.equal(byProject.get("web")!.bulkActing, undefined);
});

test("buildServicesSection: the (unknown) bucket carries no scoped controls", () => {
  const list: ServiceList = {
    available: true,
    projects: ["ashby"],
    services: [
      { name: "api", status: "running", project: "ashby" },
      { name: "stray", status: "running" }, // no project → "(unknown)"
    ],
  };
  const section = buildServicesSection(list);
  const unknown = section.repoGroups.find((g) => g.project === "(unknown)")!;
  assert.deepEqual(unknown.controls, []);
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

test("buildServicesSection: single configured repo groups under one header", () => {
  const list: ServiceList = {
    available: true,
    projects: ["ashby"],
    services: [{ name: "api", status: "running", project: "ashby" }],
  };
  const section = buildServicesSection(list);
  assert.equal(section.grouped, true);
  assert.deepEqual(
    section.repoGroups.map((g) => [g.project, g.rows.map((r) => r.name)]),
    [["ashby", ["api"]]],
  );
});

test("buildServicesSection: a list with no projects[] (older daemon) stays flat", () => {
  const list: ServiceList = {
    available: true,
    services: [
      { name: "api", status: "running" },
      { name: "db", status: "stopped" },
    ],
  };
  const section = buildServicesSection(list);
  assert.equal(section.grouped, false);
  assert.deepEqual(section.repoGroups, []);
});

test("buildServicesSection: 2+ configured repos group rows in config order", () => {
  const list: ServiceList = {
    available: true,
    projects: ["ashby", "web", "perch"],
    services: [
      { name: "api", status: "running", project: "ashby" },
      { name: "ui", status: "running", project: "web" },
      { name: "worker", status: "stopped", project: "ashby" },
    ],
  };
  const section = buildServicesSection(list);
  assert.equal(section.grouped, true);
  // One group per configured repo, in config order — INCLUDING the empty `perch`.
  assert.deepEqual(
    section.repoGroups.map((g) => [g.project, g.rows.map((r) => r.name)]),
    [
      ["ashby", ["api", "worker"]],
      ["web", ["ui"]],
      ["perch", []],
    ],
  );
});

test("buildServicesSection: an unmapped row buckets under (unknown) when grouped", () => {
  const list: ServiceList = {
    available: true,
    projects: ["ashby", "web"],
    services: [
      { name: "api", status: "running", project: "ashby" },
      // No project (e.g. an externally-managed compose proc) → "(unknown)".
      { name: "stray", status: "running" },
    ],
  };
  const section = buildServicesSection(list);
  assert.equal(section.grouped, true);
  assert.deepEqual(
    section.repoGroups.map((g) => [g.project, g.rows.map((r) => r.name)]),
    [
      ["ashby", ["api"]],
      ["web", []],
      ["(unknown)", ["stray"]],
    ],
  );
});

test("buildServicesSection: a project on a row but not configured appends a trailing group", () => {
  const list: ServiceList = {
    available: true,
    projects: ["ashby", "web"],
    // `legacy` was dropped from config but still holds a service.
    services: [
      { name: "api", status: "running", project: "ashby" },
      { name: "old", status: "stopped", project: "legacy" },
    ],
  };
  const section = buildServicesSection(list);
  assert.equal(section.grouped, true);
  assert.deepEqual(
    section.repoGroups.map((g) => g.project),
    ["ashby", "web", "legacy"],
  );
});

test("buildServicesSection: threads project onto each row", () => {
  const section = buildServicesSection({
    available: true,
    projects: ["ashby", "web"],
    services: [{ name: "api", status: "running", project: "ashby" }],
  });
  assert.equal(section.rows[0]!.project, "ashby");
});

test("worstServiceHealth picks the most severe row (bad > warn > ok > muted)", () => {
  const sec = (...statuses: ServiceList["services"][number]["status"][]) =>
    buildServicesSection({
      available: true,
      services: statuses.map((s, i) => ({ name: `s${i}`, status: s })),
    });
  // A crash dominates everything.
  assert.equal(worstServiceHealth(sec("running", "crashed", "stopped")), "bad");
  // Starting (warn) outranks running/stopped but not a crash.
  assert.equal(worstServiceHealth(sec("running", "starting")), "warn");
  // Any running with nothing worse → ok.
  assert.equal(worstServiceHealth(sec("running", "stopped", "completed")), "ok");
  // All stopped → muted (nothing notable).
  assert.equal(worstServiceHealth(sec("stopped", "stopped")), "muted");
  // No rows (hidden section) → muted.
  assert.equal(
    worstServiceHealth({ visible: false, rows: [], controls: [], grouped: false, repoGroups: [] }),
    "muted",
  );
});
