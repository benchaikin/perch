/**
 * Unit tests for the Electron-free notification mapping/filtering. The native
 * `Notification`/`shell.openExternal` wiring in `main.ts` needs a display and is
 * verified by manual launch (see README); the projection + backlog predicate
 * here are the testable part.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NotificationPayload } from "@perch/core";
import { shouldShowNotification, toNotifyOptions } from "./notify.js";

/** Build a payload with sensible defaults, overridable per-test. */
function payload(over: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    title: "PR ready",
    body: "stack/feature passed CI",
    level: "success",
    id: "n1",
    source: "stack.prs",
    timestamp: 1000,
    ...over,
  };
}

test("toNotifyOptions passes title and body through", () => {
  assert.deepEqual(toNotifyOptions(payload({ title: "Hi", body: "There" })), {
    title: "Hi",
    body: "There",
  });
});

test("toNotifyOptions normalizes a missing body to an empty string", () => {
  assert.deepEqual(toNotifyOptions(payload({ title: "Hi", body: undefined })), {
    title: "Hi",
    body: "",
  });
});

test("shouldShowNotification shows a notification stamped after start", () => {
  assert.equal(shouldShowNotification(payload({ timestamp: 2000 }), 1000), true);
});

test("shouldShowNotification shows one stamped exactly at start", () => {
  assert.equal(shouldShowNotification(payload({ timestamp: 1000 }), 1000), true);
});

test("shouldShowNotification drops a backlog notification from before start", () => {
  assert.equal(shouldShowNotification(payload({ timestamp: 500 }), 1000), false);
});
