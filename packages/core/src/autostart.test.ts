import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  launchdPlist,
  resolvePerchdEntry,
  systemdUnit,
} from "./autostart.js";

const args = { nodePath: "/usr/local/bin/node", perchdPath: "/opt/perch/dist/bin.js" };

test("launchdPlist has Label, ProgramArguments, RunAtLoad, KeepAlive", () => {
  const plist = launchdPlist(args);
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.perch\.daemon<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  // ProgramArguments → node then the resolved perchd entry, in order.
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/opt\/perch\/dist\/bin\.js<\/string>/);
  assert.ok(plist.indexOf("/usr/local/bin/node") < plist.indexOf("/opt/perch/dist/bin.js"));
  assert.equal(LAUNCHD_LABEL, "com.perch.daemon");
});

test("launchdPlist XML-escapes program argument paths", () => {
  const plist = launchdPlist({ nodePath: "/n&ode", perchdPath: "/p<a>th" });
  assert.match(plist, /<string>\/n&amp;ode<\/string>/);
  assert.match(plist, /<string>\/p&lt;a&gt;th<\/string>/);
});

test("systemdUnit has ExecStart, Restart, and WantedBy default.target", () => {
  const unit = systemdUnit(args);
  assert.match(unit, /ExecStart=\/usr\/local\/bin\/node \/opt\/perch\/dist\/bin\.js/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.equal(SYSTEMD_UNIT, "perch.service");
});

test("resolvePerchdEntry resolves a real node + perchd bin path", () => {
  const resolved = resolvePerchdEntry();
  assert.equal(resolved.nodePath, process.execPath);
  // Built daemon resolves bin.js; under tsx (tests) it maps to the bin.ts source.
  assert.match(resolved.perchdPath, /bin\.(js|ts)$/);
});
