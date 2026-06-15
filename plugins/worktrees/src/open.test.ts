/**
 * Unit tests for the open-command builder (pure; spawning is not exercised).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildOpenCommand, DEFAULT_OPEN_COMMAND } from "./open.js";

test("buildOpenCommand substitutes {path}, shell-quoted", () => {
  assert.equal(buildOpenCommand("code {path}", "/repo/wt"), "code '/repo/wt'");
  assert.equal(buildOpenCommand(DEFAULT_OPEN_COMMAND, "/repo/wt"), "open '/repo/wt'");
});

test("buildOpenCommand appends the quoted path when {path} is absent", () => {
  assert.equal(buildOpenCommand("cursor", "/repo/wt"), "cursor '/repo/wt'");
});

test("buildOpenCommand escapes single quotes in the path", () => {
  assert.equal(buildOpenCommand("open {path}", "/has/it's/quote"), "open '/has/it'\\''s/quote'");
});

test("buildOpenCommand substitutes every {path} occurrence", () => {
  assert.equal(buildOpenCommand("x {path} {path}", "/p"), "x '/p' '/p'");
});
