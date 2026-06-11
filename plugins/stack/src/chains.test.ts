import assert from "node:assert/strict";
import { test } from "node:test";

import { allChains, chainContaining } from "./chains.js";

interface Node {
  head: string;
  base?: string;
}

const headOf = (n: Node): string => n.head;
const baseOf = (n: Node): string | undefined => n.base;

function index(nodes: Node[]): { byHead: Map<string, Node>; byBase: Map<string, Node> } {
  const byHead = new Map<string, Node>();
  const byBase = new Map<string, Node>();
  for (const n of nodes) {
    byHead.set(n.head, n);
    if (n.base !== undefined) byBase.set(n.base, n);
  }
  return { byHead, byBase };
}

test("chainContaining walks down and up from an anchor", () => {
  const nodes: Node[] = [
    { head: "a", base: "main" },
    { head: "b", base: "a" },
    { head: "c", base: "b" },
  ];
  const { byHead, byBase } = index(nodes);
  const chain = chainContaining("b", byHead, byBase, headOf, baseOf);
  assert.deepEqual(
    chain.map((n) => n.head),
    ["a", "b", "c"],
  );
});

test("allChains groups a single linear stack bottom → top", () => {
  const nodes: Node[] = [
    { head: "c", base: "b" },
    { head: "a", base: "main" },
    { head: "b", base: "a" },
  ];
  const chains = allChains(nodes, headOf, baseOf);
  assert.equal(chains.length, 1);
  assert.deepEqual(
    chains[0]!.map((n) => n.head),
    ["a", "b", "c"],
  );
});

test("allChains separates standalone PRs from a stack", () => {
  const nodes: Node[] = [
    { head: "solo", base: "main" },
    { head: "a", base: "main" },
    { head: "b", base: "a" },
  ];
  const chains = allChains(nodes, headOf, baseOf);
  // One stack [a, b] and one singleton [solo]; order follows first appearance.
  const byHeads = chains.map((c) => c.map((n) => n.head));
  assert.ok(byHeads.some((c) => c.length === 1 && c[0] === "solo"));
  assert.ok(byHeads.some((c) => c.length === 2 && c[0] === "a" && c[1] === "b"));
  // Every node appears exactly once across all chains.
  assert.equal(chains.flat().length, 3);
});

test("allChains emits each unrelated PR as its own singleton", () => {
  const nodes: Node[] = [
    { head: "x", base: "main" },
    { head: "y", base: "develop" },
  ];
  const chains = allChains(nodes, headOf, baseOf);
  assert.equal(chains.length, 2);
  assert.ok(chains.every((c) => c.length === 1));
});

test("allChains tolerates a cycle without looping forever", () => {
  const nodes: Node[] = [
    { head: "a", base: "b" },
    { head: "b", base: "a" },
  ];
  const chains = allChains(nodes, headOf, baseOf);
  // It terminates (no infinite loop) and every node is accounted for. A true
  // cycle can't occur in real base→head PR data; we only guarantee termination.
  const heads = new Set(chains.flat().map(headOf));
  assert.deepEqual([...heads].sort(), ["a", "b"]);
});
