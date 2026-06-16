/**
 * Unit tests for the plugin's capabilities, driving `report.run` / `list.run`
 * directly (no daemon) with a stubbed git runner for attribution. Proves the
 * end-to-end ingestion path at the run() level: a hook-style payload in →
 * fleet out, with the right state + dex-task attribution.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { z } from "@perch/sdk";

import plugin, { __resetStore, __setExec, type ReportInput } from "./index.js";
import type { Exec } from "./provider.js";
import { AgentFleet } from "./state.js";

const report = plugin.capabilities.report!;
const list = plugin.capabilities.list!;

/** A minimal capability context for direct run() calls. */
const ctx = { config: {}, log: () => {}, global: undefined } as never;

/** A git stub returning a dex branch and no config override. */
const dexGit: Exec = (_cmd, args) =>
  args[0] === "branch" ? Promise.resolve("dex/ab12-test\n") : Promise.reject(new Error("unset"));

afterEach(() => {
  __resetStore();
  __setExec(undefined);
});

/** Run the report action with a raw hook payload. */
async function doReport(payload: ReportInput): Promise<unknown> {
  // run() receives validated input; mirror the daemon by parsing it first.
  const input = (report as { input?: z.ZodType<ReportInput> }).input!.parse(payload);
  return (report.run as (a: { input: ReportInput; ctx: never }) => Promise<unknown>)({ input, ctx });
}

/** Read the current fleet. */
function doList(): AgentFleet {
  const out = (list.run as (a: { input: unknown; ctx: never }) => AgentFleet)({ input: {}, ctx });
  return AgentFleet.parse(out);
}

test("report ingests a hook payload, attributes the cwd, and list shows it", async () => {
  __setExec(dexGit);
  const ack = (await doReport({
    session_id: "sess-1",
    hook_event_name: "UserPromptSubmit",
    cwd: "/repo/dex-ab12-test",
  })) as { ok: boolean; state: string; sessionId: string };

  assert.equal(ack.ok, true);
  assert.equal(ack.state, "running");
  assert.equal(ack.sessionId, "sess-1");

  const fleet = doList();
  assert.equal(fleet.agents.length, 1);
  const agent = fleet.agents[0]!;
  assert.equal(agent.sessionId, "sess-1");
  assert.equal(agent.state, "running");
  assert.equal(agent.cwd, "/repo/dex-ab12-test");
  assert.equal(agent.taskId, "ab12");
  assert.equal(agent.branch, "dex/ab12-test");
});

test("a permission_prompt Notification marks the session blocked", async () => {
  __setExec(dexGit);
  await doReport({ session_id: "sess-1", hook_event_name: "SessionStart", cwd: "/repo/dex-ab12-test" });
  const ack = (await doReport({
    session_id: "sess-1",
    hook_event_name: "Notification",
    notification_type: "permission_prompt",
    message: "Allow Bash(rm)?",
    cwd: "/repo/dex-ab12-test",
  })) as { state: string };
  assert.equal(ack.state, "blocked");

  const agent = doList().agents[0]!;
  assert.equal(agent.state, "blocked");
  assert.equal(agent.message, "Allow Bash(rm)?");
});

test("list sorts multiple sessions newest-activity first", async () => {
  __setExec(dexGit);
  await doReport({ session_id: "a", hook_event_name: "Stop" });
  // A 2ms gap so the two reports land in distinct milliseconds (lastActivity is
  // `Date.now()`), making the newest-first ordering deterministic to assert.
  await new Promise((r) => setTimeout(r, 2));
  await doReport({ session_id: "b", hook_event_name: "Stop" });
  const fleet = doList();
  // Both present; the most recently reported ("b") is first.
  assert.equal(fleet.agents.length, 2);
  assert.equal(fleet.agents[0]!.sessionId, "b");
});

test("report tolerates a non-git cwd (no attribution, still ingests)", async () => {
  __setExec(() => Promise.reject(new Error("not a git repo")));
  const ack = (await doReport({
    session_id: "sess-x",
    hook_event_name: "UserPromptSubmit",
    cwd: "/tmp/plain",
  })) as { ok: boolean; state: string };
  assert.equal(ack.ok, true);
  assert.equal(ack.state, "running");
  const agent = doList().agents[0]!;
  assert.equal(agent.taskId, undefined);
  assert.equal(agent.cwd, "/tmp/plain");
});

test("the report action is CLI- and MCP-exposed; list is a read", () => {
  assert.equal(report.kind, "action");
  assert.equal(report.expose?.mcp, true);
  assert.equal(list.kind, "read");
});
