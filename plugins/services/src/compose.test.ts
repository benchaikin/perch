/**
 * Tests for the process-compose generator + sync (Part A of managed services).
 *
 * `buildComposeDoc` is pure (asserted on the emitted YAML string + scalar
 * safety). `syncCompose` takes injected reader/writer/reloader seams so the
 * "only rewrite/reload when the content changed" guard is asserted without
 * touching the real filesystem or the `process-compose` binary.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildComposeDoc, syncCompose, type Proc } from "./compose.js";

test("buildComposeDoc: keys processes by name with command + working_dir", () => {
  const procs: Proc[] = [
    { name: "api", command: "node server.js", cwd: "/srv/api" },
    { name: "worker", command: "node worker.js" },
  ];
  assert.equal(
    buildComposeDoc(procs),
    [
      `version: "0.5"`,
      "processes:",
      `  "api":`,
      `    command: "node server.js"`,
      `    working_dir: "/srv/api"`,
      `  "worker":`,
      `    command: "node worker.js"`,
      "",
    ].join("\n"),
  );
});

test("buildComposeDoc: omits working_dir when cwd is unset", () => {
  const doc = buildComposeDoc([{ name: "x", command: "run" }]);
  assert.ok(doc.includes(`    command: "run"`));
  assert.ok(!doc.includes("working_dir"));
});

test("buildComposeDoc: empty procs emits an empty processes map", () => {
  assert.equal(buildComposeDoc([]), `version: "0.5"\nprocesses: {}\n`);
});

test("buildComposeDoc: safe-quotes commands with quotes, backslashes, newlines", () => {
  const doc = buildComposeDoc([
    { name: 'weird"name', command: 'echo "hi"\nrm -rf \\tmp', cwd: "a\tb" },
  ]);
  // The quotes/backslash/newline/tab are escaped, so the document stays one
  // line per scalar and nothing can break out of its double-quoted string.
  assert.ok(doc.includes(`  "weird\\"name":`));
  assert.ok(doc.includes(`    command: "echo \\"hi\\"\\nrm -rf \\\\tmp"`));
  assert.ok(doc.includes(`    working_dir: "a\\tb"`));
  // Each emitted line is a single physical line (no raw newline leaked in).
  for (const line of doc.split("\n")) {
    assert.ok(!line.includes("\n"));
  }
});

/** A reader/writer/reloader recorder for syncCompose. */
function harness(initial?: string) {
  const state = { content: initial };
  const writes: string[] = [];
  const reloads: Array<{ file: string; socket?: string; address?: string }> = [];
  return {
    deps: {
      readFile: () => state.content,
      writeFile: (_path: string, content: string) => {
        state.content = content;
        writes.push(content);
      },
      reload: (file: string, target: { socket?: string; address?: string }) =>
        reloads.push({ file, socket: target.socket, address: target.address }),
    },
    writes,
    reloads,
  };
}

test("syncCompose: writes + reloads when content changed", () => {
  const h = harness(undefined);
  const result = syncCompose([{ name: "api", command: "run" }], {
    ...h.deps,
    target: { socket: "/tmp/pc.sock" },
  });
  assert.equal(result.changed, true);
  assert.equal(h.writes.length, 1);
  assert.equal(h.reloads.length, 1);
  assert.equal(h.reloads[0]!.socket, "/tmp/pc.sock");
  assert.equal(h.reloads[0]!.file, result.path);
});

test("syncCompose: no rewrite + no reload when content is unchanged", () => {
  const procs: Proc[] = [{ name: "api", command: "run" }];
  const h = harness(buildComposeDoc(procs));
  const result = syncCompose(procs, { ...h.deps, target: { socket: "/tmp/pc.sock" } });
  assert.equal(result.changed, false);
  assert.equal(h.writes.length, 0);
  assert.equal(h.reloads.length, 0);
});

test("syncCompose: rewrites but does not reload when no target is set", () => {
  const h = harness(undefined);
  const result = syncCompose([{ name: "api", command: "run" }], h.deps);
  assert.equal(result.changed, true);
  assert.equal(h.writes.length, 1);
  assert.equal(h.reloads.length, 0);
});

test("syncCompose: a reloader that throws never escapes", () => {
  const h = harness(undefined);
  const result = syncCompose([{ name: "api", command: "run" }], {
    readFile: h.deps.readFile,
    writeFile: h.deps.writeFile,
    reload: () => {
      throw new Error("boom");
    },
    target: { socket: "/tmp/pc.sock" },
  });
  // Still reports the write happened; the failed reload is swallowed.
  assert.equal(result.changed, true);
  assert.equal(h.writes.length, 1);
});

test("syncCompose: a writer that throws is swallowed and reports not-changed", () => {
  const result = syncCompose([{ name: "api", command: "run" }], {
    readFile: () => undefined,
    writeFile: () => {
      throw new Error("EACCES");
    },
    reload: () => assert.fail("must not reload after a failed write"),
    target: { socket: "/tmp/pc.sock" },
  });
  assert.equal(result.changed, false);
});
