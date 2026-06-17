/**
 * Bundle smoke test for the renderer. `renderer.ts` has no jsdom harness, so the
 * DOM-building code (chip classes, etc.) isn't exercised directly; instead we
 * assert our load-bearing class names survive into the esbuild bundle the panel
 * actually loads (`dist/renderer/renderer.js`). This catches a renderer change
 * that drops the merge-queue chip — or a build that never ran.
 *
 * Skips (rather than fails) when the bundle is absent, so `pnpm test` on a fresh
 * checkout without a prior `pnpm build` doesn't spuriously fail; the verify flow
 * builds first, where this guard has teeth.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/renderer/ → ../../dist/renderer/renderer.js
const bundlePath = join(__dirname, "..", "..", "dist", "renderer", "renderer.js");

test(
  "renderer bundle carries the merge-queue landable chip class",
  { skip: !existsSync(bundlePath) ? "bundle not built (run pnpm build first)" : false },
  () => {
    const bundle = readFileSync(bundlePath, "utf8");
    // The dex task row's landable chip — the merge-queue affordance.
    assert.ok(
      bundle.includes("dex-landable"),
      "expected `dex-landable` chip class in the renderer bundle",
    );
    // And a couple of the state labels, so a gutted chip map is caught too.
    assert.ok(
      bundle.includes("ready to merge"),
      "expected the `ready to merge` label in the bundle",
    );
    assert.ok(bundle.includes("needs review"), "expected the `needs review` label in the bundle");
  },
);

test(
  "renderer bundle carries the live-agent fleet marker class",
  { skip: !existsSync(bundlePath) ? "bundle not built (run pnpm build first)" : false },
  () => {
    const bundle = readFileSync(bundlePath, "utf8");
    // The dex task row's live-agent marker — the fleet-view affordance.
    assert.ok(
      bundle.includes("dex-agent"),
      "expected the `dex-agent` marker class in the renderer bundle",
    );
    // A couple of the state labels, so a gutted agent-marker map is caught too.
    assert.ok(
      bundle.includes("Agent running"),
      "expected the `Agent running` hint in the bundle",
    );
    assert.ok(
      bundle.includes("Agent blocked"),
      "expected the `Agent blocked` hint in the bundle",
    );
  },
);

test(
  "renderer bundle carries the Dex tree/graph view toggle",
  { skip: !existsSync(bundlePath) ? "bundle not built (run pnpm build first)" : false },
  () => {
    const bundle = readFileSync(bundlePath, "utf8");
    // The view-mode toggle button class + both affordance labels.
    assert.ok(
      bundle.includes("dex-view-toggle"),
      "expected the `dex-view-toggle` button class in the renderer bundle",
    );
    assert.ok(
      bundle.includes("Switch to graph view"),
      "expected the `Switch to graph view` label in the bundle",
    );
    assert.ok(
      bundle.includes("Switch to tree view"),
      "expected the `Switch to tree view` label in the bundle",
    );
  },
);

test(
  "renderer bundle carries the Dex dependency-graph row render",
  { skip: !existsSync(bundlePath) ? "bundle not built (run pnpm build first)" : false },
  () => {
    const bundle = readFileSync(bundlePath, "utf8");
    // The graph-mode node row class — proof the graph branch renders (not the
    // tree fallback). Paired with the pure `deriveDexGraph` unit tests, since the
    // DOM build itself has no jsdom harness.
    assert.ok(
      bundle.includes("dex-graph-row"),
      "expected the `dex-graph-row` class in the renderer bundle",
    );
  },
);

test(
  "renderer bundle carries the task id badge",
  { skip: !existsSync(bundlePath) ? "bundle not built (run pnpm build first)" : false },
  () => {
    const bundle = readFileSync(bundlePath, "utf8");
    // The click-to-copy id chip, shared by the detail view and the main rows.
    assert.ok(bundle.includes("dex-id"), "expected the `dex-id` chip class in the renderer bundle");
    assert.ok(
      bundle.includes("Copy task id"),
      "expected the `Copy task id` hint in the bundle",
    );
    // The shared helper bundles to a single arrow function the rows reference, so
    // its presence proves the id chip reaches the row render (not just detail).
    assert.ok(
      bundle.includes("dexIdChipEl"),
      "expected the shared `dexIdChipEl` helper in the renderer bundle",
    );
  },
);

test(
  "renderer bundle carries the simplified worktree-task status chip",
  { skip: !existsSync(bundlePath) ? "bundle not built (run pnpm build first)" : false },
  () => {
    const bundle = readFileSync(bundlePath, "utf8");
    // The worktree row's linked-task chip survives into the bundle.
    assert.ok(
      bundle.includes("worktree-task"),
      "expected the `worktree-task` chip class in the renderer bundle",
    );
    // …but its redundant id/name segments are gone — the branch label owns identity
    // now, so the chip is a status-only token (no duplicated id or ellipsized name).
    assert.ok(
      !bundle.includes("worktree-task-id"),
      "expected the redundant `worktree-task-id` segment to be removed",
    );
    assert.ok(
      !bundle.includes("worktree-task-name"),
      "expected the redundant `worktree-task-name` segment to be removed",
    );
  },
);

test(
  "renderer bundle carries the ready-row start button",
  { skip: !existsSync(bundlePath) ? "bundle not built (run pnpm build first)" : false },
  () => {
    const bundle = readFileSync(bundlePath, "utf8");
    // The start button class + its hint — the spawn-an-agent affordance.
    assert.ok(
      bundle.includes("dex-spawn"),
      "expected the `dex-spawn` button class in the renderer bundle",
    );
    assert.ok(
      bundle.includes("Start an agent for this task"),
      "expected the `Start an agent for this task` hint in the bundle",
    );
    // The bridge call the button wires up reaches the bundle.
    assert.ok(
      bundle.includes("dexSpawn"),
      "expected the `dexSpawn` bridge call in the renderer bundle",
    );
  },
);
