import assert from "node:assert/strict";
import { test } from "node:test";

import { ghStackProvider, parseStackView, rollupToCiStatus } from "./gh-provider.js";
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
  assert.equal(rollupToCiStatus([{ state: "PENDING" }]), "pending");
  assert.equal(rollupToCiStatus([{ state: "ERROR" }]), "fail");
});

test("mutating methods throw not-implemented (M6)", async () => {
  const provider = ghStackProvider({ exec: () => Promise.resolve("[]") });
  await assert.rejects(() => provider.sync(), /not implemented \(M6\)/);
  await assert.rejects(() => provider.submit(), /not implemented \(M6\)/);
  await assert.rejects(() => provider.merge({}), /not implemented \(M6\)/);
});
