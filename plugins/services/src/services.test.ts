import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProcessState } from "./provider.js";
import { buildServiceList, mapStatus, toService } from "./services.js";

test("mapStatus maps every process-compose status to the plugin enum", () => {
  assert.equal(mapStatus("Running", undefined), "running");
  assert.equal(mapStatus("Foreground", undefined), "running");

  assert.equal(mapStatus("Pending", undefined), "starting");
  assert.equal(mapStatus("Launching", undefined), "starting");
  assert.equal(mapStatus("Launched", undefined), "starting");
  assert.equal(mapStatus("Restarting", undefined), "starting");

  assert.equal(mapStatus("Stopped", undefined), "stopped");
  assert.equal(mapStatus("Terminating", undefined), "stopped");
  assert.equal(mapStatus("Disabled", undefined), "stopped");
  assert.equal(mapStatus("Skipped", undefined), "stopped");

  assert.equal(mapStatus("Error", undefined), "crashed");

  // An unknown status falls back to a safe "stopped".
  assert.equal(mapStatus("SomethingNew", undefined), "stopped");
});

test("mapStatus splits Completed on exit code", () => {
  assert.equal(mapStatus("Completed", 0), "completed");
  assert.equal(mapStatus("Completed", undefined), "completed");
  assert.equal(mapStatus("Completed", 1), "crashed");
  assert.equal(mapStatus("Completed", 137), "crashed");
});

test("toService projects ProcessState fields onto the normalized Service", () => {
  const state: ProcessState = {
    name: "api",
    status: "Running",
    pid: 4242,
    age: 90,
    restarts: 2,
    exit_code: 0,
  };
  assert.deepEqual(toService(state), {
    name: "api",
    status: "running",
    pid: 4242,
    uptime: 90,
    restartCount: 2,
    exitCode: 0,
  });
});

test("buildServiceList: reachable server with processes → available + mapped", () => {
  const processes: ProcessState[] = [
    { name: "api", status: "Running", pid: 1 },
    { name: "worker", status: "Completed", exit_code: 0 },
    { name: "db", status: "Error", exit_code: 1 },
  ];
  const result = buildServiceList(processes);
  assert.equal(result.available, true);
  assert.deepEqual(
    result.services.map((s) => [s.name, s.status]),
    [
      ["api", "running"],
      ["worker", "completed"],
      ["db", "crashed"],
    ],
  );
});

test("buildServiceList: reachable but empty server → available, no services", () => {
  const result = buildServiceList([]);
  assert.deepEqual(result, { services: [], available: true });
});

test("buildServiceList: unreachable server → available:false + empty list", () => {
  const result = buildServiceList(undefined);
  assert.deepEqual(result, { services: [], available: false });
});

test("buildServiceList: unreachable but configured procs → stopped rows, available:false", () => {
  const result = buildServiceList(undefined, ["api", "db"]);
  assert.equal(result.available, false);
  assert.deepEqual(
    result.services.map((s) => [s.name, s.status]),
    [
      ["api", "stopped"],
      ["db", "stopped"],
    ],
  );
});

test("buildServiceList: reachable list is augmented with configured procs not running", () => {
  const processes: ProcessState[] = [{ name: "api", status: "Running", pid: 1 }];
  // `api` is live; `db` is configured but absent → appended as stopped.
  const result = buildServiceList(processes, ["api", "db"]);
  assert.equal(result.available, true);
  assert.deepEqual(
    result.services.map((s) => [s.name, s.status]),
    [
      ["api", "running"],
      ["db", "stopped"],
    ],
  );
});

test("buildServiceList: output follows configured (procs[]) order, not process-compose's", () => {
  // process-compose returns its own order (here: alphabetical); the result must
  // reorder to the configured definition order.
  const processes: ProcessState[] = [
    { name: "async_task_worker", status: "Running", pid: 3 },
    { name: "backend", status: "Running", pid: 1 },
    { name: "frontend", status: "Running", pid: 2 },
  ];
  const result = buildServiceList(processes, ["backend", "frontend", "async_task_worker"]);
  assert.deepEqual(
    result.services.map((s) => s.name),
    ["backend", "frontend", "async_task_worker"],
  );
});

test("buildServiceList: live procs not in config are appended after configured ones", () => {
  const processes: ProcessState[] = [
    { name: "extra", status: "Running", pid: 9 },
    { name: "backend", status: "Running", pid: 1 },
  ];
  // `backend` is configured (first); `extra` isn't → appended after, in pc order.
  const result = buildServiceList(processes, ["backend"]);
  assert.deepEqual(
    result.services.map((s) => s.name),
    ["backend", "extra"],
  );
});
