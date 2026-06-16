/**
 * Unit tests for the `dex.spawn` action's pure helpers + the `runSpawn`
 * orchestration. The `dex`/`git` CLIs (the `Exec` seam) and the terminal launcher
 * (`spawn`/`writeScript`) are stubbed, so nothing spawns a real process or touches
 * disk — we assert the composed slug/branch/path, the git args, the safely-quoted
 * `claude` launch command, and the graceful failure paths.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  branchFor,
  bootstrapPrompt,
  buildClaudeLaunch,
  deriveSlug,
  isValidTaskId,
  resolveRepo,
  runSpawn,
  type SpawnDeps,
  worktreeAddArgs,
  worktreePathFor,
} from "./spawn.js";
import type { Exec } from "./provider.js";

test("deriveSlug: kebabs a messy name, trims, keeps the first few words", () => {
  assert.equal(deriveSlug("Add a `spawn` action!! (to the GUI)"), "add-a-spawn-action-to");
  assert.equal(deriveSlug("  Already-kebab--case  "), "already-kebab-case");
  assert.equal(deriveSlug("UPPER lower 123"), "upper-lower-123");
  // No usable alphanumerics → empty (caller falls back to a bare dex/<id>).
  assert.equal(deriveSlug("!!! ??? ---"), "");
});

test("isValidTaskId: only lowercase-alphanumeric ids the branch parser recovers", () => {
  assert.equal(isValidTaskId("abc123"), true);
  assert.equal(isValidTaskId("ABC123"), false);
  assert.equal(isValidTaskId("ab-12"), false);
  assert.equal(isValidTaskId(""), false);
});

test("branchFor / worktreePathFor: convention with and without a slug", () => {
  assert.equal(branchFor("abc12", "my-task"), "dex/abc12-my-task");
  assert.equal(branchFor("abc12", ""), "dex/abc12");
  assert.equal(
    worktreePathFor("/work/perch", "abc12", "my-task"),
    "/work/perch-worktrees/abc12-my-task",
  );
  assert.equal(
    worktreePathFor("/work/perch", "abc12", ""),
    "/work/perch-worktrees/abc12-task",
  );
});

test("resolveRepo: explicit repo wins as given", () => {
  assert.deepEqual(resolveRepo({ repo: "/explicit/path" }, "perch", ["/work/perch"]), {
    repo: "/explicit/path",
  });
});

test("resolveRepo: maps project → repo by basename (single match)", () => {
  assert.deepEqual(resolveRepo({}, "perch", ["/work/perch", "/work/other"]), {
    repo: "/work/perch",
  });
});

test("resolveRepo: no match is a clean error", () => {
  const r = resolveRepo({}, "ghost", ["/work/perch"]);
  assert.ok("error" in r && /no configured repo/.test(r.error));
});

test("resolveRepo: ambiguous project (two basename matches) is a clean error", () => {
  const r = resolveRepo({}, "perch", ["/a/perch", "/b/perch"]);
  assert.ok("error" in r && /ambiguous/.test(r.error));
});

test("resolveRepo: missing project (no store knew it) is a clean error", () => {
  const r = resolveRepo({}, undefined, ["/work/perch"]);
  assert.ok("error" in r && /project/.test(r.error));
});

test("worktreeAddArgs: git -C <repo> worktree add -b <branch> <path> <base>", () => {
  assert.deepEqual(
    worktreeAddArgs("/work/perch", "dex/abc12-x", "/work/perch-worktrees/abc12-x", "main"),
    ["-C", "/work/perch", "worktree", "add", "-b", "dex/abc12-x", "/work/perch-worktrees/abc12-x", "main"],
  );
});

test("buildClaudeLaunch: cd's into the quoted path and execs claude with a quoted prompt", () => {
  const cmd = buildClaudeLaunch("/work/perch-worktrees/abc12-x", bootstrapPrompt("abc12"));
  assert.match(cmd, /^cd '\/work\/perch-worktrees\/abc12-x' && exec claude '/);
  // The prompt is a single shell-quoted argument; the backticks/quotes inside it
  // are contained by the single-quoting (no shell expansion leaks).
  assert.ok(cmd.includes("Work on dex task abc12."));
  assert.ok(cmd.includes("dex show abc12 --full"));
});

test("buildClaudeLaunch: single quotes in the path/prompt are POSIX-escaped", () => {
  const cmd = buildClaudeLaunch("/it's/here", "say 'hi'");
  assert.equal(cmd, `cd '/it'\\''s/here' && exec claude 'say '\\''hi'\\'''`);
});

// ----- runSpawn orchestration (seams stubbed) -------------------------------

/**
 * A fake terminal spawn that records it fired and returns a child stub with the
 * `.on`/`.unref` surface `spawnInTerminal` calls. Cast through `unknown` to the
 * `child_process.spawn` type — only those two methods are exercised.
 */
function fakeSpawn(): { spawn: SpawnDeps["spawn"]; calls: number } {
  let calls = 0;
  const spawn = (() => {
    calls += 1;
    return { on: () => {}, unref: () => {} };
  }) as unknown as SpawnDeps["spawn"];
  return {
    spawn,
    get calls() {
      return calls;
    },
  };
}

/** A `writeScript` stub that records the command without touching disk. */
function fakeWriteScript(): {
  writeScript: SpawnDeps["writeScript"];
  commands: string[];
} {
  const commands: string[] = [];
  return {
    writeScript: (_label, command) => {
      commands.push(command);
      return "/tmp/perch-terminal/fake.sh";
    },
    commands,
  };
}

/**
 * Build an `Exec` stub for runSpawn. `tasks` maps a `--storage-path`'s store dir
 * to the task JSON `dex show` returns there (absent ⇒ that store doesn't know the
 * id). `git worktree add` succeeds unless `failWorktree` is set; `symbolic-ref`
 * returns `origin/<defaultBranch>`; `dex start` is a no-op. Records every call.
 */
function execStub(opts: {
  tasks: Record<string, { name: string } | undefined>;
  defaultBranch?: string;
  failWorktree?: boolean;
}): { exec: Exec; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: Exec = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "dex") {
      if (args.includes("show")) {
        // `dex [--storage-path P] show <id> --json --full` — key by the store dir.
        const i = args.indexOf("--storage-path");
        const store = i >= 0 ? args[i + 1]! : "<default>";
        const task = opts.tasks[store];
        if (!task) return Promise.reject(new Error("not found"));
        return Promise.resolve(JSON.stringify(task));
      }
      // `dex start` — succeed silently.
      return Promise.resolve("");
    }
    if (cmd === "git") {
      if (args[0] === "symbolic-ref") {
        return Promise.resolve(`origin/${opts.defaultBranch ?? "main"}\n`);
      }
      if (args.includes("worktree")) {
        if (opts.failWorktree) return Promise.reject(new Error("fatal: already exists"));
        return Promise.resolve("");
      }
    }
    return Promise.resolve("");
  };
  return { exec, calls };
}

function deps(exec: Exec, over: Partial<SpawnDeps> = {}): SpawnDeps {
  return {
    exec,
    dexBin: "dex",
    gitBin: "git",
    repos: ["/work/perch"],
    terminal: {},
    ...over,
  };
}

test("runSpawn: rejects a non-conforming id before touching any seam", async () => {
  const { exec, calls } = execStub({ tasks: {} });
  const res = await runSpawn({ id: "BAD-id" }, deps(exec));
  assert.equal(res.ok, false);
  assert.match(res.message, /lowercase-alphanumeric/);
  assert.equal(calls.length, 0); // no dex/git ran
});

test("runSpawn: happy path — finds the task's store, creates the worktree, launches claude", async () => {
  const { exec, calls } = execStub({
    tasks: { "/work/perch/.dex": { name: "Add the spawn action" } },
    defaultBranch: "main",
  });
  const term = fakeSpawn();
  const script = fakeWriteScript();
  const res = await runSpawn(
    { id: "abc12" },
    deps(exec, { spawn: term.spawn, writeScript: script.writeScript }),
  );

  assert.equal(res.ok, true);
  assert.equal(res.worktreePath, "/work/perch-worktrees/abc12-add-the-spawn-action");
  assert.match(res.message, /branch dex\/abc12-add-the-spawn-action/);

  // The worktree was created off the resolved default branch with the right args.
  const add = calls.find((c) => c.cmd === "git" && c.args.includes("worktree"));
  assert.deepEqual(add!.args, [
    "-C",
    "/work/perch",
    "worktree",
    "add",
    "-b",
    "dex/abc12-add-the-spawn-action",
    "/work/perch-worktrees/abc12-add-the-spawn-action",
    "main",
  ]);
  // The agent was launched once, cd'ing into the worktree + exec'ing claude.
  assert.equal(term.calls, 1);
  assert.equal(script.commands.length, 1);
  assert.match(script.commands[0]!, /^cd '\/work\/perch-worktrees\/abc12-add-the-spawn-action' && exec claude '/);

  // `dex start` was fired (best-effort) after the worktree existed.
  assert.ok(calls.some((c) => c.cmd === "dex" && c.args.includes("start")));
});

test("runSpawn: explicit repo overrides the project mapping", async () => {
  // The task lives only in the default store, but we pass an explicit repo.
  const { exec, calls } = execStub({
    tasks: { "/elsewhere/.dex": { name: "Task" }, "<default>": { name: "Task" } },
  });
  const term = fakeSpawn();
  const res = await runSpawn(
    { id: "abc12", repo: "/elsewhere" },
    deps(exec, { repos: [], spawn: term.spawn, writeScript: fakeWriteScript().writeScript }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.worktreePath, "/elsewhere-worktrees/abc12-task");
  const add = calls.find((c) => c.cmd === "git" && c.args.includes("worktree"));
  assert.equal(add!.args[1], "/elsewhere"); // -C <repo>
});

test("runSpawn: a task no store knows is a clean not-found, no worktree", async () => {
  const { exec, calls } = execStub({ tasks: {} });
  const res = await runSpawn({ id: "ghost1" }, deps(exec));
  assert.equal(res.ok, false);
  assert.match(res.message, /not found/);
  assert.ok(!calls.some((c) => c.cmd === "git" && c.args.includes("worktree")));
});

test("runSpawn: a failing worktree-add surfaces a clear error and never launches", async () => {
  const { exec } = execStub({
    tasks: { "/work/perch/.dex": { name: "Task" } },
    failWorktree: true,
  });
  const term = fakeSpawn();
  const res = await runSpawn(
    { id: "abc12" },
    deps(exec, { spawn: term.spawn, writeScript: fakeWriteScript().writeScript }),
  );
  assert.equal(res.ok, false);
  assert.match(res.message, /couldn't create worktree/);
  assert.equal(term.calls, 0); // never launched the agent
});

test("runSpawn: default branch falls back to main when there's no origin/HEAD", async () => {
  const exec: Exec = (cmd, args) => {
    if (cmd === "dex" && args.includes("show")) return Promise.resolve(JSON.stringify({ name: "T" }));
    if (cmd === "dex") return Promise.resolve("");
    if (cmd === "git" && args[0] === "symbolic-ref") return Promise.reject(new Error("no HEAD"));
    return Promise.resolve("");
  };
  const term = fakeSpawn();
  const seenBase: string[] = [];
  const wrapped: Exec = (cmd, args, o) => {
    if (cmd === "git" && args.includes("worktree")) seenBase.push(args[args.length - 1]!);
    return exec(cmd, args, o);
  };
  const res = await runSpawn(
    { id: "abc12" },
    deps(wrapped, { spawn: term.spawn, writeScript: fakeWriteScript().writeScript }),
  );
  assert.equal(res.ok, true);
  assert.deepEqual(seenBase, ["main"]);
});
