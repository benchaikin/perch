/**
 * Daemon pidfile management.
 *
 * `perchd` writes its pid to {@link pidPath} on startup and removes it on
 * graceful shutdown. Clients (`perch daemon status/stop`) read it to discover
 * the running daemon and signal it. Treated as advisory: a stale pidfile (no
 * such process) is reported as "not running", never trusted blindly.
 */
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pidPath as defaultPidPath } from "./paths.js";

/** Write `pid` to the pidfile, creating the parent dir if needed. */
export async function writePidFile(pid: number, path: string = defaultPidPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${pid}\n`, "utf8");
}

/** Read the pid from the pidfile, or `undefined` if absent/unparseable. */
export async function readPidFile(path: string = defaultPidPath()): Promise<number | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Remove the pidfile; ignores absence. */
export async function removePidFile(path: string = defaultPidPath()): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Whether a process with `pid` currently exists (signal 0 probe). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but we can't signal it — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
