/**
 * Durable-alert derivation for the `agents.list` read — the alert counterpart of
 * {@link ./notify.ts}'s one-shot notifications. A blocked agent (one waiting on
 * the human) is a *standing* condition, so it belongs in the daemon's alert store
 * as a dashboard card that lives until the agent resumes/ends or the user
 * dismisses it — not as a banner that flashes once and is gone.
 *
 * Pure (no I/O): diffs the previous fleet against the next by `sessionId` +
 * `state` and emits {@link AlertOp}s — `raise` for each session newly (or with a
 * changed message) `blocked`, `clear` for each session that was blocked and no
 * longer is (resumed, ended, or gone). The alert id is stable per session
 * ({@link blockedAlertId}) so a raise is idempotent.
 *
 * Unlike `notify`, this does NOT suppress the first poll (`prev` undefined): a
 * blocked agent already present when polling starts (e.g. just after a daemon
 * restart) is a real condition that should surface. To avoid churning the alert's
 * `raisedAt`, a still-blocked session whose message is unchanged emits no op.
 */
import type { AlertOp } from "@perch/sdk";

import type { AgentFleet } from "./state.js";

/** The plugin id alerts are raised under (the AlertWidget registry key). */
export const AGENTS_PLUGIN_ID = "agents";

/** The stable alert id for a session blocked awaiting input. */
export function blockedAlertId(sessionId: string): string {
  return `agents:${sessionId}:blocked`;
}

/**
 * The payload a blocked-agent alert carries to its renderer widget — everything
 * the widget needs to render (session id, the dex task it's attributed to, the
 * blocking message) and to open the agent (its `cwd` worktree). Opaque to the
 * core alert store; only the agents AlertWidget reads it.
 */
export interface BlockedAgentAlert {
  /** The blocked session's id. */
  sessionId: string;
  /** The dex task this session is attributed to, when its cwd resolved to one. */
  taskId?: string;
  /** The git branch at the session's cwd (e.g. `dex/<id>-<slug>`). */
  branch?: string;
  /** The session's working directory — the worktree the Respond action opens. */
  cwd?: string;
  /** The blocking `Notification` message (what input the agent is waiting on). */
  message?: string;
}

/**
 * Diff `prev`→`next` and emit the alert raises/clears for blocked sessions. See
 * the module doc for the first-poll and idempotency semantics.
 */
export function agentAlerts(prev: AgentFleet | undefined, next: AgentFleet): AlertOp[] {
  // sessionId → blocking message, for the sessions blocked in the previous fleet.
  const wasBlocked = new Map<string, string | undefined>();
  for (const agent of prev?.agents ?? []) {
    if (agent.state === "blocked") wasBlocked.set(agent.sessionId, agent.message);
  }

  const ops: AlertOp[] = [];
  const stillBlocked = new Set<string>();
  for (const agent of next.agents) {
    if (agent.state !== "blocked") continue;
    stillBlocked.add(agent.sessionId);
    // Raise only when the condition is newly true or its message changed, so a
    // persistently-blocked agent doesn't re-stamp `raisedAt` every poll.
    if (wasBlocked.has(agent.sessionId) && wasBlocked.get(agent.sessionId) === agent.message) {
      continue;
    }
    ops.push({
      op: "raise",
      id: blockedAlertId(agent.sessionId),
      payload: {
        sessionId: agent.sessionId,
        taskId: agent.taskId,
        branch: agent.branch,
        cwd: agent.cwd,
        message: agent.message,
      } satisfies BlockedAgentAlert,
    });
  }

  // Clear any session that was blocked but isn't anymore (resumed, ended, or
  // pruned out of the fleet entirely).
  for (const sessionId of wasBlocked.keys()) {
    if (!stillBlocked.has(sessionId)) ops.push({ op: "clear", id: blockedAlertId(sessionId) });
  }

  return ops;
}
