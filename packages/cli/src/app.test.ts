/**
 * Tests for the `perch app` launch-target resolver.
 *
 * `resolveAppTarget` is pure — `exists` is injected — so these run without
 * touching the real filesystem or spawning anything.
 */
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveAppTarget } from "./app.js";

const home = "/Users/test";
const workspaceRoot = "/work/perch";

const APPLICATIONS = "/Applications/Perch.app";
const USER_APPLICATIONS = join(home, "Applications", "Perch.app");
const RELEASE_ARM = join(workspaceRoot, "packages", "gui", "release", "mac-arm64", "Perch.app");
const RELEASE_MAC = join(workspaceRoot, "packages", "gui", "release", "mac", "Perch.app");

/** Build an `exists` predicate that returns true only for paths in `present`. */
function existsFor(present: string[]): (path: string) => boolean {
  const set = new Set(present);
  return (path) => set.has(path);
}

test("returns the .app target when /Applications/Perch.app exists", () => {
  const target = resolveAppTarget({ home, workspaceRoot, exists: existsFor([APPLICATIONS]) });
  assert.deepEqual(target, { kind: "app", path: APPLICATIONS });
});

test("prefers /Applications over ~/Applications over the workspace release dir", () => {
  // All candidates present — /Applications wins.
  assert.deepEqual(
    resolveAppTarget({
      home,
      workspaceRoot,
      exists: existsFor([APPLICATIONS, USER_APPLICATIONS, RELEASE_ARM, RELEASE_MAC]),
    }),
    { kind: "app", path: APPLICATIONS },
  );

  // Without /Applications, ~/Applications wins over the release dirs.
  assert.deepEqual(
    resolveAppTarget({
      home,
      workspaceRoot,
      exists: existsFor([USER_APPLICATIONS, RELEASE_ARM, RELEASE_MAC]),
    }),
    { kind: "app", path: USER_APPLICATIONS },
  );

  // Without either Applications dir, the arm64 release dir wins over plain mac.
  assert.deepEqual(
    resolveAppTarget({
      home,
      workspaceRoot,
      exists: existsFor([RELEASE_ARM, RELEASE_MAC]),
    }),
    { kind: "app", path: RELEASE_ARM },
  );

  // Only the non-arm release dir present — it's used as a last resort.
  assert.deepEqual(resolveAppTarget({ home, workspaceRoot, exists: existsFor([RELEASE_MAC]) }), {
    kind: "app",
    path: RELEASE_MAC,
  });
});

test("falls back to the dev target when no .app exists", () => {
  const target = resolveAppTarget({ home, workspaceRoot, exists: existsFor([]) });
  assert.deepEqual(target, { kind: "dev" });
});

test("uses the injected home dir for the ~/Applications candidate", () => {
  // Sanity check that the real homedir() isn't hard-coded into the resolver.
  assert.notEqual(home, homedir());
  const target = resolveAppTarget({ home, workspaceRoot, exists: existsFor([USER_APPLICATIONS]) });
  assert.deepEqual(target, { kind: "app", path: USER_APPLICATIONS });
});
