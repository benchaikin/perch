/**
 * Unit tests for the `dex.edit` action's store resolution + `runEdit`
 * orchestration. The `dex` CLI (the `Exec` seam) is stubbed, so nothing shells
 * out — we assert which store the id resolves to, the composed `dex edit <id>
 * [-n ...] [-d ...] [-p ...]` invocation (only-changed-fields), and the graceful
 * paths (bad id, blank name, no-op, not-found, CLI error).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { runEdit, type EditDeps } from "./edit.js";
import type { Exec } from "./provider.js";

/**
 * Build an `Exec` stub for the edit path. `tasks` maps a `--storage-path` store
 * dir (or `<default>` for the cwd-resolved store) to the task `dex show` finds
 * there (absent ⇒ that store doesn't know the id). `dex edit` succeeds unless
 * `failEdit` is set. Records every call.
 */
function execStub(opts: {
  tasks: Record<string, { name: string } | undefined>;
  failEdit?: boolean;
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
      if (args.includes("edit")) {
        if (opts.failEdit) return Promise.reject(new Error("store is read-only"));
        return Promise.resolve("");
      }
    }
    return Promise.resolve("");
  };
  return { exec, calls };
}

function deps(exec: Exec, over: Partial<EditDeps> = {}): EditDeps {
  return { exec, dexBin: "dex", repos: ["/work/perch"], ...over };
}

/** The `dex edit` call's args (the subcommand the runner composed), if any. */
function editArgs(calls: Array<{ cmd: string; args: string[] }>): string[] | undefined {
  return calls.find((c) => c.cmd === "dex" && c.args.includes("edit"))?.args;
}

// ----- guards (no seam touched) ---------------------------------------------

test("runEdit: rejects a non-conforming id before touching any seam", async () => {
  const { exec, calls } = execStub({ tasks: {} });
  const res = await runEdit({ id: "BAD-id", name: "x" }, deps(exec));
  assert.equal(res.ok, false);
  assert.match(res.message, /lowercase-alphanumeric/);
  assert.equal(calls.length, 0);
});

test("runEdit: rejects a blank name (a task must keep a name)", async () => {
  const { exec, calls } = execStub({ tasks: { "/work/perch/.dex": { name: "T" } } });
  const res = await runEdit({ id: "abc12", name: "   " }, deps(exec));
  assert.equal(res.ok, false);
  assert.match(res.message, /must have a name/);
  assert.equal(calls.length, 0);
});

test("runEdit: a no-op (nothing changed) succeeds quietly without an edit", async () => {
  const { exec, calls } = execStub({ tasks: { "/work/perch/.dex": { name: "T" } } });
  const res = await runEdit({ id: "abc12" }, deps(exec));
  assert.equal(res.ok, true);
  assert.match(res.message, /No changes/);
  assert.equal(calls.length, 0);
});

// ----- command construction (only-changed-fields) ---------------------------

test("runEdit: only passes flags for the fields actually changed", async () => {
  const { exec, calls } = execStub({ tasks: { "/work/perch/.dex": { name: "T" } } });
  const res = await runEdit({ id: "abc12", name: "New name" }, deps(exec));
  assert.equal(res.ok, true);
  assert.match(res.message, /Updated dex task abc12/);
  assert.deepEqual(editArgs(calls), [
    "--storage-path",
    "/work/perch/.dex",
    "edit",
    "abc12",
    "-n",
    "New name",
  ]);
});

test("runEdit: an empty description is a legitimate clear (sent as -d \"\")", async () => {
  const { exec, calls } = execStub({ tasks: { "/work/perch/.dex": { name: "T" } } });
  const res = await runEdit({ id: "abc12", description: "" }, deps(exec));
  assert.equal(res.ok, true);
  assert.deepEqual(editArgs(calls), ["--storage-path", "/work/perch/.dex", "edit", "abc12", "-d", ""]);
});

test("runEdit: all three fields compose name, description, and priority flags", async () => {
  const { exec, calls } = execStub({ tasks: { "/work/perch/.dex": { name: "T" } } });
  const res = await runEdit(
    { id: "abc12", name: "N", description: "multi\nline", priority: 2 },
    deps(exec),
  );
  assert.equal(res.ok, true);
  assert.deepEqual(editArgs(calls), [
    "--storage-path",
    "/work/perch/.dex",
    "edit",
    "abc12",
    "-n",
    "N",
    "-d",
    "multi\nline",
    "-p",
    "2",
  ]);
});

// ----- store resolution (mirrors delete) ------------------------------------

test("runEdit: an explicit repo targets that repo's store", async () => {
  const { exec, calls } = execStub({ tasks: { "/elsewhere/.dex": { name: "T" } } });
  const res = await runEdit({ id: "abc12", repo: "/elsewhere", name: "N" }, deps(exec, { repos: [] }));
  assert.equal(res.ok, true);
  assert.equal(editArgs(calls)?.[1], "/elsewhere/.dex");
});

test("runEdit: explicit repo missing the id falls back to the default store", async () => {
  // The task lives only in the default store, but an explicit repo is passed.
  const { exec, calls } = execStub({ tasks: { "<default>": { name: "T" } } });
  const res = await runEdit({ id: "abc12", repo: "/elsewhere", name: "N" }, deps(exec, { repos: [] }));
  assert.equal(res.ok, true);
  // No --storage-path → the cwd-resolved store.
  assert.deepEqual(editArgs(calls), ["edit", "abc12", "-n", "N"]);
});

test("runEdit: probes the configured stores, first match wins", async () => {
  const { exec, calls } = execStub({ tasks: { "/b/.dex": { name: "T" } } });
  const res = await runEdit({ id: "abc12", name: "N" }, deps(exec, { repos: ["/a", "/b", "/c"] }));
  assert.equal(res.ok, true);
  assert.equal(editArgs(calls)?.[1], "/b/.dex");
});

test("runEdit: a task no store knows is a clean not-found, no edit", async () => {
  const { exec, calls } = execStub({ tasks: {} });
  const res = await runEdit({ id: "ghost1", name: "N" }, deps(exec));
  assert.equal(res.ok, false);
  assert.match(res.message, /not found/);
  assert.ok(!calls.some((c) => c.args.includes("edit")));
});

test("runEdit: a failing `dex edit` surfaces a clear error", async () => {
  const { exec } = execStub({ tasks: { "/work/perch/.dex": { name: "T" } }, failEdit: true });
  const res = await runEdit({ id: "abc12", name: "N" }, deps(exec));
  assert.equal(res.ok, false);
  assert.match(res.message, /couldn't edit dex task "abc12"/);
  assert.match(res.message, /read-only/);
});
