/**
 * Unit tests for the `dex.spawn` action's pure helpers + the `runSpawn`
 * orchestration. The `dex`/`git` CLIs (the `Exec` seam), the terminal launcher
 * (`spawn`/`writeScript`), and the filesystem (`FsOps`) are stubbed, so nothing
 * spawns a real process or touches disk — we assert the composed slug/branch/path,
 * the git args, the safely-quoted `claude` launch command, the dex-store symlink,
 * and the graceful failure paths.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentTitle,
  branchFor,
  bootstrapPrompt,
  buildClaudeLaunch,
  deriveSlug,
  DexRunner,
  dexStoreLinkSpec,
  excludeDexLink,
  type FsOps,
  GitRunner,
  isReadyToSpawn,
  isValidTaskId,
  linkDexStore,
  resolveRepo,
  runSpawn,
  runSpawnBatch,
  type SpawnCandidate,
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

test("dexStoreLinkSpec: a `.dex` in the worktree pointing at <repo>/.dex", () => {
  assert.deepEqual(dexStoreLinkSpec("/work/perch-worktrees/abc12-x", "/work/perch"), {
    linkPath: "/work/perch-worktrees/abc12-x/.dex",
    target: "/work/perch/.dex",
  });
});

test("linkDexStore: a symlink error is swallowed (best-effort, never throws)", async () => {
  let call = 0;
  const fs: FsOps = {
    // First probe (the source store) exists; second (the link path) doesn't —
    // so it attempts the symlink, which then fails.
    exists: () => Promise.resolve(call++ === 0),
    symlink: () => Promise.reject(new Error("EPERM")),
    readFile: () => Promise.reject(new Error("ENOENT")),
    appendFile: () => Promise.resolve(),
  };
  await assert.doesNotReject(linkDexStore("/wt", "/repo", fs));
});

test("excludeDexLink: appends `/.dex` to the worktree's info/exclude (once)", async () => {
  const exec: Exec = (_cmd, args) =>
    args.includes("rev-parse")
      ? Promise.resolve("/repo/.git/info/exclude\n")
      : Promise.resolve("");
  const git = new GitRunner("git", exec);
  const files = new Map<string, string>();
  const fs: FsOps = {
    exists: () => Promise.resolve(false),
    symlink: () => Promise.resolve(),
    readFile: (p) => {
      const v = files.get(p);
      return v === undefined ? Promise.reject(new Error("ENOENT")) : Promise.resolve(v);
    },
    appendFile: (p, data) => {
      files.set(p, (files.get(p) ?? "") + data);
      return Promise.resolve();
    },
  };

  await excludeDexLink("/wt", git, fs);
  assert.equal(files.get("/repo/.git/info/exclude"), "/.dex\n");
  // Idempotent: a second pass doesn't duplicate the pattern.
  await excludeDexLink("/wt", git, fs);
  assert.equal(files.get("/repo/.git/info/exclude"), "/.dex\n");
});

test("excludeDexLink: a final line without a newline gets one before the pattern", async () => {
  const exec: Exec = () => Promise.resolve("/repo/.git/info/exclude\n");
  const git = new GitRunner("git", exec);
  const files = new Map<string, string>([["/repo/.git/info/exclude", "*.log"]]);
  const fs: FsOps = {
    exists: () => Promise.resolve(false),
    symlink: () => Promise.resolve(),
    readFile: (p) => Promise.resolve(files.get(p) ?? ""),
    appendFile: (p, data) => {
      files.set(p, (files.get(p) ?? "") + data);
      return Promise.resolve();
    },
  };
  await excludeDexLink("/wt", git, fs);
  assert.equal(files.get("/repo/.git/info/exclude"), "*.log\n/.dex\n");
});

test("excludeDexLink: a rev-parse failure is swallowed (best-effort, never throws)", async () => {
  const exec: Exec = () => Promise.reject(new Error("not a git repo"));
  const git = new GitRunner("git", exec);
  const fs: FsOps = {
    exists: () => Promise.resolve(false),
    symlink: () => Promise.resolve(),
    readFile: () => Promise.reject(new Error("ENOENT")),
    appendFile: () => Promise.reject(new Error("EPERM")),
  };
  await assert.doesNotReject(excludeDexLink("/wt", git, fs));
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
  // The session launches in auto mode so the spawned agent runs without a manual
  // permission-mode toggle.
  assert.match(cmd, /^cd '\/work\/perch-worktrees\/abc12-x' && exec claude --permission-mode auto '/);
  // The prompt is a single shell-quoted argument; the backticks/quotes inside it
  // are contained by the single-quoting (no shell expansion leaks).
  assert.ok(cmd.includes("Work on dex task abc12."));
  assert.ok(cmd.includes("dex show abc12 --full"));
});

test("buildClaudeLaunch: single quotes in the path/prompt are POSIX-escaped", () => {
  const cmd = buildClaudeLaunch("/it's/here", "say 'hi'");
  assert.equal(cmd, `cd '/it'\\''s/here' && exec claude --permission-mode auto 'say '\\''hi'\\'''`);
});

test("agentTitle: `dex <id> · <name>`, bare id when the name is blank, truncated when long", () => {
  assert.equal(agentTitle("abc12", "Fix login"), "dex abc12 · Fix login");
  // No usable name → just the id (still self-identifying via the branch's id).
  assert.equal(agentTitle("abc12", "   "), "dex abc12");
  // A long name is trimmed to a readable length with an ellipsis.
  const long = "A really long task name that goes well past the limit and keeps going";
  const title = agentTitle("abc12", long);
  assert.ok(title.startsWith("dex abc12 · "));
  assert.ok(title.endsWith("…"));
  assert.ok(title.length < `dex abc12 · ${long}`.length);
});

test("DexRunner.start: passes `--force` and the storage path, reports success", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: Exec = (cmd, args) => {
    calls.push({ cmd, args });
    return Promise.resolve("");
  };
  const res = await new DexRunner("dex", exec).start("abc12", "/work/perch/.dex");
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(calls, [
    { cmd: "dex", args: ["--storage-path", "/work/perch/.dex", "start", "abc12", "--force"] },
  ]);
});

test("DexRunner.start: a CLI error is reported (not swallowed), with its detail", async () => {
  const exec: Exec = () => Promise.reject(new Error("dex store is locked"));
  const res = await new DexRunner("dex", exec).start("abc12");
  assert.equal(res.ok, false);
  assert.match(res.detail ?? "", /dex store is locked/);
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
 * returns `origin/<defaultBranch>`; `dex start` is a no-op unless `failStart` is
 * set (then it rejects, as the CLI would on a store/dex error). Records every call.
 */
function execStub(opts: {
  tasks: Record<string, { name: string } | undefined>;
  defaultBranch?: string;
  failWorktree?: boolean;
  failStart?: boolean;
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
      // `dex start <id> --force` — succeed silently unless told to fail.
      if (opts.failStart) return Promise.reject(new Error("dex store is locked"));
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
      if (args.includes("rev-parse")) {
        // `git -C <wt> rev-parse --git-path info/exclude` — the shared exclude.
        const wt = args[1]!;
        return Promise.resolve(`${wt}/.git/info/exclude\n`);
      }
    }
    return Promise.resolve("");
  };
  return { exec, calls };
}

/**
 * A fake {@link FsOps} that records the symlinks it's asked to make and reports a
 * fixed set of paths as already existing. Lets a test prove the store gets linked
 * (or skipped) without touching disk.
 */
function fakeFs(existing: string[] = []): {
  fs: FsOps;
  links: Array<{ target: string; linkPath: string }>;
  files: Map<string, string>;
} {
  const present = new Set(existing);
  const links: Array<{ target: string; linkPath: string }> = [];
  const files = new Map<string, string>();
  return {
    fs: {
      exists: (p) => Promise.resolve(present.has(p)),
      symlink: (target, linkPath) => {
        links.push({ target, linkPath });
        present.add(linkPath);
        return Promise.resolve();
      },
      readFile: (p) => {
        const v = files.get(p);
        return v === undefined ? Promise.reject(new Error("ENOENT")) : Promise.resolve(v);
      },
      appendFile: (p, data) => {
        files.set(p, (files.get(p) ?? "") + data);
        return Promise.resolve();
      },
    },
    links,
    files,
  };
}

function deps(exec: Exec, over: Partial<SpawnDeps> = {}): SpawnDeps {
  return {
    exec,
    dexBin: "dex",
    gitBin: "git",
    repos: ["/work/perch"],
    terminal: {},
    // A no-touch fs by default (nothing exists ⇒ linking is skipped); tests that
    // exercise the store-link pass an explicit `fakeFs`.
    fs: {
      exists: () => Promise.resolve(false),
      symlink: () => Promise.resolve(),
      readFile: () => Promise.reject(new Error("ENOENT")),
      appendFile: () => Promise.resolve(),
    },
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
  // The window title (dex id + name) is set first, then the cd+exec claude line.
  // (Default terminal is Terminal.app, which honors the OSC 0 title escape.)
  assert.match(
    script.commands[0]!,
    /^printf '\\033\]0;%s\\007' 'dex abc12 · Add the spawn action'\n/,
  );
  assert.match(
    script.commands[0]!,
    /\ncd '\/work\/perch-worktrees\/abc12-add-the-spawn-action' && exec claude --permission-mode auto '/,
  );

  // The task was marked in-progress with `dex start <id> --force` (the `--force`
  // makes re-spawning an already-started task idempotent rather than an error)…
  const start = calls.find((c) => c.cmd === "dex" && c.args.includes("start"));
  assert.ok(start);
  assert.ok(start.args.includes("--force"));
  // …and it happened BEFORE the worktree was created, so an agent can never be
  // launched on a task that still reads as 'ready'.
  const startIdx = calls.indexOf(start);
  const worktreeIdx = calls.findIndex((c) => c.cmd === "git" && c.args.includes("worktree"));
  assert.ok(startIdx < worktreeIdx);
});

test("runSpawn: a failing `dex start` is surfaced and nothing is created", async () => {
  const { exec, calls } = execStub({
    tasks: { "/work/perch/.dex": { name: "Task" } },
    failStart: true,
  });
  const term = fakeSpawn();
  const res = await runSpawn(
    { id: "abc12" },
    deps(exec, { spawn: term.spawn, writeScript: fakeWriteScript().writeScript }),
  );
  assert.equal(res.ok, false);
  assert.match(res.message, /couldn't mark dex task "abc12" in-progress/);
  // The store error is surfaced, not swallowed.
  assert.match(res.message, /dex store is locked/);
  // No worktree was created and no agent launched — we don't half-spawn a task
  // that would still read as 'ready'.
  assert.ok(!calls.some((c) => c.cmd === "git" && c.args.includes("worktree")));
  assert.equal(term.calls, 0);
});

test("runSpawn: links the repo's dex store into the worktree so the agent finds it", async () => {
  const { exec } = execStub({ tasks: { "/work/perch/.dex": { name: "Task" } } });
  const ff = fakeFs(["/work/perch/.dex"]); // the source store exists
  const res = await runSpawn(
    { id: "abc12" },
    deps(exec, { spawn: fakeSpawn().spawn, writeScript: fakeWriteScript().writeScript, fs: ff.fs }),
  );
  assert.equal(res.ok, true);
  // `.dex` in the worktree → the source repo's store, so `dex show <id>` resolves.
  assert.deepEqual(ff.links, [
    { target: "/work/perch/.dex", linkPath: "/work/perch-worktrees/abc12-task/.dex" },
  ]);
  // …and that link is excluded from git, so its `?? .dex` never blocks auto-land.
  assert.equal(
    ff.files.get("/work/perch-worktrees/abc12-task/.git/info/exclude"),
    "/.dex\n",
  );
});

test("runSpawn: doesn't clobber a `.dex` already in the worktree", async () => {
  const { exec } = execStub({ tasks: { "/work/perch/.dex": { name: "Task" } } });
  const ff = fakeFs(["/work/perch/.dex", "/work/perch-worktrees/abc12-task/.dex"]);
  const res = await runSpawn(
    { id: "abc12" },
    deps(exec, { spawn: fakeSpawn().spawn, writeScript: fakeWriteScript().writeScript, fs: ff.fs }),
  );
  assert.equal(res.ok, true);
  assert.equal(ff.links.length, 0); // link path already present → left alone
});

test("runSpawn: skips linking when the repo has no dex store", async () => {
  const { exec } = execStub({ tasks: { "/work/perch/.dex": { name: "Task" } } });
  const ff = fakeFs([]); // source store absent ⇒ nothing to link
  const res = await runSpawn(
    { id: "abc12" },
    deps(exec, { spawn: fakeSpawn().spawn, writeScript: fakeWriteScript().writeScript, fs: ff.fs }),
  );
  assert.equal(res.ok, true);
  assert.equal(ff.links.length, 0);
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

// ----- runSpawnBatch (the `dex.spawn-all` fleet launch) ---------------------

test("isReadyToSpawn: only unblocked `ready` rows pass the gate", () => {
  assert.equal(isReadyToSpawn({ id: "a", status: "ready", blockedByCount: 0 }), true);
  assert.equal(isReadyToSpawn({ id: "b", status: "ready", blockedByCount: 2 }), false);
  assert.equal(isReadyToSpawn({ id: "c", status: "in-progress", blockedByCount: 0 }), false);
  assert.equal(isReadyToSpawn({ id: "d", status: "blocked", blockedByCount: 1 }), false);
  assert.equal(isReadyToSpawn({ id: "e", status: "done", blockedByCount: 0 }), false);
});

test("runSpawnBatch: spawns every ready task (skipping blocked/started/done), in board order", async () => {
  const { exec, calls } = execStub({
    tasks: { "/work/perch/.dex": { name: "A task" } },
    defaultBranch: "main",
  });
  const term = fakeSpawn();
  const candidates: SpawnCandidate[] = [
    { id: "ready1", status: "ready", blockedByCount: 0 },
    { id: "blkd01", status: "ready", blockedByCount: 2 }, // active blockers → skip
    { id: "wip001", status: "in-progress", blockedByCount: 0 }, // already started → skip
    { id: "ready2", status: "ready", blockedByCount: 0 },
    { id: "done01", status: "done", blockedByCount: 0 }, // completed → skip
  ];
  const res = await runSpawnBatch(
    candidates,
    deps(exec, { spawn: term.spawn, writeScript: fakeWriteScript().writeScript }),
  );

  assert.equal(res.ok, true);
  assert.equal(res.spawned, 2);
  assert.equal(res.failed, 0);
  assert.deepEqual(
    res.results.map((r) => r.id),
    ["ready1", "ready2"],
  );
  assert.equal(term.calls, 2); // exactly the two ready tasks launched
  // No worktree was ever created for a skipped task.
  for (const skipped of ["blkd01", "wip001", "done01"]) {
    assert.ok(
      !calls.some((c) => c.cmd === "git" && c.args.some((a) => a.includes(skipped))),
      `should not have touched ${skipped}`,
    );
  }
});

test("runSpawnBatch: no ready tasks is a clean no-op (nothing launched)", async () => {
  const { exec, calls } = execStub({ tasks: { "/work/perch/.dex": { name: "T" } } });
  const term = fakeSpawn();
  const res = await runSpawnBatch(
    [{ id: "wip001", status: "in-progress", blockedByCount: 0 }],
    deps(exec, { spawn: term.spawn, writeScript: fakeWriteScript().writeScript }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.spawned, 0);
  assert.equal(res.failed, 0);
  assert.match(res.message, /No ready tasks/);
  assert.equal(term.calls, 0);
  assert.equal(calls.length, 0); // never probed a store
});

test("runSpawnBatch: a per-task failure is isolated — others still spawn", async () => {
  // The store knows "good123" but not "ghost1", so that task's spawn fails
  // (not-found) while the other succeeds.
  const { exec } = execStub({
    tasks: { "/work/perch/.dex": { name: "Known" } },
  });
  // Make "ghost1" unknown by routing it through a store with no entry: simplest
  // is a custom exec that rejects `show` for ghost1.
  const wrapped: Exec = (cmd, args, o) => {
    if (cmd === "dex" && args.includes("show") && args.includes("ghost1")) {
      return Promise.reject(new Error("not found"));
    }
    return exec(cmd, args, o);
  };
  const term = fakeSpawn();
  const res = await runSpawnBatch(
    [
      { id: "good123", status: "ready", blockedByCount: 0 },
      { id: "ghost1", status: "ready", blockedByCount: 0 },
    ],
    deps(wrapped, { spawn: term.spawn, writeScript: fakeWriteScript().writeScript }),
  );
  assert.equal(res.spawned, 1);
  assert.equal(res.failed, 1);
  assert.equal(res.ok, false);
  assert.match(res.message, /1 failed/);
  const ghost = res.results.find((r) => r.id === "ghost1");
  assert.equal(ghost!.result.ok, false);
});
