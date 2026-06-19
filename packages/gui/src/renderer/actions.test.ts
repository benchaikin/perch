/**
 * Unit tests for the typed actions surface ({@link createActions}). The surface
 * is a pure pass-through over the renderer→main bridge, so it's exercised against
 * a recording fake `window.perch`: each method must forward its argument verbatim
 * and return the bridge's result (the invoke-based actions hand back a Promise).
 *
 * Guards the contract every pane depends on — that calling an action is exactly
 * calling the bridge — and that the surface stays in lockstep with the bridge as
 * methods are added.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createActions, type PerchActions } from "./actions.js";

/** A recording fake bridge: every method logs `[name, arg]` and returns a token. */
function recordingBridge() {
  const calls: Array<[string, unknown]> = [];
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop: string) {
      return (arg?: unknown) => {
        calls.push([prop, arg]);
        // A sentinel return so we can assert the action passes the result back
        // (the invoke-based bridge methods return a Promise).
        return `result:${prop}`;
      };
    },
  };
  return { bridge: new Proxy({}, handler) as unknown as PerchActions, calls };
}

/** One representative call per action, with its expected forwarded argument. */
const CASES: Array<[keyof PerchActions, unknown, boolean]> = [
  ["refresh", undefined, false],
  ["sync", "repo-a", false],
  ["resolveConflicts", { headRefName: "h", baseRefName: "b", repo: "r", number: 1 }, true],
  ["openAgent", { headRefName: "h", repo: "r", number: 2 }, true],
  ["mergePr", { number: 3, repo: "r", headRefName: "h" }, true],
  ["openPr", "https://example.test/pr/4", false],
  ["serviceAction", { name: "svc", action: "start" }, false],
  ["servicesBulk", "startAll", false],
  ["serviceLogs", "svc", false],
  ["copyText", "some text", false],
  ["setActiveTab", "tab-id", false],
  ["setDexViewMode", "graph", false],
  ["setNewTaskDialogSize", { width: 600, height: 480 }, false],
  ["worktreeOpen", "/path/to/wt", false],
  ["worktreeRemove", { path: "/path/to/wt", name: "wt" }, true],
  ["dexSpawn", "task-1", true],
  ["dexSpawnReady", undefined, true],
  ["dexDelete", { id: "t", name: "n" }, true],
  ["dexEdit", { id: "t", name: "n" }, true],
  ["dexComplete", { id: "t", result: "done" }, true],
  ["dexAddBlocker", { blockedId: "a", blockerId: "b" }, true],
  ["dexRemoveBlocker", { blockedId: "a", blockerId: "b" }, true],
  ["dexNew", { description: "do a thing" }, true],
];

for (const [name, arg, returnsResult] of CASES) {
  test(`${name} forwards to the bridge with its argument`, () => {
    const { bridge, calls } = recordingBridge();
    const actions = createActions(() => bridge);

    // Invoke with the representative argument (argless actions get no arg).
    const result = (actions[name] as (a?: unknown) => unknown)(arg);

    assert.deepEqual(calls, [[name, arg]], "exactly one forwarded call, args verbatim");
    if (returnsResult) {
      assert.equal(result, `result:${name}`, "the bridge's result is passed back");
    }
  });
}

test("the surface covers exactly the bridge's renderer→main methods", () => {
  const { bridge } = recordingBridge();
  const actions = createActions(() => bridge);
  // Every action is a function; onState is deliberately absent (the store owns it).
  for (const name of Object.keys(actions)) {
    assert.equal(typeof (actions as Record<string, unknown>)[name], "function");
  }
  assert.equal(
    Object.keys(actions).length,
    CASES.length,
    "every action has a forwarding test case",
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(actions, "onState"),
    false,
    "onState is not part of the actions surface (the store owns the push)",
  );
});
