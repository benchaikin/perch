/**
 * Electron-free, pure state machine for the agent fleet. No process spawning, no
 * I/O, no daemon — it folds Claude Code hook events into a per-session
 * {@link AgentSession} record, so the transition logic unit-tests directly.
 *
 * The model (per `docs/agent-hooks-spike.md`): each Claude Code session (keyed
 * by `session_id`) carries one of five states —
 *
 *   running   — actively working (a prompt/tool event was the last activity)
 *   blocked   — waiting on the human (a permission / elicitation Notification)
 *   idle      — finished a turn, awaiting the next prompt (Stop / idle_prompt)
 *   ended     — the session terminated (SessionEnd)
 *   error     — derived heuristically (not a first-class hook signal); unused v1
 *
 * The crucial bit is the **blocked latch**: `Notification{permission_prompt |
 * elicitation_dialog}` SETS `blocked`, and there is no dedicated "user
 * responded" event — the latch is CLEARED by the very next *activity* event
 * (`UserPromptSubmit` / `PreToolUse` / `PostToolUse`) or by `Stop` for the same
 * session. So `applyEvent` treats `blocked` as a latch reset by the next
 * activity, not something a hook explicitly unsets.
 */
import { z } from "@perch/sdk";

/** The lifecycle state of a single Claude Code session. */
export const AgentState = z.enum(["running", "blocked", "idle", "ended", "error"]);
export type AgentState = z.infer<typeof AgentState>;

/**
 * One agent (Claude Code session) in the fleet, keyed by `sessionId`. `cwd` is
 * the attribution anchor (the agent's working directory); `taskId`/`branch` are
 * the best-effort dex-task attribution resolved from that cwd's worktree.
 */
export const AgentSession = z.object({
  /** Stable session UUID — the agent's identity key. */
  sessionId: z.string(),
  state: AgentState,
  /** The agent's working directory (the dex worktree path, for a dex run). */
  cwd: z.string().optional(),
  /** The dex task id this session is attributed to, when its cwd resolves to one. */
  taskId: z.string().optional(),
  /** The git branch at `cwd`, when resolved (e.g. `dex/<id>-<slug>`). */
  branch: z.string().optional(),
  /** Epoch-ms of the last event applied for this session. */
  lastActivity: z.number(),
  /** The latest `Notification` message, when one set/affected the state. */
  message: z.string().optional(),
});
export type AgentSession = z.infer<typeof AgentSession>;

/** `agents.list`'s output: the live fleet, newest-activity first. */
export const AgentFleet = z.object({
  agents: z.array(AgentSession),
});
export type AgentFleet = z.infer<typeof AgentFleet>;

/**
 * A normalized hook event — the fields `applyEvent` folds into the store. The
 * `report` action validates the raw hook payload (snake_case) into this shape.
 */
export interface AgentEvent {
  sessionId: string;
  hookEventName: string;
  cwd?: string;
  /**
   * For `Notification` events: the kind of notification, e.g.
   * `permission_prompt`, `idle_prompt`, `elicitation_dialog`,
   * `elicitation_complete`. Drives the blocked latch.
   */
  notificationType?: string;
  message?: string;
  transcriptPath?: string;
  /** Best-effort attribution resolved from `cwd` by the caller (not the hook). */
  taskId?: string;
  branch?: string;
  /** Epoch-ms the event was applied; defaults to `Date.now()`. */
  at?: number;
}

/** The mutable fleet store: per-session records keyed by `sessionId`. */
export type AgentStore = Map<string, AgentSession>;

/**
 * Hook events that count as *activity* (the agent is working). Each clears the
 * blocked latch and moves the session to `running`.
 */
const ACTIVITY_EVENTS = new Set(["UserPromptSubmit", "PreToolUse", "PostToolUse"]);

/** Notification types that SET the blocked latch (the agent needs the human). */
const BLOCKING_NOTIFICATIONS = new Set(["permission_prompt", "elicitation_dialog"]);

/**
 * Fold one hook event into the store, mutating the session's record in place
 * (creating it on first sight), and return the session's new state. Pure aside
 * from the supplied store mutation — no I/O — so it tests directly.
 *
 * Transition table (per the spike):
 *   - activity (`UserPromptSubmit` / `PreToolUse` / `PostToolUse`) → `running`,
 *     and CLEARS `blocked`.
 *   - `Notification{permission_prompt | elicitation_dialog}`       → `blocked` (latch).
 *   - `Notification{idle_prompt}`                                  → `idle`.
 *   - `Notification{elicitation_complete}`                         → `running` (clears blocked).
 *   - `Stop`                                                       → `idle` (clears blocked).
 *   - `SessionEnd`                                                 → `ended`.
 *   - `SessionStart` / anything else                              → `idle` (a benign default;
 *     a following prompt promotes it to `running`). Never downgrades `blocked`.
 */
export function applyEvent(store: AgentStore, event: AgentEvent): AgentState {
  const at = event.at ?? Date.now();
  const prev = store.get(event.sessionId);

  // Carry attribution forward: a later event may omit cwd/taskId (e.g. some
  // Notifications), so keep the last-known values rather than wiping them.
  const cwd = event.cwd ?? prev?.cwd;
  const taskId = event.taskId ?? prev?.taskId;
  const branch = event.branch ?? prev?.branch;

  const nextState = transition(prev?.state, event);

  const session: AgentSession = {
    sessionId: event.sessionId,
    state: nextState,
    cwd,
    taskId,
    branch,
    lastActivity: at,
    // Keep the message only while it's relevant: a Notification supplies one;
    // any other transition drops it so a stale prompt doesn't linger.
    message: event.hookEventName === "Notification" ? event.message : undefined,
  };
  store.set(event.sessionId, session);
  return nextState;
}

/** The pure state transition: previous state + event → next state. */
function transition(prev: AgentState | undefined, event: AgentEvent): AgentState {
  const name = event.hookEventName;

  if (name === "SessionEnd") return "ended";
  if (name === "Stop") return "idle"; // clears blocked
  if (ACTIVITY_EVENTS.has(name)) return "running"; // clears blocked

  if (name === "Notification") {
    const type = event.notificationType;
    if (type && BLOCKING_NOTIFICATIONS.has(type)) return "blocked"; // SET the latch
    if (type === "idle_prompt") return "idle";
    if (type === "elicitation_complete") return "running"; // clears blocked
    // An unrecognized notification (auth_success, etc.) doesn't change the
    // lifecycle: keep the prior state (defaulting to idle on first sight).
    return prev ?? "idle";
  }

  // SessionStart and any other/unknown event: a benign idle default that a
  // following activity event promotes. Never clobbers an existing blocked latch.
  if (prev === "blocked") return "blocked";
  return prev ?? "idle";
}

/** The fleet snapshot from a store: every session, newest-activity first. */
export function buildFleet(store: AgentStore): AgentFleet {
  const agents = [...store.values()].sort((a, b) => b.lastActivity - a.lastActivity);
  return { agents };
}

/**
 * Evict every `ended` session from the store, returning the count removed.
 *
 * The `agents.list` read calls this AFTER building its fleet snapshot, so an
 * ended session is surfaced for exactly one poll — long enough for that snapshot
 * to show it and for the `notify` hook to fire the "Agent done" banner — and is
 * gone by the next poll. This is what stops a finished agent's marker from
 * lingering in the fleet: `SessionEnd` latches `ended`, the next poll shows it
 * once, and this prune clears it.
 */
export function pruneEnded(store: AgentStore): number {
  let removed = 0;
  for (const [sessionId, session] of store) {
    if (session.state === "ended") {
      store.delete(sessionId);
      removed += 1;
    }
  }
  return removed;
}
