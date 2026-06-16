/**
 * Unit tests for the worktree "open" inner command (cd into the dir + exec a
 * shell). The terminal launcher it feeds is shared + tested in @perch/sdk.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildShellInDir } from "./open.js";

test("buildShellInDir: cd's into the shell-quoted path and execs $SHELL", () => {
  assert.equal(buildShellInDir("/repo/wt"), `cd '/repo/wt' && exec "$SHELL"`);
});

test("buildShellInDir: escapes single quotes in the path", () => {
  assert.equal(buildShellInDir("/has/it's/quote"), `cd '/has/it'\\''s/quote' && exec "$SHELL"`);
});
