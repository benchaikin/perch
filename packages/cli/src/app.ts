/**
 * `perch app` — launch the Perch desktop GUI (and ensure the daemon is running).
 *
 * A convenience for the monorepo checkout: it ensures `perchd` is up, then
 * resolves the Electron GUI from the workspace and spawns it detached. (A
 * packaged, double-clickable `.app` is future work.)
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonStart } from "./daemon.js";

/** Walk up to the workspace root (the dir containing `pnpm-workspace.yaml`). */
function findWorkspaceRoot(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** `perch app` — start the daemon (if needed) and open the GUI. Returns an exit code. */
export async function runApp(opts: { socket?: string }): Promise<number> {
  const root = findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)));
  if (!root) {
    console.error("perch: couldn't locate the Perch workspace to launch the GUI.");
    return 1;
  }
  const guiDir = join(root, "packages", "gui");
  if (!existsSync(join(guiDir, "dist", "main.js"))) {
    console.error(
      "perch: the GUI isn't built — run `pnpm build && pnpm --filter @perch/gui build`.",
    );
    return 1;
  }

  // Ensure the daemon is up so the panel has data (idempotent — no-ops if running).
  await daemonStart({ socket: opts.socket });

  let electronPath: string;
  try {
    electronPath = createRequire(join(guiDir, "package.json"))("electron") as string;
  } catch {
    console.error("perch: Electron isn't installed for the GUI — run `pnpm install`.");
    return 1;
  }

  // Detached so the GUI outlives this command. A single-instance lock in the GUI
  // means a second `perch app` just focuses the existing window instead of duping.
  const child = spawn(electronPath, [guiDir], { detached: true, stdio: "ignore" });
  child.unref();
  console.log("Perch app launched — look for the bird in your menu bar.");
  return 0;
}
