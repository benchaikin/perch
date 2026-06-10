import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isProcessAlive, readPidFile, removePidFile, writePidFile } from "./pidfile.js";

function tempPidPath(): string {
  return join(mkdtempSync(join(tmpdir(), "perch-pid-test-")), "perchd.pid");
}

test("writePidFile then readPidFile round-trips the pid", async () => {
  const path = tempPidPath();
  await writePidFile(12345, path);
  assert.equal(await readPidFile(path), 12345);
});

test("readPidFile returns undefined for a missing file", async () => {
  assert.equal(await readPidFile(join(tmpdir(), "perch-no-such-pid-xyz.pid")), undefined);
});

test("removePidFile is idempotent (no throw when absent)", async () => {
  const path = tempPidPath();
  await writePidFile(1, path);
  await removePidFile(path);
  await removePidFile(path);
  assert.equal(await readPidFile(path), undefined);
});

test("isProcessAlive: own pid is alive, an unused high pid is not", () => {
  assert.equal(isProcessAlive(process.pid), true);
  // PIDs are capped well below this; treat as definitely-not-running.
  assert.equal(isProcessAlive(2_147_483_646), false);
});
