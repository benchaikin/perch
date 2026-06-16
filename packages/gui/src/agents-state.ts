/**
 * Electron-free join between the agent fleet (`agents.list`) and the panel's
 * worktree↔dex-task link. It joins each work-item (a dex task with a live
 * worktree) to the Claude Code session working on it, keyed by dex task id.
 *
 * Like `worktree-task-link.ts` and `landable.ts`, this is a pure GUI-side
 * derivation from a read that already flows into panel state — no plugin-to-
 * plugin calls. A work-item's agent is matched primarily by `taskId`
 * (`agent.taskId === task.id`), falling back to `cwd === worktree.path` when the
 * session carries no taskId. Nothing renders it yet — it's the data foundation
 * for a later fleet view that surfaces "which agent is on this task".
 *
 * The `AgentFleet`/`AgentSession` shapes are mirrored here (rather than
 * depending on the agents plugin) because the GUI is a thin client of the
 * daemon: it only knows the wire shape of `agents.list`'s output, not the
 * plugin's internals — exactly how `PrInfo` mirrors the stack plugin's PR type.
 */

import type { WorktreeTaskLink } from "./worktree-task-link.js";

/** Canonical capability id of the agent fleet read the join consumes. */
export const AGENTS_LIST_ID = "agents.list";

/** The lifecycle state of a Claude Code session (mirrors the plugin's `AgentState`). */
export type AgentState = "running" | "blocked" | "idle" | "ended" | "error";

/**
 * One agent session as it arrives over RPC (the wire shape of the plugin's
 * `AgentSession`). Only the fields the join + a later fleet view need.
 */
export interface AgentSession {
  /** Stable session UUID — the agent's identity key. */
  sessionId: string;
  state: AgentState;
  /** The agent's working directory (the dex worktree path, for a dex run). */
  cwd?: string;
  /** The dex task id this session is attributed to, when its cwd resolves to one. */
  taskId?: string;
  /** The git branch at `cwd`, when resolved (e.g. `dex/<id>-<slug>`). */
  branch?: string;
  /** Epoch-ms of the last event applied for this session. */
  lastActivity: number;
  /** The latest `Notification` message, when one set/affected the state. */
  message?: string;
}

/** `agents.list`'s output: the live fleet (the wire shape of the plugin's `AgentFleet`). */
export interface AgentFleet {
  agents: AgentSession[];
}

/** The agent facet attached to a matched work-item (the fields a row carries). */
export interface AgentSummary {
  sessionId: string;
  state: AgentState;
  cwd?: string;
  branch?: string;
  lastActivity: number;
  message?: string;
}

/** Summarize a session into the facet a work-item carries. */
function summarizeAgent(a: AgentSession): AgentSummary {
  return {
    sessionId: a.sessionId,
    state: a.state,
    cwd: a.cwd,
    branch: a.branch,
    lastActivity: a.lastActivity,
    message: a.message,
  };
}

/**
 * Should candidate `a` replace the already-chosen `chosen` session for a task?
 * Prefer the most-recent `lastActivity` (the live agent); ties break on the
 * lexicographically-larger `sessionId` so the pick is stable across renders even
 * when two sessions share a timestamp.
 */
function preferAgent(a: AgentSession, chosen: AgentSession): boolean {
  if (a.lastActivity !== chosen.lastActivity) return a.lastActivity > chosen.lastActivity;
  return a.sessionId > chosen.sessionId;
}

/**
 * Join the agent fleet to the worktree↔task link and emit each work-item's
 * agent, keyed by dex task id. A session matches a work-item when either:
 *
 *  - **taskId** (primary): `session.taskId === task.id`, or
 *  - **cwd fallback**: the session has no taskId but its `cwd` equals the
 *    work-item's worktree `path`.
 *
 * A work-item is a task with a live worktree (from
 * {@link WorktreeTaskLink.worktreeByTaskId}), so only those tasks are candidates
 * for a match — the join is anchored on the link, mirroring `deriveLandableByTaskId`.
 *
 * When several sessions map to one task we pick one deterministically: the
 * most-recent `lastActivity` wins (see {@link preferAgent}).
 *
 * Tolerant by design: a missing/empty fleet, or a work-item with no matching
 * session, simply omits that task from the map (no throw). Pure: same inputs →
 * same map, no side effects.
 */
export function deriveAgentByTaskId(
  link: WorktreeTaskLink,
  fleet: AgentFleet | undefined,
): Map<string, AgentSummary> {
  const byTaskId = new Map<string, AgentSummary>();
  const agents = fleet?.agents ?? [];
  if (agents.length === 0 || link.worktreeByTaskId.size === 0) return byTaskId;

  // Index sessions for O(1) lookup in both match directions: by their attributed
  // taskId (primary) and by cwd (the fallback when a session lacks a taskId).
  const byTaskIdKey = new Map<string, AgentSession>();
  const byCwd = new Map<string, AgentSession>();
  for (const a of agents) {
    if (a.taskId) {
      const chosen = byTaskIdKey.get(a.taskId);
      if (!chosen || preferAgent(a, chosen)) byTaskIdKey.set(a.taskId, a);
    } else if (a.cwd) {
      const chosen = byCwd.get(a.cwd);
      if (!chosen || preferAgent(a, chosen)) byCwd.set(a.cwd, a);
    }
  }

  for (const [taskId, worktree] of link.worktreeByTaskId) {
    // taskId match wins over the cwd fallback when both are present.
    const match = byTaskIdKey.get(taskId) ?? byCwd.get(worktree.path);
    if (match) byTaskId.set(taskId, summarizeAgent(match));
  }

  return byTaskId;
}
