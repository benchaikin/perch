/**
 * @perch/plugin-agents — the agent-session data source. It ingests Claude Code
 * hook events (via the `agents.report` action a session's hooks shell on every
 * event) and exposes the live agent fleet as the subscribable `agents.list`
 * read, so a developer running many Claude Code agents across `dex/<id>`
 * worktrees can see, at a glance, which are running, blocked-awaiting-input, or
 * done.
 *
 * Ingestion (per `docs/agent-hooks-spike.md`): a Claude Code hook runs one cheap
 * command per event — `perch agents report --stdin-json` — which forwards the
 * raw hook JSON payload (`session_id`, `hook_event_name`, `cwd`, …) on stdin.
 * The `report` action folds that event into a per-session store via the pure
 * {@link applyEvent} state machine, resolving best-effort dex-task attribution
 * from the event's `cwd` (its git branch → `parseDexTaskId`). `agents.list`
 * renders the store, sorted newest-activity first, and notifies on a session
 * newly blocked or ended.
 *
 * State store: a module-level `Map<sessionId, AgentSession>`. It persists across
 * capability invocations within the daemon process — fine for v1 (a fleet view
 * over the current session, not durable history). A daemon restart starts fresh;
 * hooks repopulate it as agents emit their next events.
 */
import { action, definePlugin, gitConfigOf, read, z } from "@perch/sdk";

import { AttributionProvider, type Exec } from "./provider.js";
import { agentNotifications } from "./notify.js";
import {
  AgentFleet,
  AgentState,
  type AgentEvent,
  type AgentStore,
  applyEvent,
  buildFleet,
  pruneEnded,
} from "./state.js";

export { AgentFleet, AgentSession, AgentState, applyEvent, buildFleet } from "./state.js";
export type { AgentEvent, AgentStore } from "./state.js";
export { AttributionProvider } from "./provider.js";
export type { Attribution, Exec } from "./provider.js";
export { agentNotifications } from "./notify.js";

/**
 * The fleet store — a module-level `Map<sessionId, AgentSession>` that persists
 * across capability invocations within the daemon process. `report` writes it;
 * `list` reads it. Exported (with a reset) so tests can drive the capabilities
 * deterministically.
 */
const store: AgentStore = new Map();

/** Clear the fleet store (tests only). */
export function __resetStore(): void {
  store.clear();
}

/** A read-only snapshot of the store (tests only). */
export function __store(): AgentStore {
  return store;
}

/**
 * Test seam for the git attribution runner. `ctx` carries no exec, so tests
 * override this to feed fixture stdout without spawning git. Defaults to the
 * provider's real runner.
 */
let execOverride: Exec | undefined;

/** Inject an `exec` stub for the attribution provider (tests only); pass `undefined` to reset. */
export function __setExec(exec: Exec | undefined): void {
  execOverride = exec;
}

/**
 * The raw hook payload the `report` action accepts. Snake_case to match the
 * Claude Code hook JSON exactly, so the hook can forward its stdin payload
 * verbatim (via `perch agents report --stdin-json`). Loose + passthrough: we
 * read only the subset we need and ignore the rest, so an upstream hook-schema
 * addition can't break ingestion. `--key value` CLI flags are also accepted (the
 * generated CLI maps them into this object) for a flag-style invocation.
 */
const ReportInput = z
  .object({
    session_id: z.string(),
    hook_event_name: z.string(),
    cwd: z.string().optional(),
    notification_type: z.string().optional(),
    message: z.string().optional(),
    transcript_path: z.string().optional(),
  })
  .passthrough();
export type ReportInput = z.infer<typeof ReportInput>;

/** The small ack the `report` action returns to the (fire-and-forget) hook. */
const ReportAck = z.object({
  ok: z.boolean(),
  sessionId: z.string(),
  state: AgentState,
});
export type ReportAck = z.infer<typeof ReportAck>;

export default definePlugin({
  id: "agents",
  name: "Agents",
  capabilities: {
    /**
     * Ingest one Claude Code hook event into the fleet store. This is the
     * ingestion endpoint a session's hooks shell on every event (CLI-exposed,
     * not on the GUI). It resolves best-effort dex-task attribution from the
     * event's `cwd`, applies the {@link applyEvent} state transition, and returns
     * a small ack. MCP-exposed so an agent could report on another's behalf.
     */
    report: action<ReportInput, unknown, ReportAck>({
      summary: "Ingest a Claude Code hook event into the agent fleet",
      input: ReportInput,
      expose: { mcp: true },
      run: async ({ input, ctx }): Promise<ReportAck> => {
        const provider = new AttributionProvider(gitConfigOf(ctx.global).gitBin ?? "git", {
          exec: execOverride,
        });
        // Attribute the cwd to a dex task (best-effort; never throws).
        const { branch, taskId } = await provider.attribute(input.cwd);
        const event: AgentEvent = {
          sessionId: input.session_id,
          hookEventName: input.hook_event_name,
          cwd: input.cwd,
          notificationType: input.notification_type,
          message: input.message,
          transcriptPath: input.transcript_path,
          branch,
          taskId,
        };
        const state = applyEvent(store, event);
        ctx.log(`agents.report: ${input.hook_event_name} ${input.session_id.slice(0, 8)} → ${state}`);
        return { ok: true, sessionId: input.session_id, state };
      },
    }),

    /**
     * The live agent fleet, newest-activity first. Subscribable + polled (5s) and
     * refreshed on focus, mirroring `services.list`. Exposed on MCP so an agent
     * can ask "which of my agents are blocked?". Reads the module-level store —
     * never throws.
     */
    list: read({
      summary: "Live Claude Code agent fleet (running / blocked / idle / ended)",
      input: z.object({}).default({}),
      output: AgentFleet,
      // Background (panel-closed) polling drops to 30s — the live fleet only
      // needs 5s resolution while someone's actually watching it.
      refresh: { every: "5s", idleEvery: "30s", on: ["focus"] },
      view: { kind: "list", title: "Agents" },
      expose: { mcp: true },
      run: (): AgentFleet => {
        // Snapshot the fleet (still including any `ended` sessions), then evict
        // those ended sessions from the store. This snapshot keeps them for this
        // one poll — so the panel shows the agent finished and the `notify` hook
        // below can fire "Agent done" — but the next poll won't, so a done
        // agent's marker doesn't linger. (buildFleet returns a fresh array, so
        // pruning the store afterwards doesn't mutate what we return here.)
        const fleet = buildFleet(store);
        pruneEnded(store);
        return fleet;
      },
      // Announce a session newly blocked (needs input) or newly ended (done).
      notify: ({ prev, next }) => agentNotifications(prev, next),
    }),
  },
});
