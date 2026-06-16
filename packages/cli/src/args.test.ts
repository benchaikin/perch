/**
 * Unit tests for the argv parser, focused on the reserved CLI-level flags and
 * generic input collection. The `--stdin-json` flag is reserved (never forwarded
 * as capability input) so a hook can `perch agents report --stdin-json` and have
 * the payload come from stdin rather than `--flags`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgs } from "./args.js";

test("--stdin-json is a reserved flag, not forwarded as input", () => {
  const { positionals, cli, input } = parseArgs(["agents", "report", "--stdin-json"]);
  assert.deepEqual(positionals, ["agents", "report"]);
  assert.equal(cli.stdinJson, true);
  assert.equal(input, undefined);
});

test("--stdin-json combines with generic input flags (flags still collected)", () => {
  const { cli, input } = parseArgs(["agents", "report", "--stdin-json", "--cwd", "/x"]);
  assert.equal(cli.stdinJson, true);
  assert.deepEqual(input, { cwd: "/x" });
});

test("stdinJson defaults to false", () => {
  const { cli } = parseArgs(["agents", "list"]);
  assert.equal(cli.stdinJson, false);
});
