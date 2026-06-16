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
