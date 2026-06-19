/**
 * Unit tests for the `dex.complete` action's store resolution + `runComplete`
 * orchestration. The `dex` CLI (the `Exec` seam) is stubbed, so nothing shells
 * out — we assert which store the id resolves to, the composed `dex complete
 * <id> --result "..." --no-commit` invocation (default result, no `--force`,
 * only-present flags), and the graceful failure paths (bad id, not-found, CLI
 * error — including dex's incomplete-subtask validation surfacing verbatim).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_COMPLETE_RESULT, runComplete, type CompleteDeps } from "./complete.js";
import type { Exec } from "./provider.js";

/**
 * Build an `Exec` stub for the complete path. `tasks` maps a `--storage-path` store
 * dir (or `<default>` for the cwd-resolved store) to the task `dex show` finds
 * there (absent ⇒ that store doesn't know the id). `dex complete` succeeds unless
 * `failComplete` is set (which rejects with that message, modeling dex's own
 * validation error). Records every call.
 */
function execStub(opts: {
  tasks: Record<string, { name: string } | undefined>;
  failComplete?: string;
}): { exec: Exec; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: Exec = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "dex") {
      const i = args.indexOf("--storage-path");
      const store = i >= 0 ? args[i + 1]! : "<default>";
      if (args.includes("show")) {
        const task = opts.tasks[store];
        if (!task) return Promise.reject(new Error("not found"));
        return Promise.resolve(JSON.stringify(task));
      }
      if (args.includes("complete")) {
        if (opts.failComplete) return Promise.reject(new Error(opts.failComplete));
        return Promise.resolve("");
      }
    }
    return Promise.resolve("");
  };
  return { exec, calls };
}

function deps(exec: Exec, over: Partial<CompleteDeps> = {}): CompleteDeps {
  return { exec, dexBin: "dex", repos: ["/work/perch"], ...over };
}

// ----- runComplete orchestration --------------------------------------------

test("runComplete: rejects a non-conforming id before touching any seam", async () => {
  const { exec, calls } = execStub({ tasks: {} });
  const res = await runComplete({ id: "BAD-id" }, deps(exec));
  assert.equal(res.ok, false);
  assert.match(res.message, /lowercase-alphanumeric/);
  assert.equal(calls.length, 0);
});

test("runComplete: happy path — finds the store and completes with a default result + --no-commit", async () => {
  const { exec, calls } = execStub({ tasks: { "/work/perch/.dex": { name: "A task" } } });
  const res = await runComplete({ id: "abc12" }, deps(exec));
  assert.equal(res.ok, true);
  assert.match(res.message, /Completed dex task abc12/);
  const done = calls.find((c) => c.cmd === "dex" && c.args.includes("complete"));
  assert.deepEqual(done!.args, [
    "--storage-path",
    "/work/perch/.dex",
    "complete",
    "abc12",
    "--result",
    DEFAULT_COMPLETE_RESULT,
    "--no-commit",
  ]);
  // Never force-completes: dex's incomplete-subtask validation must be free to fire.
  assert.ok(!done!.args.includes("--force"));
});

test("runComplete: a given result is passed through verbatim", async () => {
  const { exec, calls } = execStub({ tasks: { "/work/perch/.dex": { name: "T" } } });
  const res = await runComplete({ id: "abc12", result: "did it by hand" }, deps(exec));
  assert.equal(res.ok, true);
  const done = calls.find((c) => c.cmd === "dex" && c.args.includes("complete"));
  const r = done!.args.indexOf("--result");
  assert.equal(done!.args[r + 1], "did it by hand");
});

test("runComplete: a blank result falls back to the default", async () => {
  const { exec, calls } = execStub({ tasks: { "/work/perch/.dex": { name: "T" } } });
  const res = await runComplete({ id: "abc12", result: "   " }, deps(exec));
  assert.equal(res.ok, true);
  const done = calls.find((c) => c.cmd === "dex" && c.args.includes("complete"));
  const r = done!.args.indexOf("--result");
  assert.equal(done!.args[r + 1], DEFAULT_COMPLETE_RESULT);
});

test("runComplete: an explicit repo targets that repo's store", async () => {
  const { exec, calls } = execStub({ tasks: { "/elsewhere/.dex": { name: "T" } } });
  const res = await runComplete({ id: "abc12", repo: "/elsewhere" }, deps(exec, { repos: [] }));
  assert.equal(res.ok, true);
  const done = calls.find((c) => c.cmd === "dex" && c.args.includes("complete"));
  assert.equal(done!.args[1], "/elsewhere/.dex");
});

test("runComplete: explicit repo missing the id falls back to the default store", async () => {
  // The task lives only in the default store, but an explicit repo is passed.
  const { exec, calls } = execStub({ tasks: { "<default>": { name: "T" } } });
  const res = await runComplete({ id: "abc12", repo: "/elsewhere" }, deps(exec, { repos: [] }));
  assert.equal(res.ok, true);
  const done = calls.find((c) => c.cmd === "dex" && c.args.includes("complete"));
  // No --storage-path → the cwd-resolved store.
  assert.deepEqual(done!.args, [
    "complete",
    "abc12",
    "--result",
    DEFAULT_COMPLETE_RESULT,
    "--no-commit",
  ]);
});

test("runComplete: a task no store knows is a clean not-found, no complete", async () => {
  const { exec, calls } = execStub({ tasks: {} });
  const res = await runComplete({ id: "ghost1" }, deps(exec));
  assert.equal(res.ok, false);
  assert.match(res.message, /not found/);
  assert.ok(!calls.some((c) => c.args.includes("complete")));
});

test("runComplete: dex's incomplete-subtask error surfaces verbatim", async () => {
  const { exec } = execStub({
    tasks: { "/work/perch/.dex": { name: "T" } },
    failComplete: "task has 2 incomplete subtasks",
  });
  const res = await runComplete({ id: "abc12" }, deps(exec));
  assert.equal(res.ok, false);
  assert.match(res.message, /couldn't complete dex task "abc12"/);
  assert.match(res.message, /incomplete subtasks/);
});
