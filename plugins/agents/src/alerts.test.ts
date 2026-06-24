/**
 * Unit tests for `agentAlerts` — the `agents.list` durable-alert hook. Raises a
 * `agents:<sessionId>:blocked` alert while a session is blocked awaiting input and
 * clears it when the session resumes, ends, or disappears. Unlike `notify`, it
 * does NOT suppress the first poll; and a still-blocked session with an unchanged
 * message emits no op (no `raisedAt` churn).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { agentAlerts, blockedAlertId, type BlockedAgentAlert } from "./alerts.js";
import type { AgentFleet, AgentSession } from "./state.js";

const agent = (
  over: Partial<AgentSession> & Pick<AgentSession, "sessionId" | "state">,
): AgentSession => ({ lastActivity: 0, ...over });

const fleet = (...agents: AgentSession[]): AgentFleet => ({ agents });

test("blockedAlertId is the documented, session-stable id", () => {
  assert.equal(blockedAlertId("s1"), "agents:s1:blocked");
});

test("first poll (no prev) raises a currently-blocked session — durable, not suppressed", () => {
  const next = fleet(
    agent({ sessionId: "s1", state: "blocked", taskId: "ab12", branch: "dex/ab12-x", cwd: "/wt", message: "Allow?" }),
  );
  const ops = agentAlerts(undefined, next);
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0], {
    op: "raise",
    id: "agents:s1:blocked",
    payload: {
      sessionId: "s1",
      taskId: "ab12",
      branch: "dex/ab12-x",
      cwd: "/wt",
      message: "Allow?",
    } satisfies BlockedAgentAlert,
  });
});

test("a session newly blocked raises", () => {
  const prev = fleet(agent({ sessionId: "s1", state: "running" }));
  const next = fleet(agent({ sessionId: "s1", state: "blocked", message: "Run tool?" }));
  const ops = agentAlerts(prev, next);
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.op, "raise");
  assert.equal(ops[0]!.id, "agents:s1:blocked");
});

test("a still-blocked session with an unchanged message emits nothing (no raisedAt churn)", () => {
  const prev = fleet(agent({ sessionId: "s1", state: "blocked", message: "Allow?" }));
  const next = fleet(agent({ sessionId: "s1", state: "blocked", message: "Allow?" }));
  assert.deepEqual(agentAlerts(prev, next), []);
});

test("a still-blocked session whose message changed re-raises (payload refresh)", () => {
  const prev = fleet(agent({ sessionId: "s1", state: "blocked", message: "Allow A?" }));
  const next = fleet(agent({ sessionId: "s1", state: "blocked", message: "Allow B?" }));
  const ops = agentAlerts(prev, next);
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.op, "raise");
  assert.equal((ops[0] as { payload: BlockedAgentAlert }).payload.message, "Allow B?");
});

test("a session that resumes (running) clears its blocked alert", () => {
  const prev = fleet(agent({ sessionId: "s1", state: "blocked" }));
  const next = fleet(agent({ sessionId: "s1", state: "running" }));
  assert.deepEqual(agentAlerts(prev, next), [{ op: "clear", id: "agents:s1:blocked" }]);
});

test("a session that ends clears its blocked alert", () => {
  const prev = fleet(agent({ sessionId: "s1", state: "blocked" }));
  const next = fleet(agent({ sessionId: "s1", state: "ended" }));
  assert.deepEqual(agentAlerts(prev, next), [{ op: "clear", id: "agents:s1:blocked" }]);
});

test("a blocked session pruned out of the fleet entirely clears its alert", () => {
  const prev = fleet(agent({ sessionId: "s1", state: "blocked" }));
  const next = fleet();
  assert.deepEqual(agentAlerts(prev, next), [{ op: "clear", id: "agents:s1:blocked" }]);
});

test("independent sessions raise/clear independently in one diff", () => {
  const prev = fleet(
    agent({ sessionId: "s1", state: "blocked", message: "m" }),
    agent({ sessionId: "s2", state: "running" }),
  );
  const next = fleet(
    agent({ sessionId: "s1", state: "running" }),
    agent({ sessionId: "s2", state: "blocked" }),
  );
  const ops = agentAlerts(prev, next);
  assert.equal(ops.length, 2);
  assert.ok(ops.some((o) => o.op === "clear" && o.id === "agents:s1:blocked"));
  assert.ok(ops.some((o) => o.op === "raise" && o.id === "agents:s2:blocked"));
});

test("a non-blocked fleet with no prior blocks is a no-op", () => {
  const prev = fleet(agent({ sessionId: "s1", state: "idle" }));
  const next = fleet(agent({ sessionId: "s1", state: "running" }));
  assert.deepEqual(agentAlerts(prev, next), []);
});
