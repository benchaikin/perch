/**
 * Unit tests for `agentNotifications` — the `agents.list` change-detection hook.
 * Announces a session newly blocked or newly ended; silent on the first poll and
 * on first-seen sessions.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { agentNotifications } from "./notify.js";
import type { AgentFleet, AgentSession } from "./state.js";

const agent = (over: Partial<AgentSession> & Pick<AgentSession, "sessionId" | "state">): AgentSession => ({
  lastActivity: 0,
  ...over,
});

const fleet = (...agents: AgentSession[]): AgentFleet => ({ agents });

test("no prev → no notifications (skip first poll)", () => {
  assert.deepEqual(agentNotifications(undefined, fleet(agent({ sessionId: "s1", state: "blocked" }))), []);
});

test("a session newly blocked announces 'Agent needs input'", () => {
  const prev = fleet(agent({ sessionId: "s1", state: "running" }));
  const next = fleet(agent({ sessionId: "s1", state: "blocked", taskId: "ab12" }));
  const notes = agentNotifications(prev, next);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.title, "Agent needs input");
  assert.match(notes[0]!.body!, /dex ab12/);
  assert.equal(notes[0]!.level, "warning");
});

test("a session newly ended announces 'Agent done'", () => {
  const prev = fleet(agent({ sessionId: "s1", state: "running" }));
  const next = fleet(agent({ sessionId: "s1", state: "ended" }));
  const notes = agentNotifications(prev, next);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.title, "Agent done");
  assert.equal(notes[0]!.level, "success");
});

test("an unchanged state announces nothing", () => {
  const prev = fleet(agent({ sessionId: "s1", state: "blocked" }));
  const next = fleet(agent({ sessionId: "s1", state: "blocked" }));
  assert.deepEqual(agentNotifications(prev, next), []);
});

test("a first-seen session is not announced", () => {
  const prev = fleet();
  const next = fleet(agent({ sessionId: "new", state: "blocked" }));
  assert.deepEqual(agentNotifications(prev, next), []);
});
