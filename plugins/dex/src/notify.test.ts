/**
 * Unit tests for dex blocked/ready change notifications.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { dexNotifications } from "./notify.js";
import type { DexBoard, DexStatus } from "./normalize.js";

/** Minimal board from (id,status) pairs; other fields are inert for notify. */
function board(...pairs: Array<[string, DexStatus]>): DexBoard {
  return {
    tasks: pairs.map(([id, status]) => ({
      id,
      name: id,
      description: "",
      result: null,
      status,
      priority: 0,
      depth: 0,
      isEpic: false,
      blockedByCount: status === "blocked" ? 1 : 0,
    })),
  };
}

test("no notifications on the first poll (no prev)", () => {
  assert.deepEqual(dexNotifications(undefined, board(["a", "blocked"])), []);
});

test("fires when a task becomes blocked", () => {
  const notes = dexNotifications(board(["a", "ready"]), board(["a", "blocked"]));
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.title, "Task blocked");
  assert.equal(notes[0]!.level, "warning");
  assert.equal(notes[0]!.dedupeKey, "dex:a:blocked");
});

test("fires 'ready' only on a blocked → ready transition", () => {
  // blocked → ready announces.
  const unblocked = dexNotifications(board(["a", "blocked"]), board(["a", "ready"]));
  assert.equal(unblocked.length, 1);
  assert.equal(unblocked[0]!.title, "Task ready");
  assert.equal(unblocked[0]!.level, "success");
  // ready arriving from in-progress (not blocked) does NOT announce.
  assert.deepEqual(dexNotifications(board(["a", "in-progress"]), board(["a", "ready"])), []);
});

test("no notification when status is unchanged or unrelated", () => {
  assert.deepEqual(dexNotifications(board(["a", "ready"]), board(["a", "ready"])), []);
  // ready → in-progress is not a blocked-related transition.
  assert.deepEqual(dexNotifications(board(["a", "ready"]), board(["a", "in-progress"])), []);
});

test("a brand-new task is not announced (only transitions of known tasks)", () => {
  // 'b' wasn't in prev → skipped even though it's blocked.
  assert.deepEqual(dexNotifications(board(["a", "ready"]), board(["a", "ready"], ["b", "blocked"])), []);
});
