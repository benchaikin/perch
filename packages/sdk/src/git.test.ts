/**
 * Unit tests for the shared git binary reader: ctx.global narrowing to
 * `global.git`, plus the settings field the General tab renders.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { GIT_SETTINGS_FIELDS, gitConfigOf } from "./git.js";

test("gitConfigOf: narrows global.git, {} on miss or invalid", () => {
  assert.deepEqual(gitConfigOf({ git: { gitBin: "/opt/homebrew/bin/git" } }), {
    gitBin: "/opt/homebrew/bin/git",
  });
  // The optional branch prefix narrows alongside gitBin.
  assert.deepEqual(gitConfigOf({ git: { gitBin: "git", branchPrefix: "feat" } }), {
    gitBin: "git",
    branchPrefix: "feat",
  });
  assert.deepEqual(gitConfigOf({}), {});
  assert.deepEqual(gitConfigOf(undefined), {});
  assert.deepEqual(gitConfigOf("nope"), {});
  // A non-object `git` doesn't satisfy the schema → {}.
  assert.deepEqual(gitConfigOf({ git: "bad" }), {});
});

test("GIT_SETTINGS_FIELDS: a git.gitBin field and an optional git.branchPrefix field", () => {
  assert.equal(GIT_SETTINGS_FIELDS.length, 2);
  const gitBin = GIT_SETTINGS_FIELDS.find((f) => f.key === "git.gitBin");
  assert.ok(gitBin);
  assert.equal(gitBin.type, "string");
  assert.equal(gitBin.default, "git");
  const prefix = GIT_SETTINGS_FIELDS.find((f) => f.key === "git.branchPrefix");
  assert.ok(prefix);
  assert.equal(prefix.type, "string");
  assert.equal(prefix.default, "");
});
