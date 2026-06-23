import assert from "node:assert/strict";
import { test } from "node:test";

import { THEME_DEFAULT, THEME_SETTINGS_FIELDS, themeSourceOf } from "./theme.js";

test("themeSourceOf: returns the persisted light/dark mode", () => {
  assert.equal(themeSourceOf({ theme: "light" }), "light");
  assert.equal(themeSourceOf({ theme: "dark" }), "dark");
  assert.equal(themeSourceOf({ theme: "system" }), "system");
});

test("themeSourceOf: missing / unknown / non-object → system (back-compat)", () => {
  assert.equal(themeSourceOf({}), "system");
  assert.equal(themeSourceOf(undefined), "system");
  assert.equal(themeSourceOf({ theme: "neon" }), "system");
  assert.equal(themeSourceOf("nope"), "system");
});

test("THEME_SETTINGS_FIELDS: a single enum at global.theme defaulting to system", () => {
  assert.equal(THEME_SETTINGS_FIELDS.length, 1);
  const [field] = THEME_SETTINGS_FIELDS;
  assert.ok(field);
  assert.equal(field.key, "theme");
  assert.equal(field.type, "enum");
  assert.equal(field.default, THEME_DEFAULT);
  assert.deepEqual(
    field.options?.map((o) => o.value),
    ["system", "light", "dark"],
  );
});
