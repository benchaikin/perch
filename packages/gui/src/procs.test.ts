/**
 * Unit tests for the Electron-free managed-process logic. The Settings window's
 * Electron wiring (window, IPC, config RPCs) needs a display + a daemon and is
 * verified by manual launch; the pure array transforms here are the testable
 * part.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addProc, procsFromConfig, ProcValidationError, removeProc, type Proc } from "./procs.js";

test("procsFromConfig reads plugins.services.procs, keeping well-formed entries", () => {
  const config = {
    plugins: {
      services: {
        procs: [
          { name: "web", command: "npm run dev", cwd: "/app" },
          { name: "api", command: "go run ." },
        ],
      },
    },
  };
  assert.deepEqual(procsFromConfig(config), [
    { name: "web", command: "npm run dev", cwd: "/app" },
    { name: "api", command: "go run ." },
  ] satisfies Proc[]);
});

test("procsFromConfig drops malformed entries (missing/non-string name or command)", () => {
  const config = {
    plugins: {
      services: {
        procs: [
          { name: "ok", command: "run" },
          { name: "no-command" },
          { command: "no-name" },
          { name: 42, command: "x" },
          null,
          "nope",
        ],
      },
    },
  };
  assert.deepEqual(procsFromConfig(config), [{ name: "ok", command: "run" }]);
});

test("procsFromConfig returns [] when services/procs is absent or wrong-typed", () => {
  assert.deepEqual(procsFromConfig({}), []);
  assert.deepEqual(procsFromConfig({ plugins: {} }), []);
  assert.deepEqual(procsFromConfig({ plugins: { services: {} } }), []);
  assert.deepEqual(procsFromConfig({ plugins: { services: { procs: "web" } } }), []);
});

test("procsFromConfig trims fields, drops blank cwd, and de-dupes by name", () => {
  const config = {
    plugins: {
      services: {
        procs: [
          { name: " web ", command: " run ", cwd: "  " },
          { name: "web", command: "other" },
        ],
      },
    },
  };
  assert.deepEqual(procsFromConfig(config), [{ name: "web", command: "run" }]);
});

test("addProc appends a new proc to the end", () => {
  assert.deepEqual(addProc([{ name: "a", command: "ra" }], { name: "b", command: "rb" }), [
    { name: "a", command: "ra" },
    { name: "b", command: "rb" },
  ]);
});

test("addProc trims fields and omits a blank cwd", () => {
  assert.deepEqual(addProc([], { name: "  web ", command: "  run ", cwd: "   " }), [
    { name: "web", command: "run" },
  ]);
});

test("addProc keeps a non-blank cwd (trimmed)", () => {
  assert.deepEqual(addProc([], { name: "web", command: "run", cwd: " /app " }), [
    { name: "web", command: "run", cwd: "/app" },
  ]);
});

test("addProc rejects a blank name", () => {
  assert.throws(
    () => addProc([], { name: "   ", command: "run" }),
    (err) => err instanceof ProcValidationError && /name is required/i.test(err.message),
  );
});

test("addProc rejects a blank command", () => {
  assert.throws(
    () => addProc([], { name: "web", command: "  " }),
    (err) => err instanceof ProcValidationError && /command is required/i.test(err.message),
  );
});

test("addProc rejects a duplicate name (after trim)", () => {
  assert.throws(
    () => addProc([{ name: "web", command: "run" }], { name: " web ", command: "other" }),
    (err) => err instanceof ProcValidationError && /already exists/i.test(err.message),
  );
});

test("addProc preserves existing order", () => {
  const procs = [
    { name: "a", command: "ra" },
    { name: "b", command: "rb" },
  ];
  assert.deepEqual(addProc(procs, { name: "c", command: "rc" }), [
    { name: "a", command: "ra" },
    { name: "b", command: "rb" },
    { name: "c", command: "rc" },
  ]);
});

test("removeProc drops the matching proc by name", () => {
  const procs = [
    { name: "a", command: "ra" },
    { name: "b", command: "rb" },
    { name: "c", command: "rc" },
  ];
  assert.deepEqual(removeProc(procs, "b"), [
    { name: "a", command: "ra" },
    { name: "c", command: "rc" },
  ]);
});

test("removeProc is a no-op when the name is not found", () => {
  const procs = [{ name: "a", command: "ra" }];
  assert.deepEqual(removeProc(procs, "z"), [{ name: "a", command: "ra" }]);
});

test("removeProc can empty the list", () => {
  assert.deepEqual(removeProc([{ name: "a", command: "ra" }], "a"), []);
});
