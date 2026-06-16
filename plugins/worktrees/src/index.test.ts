/**
 * Unit tests for the worktrees plugin's repo-root resolution + the `list` read's
 * multi-repo enumeration (precedence, per-repo tagging, graceful degrade). The
 * git runner is stubbed via `__setExec`, keyed by the `cwd` each root runs in.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Capability, ReadDef } from "@perch/sdk";

import plugin, { __setExec, resolveRepoRoots, type Worktrees, type WorktreesConfig } from "./index.js";
import type { Exec } from "./provider.js";

/** Pull the `list` read off the plugin and type its `run` for direct invocation. */
const list = plugin.capabilities.list as Capability as ReadDef<unknown, Worktrees, WorktreesConfig>;

/** A minimal `git worktree list --porcelain` for a repo with one (main) worktree. */
function listing(path: string, branch: string): string {
  return `worktree ${path}\nHEAD aaaa\nbranch refs/heads/${branch}\n`;
}

/**
 * Build an `Exec` stub that returns canned `git worktree list` output per `cwd`
 * (the repo root) and empty status output. An optional `configByCwd` returns a
 * `perch.dexTask` value per worktree path (else empty, the unset case). A repo
 * `cwd` not in `byCwd` throws (a non-git / bad root).
 */
function execFor(byCwd: Record<string, string>, configByCwd: Record<string, string> = {}): Exec {
  return (_cmd, args, opts) => {
    if (args[0] === "worktree") {
      const out = opts?.cwd !== undefined ? byCwd[opts.cwd] : undefined;
      if (out === undefined) return Promise.reject(new Error(`not a git repo: ${opts?.cwd}`));
      return Promise.resolve(out);
    }
    if (args[0] === "config") {
      // `git config --worktree --get perch.dexTask` per worktree path.
      return Promise.resolve(opts?.cwd !== undefined ? (configByCwd[opts.cwd] ?? "") : "");
    }
    // status — empty (clean) for every worktree.
    return Promise.resolve("");
  };
}

/** Invoke the `list` read with a config + global, returning its board. */
function run(config: WorktreesConfig, global?: unknown): Promise<Worktrees> {
  return Promise.resolve(
    list.run({ input: {}, ctx: { config, global, log: () => {} } }),
  );
}

test("resolveRepoRoots precedence: override → global.repos → cwd", () => {
  // 1. repoRoot override wins, untagged, a single root.
  assert.deepEqual(resolveRepoRoots({ repoRoot: "/only" }, { repos: ["/a", "/b"] }), [
    { root: "/only", tag: undefined },
  ]);
  // 2. else global.repos, each tagged by basename.
  assert.deepEqual(resolveRepoRoots({}, { repos: ["/work/alpha", "/work/beta"] }), [
    { root: "/work/alpha", tag: "alpha" },
    { root: "/work/beta", tag: "beta" },
  ]);
  // 3. else the daemon cwd (undefined root, untagged).
  assert.deepEqual(resolveRepoRoots({}, undefined), [{ root: undefined, tag: undefined }]);
  assert.deepEqual(resolveRepoRoots({}, { repos: [] }), [{ root: undefined, tag: undefined }]);
});

test("list: override pins to one repo, untagged", async () => {
  __setExec(execFor({ "/only": listing("/only", "main") }));
  try {
    const { worktrees } = await run({ repoRoot: "/only" }, { repos: ["/a", "/b"] });
    assert.equal(worktrees.length, 1);
    assert.equal(worktrees[0]!.repo, undefined);
    assert.equal(worktrees[0]!.main, true);
  } finally {
    __setExec(undefined);
  }
});

test("list: enumerates + merges across global.repos, tagged per repo", async () => {
  __setExec(
    execFor({
      "/work/alpha": listing("/work/alpha", "main") + listing("/work/alpha-feat", "feat"),
      "/work/beta": listing("/work/beta", "main"),
    }),
  );
  try {
    const { worktrees } = await run({}, { repos: ["/work/alpha", "/work/beta"] });
    assert.equal(worktrees.length, 3);
    assert.deepEqual(
      worktrees.map((w) => w.repo),
      ["alpha", "alpha", "beta"],
    );
    // Each repo's first row is its own main.
    assert.equal(worktrees[0]!.main, true);
    assert.equal(worktrees[2]!.main, true);
  } finally {
    __setExec(undefined);
  }
});

test("list: a bad root contributes nothing rather than failing the whole list", async () => {
  // /work/beta is absent from the stub → its `git worktree list` rejects.
  __setExec(execFor({ "/work/alpha": listing("/work/alpha", "main") }));
  try {
    const { worktrees } = await run({}, { repos: ["/work/alpha", "/work/beta"] });
    assert.equal(worktrees.length, 1);
    assert.equal(worktrees[0]!.repo, "alpha");
  } finally {
    __setExec(undefined);
  }
});

test("list: taskId derives from a dex/ branch when no config override is set", async () => {
  __setExec(
    execFor({
      "/work/alpha":
        listing("/work/alpha", "main") + listing("/work/alpha-feat", "dex/abc12345-link"),
    }),
  );
  try {
    const { worktrees } = await run({}, { repos: ["/work/alpha"] });
    assert.equal(worktrees.length, 2);
    assert.equal(worktrees[0]!.taskId, undefined); // main is on `main`
    assert.equal(worktrees[1]!.taskId, "abc12345"); // parsed from the branch
  } finally {
    __setExec(undefined);
  }
});

test("list: a perch.dexTask config override beats the branch parse", async () => {
  __setExec(
    execFor(
      { "/work/alpha": listing("/work/alpha-feat", "dex/abc12345-link") },
      { "/work/alpha-feat": "override9" },
    ),
  );
  try {
    const { worktrees } = await run({}, { repos: ["/work/alpha"] });
    assert.equal(worktrees[0]!.taskId, "override9");
  } finally {
    __setExec(undefined);
  }
});

test("list: showMain=false drops every repo's main worktree", async () => {
  __setExec(
    execFor({
      "/work/alpha": listing("/work/alpha", "main") + listing("/work/alpha-feat", "feat"),
      "/work/beta": listing("/work/beta", "main"),
    }),
  );
  try {
    const { worktrees } = await run({ showMain: false }, { repos: ["/work/alpha", "/work/beta"] });
    // alpha's main + beta's main dropped; only alpha-feat remains.
    assert.equal(worktrees.length, 1);
    assert.equal(worktrees[0]!.name, "alpha-feat");
    assert.equal(worktrees[0]!.main, false);
  } finally {
    __setExec(undefined);
  }
});
