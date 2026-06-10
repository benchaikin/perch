import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDuration } from "./duration.js";

test("parseDuration: seconds, minutes, hours, milliseconds", () => {
  assert.equal(parseDuration("60s"), 60_000);
  assert.equal(parseDuration("5m"), 300_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("500ms"), 500);
});

test("parseDuration: fractional amounts and surrounding whitespace", () => {
  assert.equal(parseDuration("1.5s"), 1500);
  assert.equal(parseDuration("  10s  "), 10_000);
});

test("parseDuration: rejects invalid input", () => {
  assert.throws(() => parseDuration("60"), /invalid duration/);
  assert.throws(() => parseDuration("abc"), /invalid duration/);
  assert.throws(() => parseDuration("0s"), /must be > 0/);
  assert.throws(() => parseDuration("10d"), /invalid duration/);
});
