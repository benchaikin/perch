/**
 * Unit tests for the `dex.land` auto-lander: the pure helpers (`inferBuild`,
 * `evidenceFor`, `landNotifications`) and the `runLand` enumerate→guard→reap
 * orchestration. The `git`/`gh`/`dex` CLIs (the `Exec` seam) and the toolchain
 * file checks (the `FsProbe` seam) are stubbed, so nothing spawns a process or
 * touches disk — we assert which worktrees get reaped vs. flagged, the exact
 * destructive git/dex calls, and that every guard holds before anything is
 * removed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evidenceFor,
  inferBuild,
  landNotifications,
  meaningfulDirt,
  runLand,
  type FsProbe,
  type LandBoard,
  type LandDeps,
} from "./land.js";
import type { Exec } from "./provider.js";

// --- inferBuild -------------------------------------------------------------

/** An FsProbe over a fixed set of present files (+ optional package.json text). */
function fsWith(files: string[], pkgText?: string): FsProbe {
  const set = new Set(files);
  return {
    exists: (p) => set.has(p),
    readText: (p) => (p.endsWith("package.json") ? pkgText : undefined),
  };
}

test("inferBuild: pnpm-lock wins → pnpm -r build", () => {
  const b = inferBuild("/r", fsWith(["/r/pnpm-lock.yaml", "/r/package.json"], '{"scripts":{"build":"x"}}'));
  assert.deepEqual(b, { cmd: "pnpm", args: ["-r", "build"] });
});

test("inferBuild: package.json build script, no yarn → npm run build", () => {
  const b = inferBuild("/r", fsWith(["/r/package.json"], '{"scripts":{"build":"tsc"}}'));
  assert.deepEqual(b, { cmd: "npm", args: ["run", "build"] });
});

test("inferBuild: package.json build script + yarn.lock → yarn build", () => {
  const b = inferBuild("/r", fsWith(["/r/package.json", "/r/yarn.lock"], '{"scripts":{"build":"tsc"}}'));
  assert.deepEqual(b, { cmd: "yarn", args: ["build"] });
});

test("inferBuild: package.json with NO build script falls through to make", () => {
  const b = inferBuild("/r", fsWith(["/r/package.json", "/r/Makefile"], '{"scripts":{"test":"x"}}'));
  assert.deepEqual(b, { cmd: "make", args: [] });
});

test("inferBuild: Cargo.toml → cargo build; go.mod → go build ./...", () => {
  assert.deepEqual(inferBuild("/r", fsWith(["/r/Cargo.toml"])), { cmd: "cargo", args: ["build"] });
  assert.deepEqual(inferBuild("/r", fsWith(["/r/go.mod"])), { cmd: "go", args: ["build", "./..."] });
});

test("inferBuild: nothing inferable → undefined", () => {
  assert.equal(inferBuild("/r", fsWith(["/r/README.md"])), undefined);
});

test("evidenceFor: composes the PR-derived completion string", () => {
  assert.equal(
    evidenceFor({ number: 42, title: "Fix login", url: "http://x/42", mergeCommit: "deadbeef" }),
    "Merged PR #42: Fix login (http://x/42) — merge commit deadbeef",
  );
});

// --- runLand orchestration --------------------------------------------------

/** Build `git worktree list --porcelain` output: main first, then each dex tree. */
function porcelain(main: string, trees: Array<{ path: string; branch: string }>): string {
  const blocks = [`worktree ${main}\nHEAD aaa\nbranch refs/heads/main`];
  for (const t of trees) {
    blocks.push(`worktree ${t.path}\nHEAD bbb\nbranch refs/heads/${t.branch}`);
  }
  return blocks.join("\n\n") + "\n";
}

interface StubOpts {
  /** porcelain for `git -C <repo> worktree list`. */
  worktrees: string;
  /** gh pr view JSON per branch; a missing branch → gh rejects (no PR). */
  prByBranch: Record<string, string>;
  /** `git status --porcelain` dirt per worktree path (default clean = ""). */
  dirtByPath?: Record<string, string>;
  /** perch.dexTask override per worktree path (default unset). */
  overrideByPath?: Record<string, string>;
  /** Reject the build command (no-CI gate failure). */
  failBuild?: boolean;
  /** Reject `git branch -d` so the `-D` fallback is exercised. */
  failBranchD?: boolean;
  /** Task ids `dex show --json` reports as already completed. */
  completedTasks?: string[];
  /** When true, `git cat-file -e <sha>` rejects (the merge commit isn't local). */
  commitMissing?: boolean;
}

function stub(opts: StubOpts): { exec: Exec; calls: Array<{ cmd: string; args: string[]; cwd?: string }> } {
  const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
  const dirt = opts.dirtByPath ?? {};
  const overrides = opts.overrideByPath ?? {};
  const exec: Exec = (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o?.cwd });
    if (cmd === "git") {
      if (args.includes("worktree") && args.includes("list")) return Promise.resolve(opts.worktrees);
      if (args.includes("config") && args.includes("perch.dexTask")) {
        const path = args[args.indexOf("-C") + 1]!;
        const v = overrides[path];
        return v ? Promise.resolve(v + "\n") : Promise.reject(new Error("unset"));
      }
      if (args.includes("status")) {
        const path = args[args.indexOf("-C") + 1]!;
        return Promise.resolve(dirt[path] ?? "");
      }
      if (args.includes("cat-file")) {
        return opts.commitMissing ? Promise.reject(new Error("not found")) : Promise.resolve("");
      }
      if (args.includes("worktree") && args.includes("remove")) return Promise.resolve("");
      if (args.includes("branch") && args.includes("-d")) {
        return opts.failBranchD ? Promise.reject(new Error("not merged")) : Promise.resolve("");
      }
      if (args.includes("branch") && args.includes("-D")) return Promise.resolve("");
    }
    if (cmd === "gh") {
      const branch = args[args.indexOf("view") + 1]!;
      const json = opts.prByBranch[branch];
      return json ? Promise.resolve(json) : Promise.reject(new Error("no PR"));
    }
    if (cmd === "dex") {
      if (args.includes("show")) {
        const id = args[args.indexOf("show") + 1]!;
        return Promise.resolve(JSON.stringify({ id, completed: (opts.completedTasks ?? []).includes(id) }));
      }
      return Promise.resolve(""); // complete
    }
    // A build command (pnpm/npm/yarn/make/cargo/go).
    return opts.failBuild ? Promise.reject(new Error("build failed")) : Promise.resolve("");
  };
  return { exec, calls };
}

function deps(exec: Exec, over: Partial<LandDeps> = {}): LandDeps {
  return {
    exec,
    gitBin: "git",
    ghBin: "gh",
    dexBin: "dex",
    repos: ["/work/perch"],
    autoLand: true,
    // Default fs: no toolchain files (only matters for no-CI repos in specific tests).
    fs: { exists: () => false, readText: () => undefined },
    ...over,
  };
}

const mergedWithCi = JSON.stringify({
  state: "MERGED",
  mergedAt: "2026-06-17T00:00:00Z",
  mergeCommit: { oid: "sha123" },
  url: "http://x/7",
  title: "Do the thing",
  number: 7,
  statusCheckRollup: [{ name: "ci" }],
});

test("runLand: merged + clean + has CI → reaps (worktree remove, branch -d, dex complete)", async () => {
  const wt = "/work/perch-worktrees/abc12-foo";
  const { exec, calls } = stub({
    worktrees: porcelain("/work/perch", [{ path: wt, branch: "dex/abc12-foo" }]),
    prByBranch: { "dex/abc12-foo": mergedWithCi },
  });
  const board = await runLand(deps(exec));

  assert.equal(board.flagged.length, 0);
  assert.equal(board.reaped.length, 1);
  assert.equal(board.reaped[0]!.taskId, "abc12");
  assert.match(board.reaped[0]!.reason, /Merged PR #7: Do the thing/);

  // The destructive calls fired, in order, with the merge SHA.
  const remove = calls.find((c) => c.args.includes("remove"));
  const branch = calls.find((c) => c.args.includes("branch"));
  const complete = calls.find((c) => c.cmd === "dex" && c.args.includes("complete"));
  assert.deepEqual(remove?.args, ["-C", "/work/perch", "worktree", "remove", wt]);
  assert.deepEqual(branch?.args, ["-C", "/work/perch", "branch", "-d", "dex/abc12-foo"]);
  assert.ok(complete);
  assert.deepEqual(complete!.args, [
    "--storage-path",
    "/work/perch/.dex",
    "complete",
    "abc12",
    "--commit",
    "sha123",
    "--result",
    "Merged PR #7: Do the thing (http://x/7) — merge commit sha123",
  ]);
});

test("runLand: open (unmerged) PR is skipped entirely — not reaped, not flagged", async () => {
  const { exec, calls } = stub({
    worktrees: porcelain("/work/perch", [{ path: "/wt/a", branch: "dex/abc12-foo" }]),
    prByBranch: { "dex/abc12-foo": JSON.stringify({ state: "OPEN", mergedAt: "" }) },
  });
  const board = await runLand(deps(exec));
  assert.deepEqual(board, { reaped: [], flagged: [] });
  assert.equal(calls.some((c) => c.args.includes("remove")), false);
});

test("runLand: no PR for the branch → skipped (in-progress, not actionable)", async () => {
  const { exec } = stub({
    worktrees: porcelain("/work/perch", [{ path: "/wt/a", branch: "dex/abc12-foo" }]),
    prByBranch: {},
  });
  const board = await runLand(deps(exec));
  assert.deepEqual(board, { reaped: [], flagged: [] });
});

test("runLand: merged but DIRTY tree → flagged, never reaped", async () => {
  const wt = "/wt/a";
  const { exec, calls } = stub({
    worktrees: porcelain("/work/perch", [{ path: wt, branch: "dex/abc12-foo" }]),
    prByBranch: { "dex/abc12-foo": mergedWithCi },
    dirtByPath: { [wt]: " M src/x.ts\n" },
  });
  const board = await runLand(deps(exec));
  assert.equal(board.reaped.length, 0);
  assert.equal(board.flagged.length, 1);
  assert.match(board.flagged[0]!.reason, /uncommitted changes/);
  assert.equal(calls.some((c) => c.args.includes("remove")), false);
});

test("meaningfulDirt: drops a lone perch-created `.dex` link, keeps real changes", () => {
  // The store link git won't ignore (a symlink vs the repo's dir-only `.dex/`).
  assert.deepEqual(meaningfulDirt("?? .dex\n"), []);
  assert.deepEqual(meaningfulDirt(""), []);
  // Real edits alongside the link still count as dirt.
  assert.deepEqual(meaningfulDirt("?? .dex\n M src/x.ts\n"), [" M src/x.ts"]);
  // A path that merely starts with `.dex` is not the link — keep it.
  assert.deepEqual(meaningfulDirt("?? .dexrc\n"), ["?? .dexrc"]);
});

test("runLand: merged + a lone `.dex` link (pre-fix worktree) → still reaps", async () => {
  const wt = "/work/perch-worktrees/abc12-foo";
  const { exec, calls } = stub({
    worktrees: porcelain("/work/perch", [{ path: wt, branch: "dex/abc12-foo" }]),
    prByBranch: { "dex/abc12-foo": mergedWithCi },
    // A worktree spawned before the exclude fix carries the untracked `.dex`.
    dirtByPath: { [wt]: "?? .dex\n" },
  });
  const board = await runLand(deps(exec));
  assert.equal(board.flagged.length, 0);
  assert.equal(board.reaped.length, 1);
  assert.ok(calls.some((c) => c.args.includes("remove")));
});

test("runLand: never touches the main worktree even if it somehow matched", async () => {
  // Main worktree listed first; only the dex tree below is a candidate.
  const { exec, calls } = stub({
    worktrees: porcelain("/work/perch", []),
    prByBranch: {},
  });
  const board = await runLand(deps(exec));
  assert.deepEqual(board, { reaped: [], flagged: [] });
  // Only the `worktree list` ran — no gh/status/remove against main.
  assert.equal(calls.filter((c) => c.cmd === "gh").length, 0);
});

const mergedNoCi = JSON.stringify({
  state: "MERGED",
  mergedAt: "2026-06-17T00:00:00Z",
  mergeCommit: { oid: "sha9" },
  url: "http://x/9",
  title: "No CI repo",
  number: 9,
  statusCheckRollup: [],
});

test("runLand: no-CI repo — build passes → reaped", async () => {
  const wt = "/wt/a";
  const { exec, calls } = stub({
    worktrees: porcelain("/work/perch", [{ path: wt, branch: "dex/abc12-foo" }]),
    prByBranch: { "dex/abc12-foo": mergedNoCi },
  });
  const board = await runLand(deps(exec, { fs: fsWith([`${wt}/go.mod`]) }));
  assert.equal(board.reaped.length, 1);
  // The build gate ran in the worktree before the reap.
  const build = calls.find((c) => c.cmd === "go");
  assert.deepEqual(build?.args, ["build", "./..."]);
  assert.equal(build?.cwd, wt);
});

test("runLand: no-CI repo — build FAILS → flagged, never reaped", async () => {
  const wt = "/wt/a";
  const { exec, calls } = stub({
    worktrees: porcelain("/work/perch", [{ path: wt, branch: "dex/abc12-foo" }]),
    prByBranch: { "dex/abc12-foo": mergedNoCi },
    failBuild: true,
  });
  const board = await runLand(deps(exec, { fs: fsWith([`${wt}/go.mod`]) }));
  assert.equal(board.reaped.length, 0);
  assert.match(board.flagged[0]!.reason, /build failed/);
  assert.equal(calls.some((c) => c.args.includes("remove")), false);
});

test("runLand: no-CI repo — no inferable build → flagged", async () => {
  const { exec } = stub({
    worktrees: porcelain("/work/perch", [{ path: "/wt/a", branch: "dex/abc12-foo" }]),
    prByBranch: { "dex/abc12-foo": mergedNoCi },
  });
  const board = await runLand(deps(exec)); // default fs: no toolchain files
  assert.match(board.flagged[0]!.reason, /no build command could be inferred/);
});

test("runLand: autoLand=false — merged+clean is flagged 'ready to land', NOT reaped", async () => {
  const { exec, calls } = stub({
    worktrees: porcelain("/work/perch", [{ path: "/wt/a", branch: "dex/abc12-foo" }]),
    prByBranch: { "dex/abc12-foo": mergedWithCi },
  });
  const board = await runLand(deps(exec, { autoLand: false }));
  assert.equal(board.reaped.length, 0);
  assert.match(board.flagged[0]!.reason, /ready to land/);
  assert.equal(calls.some((c) => c.args.includes("remove")), false);
});

test("runLand: perch.dexTask override resolves the id when the branch isn't dex/<id>", async () => {
  const wt = "/wt/custom";
  const { exec } = stub({
    worktrees: porcelain("/work/perch", [{ path: wt, branch: "feature/login" }]),
    prByBranch: { "feature/login": mergedWithCi },
    overrideByPath: { [wt]: "xyz99" },
  });
  const board = await runLand(deps(exec));
  assert.equal(board.reaped.length, 1);
  assert.equal(board.reaped[0]!.taskId, "xyz99");
});

test("runLand: a non-dex branch with no override is ignored", async () => {
  const { exec } = stub({
    worktrees: porcelain("/work/perch", [{ path: "/wt/x", branch: "feature/login" }]),
    prByBranch: { "feature/login": mergedWithCi },
  });
  const board = await runLand(deps(exec));
  assert.deepEqual(board, { reaped: [], flagged: [] });
});

test("runLand: an already-completed task is reaped but `dex complete` is skipped", async () => {
  const wt = "/wt/a";
  const { exec, calls } = stub({
    worktrees: porcelain("/work/perch", [{ path: wt, branch: "dex/abc12-foo" }]),
    prByBranch: { "dex/abc12-foo": mergedWithCi },
    completedTasks: ["abc12"],
  });
  const board = await runLand(deps(exec));
  assert.equal(board.reaped.length, 1);
  // Worktree + branch were removed…
  assert.ok(calls.some((c) => c.args.includes("remove")));
  assert.ok(calls.some((c) => c.cmd === "git" && c.args.includes("-d")));
  // …but `dex complete` was NOT called (the task is already done).
  assert.equal(calls.some((c) => c.cmd === "dex" && c.args.includes("complete")), false);
});

test("runLand: merge commit not local → completes with --no-commit, still reaps", async () => {
  const { exec, calls } = stub({
    worktrees: porcelain("/work/perch", [{ path: "/wt/a", branch: "dex/abc12-foo" }]),
    prByBranch: { "dex/abc12-foo": mergedWithCi },
    commitMissing: true, // GitHub merge commit isn't in the local repo
  });
  const board = await runLand(deps(exec));
  assert.equal(board.reaped.length, 1);
  const complete = calls.find((c) => c.cmd === "dex" && c.args.includes("complete"));
  assert.ok(complete);
  assert.ok(complete!.args.includes("--no-commit"), "expected --no-commit fallback");
  assert.equal(complete!.args.includes("--commit"), false);
  // The merge SHA is still preserved in the evidence/result text.
  assert.match(board.reaped[0]!.reason, /merge commit sha123/);
});

test("runLand: branch -d refusal falls back to -D (merge is gh-confirmed)", async () => {
  const { exec, calls } = stub({
    worktrees: porcelain("/work/perch", [{ path: "/wt/a", branch: "dex/abc12-foo" }]),
    prByBranch: { "dex/abc12-foo": mergedWithCi },
    failBranchD: true,
  });
  const board = await runLand(deps(exec));
  assert.equal(board.reaped.length, 1);
  assert.ok(calls.some((c) => c.args.includes("-D")), "expected the -D fallback");
});

// --- landNotifications ------------------------------------------------------

const reapedBoard: LandBoard = {
  reaped: [
    { taskId: "abc12", branch: "dex/abc12", path: "/wt/a", repo: "/r", action: "reaped", reason: "Merged PR #7", pr: { number: 7 } },
  ],
  flagged: [],
};

test("landNotifications: first poll (no prev) is silent", () => {
  assert.deepEqual(landNotifications(undefined, reapedBoard), []);
});

test("landNotifications: a reaped worktree announces 'Landed' once", () => {
  const notes = landNotifications({ reaped: [], flagged: [] }, reapedBoard);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.title, "Landed");
  assert.equal(notes[0]!.level, "success");
  assert.equal(notes[0]!.dedupeKey, "land:abc12:reaped");
});

test("landNotifications: a NEW flag warns; a persistent one does not re-warn", () => {
  const flagged: LandBoard = {
    reaped: [],
    flagged: [{ taskId: "z9", branch: "dex/z9", path: "/wt/z", repo: "/r", action: "flagged", reason: "merged but dirty" }],
  };
  // New flag (absent in prev) → one warning.
  const first = landNotifications({ reaped: [], flagged: [] }, flagged);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.level, "warning");
  // Same flag still present next poll → no repeat.
  const again = landNotifications(flagged, flagged);
  assert.equal(again.length, 0);
});
