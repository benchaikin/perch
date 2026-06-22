import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { __resetCachedMe } from "./gh-provider.js";
import { buildPrOverview, PrGroup } from "./prs.js";
import type { Exec, ExecOptions } from "./provider.js";

// The authenticated-login cache is module-level (it lives for the daemon's
// lifetime), so clear it between cases or one test's resolved `me` would leak
// into the next.
beforeEach(() => __resetCachedMe());

/** A repo with one standalone PR + a 2-PR stack (feat-a ← feat-b). */
const REPO_A_PRS = JSON.stringify([
  {
    number: 10,
    title: "Standalone fix",
    url: "https://github.com/o/a/pull/10",
    headRefName: "fix-typo",
    baseRefName: "main",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    reviewDecision: "APPROVED",
    mergeable: "MERGEABLE",
  },
  {
    number: 11,
    title: "Stack base",
    url: "https://github.com/o/a/pull/11",
    headRefName: "feat-a",
    baseRefName: "main",
    statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }],
    reviewDecision: "REVIEW_REQUIRED",
    mergeable: "MERGEABLE",
  },
  {
    number: 12,
    title: "Stack tip",
    url: "https://github.com/o/a/pull/12",
    headRefName: "feat-b",
    baseRefName: "feat-a",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
    reviewDecision: "CHANGES_REQUESTED",
    mergeable: "CONFLICTING",
  },
]);

/** A second repo with a single standalone PR. */
const REPO_B_PRS = JSON.stringify([
  {
    number: 5,
    title: "Infra bump",
    url: "https://github.com/o/b/pull/5",
    headRefName: "bump-deps",
    baseRefName: "main",
    statusCheckRollup: [],
    reviewDecision: null,
    mergeable: "MERGEABLE",
  },
]);

/** gh stack view --json for repo A's stack (feat-a ← feat-b), feat-b needs rebase. */
const REPO_A_STACK_VIEW = JSON.stringify({
  branches: [
    { name: "feat-a", needsRebase: false },
    { name: "feat-b", needsRebase: true },
  ],
});

type Call = { cmd: string; args: string[]; cwd?: string };

/** Per-repo fixture: pr-list / stack-view payloads and a per-PR comments map. */
interface RepoFixture {
  prs?: string;
  stackView?: string;
  prError?: Error;
  /** PR number → `gh api …/comments` stdout (a JSON array of `{login,type}`). */
  comments?: Record<number, string>;
}

/** Build a fake exec keyed by cwd, routing pr-list / stack-view / comments. */
function fakeExec(
  byCwd: Record<string, RepoFixture>,
  /** Login for `gh api user --jq .login`; an Error rejects it (resolution fails). */
  me: string | Error = "me",
): {
  exec: Exec;
  calls: Call[];
} {
  const calls: Call[] = [];
  const exec: Exec = (cmd, args, opts?: ExecOptions) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    // `gh api user` resolves the authenticated login once per overview build —
    // it is host-global, so it is not keyed by repo cwd.
    if (cmd === "gh" && args[0] === "api" && args[1] === "user") {
      return me instanceof Error ? Promise.reject(me) : Promise.resolve(`${me}\n`);
    }
    const repo = byCwd[opts?.cwd ?? ""];
    if (!repo) return Promise.reject(new Error(`no fixture for cwd ${opts?.cwd}`));
    if (cmd === "gh" && args.includes("pr") && args.includes("list")) {
      if (repo.prError) return Promise.reject(repo.prError);
      return Promise.resolve(repo.prs ?? "[]");
    }
    if (cmd === "gh" && args[0] === "stack" && args[1] === "view") {
      if (repo.stackView) return Promise.resolve(repo.stackView);
      return Promise.reject(new Error("no stack"));
    }
    if (cmd === "gh" && args[0] === "api") {
      const path = args.find((a) => a.includes("/comments")) ?? "";
      const num = Number(path.match(/\/pulls\/(\d+)\/comments/)?.[1]);
      return Promise.resolve(repo.comments?.[num] ?? "[]");
    }
    return Promise.reject(new Error(`unexpected exec: ${cmd} ${args.join(" ")}`));
  };
  return { exec, calls };
}

/** Inline-comment authors for a PR, as a `gh api … --jq` stdout array. */
const comments = (...authors: { login: string; type?: string }[]): string =>
  JSON.stringify(authors);

const stackGroups = (groups: PrGroup[]): Extract<PrGroup, { kind: "stack" }>[] =>
  groups.filter((g): g is Extract<PrGroup, { kind: "stack" }> => g.kind === "stack");
const prGroups = (groups: PrGroup[]): Extract<PrGroup, { kind: "pr" }>[] =>
  groups.filter((g): g is Extract<PrGroup, { kind: "pr" }> => g.kind === "pr");

test("groups a standalone PR + a 2-chain in one repo, with status mapping", async () => {
  const { exec } = fakeExec({ "/work/a": { prs: REPO_A_PRS } });
  const overview = await buildPrOverview({
    repos: ["/work/a"],
    exec,
    hasGhStack: () => false,
  });

  assert.equal(overview.repos.length, 1);
  const repo = overview.repos[0]!;
  assert.equal(repo.name, "a");
  assert.equal(repo.path, "/work/a");
  assert.equal(repo.error, undefined);

  // One standalone + one stack.
  const solos = prGroups(repo.groups);
  const stacks = stackGroups(repo.groups);
  assert.equal(solos.length, 1);
  assert.equal(stacks.length, 1);

  assert.equal(solos[0]!.pr.number, 10);
  assert.equal(solos[0]!.pr.ciStatus, "pass");
  assert.equal(solos[0]!.pr.reviewDecision, "APPROVED");

  // Stack bottom → top: feat-a (#11) then feat-b (#12).
  const stack = stacks[0]!;
  assert.deepEqual(
    stack.layers.map((l) => l.headRefName),
    ["feat-a", "feat-b"],
  );
  assert.deepEqual(
    stack.layers.map((l) => l.number),
    [11, 12],
  );
  assert.equal(stack.layers[0]!.ciStatus, "pending");
  assert.equal(stack.layers[1]!.ciStatus, "fail");
  assert.equal(stack.layers[1]!.mergeable, "CONFLICTING");
  assert.equal(stack.layers[1]!.conflict, true);
  // No gh-stack tracking → not tracked.
  assert.equal(stack.tracked, false);
});

test("covers multiple repos", async () => {
  const { exec, calls } = fakeExec({
    "/work/a": { prs: REPO_A_PRS },
    "/work/b": { prs: REPO_B_PRS },
  });
  const overview = await buildPrOverview({
    repos: ["/work/a", "/work/b"],
    exec,
    hasGhStack: () => false,
  });

  assert.deepEqual(
    overview.repos.map((r) => r.name),
    ["a", "b"],
  );
  // Each repo's gh pr list ran in its own cwd.
  const cwds = calls.filter((c) => c.args.includes("list")).map((c) => c.cwd);
  assert.deepEqual(cwds.sort(), ["/work/a", "/work/b"]);

  const b = overview.repos[1]!;
  assert.equal(b.groups.length, 1);
  assert.equal(prGroups(b.groups)[0]!.pr.number, 5);
});

test("one repo's error is isolated; others still resolve", async () => {
  const { exec } = fakeExec({
    "/work/a": { prError: new Error("gh: 504 Gateway Timeout") },
    "/work/b": { prs: REPO_B_PRS },
  });
  const overview = await buildPrOverview({
    repos: ["/work/a", "/work/b"],
    exec,
    hasGhStack: () => false,
  });

  const [a, b] = overview.repos;
  assert.equal(a!.error, "gh: 504 Gateway Timeout");
  assert.deepEqual(a!.groups, []);
  // The healthy repo is unaffected.
  assert.equal(b!.error, undefined);
  assert.equal(b!.groups.length, 1);
});

test("gh-stack enrichment marks the matching group tracked + applies needsRebase", async () => {
  const { exec } = fakeExec({
    "/work/a": { prs: REPO_A_PRS, stackView: REPO_A_STACK_VIEW },
  });
  const overview = await buildPrOverview({
    repos: ["/work/a"],
    exec,
    hasGhStack: () => true, // repo A has local .git/gh-stack tracking.
  });

  const stacks = stackGroups(overview.repos[0]!.groups);
  assert.equal(stacks.length, 1);
  const stack = stacks[0]!;
  assert.equal(stack.tracked, true);
  // feat-b needs rebase per gh-stack → stack-level needsRebase true.
  assert.equal(stack.needsRebase, true);
  assert.equal(stack.layers.find((l) => l.headRefName === "feat-b")!.needsRebase, true);
  assert.equal(stack.layers.find((l) => l.headRefName === "feat-a")!.needsRebase, false);
  // Ordering still bottom → top.
  assert.deepEqual(
    stack.layers.map((l) => l.headRefName),
    ["feat-a", "feat-b"],
  );
});

test("enrichment is resilient: gh stack view failure leaves base-ref grouping", async () => {
  const { exec } = fakeExec({ "/work/a": { prs: REPO_A_PRS } }); // no stackView → rejects
  const overview = await buildPrOverview({
    repos: ["/work/a"],
    exec,
    hasGhStack: () => true,
  });
  const stack = stackGroups(overview.repos[0]!.groups)[0]!;
  assert.equal(stack.tracked, false);
  assert.deepEqual(
    stack.layers.map((l) => l.headRefName),
    ["feat-a", "feat-b"],
  );
});

test("counts human inline review comments per PR, filtering bots + ignore-list", async () => {
  const { exec } = fakeExec({
    "/work/a": {
      prs: REPO_A_PRS,
      comments: {
        // #10: two humans + a bot (by type) + a [bot] login + an ignored AI account → 2.
        10: comments(
          { login: "alice", type: "User" },
          { login: "bob", type: "User" },
          { login: "copilot", type: "Bot" },
          { login: "github-actions[bot]", type: "User" },
          { login: "coderabbitai", type: "User" },
        ),
        // #11: one human → 1.
        11: comments({ login: "carol", type: "User" }),
        // #12: none reported → 0 (default).
      },
    },
  });
  const overview = await buildPrOverview({
    repos: ["/work/a"],
    exec,
    hasGhStack: () => false,
    reviewBotIgnore: ["coderabbitai"],
  });
  const repo = overview.repos[0]!;
  const solo = prGroups(repo.groups)[0]!;
  assert.equal(solo.pr.number, 10);
  assert.equal(solo.pr.humanReviewCommentCount, 2);
  const stack = stackGroups(repo.groups)[0]!;
  assert.equal(stack.layers.find((l) => l.number === 11)!.humanReviewCommentCount, 1);
  assert.equal(stack.layers.find((l) => l.number === 12)!.humanReviewCommentCount, 0);
});

test("excludes my own review comments from the count (case-insensitive)", async () => {
  const { exec } = fakeExec(
    {
      "/work/a": {
        prs: REPO_A_PRS,
        comments: {
          // #10: me (mixed-case) + a reply from me + one other human → 1 (only bob).
          10: comments(
            { login: "Me", type: "User" },
            { login: "bob", type: "User" },
            { login: "ME", type: "User" },
          ),
          // #11: only my own comments → 0.
          11: comments({ login: "me", type: "User" }),
        },
      },
    },
    "me",
  );
  const overview = await buildPrOverview({ repos: ["/work/a"], exec, hasGhStack: () => false });
  const repo = overview.repos[0]!;
  assert.equal(prGroups(repo.groups)[0]!.pr.humanReviewCommentCount, 1);
  const stack = stackGroups(repo.groups)[0]!;
  assert.equal(stack.layers.find((l) => l.number === 11)!.humanReviewCommentCount, 0);
});

test("when the gh-user lookup fails, my own comments are still counted (back-compat)", async () => {
  const { exec } = fakeExec(
    {
      "/work/a": {
        prs: REPO_A_PRS,
        // me + bob, but `gh api user` errors → no self-exclusion → both count → 2.
        comments: { 10: comments({ login: "me", type: "User" }, { login: "bob", type: "User" }) },
      },
    },
    new Error("gh: not authenticated"),
  );
  const overview = await buildPrOverview({ repos: ["/work/a"], exec, hasGhStack: () => false });
  assert.equal(prGroups(overview.repos[0]!.groups)[0]!.pr.humanReviewCommentCount, 2);
});

test("resolves the authed login once per daemon run, reusing it across builds", async () => {
  const { exec, calls } = fakeExec({ "/work/a": { prs: REPO_A_PRS } });
  const userCalls = () => calls.filter((c) => c.args[0] === "api" && c.args[1] === "user").length;

  await buildPrOverview({ repos: ["/work/a"], exec, hasGhStack: () => false });
  assert.equal(userCalls(), 1);

  // A second build reuses the cached login — no further `gh api user` spawn.
  await buildPrOverview({ repos: ["/work/a"], exec, hasGhStack: () => false });
  assert.equal(userCalls(), 1);

  // The test seam clears the cache so the next build resolves it afresh.
  __resetCachedMe();
  await buildPrOverview({ repos: ["/work/a"], exec, hasGhStack: () => false });
  assert.equal(userCalls(), 2);
});

test("a failed comment fetch defaults the count to 0 without failing the overview", async () => {
  const exec: Exec = (cmd, args, opts) => {
    if (cmd === "gh" && args.includes("pr") && args.includes("list")) {
      return Promise.resolve(REPO_B_PRS);
    }
    if (cmd === "gh" && args[0] === "api") return Promise.reject(new Error("gh: 404"));
    return Promise.reject(new Error(`unexpected: ${cmd} ${args.join(" ")} (${opts?.cwd})`));
  };
  const overview = await buildPrOverview({ repos: ["/work/b"], exec, hasGhStack: () => false });
  const pr = prGroups(overview.repos[0]!.groups)[0]!.pr;
  assert.equal(pr.number, 5);
  assert.equal(pr.humanReviewCommentCount, 0);
});

test("stackDirection defaults to bottom-to-top when not configured", async () => {
  const { exec } = fakeExec({ "/work/a": { prs: REPO_A_PRS } });
  const overview = await buildPrOverview({ repos: ["/work/a"], exec, hasGhStack: () => false });
  assert.equal(overview.stackDirection, "bottom-to-top");
  // The data ordering is never affected by direction — layers stay bottom → top.
  const stack = stackGroups(overview.repos[0]!.groups)[0]!;
  assert.deepEqual(
    stack.layers.map((l) => l.headRefName),
    ["feat-a", "feat-b"],
  );
});

test("stackDirection is surfaced verbatim, leaving layer order bottom → top", async () => {
  const { exec } = fakeExec({ "/work/a": { prs: REPO_A_PRS } });
  const overview = await buildPrOverview({
    repos: ["/work/a"],
    exec,
    hasGhStack: () => false,
    stackDirection: "top-to-bottom",
  });
  assert.equal(overview.stackDirection, "top-to-bottom");
  // Presentation-only: the data still arrives bottom → top regardless.
  const stack = stackGroups(overview.repos[0]!.groups)[0]!;
  assert.deepEqual(
    stack.layers.map((l) => l.headRefName),
    ["feat-a", "feat-b"],
  );
});
