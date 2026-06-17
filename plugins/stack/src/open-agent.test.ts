/**
 * Unit tests for the `stack.open-agent` action's pure helpers + the `runOpenAgent`
 * orchestration. The `git` CLI (the `Exec` seam) and the terminal launcher
 * (`spawn`/`writeScript`) are stubbed, so nothing spawns a real process — we
 * assert the window title, existing-worktree reuse, the NO-prompt `claude` launch
 * command (auto mode, nothing after `auto`), and the graceful failure paths.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { agentTitle, runOpenAgent, type OpenAgentDeps } from "./open-agent.js";
import type { Exec } from "./provider.js";

test("agentTitle: uses the PR number when known, else the branch", () => {
  assert.equal(agentTitle({ headRefName: "feat-x", number: 42 }), "agent · #42");
  assert.equal(agentTitle({ headRefName: "feat-x" }), "agent · feat-x");
});

/** A fake terminal spawn that just counts calls (only `.on`/`.unref` are used). */
function fakeSpawn(): { spawn: OpenAgentDeps["spawn"]; calls: number } {
  let calls = 0;
  const spawn = (() => {
    calls += 1;
    return { on: () => {}, unref: () => {} };
  }) as unknown as OpenAgentDeps["spawn"];
  return {
    spawn,
    get calls() {
      return calls;
    },
  };
}

/** A `writeScript` stub that records the command without touching disk. */
function fakeWriteScript(): {
  writeScript: OpenAgentDeps["writeScript"];
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
 * An `Exec` stub recording calls. `worktreeList` is the porcelain `git worktree
 * list` returns; `failAdd` makes `worktree add` reject.
 */
function execStub(opts: { worktreeList?: string; failAdd?: boolean } = {}): {
  exec: Exec;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: Exec = (cmd, args) => {
    calls.push({ cmd, args });
    if (args.includes("list")) return Promise.resolve(opts.worktreeList ?? "");
    if (args.includes("add")) {
      return opts.failAdd
        ? Promise.reject(new Error("fatal: already checked out"))
        : Promise.resolve("");
    }
    return Promise.resolve("");
  };
  return { exec, calls };
}

function deps(exec: Exec, over: Partial<OpenAgentDeps> = {}): OpenAgentDeps {
  return { repoDir: "/work/perch", exec, gitBin: "git", terminal: {}, ...over };
}

test("runOpenAgent: rejects an empty head branch before touching any seam", async () => {
  const { exec, calls } = execStub();
  const res = await runOpenAgent({ headRefName: "  " }, deps(exec));
  assert.equal(res.ok, false);
  assert.match(res.message, /no head branch/);
  assert.equal(calls.length, 0);
});

test("runOpenAgent: happy path — adds the branch worktree, launches claude with NO prompt", async () => {
  const { exec, calls } = execStub({
    worktreeList: "worktree /work/perch\nbranch refs/heads/main\n",
  });
  const term = fakeSpawn();
  const script = fakeWriteScript();
  const res = await runOpenAgent(
    { headRefName: "feat-x", number: 7 },
    deps(exec, { spawn: term.spawn, writeScript: script.writeScript }),
  );

  assert.equal(res.ok, true);
  assert.equal(res.reused, false);
  assert.equal(res.worktreePath, "/work/perch-worktrees/feat-x");

  // The worktree was added on the EXISTING branch (no -b).
  const add = calls.find((c) => c.args.includes("add"));
  assert.deepEqual(add!.args, [
    "-C",
    "/work/perch",
    "worktree",
    "add",
    "/work/perch-worktrees/feat-x",
    "feat-x",
  ]);

  // The agent launched once: title first, then cd + exec claude with NO prompt
  // (the line ends right after `auto`, not an empty quoted string).
  assert.equal(term.calls, 1);
  assert.equal(script.commands.length, 1);
  assert.match(script.commands[0]!, /^printf '\\033\]0;%s\\007' 'agent · #7'\n/);
  assert.match(
    script.commands[0]!,
    /\ncd '\/work\/perch-worktrees\/feat-x' && exec claude --permission-mode auto$/,
  );
});

test("runOpenAgent: reuses an existing worktree for the branch (no add)", async () => {
  const porcelain = "worktree /existing/feat\nHEAD abc\nbranch refs/heads/feat-x\n";
  const { exec, calls } = execStub({ worktreeList: porcelain });
  const term = fakeSpawn();
  const res = await runOpenAgent(
    { headRefName: "feat-x" },
    deps(exec, { spawn: term.spawn, writeScript: fakeWriteScript().writeScript }),
  );

  assert.equal(res.ok, true);
  assert.equal(res.reused, true);
  assert.equal(res.worktreePath, "/existing/feat");
  assert.equal(
    calls.some((c) => c.args.includes("add")),
    false,
  );
  assert.match(res.message, /existing worktree \/existing\/feat/);
});

test("runOpenAgent: a worktree-add failure is a clean error, no launch", async () => {
  const { exec } = execStub({ failAdd: true });
  const term = fakeSpawn();
  const res = await runOpenAgent(
    { headRefName: "feat-x" },
    deps(exec, { spawn: term.spawn, writeScript: fakeWriteScript().writeScript }),
  );
  assert.equal(res.ok, false);
  assert.match(res.message, /couldn't create worktree/);
  assert.equal(term.calls, 0);
});
