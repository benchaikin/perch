import test from "node:test";
import assert from "node:assert/strict";
import { baseRefProvider } from "./base-ref-provider.js";
import type { Exec } from "./provider.js";

/** A linear 3-PR stack: feat-a (→main) ← feat-b ← feat-c. */
const PRS = JSON.stringify([
  {
    number: 3,
    title: "C",
    url: "u3",
    headRefName: "feat-c",
    baseRefName: "feat-b",
    statusCheckRollup: [{ status: "IN_PROGRESS" }],
    reviewDecision: "REVIEW_REQUIRED",
    mergeable: "MERGEABLE",
  },
  {
    number: 1,
    title: "A",
    url: "u1",
    headRefName: "feat-a",
    baseRefName: "main",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
    reviewDecision: "APPROVED",
    mergeable: "MERGEABLE",
  },
  {
    number: 2,
    title: "B",
    url: "u2",
    headRefName: "feat-b",
    baseRefName: "feat-a",
    statusCheckRollup: [{ conclusion: "FAILURE" }],
    reviewDecision: "CHANGES_REQUESTED",
    mergeable: "CONFLICTING",
  },
]);

/** Route a fake exec by inspecting the command + args. */
function fakeExec(opts: { prs?: string; head?: string }): Exec {
  return (cmd, args) => {
    if (cmd === "git" && args.includes("rev-parse")) return Promise.resolve(`${opts.head ?? ""}\n`);
    if (cmd === "gh" && args.includes("pr") && args.includes("list")) {
      return Promise.resolve(opts.prs ?? "[]");
    }
    return Promise.reject(new Error(`unexpected exec: ${cmd} ${args.join(" ")}`));
  };
}

test("reconstructs the ordered chain containing the current branch", async () => {
  const graph = await baseRefProvider({ exec: fakeExec({ prs: PRS, head: "feat-b" }) }).view();

  assert.deepEqual(
    graph.layers.map((l) => l.branch),
    ["feat-a", "feat-b", "feat-c"],
  );
  assert.deepEqual(
    graph.layers.map((l) => l.prNumber),
    [1, 2, 3],
  );
  assert.equal(graph.layers[0]!.ciStatus, "pass");
  assert.equal(graph.layers[1]!.ciStatus, "fail");
  assert.equal(graph.layers[2]!.ciStatus, "pending");
  assert.equal(graph.layers[1]!.mergeable, "CONFLICTING");
  assert.equal(graph.layers[1]!.conflict, true);
  // needsRebase is not determinable in the fallback — always false.
  assert.ok(graph.layers.every((l) => l.needsRebase === false));
});

test("falls back to the single maximal chain when current branch has no PR", async () => {
  const graph = await baseRefProvider({ exec: fakeExec({ prs: PRS, head: "main" }) }).view();
  assert.deepEqual(
    graph.layers.map((l) => l.branch),
    ["feat-a", "feat-b", "feat-c"],
  );
});

test("returns an empty graph when there are no open PRs", async () => {
  const graph = await baseRefProvider({ exec: fakeExec({ prs: "[]", head: "main" }) }).view();
  assert.equal(graph.layers.length, 0);
});

test("mutations are unsupported on a reconstructed stack", async () => {
  const p = baseRefProvider({ exec: fakeExec({ prs: PRS }) });
  await assert.rejects(() => p.sync(), /not supported/);
  await assert.rejects(() => p.submit(), /not supported/);
  await assert.rejects(() => p.unstack(), /not supported/);
  assert.equal(await p.version(), "base-ref-fallback");
});
