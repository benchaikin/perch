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
  assert.deepEqual(gitConfigOf({}), {});
  assert.deepEqual(gitConfigOf(undefined), {});
  assert.deepEqual(gitConfigOf("nope"), {});
  // A non-object `git` doesn't satisfy the schema → {}.
  assert.deepEqual(gitConfigOf({ git: "bad" }), {});
});

test("GIT_SETTINGS_FIELDS: a single git.gitBin string field defaulting to git", () => {
  assert.equal(GIT_SETTINGS_FIELDS.length, 1);
  const [field] = GIT_SETTINGS_FIELDS;
  assert.ok(field);
  assert.equal(field.key, "git.gitBin");
  assert.equal(field.type, "string");
  assert.equal(field.default, "git");
});
