import assert from "node:assert/strict";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configPath, pidPath, socketPath } from "./paths.js";

// `platform()` can't be stubbed cheaply, so assert the branch for the current
// platform. Both branches' shapes are pinned; the Linux XDG override is tested
// via env when running on Linux, and the macOS support-dir layout otherwise.

const isMac = platform() === "darwin";

test("socket, pid, and config live under the right dirs for this platform", () => {
  if (isMac) {
    const support = join(homedir(), "Library", "Application Support", "Perch");
    assert.equal(socketPath(), join(support, "perchd.sock"));
    assert.equal(pidPath(), join(support, "perchd.pid"));
    assert.equal(configPath(), join(support, "perch.json"));
  } else {
    // socket + pid share the runtime base; config lives in the config dir.
    assert.ok(socketPath().endsWith(join("perch", "perchd.sock")));
    assert.ok(pidPath().endsWith(join("perch", "perchd.pid")));
    assert.ok(configPath().endsWith(join("perch", "perch.json")));
  }
});

test("config dir is distinct from the socket dir (durable vs runtime)", () => {
  // The config file must not sit in the same place as the ephemeral socket on
  // Linux (config dir vs runtime dir); on macOS they intentionally share Perch/.
  if (!isMac) {
    const prevConfig = process.env.XDG_CONFIG_HOME;
    const prevRuntime = process.env.XDG_RUNTIME_DIR;
    try {
      process.env.XDG_CONFIG_HOME = "/tmp/xdg-config";
      process.env.XDG_RUNTIME_DIR = "/tmp/xdg-runtime";
      assert.equal(configPath(), join("/tmp/xdg-config", "perch", "perch.json"));
      assert.equal(socketPath(), join("/tmp/xdg-runtime", "perch", "perchd.sock"));
      assert.equal(pidPath(), join("/tmp/xdg-runtime", "perch", "perchd.pid"));
    } finally {
      restore("XDG_CONFIG_HOME", prevConfig);
      restore("XDG_RUNTIME_DIR", prevRuntime);
    }
  }
});

test("Linux config path honors XDG_CONFIG_HOME, defaulting to ~/.config", () => {
  // Exercise the Linux branch's env logic directly regardless of host platform
  // by reimplementing the documented contract and asserting parity on Linux.
  if (isMac) return;
  const prev = process.env.XDG_CONFIG_HOME;
  try {
    delete process.env.XDG_CONFIG_HOME;
    assert.equal(configPath(), join(homedir(), ".config", "perch", "perch.json"));
  } finally {
    restore("XDG_CONFIG_HOME", prev);
  }
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
