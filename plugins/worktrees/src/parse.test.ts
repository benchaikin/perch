/**
 * Unit tests for the pure worktree parsing + normalization.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildWorktrees,
  mergeWorktrees,
  parseStatus,
  parseWorktreeList,
  worktreeHealth,
  type WorktreeStatus,
} from "./parse.js";

const LIST = `worktree /repo
HEAD aaaa
branch refs/heads/main

worktree /repo-feature
HEAD bbbb
branch refs/heads/feat-x

worktree /repo-detached
HEAD cccc
detached
`;

test("parseWorktreeList parses records, strips refs/heads/, flags detached", () => {
  const wts = parseWorktreeList(LIST);
  assert.equal(wts.length, 3);
  assert.deepEqual(
    wts.map((w) => w.branch),
    ["main", "feat-x", undefined],
  );
  assert.equal(wts[2]!.detached, true);
  assert.equal(wts[0]!.path, "/repo");
});

test("parseWorktreeList flags bare / locked / prunable", () => {
  const wts = parseWorktreeList(
    `worktree /bare
bare

worktree /stale
HEAD dddd
branch refs/heads/old
locked reason here
prunable gitdir file points to non-existent location
`,
  );
  assert.equal(wts[0]!.bare, true);
  assert.equal(wts[1]!.locked, true);
  assert.equal(wts[1]!.prunable, true);
});

test("parseStatus counts dirty entries, detects conflict + ahead/behind", () => {
  const v2 = `# branch.oid abcd
# branch.head feat-x
# branch.upstream origin/feat-x
# branch.ab +2 -1
1 M. N... 100644 100644 100644 aaaa bbbb plugins/x.ts
? untracked.txt
u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflicted.ts`;
  const s = parseStatus(v2);
  assert.equal(s.dirtyCount, 3); // changed + untracked + unmerged
  assert.equal(s.conflict, true);
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 1);
});

test("parseStatus on a clean, no-upstream branch", () => {
  const s = parseStatus(`# branch.oid abcd\n# branch.head feat-x\n`);
  assert.deepEqual(s, { dirtyCount: 0, conflict: false, ahead: undefined, behind: undefined });
});

test("worktreeHealth: conflict/prunable → bad, diverged → warn, else muted", () => {
  assert.equal(worktreeHealth({ conflict: true, prunable: false }), "bad");
  assert.equal(worktreeHealth({ conflict: false, prunable: true }), "bad");
  assert.equal(worktreeHealth({ conflict: false, prunable: false, ahead: 2, behind: 1 }), "warn");
  // Dirty/ahead-only is normal → muted (severity stays neutral; chips show detail).
  assert.equal(worktreeHealth({ conflict: false, prunable: false, ahead: 3, behind: 0 }), "muted");
  assert.equal(worktreeHealth({ conflict: false, prunable: false }), "muted");
});

test("buildWorktrees marks the first as main, skips bare, joins status", () => {
  const raws = parseWorktreeList(LIST);
  const statusByPath = new Map<string, WorktreeStatus>([
    ["/repo-feature", { dirtyCount: 2, conflict: false, ahead: undefined, behind: undefined }],
  ]);
  const { worktrees } = buildWorktrees(raws, statusByPath);
  assert.equal(worktrees.length, 3);
  assert.equal(worktrees[0]!.main, true);
  assert.equal(worktrees[0]!.name, "repo");
  assert.equal(worktrees[1]!.main, false);
  assert.equal(worktrees[1]!.dirty, true);
  assert.equal(worktrees[1]!.dirtyCount, 2);
  assert.equal(worktrees[2]!.detached, true);
});

test("buildWorktrees drops bare worktrees and keeps main = first non-bare", () => {
  const raws = parseWorktreeList(
    `worktree /bare
bare

worktree /real
HEAD aaaa
branch refs/heads/main
`,
  );
  const { worktrees } = buildWorktrees(raws, new Map());
  assert.equal(worktrees.length, 1);
  assert.equal(worktrees[0]!.name, "real");
  assert.equal(worktrees[0]!.main, true);
});

test("buildWorktrees tags every row with its repo; undefined when omitted", () => {
  const raws = parseWorktreeList(LIST);
  const tagged = buildWorktrees(raws, new Map(), "alpha").worktrees;
  assert.deepEqual(
    tagged.map((w) => w.repo),
    ["alpha", "alpha", "alpha"],
  );
  const untagged = buildWorktrees(raws, new Map()).worktrees;
  assert.equal(untagged[0]!.repo, undefined);
});

test("mergeWorktrees concatenates per-repo boards, each main-first, in order", () => {
  const a = buildWorktrees(parseWorktreeList(LIST), new Map(), "alpha");
  const b = buildWorktrees(
    parseWorktreeList(`worktree /beta\nHEAD eeee\nbranch refs/heads/main\n`),
    new Map(),
    "beta",
  );
  const { worktrees } = mergeWorktrees([a, b]);
  assert.equal(worktrees.length, 4);
  assert.deepEqual(
    worktrees.map((w) => w.repo),
    ["alpha", "alpha", "alpha", "beta"],
  );
  // Each board keeps its own main-first ordering: row 0 (alpha) and the beta row.
  assert.equal(worktrees[0]!.main, true);
  assert.equal(worktrees[3]!.main, true);
  assert.equal(worktrees[1]!.main, false);
});
