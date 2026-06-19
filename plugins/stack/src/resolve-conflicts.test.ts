/**
 * Unit tests for the `stack.resolve-conflicts` action's pure helpers + the
 * `runResolveConflicts` orchestration. The `git` CLI (the `Exec` seam) and the
 * terminal launcher (`spawn`/`writeScript`) are stubbed, so nothing spawns a real
 * process — we assert the worktree path/branch, the git args (existing branch, no
 * `-b`), the conflict-resolution prompt, the safely-quoted `claude` launch
 * command, existing-worktree reuse, and the graceful failure paths.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { dexTaskColorRgb, resolveTabColorCommand, type GlobalTerminalConfig } from "@perch/sdk";

import {
  agentTitle,
  conflictPrompt,
  parseWorktreeForBranch,
  runResolveConflicts,
  sanitizeBranchForPath,
  worktreeAddArgs,
  worktreeListArgs,
  worktreePathFor,
  type ResolveConflictsDeps,
} from "./resolve-conflicts.js";
import type { Exec } from "./provider.js";

/** The iTerm2 tab-color escape a given color key resolves to in the launch script. */
function tabColor(term: GlobalTerminalConfig, key: string): string {
  return resolveTabColorCommand(term, dexTaskColorRgb(key))!;
}

/** Escape a literal string for use inside a `RegExp` (the escapes carry `\`, `]`, `;`). */
function escapeForRegex(literal: string): RegExp {
  return new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

test("sanitizeBranchForPath: collapses separators into a single path segment", () => {
  assert.equal(sanitizeBranchForPath("dex/abc-foo"), "dex-abc-foo");
  assert.equal(sanitizeBranchForPath("feat/x_y.z"), "feat-x_y.z");
  assert.equal(sanitizeBranchForPath("--weird//name--"), "weird-name");
  // No usable characters → a well-formed fallback.
  assert.equal(sanitizeBranchForPath("///"), "branch");
});

test("worktreePathFor: a sibling <repo>-worktrees/<sanitized-branch> dir", () => {
  assert.equal(worktreePathFor("/work/perch", "dex/abc-foo"), "/work/perch-worktrees/dex-abc-foo");
});

test("worktreeAddArgs: checks out the EXISTING branch (no -b)", () => {
  assert.deepEqual(worktreeAddArgs("/work/perch", "/work/perch-worktrees/fix", "fix-branch"), [
    "-C",
    "/work/perch",
    "worktree",
    "add",
    "/work/perch-worktrees/fix",
    "fix-branch",
  ]);
});

test("worktreeListArgs: porcelain listing scoped to the repo", () => {
  assert.deepEqual(worktreeListArgs("/work/perch"), [
    "-C",
    "/work/perch",
    "worktree",
    "list",
    "--porcelain",
  ]);
});

test("parseWorktreeForBranch: finds the matching worktree, ignores others/detached", () => {
  const porcelain = [
    "worktree /work/perch",
    "HEAD aaa",
    "branch refs/heads/main",
    "",
    "worktree /work/perch-worktrees/fix",
    "HEAD bbb",
    "branch refs/heads/fix-branch",
    "",
    "worktree /work/perch-worktrees/detached",
    "HEAD ccc",
    "detached",
    "",
  ].join("\n");
  assert.equal(parseWorktreeForBranch(porcelain, "fix-branch"), "/work/perch-worktrees/fix");
  assert.equal(parseWorktreeForBranch(porcelain, "main"), "/work/perch");
  // A branch that's only a prefix of another must not match.
  assert.equal(parseWorktreeForBranch(porcelain, "fix"), undefined);
  assert.equal(parseWorktreeForBranch(porcelain, "nope"), undefined);
});

test("conflictPrompt: names the branch, the base, and the no-merge boundary", () => {
  const prompt = conflictPrompt({ headRefName: "fix-branch", baseRefName: "main" });
  assert.match(prompt, /branch `fix-branch`/);
  assert.match(prompt, /its base `main`/);
  assert.match(prompt, /git rebase origin\/main/);
  assert.match(prompt, /Do NOT merge/);
});

test("conflictPrompt: degrades gracefully when the base is unknown", () => {
  const prompt = conflictPrompt({ headRefName: "fix-branch" });
  assert.match(prompt, /its base branch \(check the PR for it\)/);
  assert.match(prompt, /git rebase onto the PR's base/);
});

test("agentTitle: uses the PR number when known, else the branch", () => {
  assert.equal(agentTitle({ headRefName: "fix-branch", number: 42 }), "fix conflicts · #42");
  assert.equal(agentTitle({ headRefName: "fix-branch" }), "fix conflicts · fix-branch");
});

/** A fake terminal spawn that just counts calls (only `.on`/`.unref` are used). */
function fakeSpawn(): { spawn: ResolveConflictsDeps["spawn"]; calls: number } {
  let calls = 0;
  const spawn = (() => {
    calls += 1;
    return { on: () => {}, unref: () => {} };
  }) as unknown as ResolveConflictsDeps["spawn"];
  return {
    spawn,
    get calls() {
      return calls;
    },
  };
}

/** A `writeScript` stub that records the command without touching disk. */
function fakeWriteScript(): {
  writeScript: ResolveConflictsDeps["writeScript"];
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

function deps(exec: Exec, over: Partial<ResolveConflictsDeps> = {}): ResolveConflictsDeps {
  return { repoDir: "/work/perch", exec, gitBin: "git", terminal: {}, ...over };
}

test("runResolveConflicts: rejects an empty head branch before touching any seam", async () => {
  const { exec, calls } = execStub();
  const res = await runResolveConflicts({ headRefName: "  " }, deps(exec));
  assert.equal(res.ok, false);
  assert.match(res.message, /no head branch/);
  assert.equal(calls.length, 0);
});

test("runResolveConflicts: happy path — adds the branch worktree, launches claude", async () => {
  const { exec, calls } = execStub({
    worktreeList: "worktree /work/perch\nbranch refs/heads/main\n",
  });
  const term = fakeSpawn();
  const script = fakeWriteScript();
  const res = await runResolveConflicts(
    { headRefName: "fix-branch", baseRefName: "main", number: 7 },
    deps(exec, { spawn: term.spawn, writeScript: script.writeScript }),
  );

  assert.equal(res.ok, true);
  assert.equal(res.reused, false);
  assert.equal(res.worktreePath, "/work/perch-worktrees/fix-branch");

  // The worktree was added on the EXISTING branch (no -b).
  const add = calls.find((c) => c.args.includes("add"));
  assert.deepEqual(add!.args, [
    "-C",
    "/work/perch",
    "worktree",
    "add",
    "/work/perch-worktrees/fix-branch",
    "fix-branch",
  ]);

  // The agent launched once: title first, then cd + exec claude with the prompt.
  assert.equal(term.calls, 1);
  assert.equal(script.commands.length, 1);
  assert.match(script.commands[0]!, /^printf '\\033\]0;%s\\007' 'fix conflicts · #7'\n/);
  assert.match(
    script.commands[0]!,
    /\ncd '\/work\/perch-worktrees\/fix-branch' && exec claude --permission-mode auto '/,
  );
});

test("runResolveConflicts: reuses an existing worktree for the branch (no add)", async () => {
  const porcelain = "worktree /existing/fix\nHEAD abc\nbranch refs/heads/fix-branch\n";
  const { exec, calls } = execStub({ worktreeList: porcelain });
  const term = fakeSpawn();
  const res = await runResolveConflicts(
    { headRefName: "fix-branch", baseRefName: "main" },
    deps(exec, { spawn: term.spawn, writeScript: fakeWriteScript().writeScript }),
  );

  assert.equal(res.ok, true);
  assert.equal(res.reused, true);
  assert.equal(res.worktreePath, "/existing/fix");
  // No `worktree add` ran — the existing checkout was reused.
  assert.equal(
    calls.some((c) => c.args.includes("add")),
    false,
  );
  assert.match(res.message, /existing worktree \/existing\/fix/);
});

test("runResolveConflicts: a worktree-add failure is a clean error, no launch", async () => {
  const { exec } = execStub({ failAdd: true });
  const term = fakeSpawn();
  const res = await runResolveConflicts(
    { headRefName: "fix-branch", baseRefName: "main" },
    deps(exec, { spawn: term.spawn, writeScript: fakeWriteScript().writeScript }),
  );
  assert.equal(res.ok, false);
  assert.match(res.message, /couldn't create worktree/);
  assert.equal(term.calls, 0);
});

test("runResolveConflicts: a dex PR's terminal is tinted by the bare task id", async () => {
  const { exec } = execStub();
  const script = fakeWriteScript();
  const term: GlobalTerminalConfig = { terminalApp: "iTerm2" };
  await runResolveConflicts(
    { headRefName: "dex/abc123-fix-login", baseRefName: "main" },
    deps(exec, { terminal: term, spawn: fakeSpawn().spawn, writeScript: script.writeScript }),
  );
  // Colored by the dex task id (matching the GUI chip + dex-spawn terminal),
  // NOT the full head branch.
  assert.match(script.commands[0]!, escapeForRegex(tabColor(term, "abc123")));
  assert.doesNotMatch(script.commands[0]!, escapeForRegex(tabColor(term, "dex/abc123-fix-login")));
});

test("runResolveConflicts: a non-dex PR's terminal is tinted by the full branch", async () => {
  const { exec } = execStub();
  const script = fakeWriteScript();
  const term: GlobalTerminalConfig = { terminalApp: "iTerm2" };
  await runResolveConflicts(
    { headRefName: "feature/x", baseRefName: "main" },
    deps(exec, { terminal: term, spawn: fakeSpawn().spawn, writeScript: script.writeScript }),
  );
  // No dex id to extract → unchanged from today: keyed off the full head branch.
  assert.match(script.commands[0]!, escapeForRegex(tabColor(term, "feature/x")));
});

test("runResolveConflicts: stacked PR rebases onto its parent layer, not trunk", async () => {
  const { exec } = execStub();
  const script = fakeWriteScript();
  // A stacked PR conflicts against its parent layer (baseRefName), not main.
  await runResolveConflicts(
    { headRefName: "feature-top", baseRefName: "feature-base" },
    deps(exec, { spawn: fakeSpawn().spawn, writeScript: script.writeScript }),
  );
  assert.match(script.commands[0]!, /git rebase origin\/feature-base/);
  assert.doesNotMatch(script.commands[0]!, /origin\/main/);
});
