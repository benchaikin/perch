/**
 * `perch app` — launch the Perch desktop GUI (and ensure the daemon is running).
 *
 * It ensures `perchd` is up, then prefers an installed/built `Perch.app`
 * (launched via macOS `open`), falling back to the dev launch — spawning
 * Electron on the workspace GUI dir — when no packaged app is found.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
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

/** Where `perch app` should launch the GUI from. */
export type AppTarget = { kind: "app"; path: string } | { kind: "dev" };

/**
 * Resolve the best launch target for `perch app`, in priority order:
 *
 * 1. An installed/built `Perch.app` — `/Applications`, then `~/Applications`,
 *    then the workspace build output (`release/mac-arm64`, then `release/mac`).
 *    The first candidate `exists(path)` reports true wins.
 * 2. Otherwise `{ kind: "dev" }` — the workspace Electron launch.
 *
 * Pure + side-effect-free: `exists` is injected so this is unit-testable
 * without touching the real filesystem.
 */
export function resolveAppTarget(deps: {
  home: string;
  workspaceRoot: string;
  exists: (path: string) => boolean;
}): AppTarget {
  const { home, workspaceRoot, exists } = deps;
  const candidates = [
    "/Applications/Perch.app",
    join(home, "Applications", "Perch.app"),
    join(workspaceRoot, "packages", "gui", "release", "mac-arm64", "Perch.app"),
    join(workspaceRoot, "packages", "gui", "release", "mac", "Perch.app"),
  ];
  for (const path of candidates) {
    if (exists(path)) return { kind: "app", path };
  }
  return { kind: "dev" };
}

/** `perch app` — start the daemon (if needed) and open the GUI. Returns an exit code. */
export async function runApp(opts: { socket?: string }): Promise<number> {
  const root = findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)));
  if (!root) {
    console.error("perch: couldn't locate the Perch workspace to launch the GUI.");
    return 1;
  }
  // Ensure the daemon is up so the panel has data (idempotent — no-ops if
  // running, and harmless even if a packaged app later self-starts its own).
  await daemonStart({ socket: opts.socket });

  const target = resolveAppTarget({ home: homedir(), workspaceRoot: root, exists: existsSync });

  // Prefer an installed/built `Perch.app`: open it via macOS `open`, detached
  // so the GUI outlives this command.
  if (target.kind === "app") {
    spawn("open", [target.path], { detached: true, stdio: "ignore" }).unref();
    console.log(`Opened Perch.app (${target.path}) — look for the bird in your menu bar.`);
    return 0;
  }

  // Dev fallback: spawn Electron on the workspace GUI dir.
  const guiDir = join(root, "packages", "gui");
  if (!existsSync(join(guiDir, "dist", "main.js"))) {
    console.error(
      "perch: the GUI isn't built — run `pnpm build && pnpm --filter @perch/gui build`.",
    );
    return 1;
  }

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
  console.log("Launched Perch (dev) — look for the bird in your menu bar.");
  return 0;
}
