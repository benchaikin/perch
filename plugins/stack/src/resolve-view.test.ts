import test from "node:test";
import assert from "node:assert/strict";
import { resolveStackView } from "./resolve-view.js";
import type { Exec } from "./provider.js";

const PR_LIST = JSON.stringify([
  { number: 1, title: "A", url: "u1", headRefName: "feat-a", baseRefName: "main" },
  { number: 2, title: "B", url: "u2", headRefName: "feat-b", baseRefName: "feat-a" },
]);

// A minimal `gh stack view --json` payload (one layer) for the primary path.
const STACK_VIEW = JSON.stringify([{ branch: "feat-a", prNumber: 1 }]);

test("uses the primary gh-stack view when it returns a stack", async () => {
  const exec: Exec = (cmd, args) => {
    if (args.includes("stack") && args.includes("view")) return Promise.resolve(STACK_VIEW);
    if (args.includes("pr") && args.includes("list")) return Promise.resolve(PR_LIST);
    return Promise.reject(new Error(`unexpected: ${cmd} ${args.join(" ")}`));
  };
  const graph = await resolveStackView({ exec });
  assert.deepEqual(
    graph.layers.map((l) => l.branch),
    ["feat-a"],
  );
});

test("falls back to base-ref reconstruction when gh stack view fails", async () => {
  const logs: string[] = [];
  const exec: Exec = (cmd, args) => {
    if (args.includes("stack") && args.includes("view")) {
      return Promise.reject(new Error("not a stack"));
    }
    if (cmd === "git" && args.includes("rev-parse")) return Promise.resolve("feat-b\n");
    if (args.includes("pr") && args.includes("list")) return Promise.resolve(PR_LIST);
    return Promise.reject(new Error(`unexpected: ${cmd} ${args.join(" ")}`));
  };
  const graph = await resolveStackView({ exec, log: (m) => logs.push(m) });
  assert.deepEqual(
    graph.layers.map((l) => l.branch),
    ["feat-a", "feat-b"],
  );
  assert.ok(logs.some((m) => /reconstructed/i.test(m)));
});
