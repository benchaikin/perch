/**
 * Unit tests for the `dex.delete` action's store resolution + `runDelete`
 * orchestration. The `dex` CLI (the `Exec` seam) is stubbed, so nothing shells
 * out — we assert which store the id resolves to, the composed `dex delete
 * <id> --force --storage-path <store>` invocation, and the graceful failure paths
 * (bad id, not-found, CLI error).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { DexRunner } from "./spawn.js";
import { locateTaskStore, runDelete, type DeleteDeps } from "./delete.js";
import type { Exec } from "./provider.js";

/**
 * Build an `Exec` stub for the delete path. `tasks` maps a `--storage-path` store
 * dir (or `<default>` for the cwd-resolved store) to the task `dex show` finds
 * there (absent ⇒ that store doesn't know the id). `dex delete` succeeds unless
 * `failDelete` is set. Records every call.
 */
function execStub(opts: {
  tasks: Record<string, { name: string } | undefined>;
  failDelete?: boolean;
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
      if (args.includes("delete")) {
        if (opts.failDelete) return Promise.reject(new Error("store is read-only"));
        return Promise.resolve("");
      }
    }
    return Promise.resolve("");
  };
  return { exec, calls };
}

function deps(exec: Exec, over: Partial<DeleteDeps> = {}): DeleteDeps {
  return { exec, dexBin: "dex", repos: ["/work/perch"], ...over };
}

// ----- locateTaskStore (store resolution) -----------------------------------

test("locateTaskStore: first configured store that knows the id wins", async () => {
  const { exec } = execStub({ tasks: { "/b/.dex": { name: "T" } } });
  const dex = new DexRunner("dex", exec);
  const located = await locateTaskStore(dex, "abc12", ["/a", "/b", "/c"]);
  assert.deepEqual(located, { storagePath: "/b/.dex" });
});

test("locateTaskStore: no configured repos falls back to the cwd-resolved store", async () => {
  const { exec } = execStub({ tasks: { "<default>": { name: "T" } } });
  const dex = new DexRunner("dex", exec);
  const located = await locateTaskStore(dex, "abc12", []);
  assert.deepEqual(located, { storagePath: undefined });
});

test("locateTaskStore: an id no store knows is undefined", async () => {
  const { exec } = execStub({ tasks: {} });
  const dex = new DexRunner("dex", exec);
  assert.equal(await locateTaskStore(dex, "ghost1", ["/a", "/b"]), undefined);
});

// ----- runDelete orchestration ----------------------------------------------

test("runDelete: rejects a non-conforming id before touching any seam", async () => {
  const { exec, calls } = execStub({ tasks: {} });
  const res = await runDelete({ id: "BAD-id" }, deps(exec));
  assert.equal(res.ok, false);
  assert.match(res.message, /lowercase-alphanumeric/);
  assert.equal(calls.length, 0);
});

test("runDelete: happy path — finds the store and force-deletes against it", async () => {
  const { exec, calls } = execStub({ tasks: { "/work/perch/.dex": { name: "A task" } } });
  const res = await runDelete({ id: "abc12" }, deps(exec));
  assert.equal(res.ok, true);
  assert.match(res.message, /Deleted dex task abc12/);
  const del = calls.find((c) => c.cmd === "dex" && c.args.includes("delete"));
  assert.deepEqual(del!.args, ["--storage-path", "/work/perch/.dex", "delete", "abc12", "--force"]);
});

test("runDelete: an explicit repo targets that repo's store", async () => {
  const { exec, calls } = execStub({ tasks: { "/elsewhere/.dex": { name: "T" } } });
  const res = await runDelete({ id: "abc12", repo: "/elsewhere" }, deps(exec, { repos: [] }));
  assert.equal(res.ok, true);
  const del = calls.find((c) => c.cmd === "dex" && c.args.includes("delete"));
  assert.equal(del!.args[1], "/elsewhere/.dex");
});

test("runDelete: explicit repo missing the id falls back to the default store", async () => {
  // The task lives only in the default store, but an explicit repo is passed.
  const { exec, calls } = execStub({ tasks: { "<default>": { name: "T" } } });
  const res = await runDelete({ id: "abc12", repo: "/elsewhere" }, deps(exec, { repos: [] }));
  assert.equal(res.ok, true);
  const del = calls.find((c) => c.cmd === "dex" && c.args.includes("delete"));
  // No --storage-path → the cwd-resolved store.
  assert.deepEqual(del!.args, ["delete", "abc12", "--force"]);
});

test("runDelete: a task no store knows is a clean not-found, no delete", async () => {
  const { exec, calls } = execStub({ tasks: {} });
  const res = await runDelete({ id: "ghost1" }, deps(exec));
  assert.equal(res.ok, false);
  assert.match(res.message, /not found/);
  assert.ok(!calls.some((c) => c.args.includes("delete")));
});

test("runDelete: a failing `dex delete` surfaces a clear error", async () => {
  const { exec } = execStub({ tasks: { "/work/perch/.dex": { name: "T" } }, failDelete: true });
  const res = await runDelete({ id: "abc12" }, deps(exec));
  assert.equal(res.ok, false);
  assert.match(res.message, /couldn't delete dex task "abc12"/);
  assert.match(res.message, /read-only/);
});
