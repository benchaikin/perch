import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProcessState } from "./provider.js";
import { buildServiceList, mapStatus, resolveProject, toService } from "./services.js";

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
  const result = buildServiceList(undefined, [{ name: "api" }, { name: "db" }]);
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
  const result = buildServiceList(processes, [{ name: "api" }, { name: "db" }]);
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
  const result = buildServiceList(processes, [
    { name: "backend" },
    { name: "frontend" },
    { name: "async_task_worker" },
  ]);
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
  const result = buildServiceList(processes, [{ name: "backend" }]);
  assert.deepEqual(
    result.services.map((s) => s.name),
    ["backend", "extra"],
  );
});

test("resolveProject: explicit proc.repo wins over cwd inference", () => {
  // Even though cwd sits inside /home/me/other, the explicit repo is honored.
  assert.equal(
    resolveProject({ repo: "ashby", cwd: "/home/me/other/sub" }, ["/home/me/other"]),
    "ashby",
  );
});

test("resolveProject: infers the repo whose dir contains the cwd (basename)", () => {
  const repos = ["/home/me/ashby", "/home/me/perch"];
  // cwd nested inside a configured repo → that repo's basename.
  assert.equal(resolveProject({ cwd: "/home/me/ashby/services/api" }, repos), "ashby");
  // cwd exactly the repo dir → still matches.
  assert.equal(resolveProject({ cwd: "/home/me/perch" }, repos), "perch");
  // Trailing slashes / `..` segments normalize.
  assert.equal(resolveProject({ cwd: "/home/me/ashby/../ashby/api/" }, repos), "ashby");
});

test("resolveProject: undefined when no repo set and cwd matches none", () => {
  const repos = ["/home/me/ashby"];
  // cwd outside every configured repo.
  assert.equal(resolveProject({ cwd: "/tmp/elsewhere" }, repos), undefined);
  // A sibling that merely shares a prefix is NOT a match.
  assert.equal(resolveProject({ cwd: "/home/me/ashby-extra" }, repos), undefined);
  // No repo and no cwd → undefined.
  assert.equal(resolveProject({}, repos), undefined);
  // No configured repos → cwd can't be inferred.
  assert.equal(resolveProject({ cwd: "/home/me/ashby/api" }, []), undefined);
});

test("buildServiceList: tags each row (live + synthesized stopped) with its project", () => {
  const processes: ProcessState[] = [{ name: "api", status: "Running", pid: 1 }];
  // `api` is live (tagged ashby), `worker` is configured-but-absent (stopped, perch).
  const result = buildServiceList(
    processes,
    [
      { name: "api", project: "ashby" },
      { name: "worker", project: "perch" },
    ],
    ["ashby", "perch"],
  );
  assert.deepEqual(
    result.services.map((s) => [s.name, s.status, s.project]),
    [
      ["api", "running", "ashby"],
      ["worker", "stopped", "perch"],
    ],
  );
});

test("buildServiceList: surfaces the configured projects[] (incl. empty repos)", () => {
  // `web` has no proc, but it's a configured repo → still listed in projects[].
  const result = buildServiceList(undefined, [{ name: "api", project: "ashby" }], [
    "ashby",
    "web",
  ]);
  assert.deepEqual(result.projects, ["ashby", "web"]);
});

test("buildServiceList: omits projects[] when no repos are configured", () => {
  const result = buildServiceList([{ name: "api", status: "Running", pid: 1 }]);
  assert.equal(result.projects, undefined);
});

test("buildServiceList: an extra (unconfigured) live proc carries no project", () => {
  const processes: ProcessState[] = [
    { name: "api", status: "Running", pid: 1 },
    { name: "extra", status: "Running", pid: 2 },
  ];
  const result = buildServiceList(processes, [{ name: "api", project: "ashby" }], ["ashby"]);
  const extra = result.services.find((s) => s.name === "extra");
  assert.equal(extra?.project, undefined);
});
