/**
 * Unit tests for the Electron-free "landable" derivation: per-PR state mapping
 * and the work-item branch→PR join.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { PrInfo, PrOverview } from "./panel-state.js";
import type { WorktreeTaskLink, LinkedWorktree } from "./worktree-task-link.js";
import {
  deriveLandable,
  deriveLandableByTaskId,
  deriveLandablePrByTaskId,
  type LandableState,
} from "./landable.js";

/** A PR with defaults; override per case. */
function pr(over: Partial<PrInfo> & { headRefName: string }): PrInfo {
  return {
    number: 1,
    title: over.headRefName,
    url: `https://example.test/${over.headRefName}`,
    baseRefName: "main",
    ciStatus: "pass",
    ...over,
  };
}

/** A single-PR overview from a flat list of PRs (all in one repo). */
function overview(...prs: PrInfo[]): PrOverview {
  return { repos: [{ name: "repo", groups: prs.map((p) => ({ kind: "pr" as const, pr: p })) }] };
}

/** A worktree summary (the task→worktree facet) with a branch. */
function linkedWorktree(branch: string | undefined): LinkedWorktree {
  return { path: `/wt/${branch ?? "x"}`, branch, dirty: false, dirtyCount: 0 };
}

/** A link with the given task→worktree branch mappings. */
function link(entries: Record<string, string | undefined>): WorktreeTaskLink {
  const worktreeByTaskId = new Map<string, LinkedWorktree>();
  for (const [taskId, branch] of Object.entries(entries)) {
    worktreeByTaskId.set(taskId, linkedWorktree(branch));
  }
  return { taskByWorktreePath: new Map(), worktreeByTaskId };
}

// ---- deriveLandable: per-PR state mapping ----

test("CI green + approved → ready", () => {
  assert.equal(deriveLandable(pr({ headRefName: "b", ciStatus: "pass", reviewDecision: "APPROVED" })), "ready");
});

test("CI green + review required → needs-review", () => {
  assert.equal(
    deriveLandable(pr({ headRefName: "b", ciStatus: "pass", reviewDecision: "REVIEW_REQUIRED" })),
    "needs-review",
  );
});

test("CI green + no review decision → needs-review", () => {
  assert.equal(deriveLandable(pr({ headRefName: "b", ciStatus: "pass", reviewDecision: undefined })), "needs-review");
});

test("CI running → ci-running (even if approved)", () => {
  assert.equal(
    deriveLandable(pr({ headRefName: "b", ciStatus: "pending", reviewDecision: "APPROVED" })),
    "ci-running",
  );
});

// ---- no-CI repos: CI absent (not pending) → review is the gate ----

test("no CI + approved → ready (review is the gate)", () => {
  assert.equal(deriveLandable(pr({ headRefName: "b", ciStatus: "none", reviewDecision: "APPROVED" })), "ready");
});

test("no CI + review required → needs-review", () => {
  assert.equal(
    deriveLandable(pr({ headRefName: "b", ciStatus: "none", reviewDecision: "REVIEW_REQUIRED" })),
    "needs-review",
  );
});

test("no CI + no review decision → needs-review", () => {
  assert.equal(deriveLandable(pr({ headRefName: "b", ciStatus: "none", reviewDecision: undefined })), "needs-review");
});

test("absent ciStatus (undefined) is treated as no CI → review is the gate", () => {
  assert.equal(deriveLandable(pr({ headRefName: "b", ciStatus: undefined, reviewDecision: "APPROVED" })), "ready");
});

test("distinction: no CI (none) + approved → ready, but pending + approved → ci-running", () => {
  assert.equal(deriveLandable(pr({ headRefName: "b", ciStatus: "none", reviewDecision: "APPROVED" })), "ready");
  assert.equal(deriveLandable(pr({ headRefName: "b", ciStatus: "pending", reviewDecision: "APPROVED" })), "ci-running");
});

test("CI failed → ci-failed", () => {
  assert.equal(deriveLandable(pr({ headRefName: "b", ciStatus: "fail" })), "ci-failed");
});

test("changes requested (CI green) → changes-requested", () => {
  assert.equal(
    deriveLandable(pr({ headRefName: "b", ciStatus: "pass", reviewDecision: "CHANGES_REQUESTED" })),
    "changes-requested",
  );
});

test("precedence: ci-failed outranks changes-requested", () => {
  assert.equal(
    deriveLandable(pr({ headRefName: "b", ciStatus: "fail", reviewDecision: "CHANGES_REQUESTED" })),
    "ci-failed",
  );
});

test("precedence: ci-running outranks needs-review (pending, not approved)", () => {
  assert.equal(
    deriveLandable(pr({ headRefName: "b", ciStatus: "pending", reviewDecision: "REVIEW_REQUIRED" })),
    "ci-running",
  );
});

test("merged overrides everything (even a failing CI)", () => {
  const merged = { ...pr({ headRefName: "b", ciStatus: "fail" }), merged: true } as PrInfo;
  assert.equal(deriveLandable(merged), "merged");
});

test("merged via state field", () => {
  const merged = { ...pr({ headRefName: "b" }), state: "MERGED" } as PrInfo;
  assert.equal(deriveLandable(merged), "merged");
});

// ---- deriveLandableByTaskId: the work-item branch→PR join ----

test("matches a work-item's worktree branch to its PR by head ref", () => {
  const result = deriveLandableByTaskId(
    link({ t1: "feature-a" }),
    overview(pr({ headRefName: "feature-a", ciStatus: "pass", reviewDecision: "APPROVED" })),
  );
  assert.equal(result.get("t1"), "ready" satisfies LandableState);
});

test("no matching PR for the branch → task omitted (state none)", () => {
  const result = deriveLandableByTaskId(
    link({ t1: "feature-a" }),
    overview(pr({ headRefName: "other-branch" })),
  );
  assert.equal(result.has("t1"), false);
});

test("a work-item whose worktree has no branch is skipped", () => {
  const result = deriveLandableByTaskId(link({ t1: undefined }), overview(pr({ headRefName: "feature-a" })));
  assert.equal(result.has("t1"), false);
});

test("missing overview → empty map, no throw", () => {
  const result = deriveLandableByTaskId(link({ t1: "feature-a" }), undefined);
  assert.equal(result.size, 0);
});

test("empty overview (no PRs) → empty map", () => {
  const result = deriveLandableByTaskId(link({ t1: "feature-a" }), overview());
  assert.equal(result.size, 0);
});

test("resolves multiple work-items independently", () => {
  const result = deriveLandableByTaskId(
    link({ t1: "a", t2: "b", t3: "c" }),
    overview(
      pr({ headRefName: "a", ciStatus: "pass", reviewDecision: "APPROVED" }),
      pr({ headRefName: "b", ciStatus: "fail" }),
      // c has no PR
    ),
  );
  assert.equal(result.get("t1"), "ready");
  assert.equal(result.get("t2"), "ci-failed");
  assert.equal(result.has("t3"), false);
});

test("matches PRs inside a stack group by head ref", () => {
  const stacked: PrOverview = {
    repos: [
      {
        name: "repo",
        groups: [
          {
            kind: "stack",
            layers: [
              pr({ headRefName: "base", ciStatus: "pass", reviewDecision: "APPROVED" }),
              pr({ headRefName: "tip", ciStatus: "pending" }),
            ],
          },
        ],
      },
    ],
  };
  const result = deriveLandableByTaskId(link({ t1: "base", t2: "tip" }), stacked);
  assert.equal(result.get("t1"), "ready");
  assert.equal(result.get("t2"), "ci-running");
});

// ---- deriveLandablePrByTaskId: the matched PR's { number, url } per task ----

test("surfaces the matched PR's number + url, keyed by task id", () => {
  const result = deriveLandablePrByTaskId(
    link({ t1: "feature-a" }),
    overview(pr({ headRefName: "feature-a", number: 123, url: "https://gh.test/pr/123" })),
  );
  assert.deepEqual(result.get("t1"), { number: 123, url: "https://gh.test/pr/123" });
});

test("lines up with the landable join: same task ids, no spurious entries", () => {
  const link_ = link({ t1: "a", t2: "b", t3: "c" });
  const ov = overview(
    pr({ headRefName: "a", number: 1 }),
    pr({ headRefName: "b", number: 2 }),
    // c has no PR
  );
  const landable = deriveLandableByTaskId(link_, ov);
  const prs = deriveLandablePrByTaskId(link_, ov);
  assert.deepEqual([...prs.keys()].sort(), [...landable.keys()].sort());
  assert.equal(prs.get("t1")?.number, 1);
  assert.equal(prs.get("t2")?.number, 2);
  assert.equal(prs.has("t3"), false);
});

test("no matching PR / branchless worktree / missing overview → omitted, no throw", () => {
  assert.equal(
    deriveLandablePrByTaskId(link({ t1: "feature-a" }), overview(pr({ headRefName: "other" }))).has(
      "t1",
    ),
    false,
  );
  assert.equal(
    deriveLandablePrByTaskId(link({ t1: undefined }), overview(pr({ headRefName: "feature-a" }))).has(
      "t1",
    ),
    false,
  );
  assert.equal(deriveLandablePrByTaskId(link({ t1: "feature-a" }), undefined).size, 0);
});

test("matches PRs inside a stack group by head ref (PR-ref companion)", () => {
  const stacked: PrOverview = {
    repos: [
      {
        name: "repo",
        groups: [
          {
            kind: "stack",
            layers: [pr({ headRefName: "base", number: 10 }), pr({ headRefName: "tip", number: 11 })],
          },
        ],
      },
    ],
  };
  const result = deriveLandablePrByTaskId(link({ t1: "base", t2: "tip" }), stacked);
  assert.equal(result.get("t1")?.number, 10);
  assert.equal(result.get("t2")?.number, 11);
});
