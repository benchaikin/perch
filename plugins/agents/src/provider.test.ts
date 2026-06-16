/**
 * Unit tests for the cwd → dex-task attribution provider, with a stubbed `git`
 * runner (no real process). Covers a `dex/<id>` branch parse, the `perch.dexTask`
 * config override winning over the branch, and a non-git cwd degrading to {}.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { AttributionProvider, type Exec } from "./provider.js";

/** A git stub: maps the subcommand to canned stdout (or throws to simulate failure). */
function gitStub(responses: { branch?: string | Error; config?: string | Error }): Exec {
  return (_cmd, args) => {
    const isBranch = args[0] === "branch";
    const value = isBranch ? responses.branch : responses.config;
    if (value instanceof Error) return Promise.reject(value);
    if (value === undefined) return Promise.reject(new Error("not configured"));
    return Promise.resolve(value);
  };
}

test("attributes a dex/<id> branch cwd to its task id", async () => {
  const p = new AttributionProvider("git", {
    exec: gitStub({ branch: "dex/ab12-test-slug\n", config: new Error("unset") }),
  });
  const out = await p.attribute("/repo/dex-ab12-test-slug");
  assert.equal(out.branch, "dex/ab12-test-slug");
  assert.equal(out.taskId, "ab12");
});

test("the perch.dexTask config override wins over the branch parse", async () => {
  const p = new AttributionProvider("git", {
    exec: gitStub({ branch: "dex/ab12-test\n", config: "override99\n" }),
  });
  const out = await p.attribute("/repo/wt");
  assert.equal(out.taskId, "override99");
});

test("a non-dex branch yields no taskId", async () => {
  const p = new AttributionProvider("git", {
    exec: gitStub({ branch: "main\n", config: new Error("unset") }),
  });
  const out = await p.attribute("/repo/main");
  assert.equal(out.branch, "main");
  assert.equal(out.taskId, undefined);
});

test("a non-git cwd degrades to no attribution", async () => {
  const p = new AttributionProvider("git", {
    exec: gitStub({ branch: new Error("not a git repo"), config: new Error("not a git repo") }),
  });
  const out = await p.attribute("/tmp/plain");
  assert.deepEqual(out, { branch: undefined, taskId: undefined });
});

test("an undefined cwd yields {}", async () => {
  const p = new AttributionProvider("git", { exec: gitStub({}) });
  assert.deepEqual(await p.attribute(undefined), {});
});
