import assert from "node:assert/strict";
import { test } from "node:test";

import {
  countHumanReviewComments,
  fetchCurrentUserLogin,
  fetchHumanReviewCommentCount,
  ghStackProvider,
  isHumanReviewComment,
  parseStackView,
  rollupToCiStatus,
} from "./gh-provider.js";
import type { Exec } from "./provider.js";

/**
 * A representative `gh stack view --json` payload. Per assumption A1 it is a
 * top-level array, ordered bottom → top (A2), with branches under `branch`
 * (A3) and gh's self-computed rebase flag under `needsRebase` (A4). The top
 * layer carries no PR inline — exercising the `gh pr list` join + tolerance.
 */
const STACK_VIEW_FIXTURE = JSON.stringify([
  { branch: "feat-base", prNumber: 101, title: "Base layer", needsRebase: false },
  { branch: "feat-middle", prNumber: 102, needsRebase: true },
  { branch: "feat-tip" },
]);

/** A representative `gh pr list --json …` payload. */
const PR_LIST_FIXTURE = JSON.stringify([
  {
    number: 101,
    title: "Base layer",
    url: "https://github.com/o/r/pull/101",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    reviewDecision: "APPROVED",
    mergeable: "MERGEABLE",
    headRefName: "feat-base",
    baseRefName: "main",
  },
  {
    number: 102,
    title: "Middle layer",
    url: "https://github.com/o/r/pull/102",
    statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }],
    reviewDecision: "REVIEW_REQUIRED",
    mergeable: "CONFLICTING",
    headRefName: "feat-middle",
    baseRefName: "feat-base",
  },
  {
    number: 103,
    title: "Tip layer",
    url: "https://github.com/o/r/pull/103",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
    reviewDecision: null,
    mergeable: "UNKNOWN",
    headRefName: "feat-tip",
    baseRefName: "feat-middle",
  },
]);

/** Build an `exec` stub that returns fixtures based on the gh subcommand. */
function fixtureExec(stackOut: string, prOut: string): Exec {
  return (cmd, args) => {
    assert.equal(cmd, "gh");
    if (args[0] === "stack" && args[1] === "view") {
      return Promise.resolve(stackOut);
    }
    if (args.includes("pr") && args.includes("list")) {
      return Promise.resolve(prOut);
    }
    throw new Error(`unexpected exec: gh ${args.join(" ")}`);
  };
}

test("view joins stack layers with PR status by branch, preserving order", async () => {
  const provider = ghStackProvider({ exec: fixtureExec(STACK_VIEW_FIXTURE, PR_LIST_FIXTURE) });
  const graph = await provider.view();

  assert.deepEqual(
    graph.layers.map((l) => l.branch),
    ["feat-base", "feat-middle", "feat-tip"],
    "ordering bottom → top is preserved",
  );

  const [base, middle, tip] = graph.layers;

  // Base: green, approved, mergeable, no rebase.
  assert.equal(base?.prNumber, 101);
  assert.equal(base?.ciStatus, "pass");
  assert.equal(base?.reviewDecision, "APPROVED");
  assert.equal(base?.mergeable, "MERGEABLE");
  assert.equal(base?.needsRebase, false);
  assert.equal(base?.conflict, undefined);
  assert.equal(base?.url, "https://github.com/o/r/pull/101");

  // Middle: pending CI, needs rebase (from gh), conflicting → conflict=true.
  assert.equal(middle?.ciStatus, "pending");
  assert.equal(middle?.needsRebase, true);
  assert.equal(middle?.mergeable, "CONFLICTING");
  assert.equal(middle?.conflict, true);
  // Title from stack view absent → falls back to PR list title.
  assert.equal(middle?.title, "Middle layer");

  // Tip: no PR inline in stack view → joined from PR list; failing CI.
  assert.equal(tip?.prNumber, 103);
  assert.equal(tip?.ciStatus, "fail");
  assert.equal(tip?.reviewDecision, undefined, "null reviewDecision normalized away");
});

test("view is tolerant of missing PRs and empty status", async () => {
  const stack = JSON.stringify([{ branch: "lonely", needsRebase: false }]);
  const provider = ghStackProvider({ exec: fixtureExec(stack, "[]") });
  const graph = await provider.view("owner/repo");

  assert.equal(graph.repo, "owner/repo");
  assert.equal(graph.layers.length, 1);
  const [only] = graph.layers;
  assert.equal(only?.branch, "lonely");
  assert.equal(only?.prNumber, undefined);
  assert.equal(only?.ciStatus, "none", "no PR → ciStatus none default");
  assert.equal(only?.needsRebase, false);
});

test("view degrades gracefully when gh pr list fails (e.g. no remote)", async () => {
  // A local stack with no GitHub remote: `gh stack view` succeeds but
  // `gh pr list` errors. The stack structure must still render (no PR status).
  const stack = JSON.stringify({ branches: [{ name: "feat-a" }, { name: "feat-b" }] });
  const exec: Exec = (_cmd, args) => {
    if (args[0] === "stack" && args[1] === "view") return Promise.resolve(stack);
    if (args.includes("pr") && args.includes("list")) {
      return Promise.reject(new Error("no git remotes found"));
    }
    return Promise.reject(new Error(`unexpected: ${args.join(" ")}`));
  };
  const graph = await ghStackProvider({ exec }).view();
  assert.deepEqual(
    graph.layers.map((l) => l.branch),
    ["feat-a", "feat-b"],
  );
  assert.equal(graph.layers[0]?.ciStatus, "none", "no PR status → ciStatus none");
  assert.equal(graph.layers[0]?.prNumber, undefined);
});

test("view passes -R when a repo is supplied to pr list", async () => {
  let sawRepoFlag = false;
  const exec: Exec = (_cmd, args) => {
    if (args[0] === "stack") {
      return Promise.resolve("[]");
    }
    if (args[0] === "-R" && args[1] === "owner/repo") {
      sawRepoFlag = true;
    }
    return Promise.resolve("[]");
  };
  await ghStackProvider({ exec }).view("owner/repo");
  assert.equal(sawRepoFlag, true);
});

test("view runs gh in the configured cwd and DROPS -R (cwd is the target)", async () => {
  const calls: { args: string[]; cwd?: string }[] = [];
  const exec: Exec = (cmd, args, opts) => {
    assert.equal(cmd, "gh");
    calls.push({ args, cwd: opts?.cwd });
    if (args[0] === "stack" && args[1] === "view") return Promise.resolve("[]");
    return Promise.resolve("[]");
  };
  // A repo name is still passed, but with cwd set it must NOT become `-R`.
  await ghStackProvider({ exec, cwd: "/work/main" }).view("owner/repo");

  assert.ok(
    calls.every((c) => c.cwd === "/work/main"),
    "every gh call carries the cwd",
  );
  const prList = calls.find((c) => c.args.includes("pr") && c.args.includes("list"));
  assert.ok(prList, "pr list was called");
  assert.ok(!prList!.args.includes("-R"), "no -R flag when targeting by cwd");
});

test("mutations carry the configured cwd through Exec", async () => {
  const calls: { args: string[]; cwd?: string }[] = [];
  const exec: Exec = (_cmd, args, opts) => {
    calls.push({ args, cwd: opts?.cwd });
    return Promise.resolve("");
  };
  const provider = ghStackProvider({ exec, cwd: "/work/main" });
  await provider.submit();
  await provider.checkout("feat-x");

  assert.ok(
    calls.every((c) => c.cwd === "/work/main"),
    "submit + checkout both run in the targeted repo's cwd",
  );
});

test("parseStackView tolerates a wrapper object and nested pr fields", () => {
  const wrapped = JSON.stringify({
    layers: [
      { name: "b1", pr: { number: 5, title: "Nested" }, status: "⚠ Needs rebase" },
      { headRefName: "b2" },
    ],
  });
  const layers = parseStackView(wrapped);
  assert.equal(layers.length, 2);
  assert.deepEqual(layers[0], {
    branch: "b1",
    prNumber: 5,
    title: "Nested",
    needsRebase: true,
  });
  assert.equal(layers[1]?.branch, "b2");
  assert.equal(layers[1]?.needsRebase, false);
});

test("parseStackView handles the real gh-stack v0.0.5 payload", () => {
  // Captured verbatim from `gh stack view --json` (gh-stack v0.0.5) on a local
  // 3-branch stack: object with a `branches` array (A1), bottom→top (A2),
  // branch under `name` (A3), boolean `needsRebase` (A4), no inline PR (A5).
  const real = JSON.stringify({
    trunk: "main",
    currentBranch: "feat-c",
    branches: [
      { name: "feat-a", base: "304f134", isCurrent: false, isMerged: false, needsRebase: false },
      { name: "feat-b", base: "d829a88", isCurrent: false, isMerged: false, needsRebase: false },
      { name: "feat-c", base: "7bb8702", isCurrent: true, isMerged: false, needsRebase: false },
    ],
  });
  const layers = parseStackView(real);
  assert.deepEqual(
    layers.map((l) => l.branch),
    ["feat-a", "feat-b", "feat-c"],
  );
  assert.ok(layers.every((l) => l.needsRebase === false));
  assert.ok(layers.every((l) => l.prNumber === undefined));
});

test("parseStackView returns [] for empty or shapeless input", () => {
  assert.deepEqual(parseStackView(""), []);
  assert.deepEqual(parseStackView("{}"), []);
  assert.deepEqual(parseStackView("null"), []);
});

test("rollupToCiStatus maps check arrays to normalized status", () => {
  assert.equal(rollupToCiStatus(null), "none");
  assert.equal(rollupToCiStatus([]), "none");
  assert.equal(rollupToCiStatus([{ status: "COMPLETED", conclusion: "SUCCESS" }]), "pass");
  assert.equal(
    rollupToCiStatus([
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { status: "COMPLETED", conclusion: "FAILURE" },
    ]),
    "fail",
  );
  assert.equal(rollupToCiStatus([{ status: "IN_PROGRESS", conclusion: null }]), "pending");
  assert.equal(rollupToCiStatus([{ status: "QUEUED", conclusion: null }]), "pending");
  assert.equal(rollupToCiStatus([{ state: "PENDING" }]), "pending");
  assert.equal(rollupToCiStatus([{ state: "ERROR" }]), "fail");
  // A passing StatusContext has only `state` (empty status+conclusion) — it must
  // read as pass, not pending (regression: green commit-status stuck spinning).
  assert.equal(rollupToCiStatus([{ state: "SUCCESS" }]), "pass");
  assert.equal(
    rollupToCiStatus([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }]),
    "pass",
  );
  // A completed CheckRun with a non-failing, non-success conclusion still passes.
  assert.equal(rollupToCiStatus([{ status: "COMPLETED", conclusion: "SKIPPED" }]), "pass");
});

/** Record every `gh` invocation's argv and resolve a fixed stdout. */
function recordingExec(stdout = ""): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = (cmd, args) => {
    assert.equal(cmd, "gh");
    calls.push(args);
    return Promise.resolve(stdout);
  };
  return { exec, calls };
}

test("mutations shell to the matching gh stack subcommand with the right argv", async () => {
  const { exec, calls } = recordingExec();
  const provider = ghStackProvider({ exec });

  await provider.submit();
  await provider.push();
  await provider.add();
  await provider.add("feat-new");
  await provider.merge({});
  await provider.checkout("feat-foo");
  await provider.checkout(42);
  await provider.link(["feat-a", 7]);
  await provider.unstack();

  assert.deepEqual(calls, [
    ["stack", "submit"],
    ["stack", "push"],
    ["stack", "add"],
    ["stack", "add", "feat-new"],
    ["stack", "merge"],
    ["stack", "checkout", "feat-foo"],
    ["stack", "checkout", "42"],
    ["stack", "link", "feat-a", "7"],
    ["stack", "unstack"],
  ]);
});

test("mutations pass -R when a repo is supplied", async () => {
  const { exec, calls } = recordingExec();
  const provider = ghStackProvider({ exec });

  await provider.submit("owner/repo");
  await provider.push("owner/repo");
  await provider.merge({ repo: "owner/repo" });

  assert.deepEqual(calls, [
    ["-R", "owner/repo", "stack", "submit"],
    ["-R", "owner/repo", "stack", "push"],
    ["-R", "owner/repo", "stack", "merge"],
  ]);
});

test("sync shells `gh stack sync` and reports success on a clean rebase", async () => {
  const { exec, calls } = recordingExec("Synced 3 branches onto main.\n");
  const result = await ghStackProvider({ exec }).sync();

  assert.deepEqual(calls, [["stack", "sync"]]);
  assert.equal(result.conflict, false);
  assert.equal(result.needsResolution, undefined);
  assert.match(result.output, /Synced 3 branches/);
});

test("sync passes -R and stays clean", async () => {
  const { exec, calls } = recordingExec("up to date\n");
  const result = await ghStackProvider({ exec }).sync("owner/repo");
  assert.deepEqual(calls, [["-R", "owner/repo", "stack", "sync"]]);
  assert.equal(result.conflict, false);
});

test("sync maps a conflict-style failure to a conflict SyncResult (no throw)", async () => {
  // gh stack sync exits non-zero on conflict; the runner rejects, and we map
  // the conflict-looking output to conflict:true rather than re-throwing.
  const exec: Exec = () => {
    const err = new Error(
      "rebasing feat-middle\nCONFLICT (content): Merge conflict in src/app.ts\n" +
        "could not apply feat-middle... fix conflicts and then run sync again",
    );
    return Promise.reject(err);
  };
  const result = await ghStackProvider({ exec }).sync();

  assert.equal(result.conflict, true);
  assert.ok(result.needsResolution?.includes("feat-middle"), "names the conflicting branch");
  assert.match(result.output, /Merge conflict/);
});

test("sync re-throws a genuine (non-conflict) command failure", async () => {
  const exec: Exec = () =>
    Promise.reject(new Error("gh: command not found / not a gh stack repository"));
  await assert.rejects(() => ghStackProvider({ exec }).sync(), /not a gh stack repository/);
});

test("isHumanReviewComment excludes Bot type, [bot] logins, and the ignore-list", () => {
  // Humans count.
  assert.equal(isHumanReviewComment({ login: "alice", type: "User" }), true);
  assert.equal(isHumanReviewComment({ login: "alice" }), true);
  // GitHub Apps: type Bot OR a [bot] login.
  assert.equal(isHumanReviewComment({ login: "copilot", type: "Bot" }), false);
  assert.equal(isHumanReviewComment({ login: "github-actions[bot]", type: "User" }), false);
  assert.equal(isHumanReviewComment({ login: "dependabot[bot]" }), false);
  // Case-insensitive on the [bot] suffix.
  assert.equal(isHumanReviewComment({ login: "Weird[BOT]" }), false);
  // Ignore-list (escape hatch for AI reviewers posting as normal accounts).
  assert.equal(
    isHumanReviewComment({ login: "coderabbitai", type: "User" }, ["coderabbitai"]),
    false,
  );
  assert.equal(isHumanReviewComment({ login: "CodeRabbitAI" }, ["coderabbitai"]), false);
  assert.equal(isHumanReviewComment({ login: "alice" }, ["coderabbitai"]), true);
  // No resolvable login → not a human.
  assert.equal(isHumanReviewComment(null), false);
  assert.equal(isHumanReviewComment({ login: null }), false);
  assert.equal(isHumanReviewComment({ login: "" }), false);
});

test("countHumanReviewComments tallies humans after the filter", () => {
  const comments = [
    { user: { login: "alice", type: "User" } },
    { user: { login: "github-actions[bot]", type: "Bot" } },
    { user: { login: "bob", type: "User" } },
    { user: { login: "alice", type: "User" } }, // a second comment from alice still counts.
    { user: { login: "coderabbitai", type: "User" } },
  ];
  assert.equal(countHumanReviewComments(comments), 4);
  assert.equal(countHumanReviewComments(comments, ["coderabbitai"]), 3);
  // Tolerant of non-array / empty input.
  assert.equal(countHumanReviewComments(undefined), 0);
  assert.equal(countHumanReviewComments([]), 0);
});

test("countHumanReviewComments excludes my own comments (case-insensitive)", () => {
  const comments = [
    { user: { login: "alice", type: "User" } },
    { user: { login: "Me", type: "User" } }, // mine, mixed case → excluded.
    { user: { login: "bob", type: "User" } },
    { user: { login: "ME", type: "User" } }, // a second reply from me → excluded.
    { user: { login: "github-actions[bot]", type: "Bot" } }, // still a bot → excluded.
  ];
  assert.equal(countHumanReviewComments(comments, [], "me"), 2); // alice + bob.
  // Self-exclusion stacks with the ignore-list.
  assert.equal(countHumanReviewComments(comments, ["alice"], "me"), 1); // bob only.
  // me undefined/empty → no self-exclusion (back-compat).
  assert.equal(countHumanReviewComments(comments, [], undefined), 4);
  assert.equal(countHumanReviewComments(comments, [], ""), 4);
});

test("fetchCurrentUserLogin resolves the authed login via gh api user", async () => {
  let calledArgs: string[] = [];
  const exec: Exec = (cmd, args) => {
    calledArgs = args;
    assert.equal(cmd, "gh");
    return Promise.resolve("octocat\n");
  };
  assert.equal(await fetchCurrentUserLogin(exec, undefined), "octocat");
  assert.deepEqual(calledArgs, ["api", "user", "--jq", ".login"]);
});

test("fetchCurrentUserLogin returns undefined on gh error or empty output", async () => {
  const failing: Exec = () => Promise.reject(new Error("gh: not authenticated"));
  assert.equal(await fetchCurrentUserLogin(failing, undefined), undefined);
  const empty: Exec = () => Promise.resolve("\n");
  assert.equal(await fetchCurrentUserLogin(empty, undefined), undefined);
});

test("fetchHumanReviewCommentCount shells gh api and counts humans across pages", async () => {
  let calledArgs: string[] = [];
  const exec: Exec = (cmd, args) => {
    calledArgs = args;
    assert.equal(cmd, "gh");
    // Two `--paginate` pages, each its own JSON array on its own line.
    return Promise.resolve(
      [
        JSON.stringify([
          { login: "alice", type: "User" },
          { login: "github-actions[bot]", type: "Bot" },
        ]),
        JSON.stringify([{ login: "bob", type: "User" }]),
      ].join("\n"),
    );
  };
  const count = await fetchHumanReviewCommentCount(exec, 142, [], undefined);
  assert.equal(count, 2);
  assert.ok(calledArgs.includes("api"));
  assert.ok(calledArgs.some((a) => a.includes("/pulls/142/comments")));
});

test("fetchHumanReviewCommentCount threads `me` through to exclude my own comments", async () => {
  const exec: Exec = () =>
    Promise.resolve(
      JSON.stringify([
        { login: "alice", type: "User" },
        { login: "Me", type: "User" }, // mine (mixed case) → excluded.
        { login: "bob", type: "User" },
      ]),
    );
  // repo positional comes before `me`.
  assert.equal(await fetchHumanReviewCommentCount(exec, 9, [], undefined, undefined, "me"), 2);
  assert.equal(await fetchHumanReviewCommentCount(exec, 9, [], undefined, undefined, undefined), 3);
});

test("fetchHumanReviewCommentCount defaults to 0 when the gh call fails", async () => {
  const exec: Exec = () => Promise.reject(new Error("gh: 404 Not Found"));
  assert.equal(await fetchHumanReviewCommentCount(exec, 7, [], undefined), 0);
});
