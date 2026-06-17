/**
 * Unit tests for the pure fleet state machine (`applyEvent` / `buildFleet`).
 * Driven directly against an in-memory store — no daemon, no I/O — so the
 * transition table (and the crucial blocked latch) is exercised in isolation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { applyEvent, buildFleet, pruneEnded, type AgentEvent, type AgentStore } from "./state.js";

/** A fresh store + a small helper to apply an event with a fixed clock. */
function newStore(): AgentStore {
  return new Map();
}

const ev = (over: Partial<AgentEvent> & Pick<AgentEvent, "sessionId" | "hookEventName">): AgentEvent => ({
  ...over,
});

test("activity event → running", () => {
  const store = newStore();
  const state = applyEvent(store, ev({ sessionId: "s1", hookEventName: "UserPromptSubmit" }));
  assert.equal(state, "running");
  assert.equal(store.get("s1")!.state, "running");
});

test("PreToolUse / PostToolUse are activity → running", () => {
  const store = newStore();
  assert.equal(applyEvent(store, ev({ sessionId: "s1", hookEventName: "PreToolUse" })), "running");
  assert.equal(applyEvent(store, ev({ sessionId: "s2", hookEventName: "PostToolUse" })), "running");
});

test("Notification{permission_prompt} → blocked (sets the latch)", () => {
  const store = newStore();
  const state = applyEvent(
    store,
    ev({ sessionId: "s1", hookEventName: "Notification", notificationType: "permission_prompt", message: "Approve?" }),
  );
  assert.equal(state, "blocked");
  assert.equal(store.get("s1")!.message, "Approve?");
});

test("Notification{elicitation_dialog} → blocked", () => {
  const store = newStore();
  const state = applyEvent(
    store,
    ev({ sessionId: "s1", hookEventName: "Notification", notificationType: "elicitation_dialog" }),
  );
  assert.equal(state, "blocked");
});

test("the blocked latch clears on the next activity event", () => {
  const store = newStore();
  applyEvent(store, ev({ sessionId: "s1", hookEventName: "Notification", notificationType: "permission_prompt" }));
  assert.equal(store.get("s1")!.state, "blocked");
  // No dedicated "cleared" event — the next activity event clears it.
  const next = applyEvent(store, ev({ sessionId: "s1", hookEventName: "PreToolUse" }));
  assert.equal(next, "running");
  assert.equal(store.get("s1")!.state, "running");
});

test("Stop clears the blocked latch → idle", () => {
  const store = newStore();
  applyEvent(store, ev({ sessionId: "s1", hookEventName: "Notification", notificationType: "permission_prompt" }));
  const next = applyEvent(store, ev({ sessionId: "s1", hookEventName: "Stop" }));
  assert.equal(next, "idle");
});

test("Notification{elicitation_complete} clears blocked → running", () => {
  const store = newStore();
  applyEvent(store, ev({ sessionId: "s1", hookEventName: "Notification", notificationType: "elicitation_dialog" }));
  const next = applyEvent(
    store,
    ev({ sessionId: "s1", hookEventName: "Notification", notificationType: "elicitation_complete" }),
  );
  assert.equal(next, "running");
});

test("Notification{idle_prompt} → idle (not blocked)", () => {
  const store = newStore();
  const state = applyEvent(
    store,
    ev({ sessionId: "s1", hookEventName: "Notification", notificationType: "idle_prompt" }),
  );
  assert.equal(state, "idle");
});

test("Stop → idle", () => {
  const store = newStore();
  const state = applyEvent(store, ev({ sessionId: "s1", hookEventName: "Stop" }));
  assert.equal(state, "idle");
});

test("SessionEnd → ended", () => {
  const store = newStore();
  applyEvent(store, ev({ sessionId: "s1", hookEventName: "UserPromptSubmit" }));
  const state = applyEvent(store, ev({ sessionId: "s1", hookEventName: "SessionEnd" }));
  assert.equal(state, "ended");
});

test("SessionStart defaults to idle", () => {
  const store = newStore();
  assert.equal(applyEvent(store, ev({ sessionId: "s1", hookEventName: "SessionStart" })), "idle");
});

test("an unrecognized Notification keeps the prior state (latch not downgraded)", () => {
  const store = newStore();
  applyEvent(store, ev({ sessionId: "s1", hookEventName: "Notification", notificationType: "permission_prompt" }));
  // auth_success is not a lifecycle signal — blocked must persist.
  const next = applyEvent(
    store,
    ev({ sessionId: "s1", hookEventName: "Notification", notificationType: "auth_success" }),
  );
  assert.equal(next, "blocked");
});

test("attribution (cwd/taskId/branch) is stored and carried forward", () => {
  const store = newStore();
  applyEvent(
    store,
    ev({
      sessionId: "s1",
      hookEventName: "SessionStart",
      cwd: "/repo/dex-ab12-test",
      taskId: "ab12",
      branch: "dex/ab12-test",
    }),
  );
  let s = store.get("s1")!;
  assert.equal(s.cwd, "/repo/dex-ab12-test");
  assert.equal(s.taskId, "ab12");
  assert.equal(s.branch, "dex/ab12-test");
  // A later event without cwd/taskId keeps the last-known attribution.
  applyEvent(store, ev({ sessionId: "s1", hookEventName: "Stop" }));
  s = store.get("s1")!;
  assert.equal(s.taskId, "ab12");
  assert.equal(s.cwd, "/repo/dex-ab12-test");
});

test("buildFleet sorts by lastActivity desc", () => {
  const store = newStore();
  applyEvent(store, ev({ sessionId: "old", hookEventName: "Stop", at: 100 }));
  applyEvent(store, ev({ sessionId: "new", hookEventName: "Stop", at: 200 }));
  applyEvent(store, ev({ sessionId: "mid", hookEventName: "Stop", at: 150 }));
  const fleet = buildFleet(store);
  assert.deepEqual(
    fleet.agents.map((a) => a.sessionId),
    ["new", "mid", "old"],
  );
});

test("lastActivity updates on each event", () => {
  const store = newStore();
  applyEvent(store, ev({ sessionId: "s1", hookEventName: "UserPromptSubmit", at: 100 }));
  assert.equal(store.get("s1")!.lastActivity, 100);
  applyEvent(store, ev({ sessionId: "s1", hookEventName: "Stop", at: 250 }));
  assert.equal(store.get("s1")!.lastActivity, 250);
});

test("pruneEnded evicts only ended sessions, leaving the rest", () => {
  const store = newStore();
  applyEvent(store, ev({ sessionId: "run", hookEventName: "UserPromptSubmit" }));
  applyEvent(store, ev({ sessionId: "idle", hookEventName: "Stop" }));
  applyEvent(store, ev({ sessionId: "done", hookEventName: "SessionEnd" }));

  const removed = pruneEnded(store);
  assert.equal(removed, 1);
  assert.equal(store.has("done"), false);
  assert.equal(store.has("run"), true);
  assert.equal(store.has("idle"), true);
});

test("pruneEnded after a snapshot: the ended session shows once, then is gone", () => {
  const store = newStore();
  applyEvent(store, ev({ sessionId: "s1", hookEventName: "UserPromptSubmit", at: 100 }));
  applyEvent(store, ev({ sessionId: "s1", hookEventName: "SessionEnd", at: 200 }));

  // This poll still surfaces it (so the panel + notify see "ended")…
  const shown = buildFleet(store);
  pruneEnded(store);
  assert.equal(shown.agents.find((a) => a.sessionId === "s1")?.state, "ended");

  // …the next poll no longer does.
  assert.equal(buildFleet(store).agents.length, 0);
});
