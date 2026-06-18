/**
 * Bundle smoke test for the Settings renderer. The behavior is covered by the
 * jsdom component tests (`app.test.tsx`); this guards the one thing those can't
 * see — that the production esbuild bundle the window actually loads
 * (`dist/settings/settings.js`) obeys the window's strict CSP: no `eval` /
 * `new Function`, which `script-src 'self'` forbids. React's DEVELOPMENT build
 * is eval-free too, but only the production transform (jsxDev:false) is shipped;
 * an accidental dev bundle would still trip the runtime, so we also assert React
 * itself reached the bundle.
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
// src/settings/ → ../../dist/settings/settings.js
const bundlePath = join(__dirname, "..", "..", "dist", "settings", "settings.js");

test(
  "settings bundle is CSP-safe (no eval / new Function) and bundles React",
  { skip: !existsSync(bundlePath) ? "bundle not built (run pnpm build first)" : false },
  () => {
    const bundle = readFileSync(bundlePath, "utf8");
    assert.ok(!/\beval\s*\(/.test(bundle), "expected no eval() in the settings bundle (CSP)");
    assert.ok(
      !/\bnew Function\s*\(/.test(bundle),
      "expected no `new Function(` in the settings bundle (CSP)",
    );
    // React is bundled IN (the CSP blocks any CDN); a stable internal marker
    // present in both its dev and production builds.
    assert.ok(
      bundle.includes("__SECRET_INTERNALS"),
      "expected React to be bundled into the settings bundle",
    );
  },
);
