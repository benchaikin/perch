/**
 * Change-detection for the `agents.list` read: announce the transitions that
 * matter when coordinating a fleet of Claude Code agents — a session newly
 * **blocked** (it needs the human's input) and a session newly **ended** (it
 * finished). Mirrors the `dex.tasks` / `worktrees.list` notify shape.
 *
 * Pure (no I/O): diffs the previous fleet against the next by `sessionId` +
 * `state`. Returns `[]` on the first poll (no `prev`) so an initial load doesn't
 * spam, and only fires on a genuine state change of an already-known session
 * (a first-seen session isn't announced). Dedup-keyed so a persistent state
 * announces once.
 */
import type { Notification } from "@perch/sdk";

import type { AgentFleet, AgentState } from "./state.js";

/** A short label for a session in a notification body. */
function label(taskId: string | undefined, sessionId: string): string {
  if (taskId) return `dex ${taskId}`;
  return `session ${sessionId.slice(0, 8)}`;
}

export function agentNotifications(prev: AgentFleet | undefined, next: AgentFleet): Notification[] {
  if (prev === undefined) return [];
  const before = new Map<string, AgentState>(prev.agents.map((a) => [a.sessionId, a.state]));
  const notes: Notification[] = [];
  for (const agent of next.agents) {
    const was = before.get(agent.sessionId);
    if (was === undefined || was === agent.state) continue;
    if (agent.state === "blocked") {
      notes.push({
        title: "Agent needs input",
        body: `${label(agent.taskId, agent.sessionId)} is blocked`,
        level: "warning",
        dedupeKey: `agent:${agent.sessionId}:blocked`,
      });
    } else if (agent.state === "ended") {
      notes.push({
        title: "Agent done",
        body: `${label(agent.taskId, agent.sessionId)} ended`,
        level: "success",
        dedupeKey: `agent:${agent.sessionId}:ended`,
      });
    }
  }
  return notes;
}
