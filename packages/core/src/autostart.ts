/**
 * Autostart unit generation + (un)installation.
 *
 * Per v1-spec §4, `perchd` autostarts via **launchd** (macOS) / a **systemd
 * user unit** (Linux). This module owns:
 *
 * - Pure generators for the launchd plist and systemd unit strings (unit-tested
 *   without touching the machine).
 * - `installAutostart` / `uninstallAutostart`, which WRITE the unit file and
 *   shell out to `launchctl`/`systemctl`. These have real side effects and are
 *   exercised only by the live `perch daemon install/uninstall` commands, never
 *   in tests.
 *
 * The program to launch is resolved from `@perch/core`'s `bin.perchd` (see
 * {@link resolvePerchdEntry}) so no absolute path is hard-coded.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

/** launchd label / plist basename. */
export const LAUNCHD_LABEL = "com.perch.daemon";
/** systemd user unit basename. */
export const SYSTEMD_UNIT = "perch.service";

/** Inputs for unit generation: the node binary + the resolved `perchd` entry. */
export interface AutostartArgs {
  /** Absolute path to the node executable. */
  nodePath: string;
  /** Absolute path to the resolved `perchd` entry script. */
  perchdPath: string;
}

/**
 * Resolve the `perchd` entry script from `@perch/core`'s package.json `bin`,
 * plus the current node executable. Used to fill in unit ProgramArguments/Exec
 * without hard-coding a path.
 */
export function resolvePerchdEntry(): AutostartArgs {
  const require = createRequire(import.meta.url);
  // Resolve relative to this module: `@perch/core`'s own bin entry is bin.js.
  const perchdPath = require.resolve("./bin.js");
  return { nodePath: process.execPath, perchdPath };
}

/** Absolute path to the launchd LaunchAgent plist for the current user. */
export function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

/** Absolute path to the systemd user unit for the current user. */
export function systemdUnitPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "systemd", "user", SYSTEMD_UNIT);
}

/** Escape a string for inclusion in XML text/CDATA-free content. */
function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Generate the launchd LaunchAgent plist. RunAtLoad + KeepAlive keep `perchd`
 * running and restart it if it exits; ProgramArguments runs `node <perchd>`.
 */
export function launchdPlist(args: AutostartArgs): string {
  const programArgs = [args.nodePath, args.perchdPath]
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
}

/**
 * Generate the systemd user service unit. `Restart=always` + the default-target
 * WantedBy give launch-on-login + restart-on-exit, mirroring launchd.
 */
export function systemdUnit(args: AutostartArgs): string {
  return `[Unit]
Description=Perch daemon (perchd)
After=default.target

[Service]
Type=simple
ExecStart=${args.nodePath} ${args.perchdPath}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

/** Run a command, resolving on exit 0 and rejecting otherwise. */
function runCommand(cmd: string, cmdArgs: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${cmdArgs.join(" ")} exited with code ${code}`));
    });
  });
}

/** Result of an (un)install: which file was written and how it was loaded. */
export interface AutostartResult {
  platform: "darwin" | "linux";
  unitPath: string;
}

/**
 * WRITE the platform autostart unit and load it (`launchctl load` /
 * `systemctl --user enable --now`). Has real side effects; called only by the
 * live `perch daemon install` command, never in tests.
 */
export async function installAutostart(
  args: AutostartArgs = resolvePerchdEntry(),
): Promise<AutostartResult> {
  if (platform() === "darwin") {
    const unitPath = launchdPlistPath();
    await mkdir(dirname(unitPath), { recursive: true });
    await writeFile(unitPath, launchdPlist(args), "utf8");
    // `load` is idempotent enough for v1; unload first to refresh if present.
    await runCommand("launchctl", ["unload", unitPath]).catch(() => undefined);
    await runCommand("launchctl", ["load", unitPath]);
    return { platform: "darwin", unitPath };
  }
  const unitPath = systemdUnitPath();
  await mkdir(dirname(unitPath), { recursive: true });
  await writeFile(unitPath, systemdUnit(args), "utf8");
  await runCommand("systemctl", ["--user", "daemon-reload"]);
  await runCommand("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
  return { platform: "linux", unitPath };
}

/**
 * Unload/disable the autostart unit and remove its file. Has real side effects;
 * called only by the live `perch daemon uninstall` command, never in tests.
 */
export async function uninstallAutostart(): Promise<AutostartResult> {
  if (platform() === "darwin") {
    const unitPath = launchdPlistPath();
    await runCommand("launchctl", ["unload", unitPath]).catch(() => undefined);
    await rm(unitPath, { force: true });
    return { platform: "darwin", unitPath };
  }
  const unitPath = systemdUnitPath();
  await runCommand("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]).catch(
    () => undefined,
  );
  await rm(unitPath, { force: true });
  await runCommand("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
  return { platform: "linux", unitPath };
}
