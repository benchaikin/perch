import assert from "node:assert/strict";
import { test } from "node:test";

import { crashNotifications } from "./notify.js";
import type { Service, ServiceList } from "./services.js";

/** Build a Service with sane defaults, overriding only what a case cares about. */
function svc(over: Partial<Service> & { name: string; status: Service["status"] }): Service {
  return {
    name: over.name,
    status: over.status,
    pid: over.pid,
    uptime: over.uptime,
    restartCount: over.restartCount,
    exitCode: over.exitCode,
  };
}

/** Wrap services into a reachable list. */
function list(services: Service[]): ServiceList {
  return { services, available: true };
}

test("prev undefined → no notifications (first poll)", () => {
  const next = list([svc({ name: "api", status: "crashed", exitCode: 1 })]);
  assert.deepEqual(crashNotifications(undefined, next), []);
});

test("running → crashed fires one error notification with the right key + body", () => {
  const prev = list([svc({ name: "api", status: "running" })]);
  const next = list([svc({ name: "api", status: "crashed", exitCode: 1, restartCount: 0 })]);
  const notes = crashNotifications(prev, next);
  assert.equal(notes.length, 1);
  const n = notes[0]!;
  assert.equal(n.level, "error");
  assert.equal(n.title, "Service crashed");
  assert.equal(n.body, "api crashed (exit 1)");
  assert.equal(n.dedupeKey, "api:crashed:0");
});

test("dedupeKey carries the restart count", () => {
  const prev = list([svc({ name: "api", status: "running", restartCount: 3 })]);
  const next = list([svc({ name: "api", status: "crashed", exitCode: 2, restartCount: 3 })]);
  const notes = crashNotifications(prev, next);
  assert.equal(notes[0]!.dedupeKey, "api:crashed:3");
});

test("body omits the exit code when none is known", () => {
  const prev = list([svc({ name: "api", status: "running" })]);
  const next = list([svc({ name: "api", status: "crashed" })]);
  const notes = crashNotifications(prev, next);
  assert.equal(notes[0]!.body, "api crashed");
});

test("Completed-nonzero (mapped to crashed) fires", () => {
  const prev = list([svc({ name: "job", status: "running" })]);
  const next = list([svc({ name: "job", status: "crashed", exitCode: 1 })]);
  assert.equal(crashNotifications(prev, next).length, 1);
});

test("unchanged crashed → no re-fire", () => {
  const prev = list([svc({ name: "api", status: "crashed", exitCode: 1 })]);
  const next = list([svc({ name: "api", status: "crashed", exitCode: 1 })]);
  assert.deepEqual(crashNotifications(prev, next), []);
});

test("recovery (crashed → running) does not fire", () => {
  const prev = list([svc({ name: "api", status: "crashed", exitCode: 1 })]);
  const next = list([svc({ name: "api", status: "running" })]);
  assert.deepEqual(crashNotifications(prev, next), []);
});

test("a process new-and-already-crashed fires once", () => {
  const prev = list([svc({ name: "api", status: "running" })]);
  const next = list([
    svc({ name: "api", status: "running" }),
    svc({ name: "db", status: "crashed", exitCode: 1 }),
  ]);
  const notes = crashNotifications(prev, next);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.dedupeKey, "db:crashed:0");
});
