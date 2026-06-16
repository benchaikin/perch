/**
 * Unit tests for the Electron-free agent-fleet ↔ work-item join.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentFleet, AgentSession } from "./agents-state.js";
import { deriveAgentByTaskId } from "./agents-state.js";
import type { WorktreeTaskLink, LinkedWorktree } from "./worktree-task-link.js";

/** A session with defaults; override per case. */
function session(over: Partial<AgentSession> & { sessionId: string }): AgentSession {
  return {
    state: "running",
    lastActivity: 1,
    ...over,
  };
}

function fleet(...agents: AgentSession[]): AgentFleet {
  return { agents };
}

/** A worktree summary (the task→worktree facet) with a path. */
function linkedWorktree(path: string): LinkedWorktree {
  return { path, branch: "b", dirty: false, dirtyCount: 0 };
}

/** A link with the given task id → worktree path mappings. */
function link(entries: Record<string, string>): WorktreeTaskLink {
  const worktreeByTaskId = new Map<string, LinkedWorktree>();
  for (const [taskId, path] of Object.entries(entries)) {
    worktreeByTaskId.set(taskId, linkedWorktree(path));
  }
  return { taskByWorktreePath: new Map(), worktreeByTaskId };
}

test("matches a session to a work-item by taskId", () => {
  const map = deriveAgentByTaskId(
    link({ t1: "/wt/a" }),
    fleet(session({ sessionId: "s1", taskId: "t1", cwd: "/wt/a", state: "blocked" })),
  );
  assert.equal(map.get("t1")?.sessionId, "s1");
  assert.equal(map.get("t1")?.state, "blocked");
});

test("falls back to cwd === worktree.path when the session has no taskId", () => {
  const map = deriveAgentByTaskId(
    link({ t1: "/wt/a" }),
    fleet(session({ sessionId: "s1", cwd: "/wt/a" })),
  );
  assert.equal(map.get("t1")?.sessionId, "s1");
});

test("taskId match wins over a cwd-only candidate for the same work-item", () => {
  const map = deriveAgentByTaskId(
    link({ t1: "/wt/a" }),
    fleet(
      session({ sessionId: "cwd-only", cwd: "/wt/a", lastActivity: 99 }),
      session({ sessionId: "by-task", taskId: "t1", cwd: "/elsewhere", lastActivity: 1 }),
    ),
  );
  // The taskId match wins even though the cwd candidate is more recent.
  assert.equal(map.get("t1")?.sessionId, "by-task");
});

test("no matching session → task absent from the map", () => {
  const map = deriveAgentByTaskId(
    link({ t1: "/wt/a" }),
    fleet(session({ sessionId: "s1", taskId: "other", cwd: "/wt/other" })),
  );
  assert.equal(map.has("t1"), false);
  assert.equal(map.size, 0);
});

test("a work-item with no live worktree is never matched", () => {
  // No worktreeByTaskId entries → no candidates, even with a matching session.
  const map = deriveAgentByTaskId(
    { taskByWorktreePath: new Map(), worktreeByTaskId: new Map() },
    fleet(session({ sessionId: "s1", taskId: "t1", cwd: "/wt/a" })),
  );
  assert.equal(map.size, 0);
});

test("multiple sessions for one task: most-recent lastActivity wins", () => {
  const map = deriveAgentByTaskId(
    link({ t1: "/wt/a" }),
    fleet(
      session({ sessionId: "old", taskId: "t1", lastActivity: 10 }),
      session({ sessionId: "new", taskId: "t1", lastActivity: 30 }),
      session({ sessionId: "mid", taskId: "t1", lastActivity: 20 }),
    ),
  );
  assert.equal(map.get("t1")?.sessionId, "new");
});

test("multiple cwd-fallback sessions for one task: most-recent wins", () => {
  const map = deriveAgentByTaskId(
    link({ t1: "/wt/a" }),
    fleet(
      session({ sessionId: "old", cwd: "/wt/a", lastActivity: 10 }),
      session({ sessionId: "new", cwd: "/wt/a", lastActivity: 30 }),
    ),
  );
  assert.equal(map.get("t1")?.sessionId, "new");
});

test("tie on lastActivity breaks on the larger sessionId (stable)", () => {
  const map = deriveAgentByTaskId(
    link({ t1: "/wt/a" }),
    fleet(
      session({ sessionId: "a", taskId: "t1", lastActivity: 5 }),
      session({ sessionId: "b", taskId: "t1", lastActivity: 5 }),
    ),
  );
  assert.equal(map.get("t1")?.sessionId, "b");
});

test("missing fleet → empty map, no throw", () => {
  const map = deriveAgentByTaskId(link({ t1: "/wt/a" }), undefined);
  assert.equal(map.size, 0);
});

test("empty fleet → empty map", () => {
  const map = deriveAgentByTaskId(link({ t1: "/wt/a" }), fleet());
  assert.equal(map.size, 0);
});

test("carries the agent facet (state, cwd, branch, lastActivity, message)", () => {
  const map = deriveAgentByTaskId(
    link({ t1: "/wt/a" }),
    fleet(
      session({
        sessionId: "s1",
        taskId: "t1",
        cwd: "/wt/a",
        branch: "dex/t1-slug",
        state: "blocked",
        lastActivity: 42,
        message: "needs permission",
      }),
    ),
  );
  assert.deepEqual(map.get("t1"), {
    sessionId: "s1",
    state: "blocked",
    cwd: "/wt/a",
    branch: "dex/t1-slug",
    lastActivity: 42,
    message: "needs permission",
  });
});
