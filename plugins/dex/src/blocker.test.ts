/**
 * Unit tests for the `dex.add-blocker` / `dex.remove-blocker` actions' store
 * resolution + `runAddBlocker`/`runRemoveBlocker` orchestration. The `dex` CLI (the
 * `Exec` seam) is stubbed, so nothing shells out — we assert which store the pair
 * resolves to, the composed `dex edit <blockedId> --add-blocker|--remove-blocker
 * <blockerId>` invocation, and the graceful failure paths (bad id, self-block,
 * cross-store, not-found, and dex's own cycle rejection surfaced via stderr).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { DexRunner } from "./spawn.js";
import {
  resolveBlockerStore,
  runAddBlocker,
  runRemoveBlocker,
  type BlockerDeps,
} from "./blocker.js";
import type { Exec } from "./provider.js";

/**
 * Build an `Exec` stub for the blocker path. `tasks` maps a `--storage-path` store
 * dir (or `<default>` for the cwd-resolved store) to the set of task ids that store
 * knows. `dex edit` succeeds unless `editError` is set, in which case it rejects
 * with that text on stderr (mimicking dex's cycle/self-block rejection). Records
 * every call.
 */
function execStub(opts: { tasks: Record<string, string[]>; editError?: string }): {
  exec: Exec;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: Exec = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "dex") {
      const i = args.indexOf("--storage-path");
      const store = i >= 0 ? args[i + 1]! : "<default>";
      const known = opts.tasks[store] ?? [];
      if (args.includes("show")) {
        const id = args[args.indexOf("show") + 1]!;
        if (!known.includes(id)) return Promise.reject(new Error("not found"));
        return Promise.resolve(JSON.stringify({ id, name: id }));
      }
      if (args.includes("edit")) {
        if (opts.editError) {
          const err = new Error("Command failed: dex edit") as Error & { stderr?: string };
          err.stderr = opts.editError;
          return Promise.reject(err);
        }
        return Promise.resolve("");
      }
    }
    return Promise.resolve("");
  };
  return { exec, calls };
}

function deps(exec: Exec, over: Partial<BlockerDeps> = {}): BlockerDeps {
  return { exec, dexBin: "dex", repos: ["/work/perch"], ...over };
}

// ----- resolveBlockerStore (store resolution) -------------------------------

test("resolveBlockerStore: first store knowing the blocked task wins (blocker shares it)", async () => {
  const { exec } = execStub({ tasks: { "/b/.dex": ["blk111", "blk222"] } });
  const dex = new DexRunner("dex", exec);
  const r = await resolveBlockerStore(dex, "blk111", "blk222", {}, ["/a", "/b", "/c"]);
  assert.deepEqual(r, { storagePath: "/b/.dex" });
});

test("resolveBlockerStore: no configured repos falls back to the cwd-resolved store", async () => {
  const { exec } = execStub({ tasks: { "<default>": ["blk111", "blk222"] } });
  const dex = new DexRunner("dex", exec);
  const r = await resolveBlockerStore(dex, "blk111", "blk222", {}, []);
  assert.deepEqual(r, { storagePath: undefined });
});

test("resolveBlockerStore: blocked + blocker in different stores is a clean error", async () => {
  const { exec } = execStub({ tasks: { "/a/.dex": ["blk111"], "/b/.dex": ["blk222"] } });
  const dex = new DexRunner("dex", exec);
  const r = await resolveBlockerStore(dex, "blk111", "blk222", {}, ["/a", "/b"]);
  assert.ok("error" in r);
  assert.match(r.error, /same store|same project/);
});

test("resolveBlockerStore: an unknown blocked id is undefined/error", async () => {
  const { exec } = execStub({ tasks: {} });
  const dex = new DexRunner("dex", exec);
  const r = await resolveBlockerStore(dex, "ghost1", "blk222", {}, ["/a", "/b"]);
  assert.ok("error" in r);
  assert.match(r.error, /not found/);
});

// ----- runAddBlocker orchestration ------------------------------------------

test("runAddBlocker: rejects a non-conforming id before touching any seam", async () => {
  const { exec, calls } = execStub({ tasks: {} });
  const res = await runAddBlocker({ blockedId: "BAD-id", blockerId: "blk222" }, deps(exec));
  assert.equal(res.ok, false);
  assert.match(res.message, /lowercase-alphanumeric/);
  assert.equal(calls.length, 0);
});

test("runAddBlocker: rejects a self-block (no-op) before touching any seam", async () => {
  const { exec, calls } = execStub({ tasks: { "/work/perch/.dex": ["blk111"] } });
  const res = await runAddBlocker({ blockedId: "blk111", blockerId: "blk111" }, deps(exec));
  assert.equal(res.ok, false);
  assert.match(res.message, /can't block itself/);
  assert.equal(calls.length, 0);
});

test("runAddBlocker: happy path — resolves the store and composes the edit", async () => {
  const { exec, calls } = execStub({ tasks: { "/work/perch/.dex": ["blk111", "blk222"] } });
  const res = await runAddBlocker({ blockedId: "blk111", blockerId: "blk222" }, deps(exec));
  assert.equal(res.ok, true);
  assert.match(res.message, /blk111 is now blocked by blk222/);
  const edit = calls.find((c) => c.cmd === "dex" && c.args.includes("edit"));
  assert.deepEqual(edit!.args, [
    "--storage-path",
    "/work/perch/.dex",
    "edit",
    "blk111",
    "--add-blocker",
    "blk222",
  ]);
});

test("runAddBlocker: an explicit repo targets that repo's store", async () => {
  const { exec, calls } = execStub({ tasks: { "/elsewhere/.dex": ["blk111", "blk222"] } });
  const res = await runAddBlocker(
    { blockedId: "blk111", blockerId: "blk222", repo: "/elsewhere" },
    deps(exec, { repos: [] }),
  );
  assert.equal(res.ok, true);
  const edit = calls.find((c) => c.cmd === "dex" && c.args.includes("edit"));
  assert.equal(edit!.args[1], "/elsewhere/.dex");
});

test("runAddBlocker: a cross-store pair is rejected, no edit", async () => {
  const { exec, calls } = execStub({
    tasks: { "/a/.dex": ["blk111"], "/b/.dex": ["blk222"] },
  });
  const res = await runAddBlocker(
    { blockedId: "blk111", blockerId: "blk222" },
    deps(exec, { repos: ["/a", "/b"] }),
  );
  assert.equal(res.ok, false);
  assert.match(res.message, /same store|same project/);
  assert.ok(!calls.some((c) => c.args.includes("edit")));
});

test("runAddBlocker: dex's cycle rejection is surfaced via stderr", async () => {
  const { exec } = execStub({
    tasks: { "/work/perch/.dex": ["blk111", "blk222"] },
    editError: "Error: Cannot add blocker blk222: would create a cycle",
  });
  const res = await runAddBlocker({ blockedId: "blk111", blockerId: "blk222" }, deps(exec));
  assert.equal(res.ok, false);
  assert.match(res.message, /couldn't add blocker/);
  assert.match(res.message, /would create a cycle/);
});

// ----- runRemoveBlocker orchestration ---------------------------------------

test("runRemoveBlocker: happy path — composes the --remove-blocker edit", async () => {
  const { exec, calls } = execStub({ tasks: { "/work/perch/.dex": ["blk111", "blk222"] } });
  const res = await runRemoveBlocker({ blockedId: "blk111", blockerId: "blk222" }, deps(exec));
  assert.equal(res.ok, true);
  assert.match(res.message, /no longer blocked by blk222/);
  const edit = calls.find((c) => c.cmd === "dex" && c.args.includes("edit"));
  assert.deepEqual(edit!.args, [
    "--storage-path",
    "/work/perch/.dex",
    "edit",
    "blk111",
    "--remove-blocker",
    "blk222",
  ]);
});
