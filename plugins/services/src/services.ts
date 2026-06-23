/**
 * `services.list` output shape + the process-compose status → enum mapping
 * (Dev services M1).
 *
 * The plugin normalizes process-compose's broad status vocabulary onto a small,
 * stable enum the panel + agents reason about. Kept Electron-free and provider-
 * free so it unit-tests as a pure function over a `ProcessState[]` fixture.
 */
import { basename, isAbsolute, relative, resolve } from "node:path";

import { z } from "@perch/sdk";

import type { Proc } from "./compose.js";
import type { ProcessState } from "./provider.js";

/**
 * Normalized lifecycle of a single supervised process. The panel colors rows by
 * this; agents read it to answer "is the api up?".
 * - `running`   — up and serving.
 * - `starting`  — pending/launching/restarting (transitional).
 * - `stopped`   — intentionally down (stopped/terminating/disabled/skipped).
 * - `crashed`   — errored or exited non-zero.
 * - `completed` — ran to a clean (exit 0) finish.
 */
export const ServiceStatus = z.enum(["running", "starting", "stopped", "crashed", "completed"]);
export type ServiceStatus = z.infer<typeof ServiceStatus>;

/** One supervised process, projected from process-compose's `ProcessState`. */
export const Service = z.object({
  /** Process name (the key in the compose file). */
  name: z.string(),
  /** Normalized lifecycle status. */
  status: ServiceStatus,
  /** OS process id, when running. */
  pid: z.number().int().optional(),
  /** Uptime in seconds (process-compose `age`), when known. */
  uptime: z.number().optional(),
  /** Restart count for this process. */
  restartCount: z.number().int().optional(),
  /** Last exit code, when the process has exited. */
  exitCode: z.number().int().optional(),
  /**
   * The repo (a configured `global.repos` basename) this process belongs to,
   * for the Services tab's per-repo grouping; undefined when it maps to no
   * configured repo. See {@link resolveProject}.
   */
  project: z.string().optional(),
});
export type Service = z.infer<typeof Service>;

/** Output of the `services.list` read: the process list + server reachability. */
export const ServiceList = z.object({
  /** One entry per supervised process (empty when unavailable). */
  services: z.array(Service),
  /** False when the process-compose server is unreachable. */
  available: z.boolean(),
  /**
   * The configured repos (`global.repos` basenames) in config order, so the GUI
   * renders a header for every monitored repo — including ones with zero
   * services. Mirrors `DexBoard.projects`; omitted by an older daemon (the GUI
   * then degrades to a flat list).
   */
  projects: z.array(z.string()).optional(),
  /**
   * Per-repo Auto/Manual mode (`plugins.services.auto`), keyed by repo basename
   * (or the flat-pane sentinel), surfaced so the GUI's per-repo toggle reflects
   * the persisted mode. Mirrors `DexBoard.autoSpawn`; absent when no repo is
   * configured Auto (the default).
   */
  auto: z.record(z.string(), z.boolean()).optional(),
});
export type ServiceList = z.infer<typeof ServiceList>;

/**
 * Map a process-compose status string (+ exit code) onto a {@link ServiceStatus}.
 *
 * The canonical process-compose status set is: Disabled, Foreground, Pending,
 * Running, Launching, Launched, Restarting, Terminating, Completed, Skipped,
 * Error, Stopped. `Completed` splits on exit code (0 → completed, else crashed);
 * an unknown status falls back to `stopped` (a safe, non-alarming default).
 */
export function mapStatus(status: string, exitCode: number | undefined): ServiceStatus {
  switch (status) {
    case "Running":
    case "Foreground":
      return "running";
    case "Pending":
    case "Launching":
    case "Launched":
    case "Restarting":
      return "starting";
    case "Completed":
      return exitCode !== undefined && exitCode !== 0 ? "crashed" : "completed";
    case "Error":
      return "crashed";
    case "Stopped":
    case "Terminating":
    case "Disabled":
    case "Skipped":
      return "stopped";
    default:
      return "stopped";
  }
}

/** Project one raw `ProcessState` onto a normalized {@link Service}. */
export function toService(state: ProcessState): Service {
  return Service.parse({
    name: state.name,
    status: mapStatus(state.status, state.exit_code),
    pid: state.pid,
    uptime: state.age,
    restartCount: state.restarts,
    exitCode: state.exit_code,
  });
}

/**
 * Whether `child` is the same directory as, or nested inside, `dir`. Compares
 * resolved absolute paths so trailing slashes / `..` segments don't matter.
 */
function isWithin(dir: string, child: string): boolean {
  const rel = relative(resolve(dir), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve the repo (project label) a configured proc belongs to, for the
 * Services tab's per-repo grouping:
 * 1. an explicit `proc.repo` (already a configured repo's basename), else
 * 2. the configured `repos` dir that contains `proc.cwd` (its basename), else
 * 3. `undefined` (the proc maps to no configured repo → ungrouped).
 *
 * Pure: `repos` is the list of absolute repo directories (`reposOf(ctx.global)`).
 */
export function resolveProject(
  proc: Pick<Proc, "cwd" | "repo">,
  repos: readonly string[],
): string | undefined {
  if (proc.repo !== undefined) return proc.repo;
  if (proc.cwd !== undefined) {
    const match = repos.find((dir) => isWithin(dir, proc.cwd!));
    if (match !== undefined) return basename(match);
  }
  return undefined;
}

/** A configured proc paired with its resolved {@link resolveProject} project. */
export interface ServiceProc {
  /** Process name (matches a live process / synthesized `stopped` row). */
  name: string;
  /** Resolved repo basename, or undefined when it maps to no configured repo. */
  project?: string;
}

/** Synthesize a `stopped` {@link Service} for a configured-but-absent proc. */
function stoppedService(name: string, project?: string): Service {
  return Service.parse({ name, status: "stopped", project });
}

/** Tag an already-normalized live {@link Service} with its resolved project. */
function withProject(svc: Service, project: string | undefined): Service {
  return project === undefined ? svc : { ...svc, project };
}

/**
 * Build the `services.list` output from a raw process list and the user's
 * **configured** procs (`plugins.services.procs[]`), each already paired with
 * its resolved {@link ServiceProc.project} so every row — live or synthesized —
 * carries its repo. `projects` is the configured repo list (config order) that
 * surfaces on the output so the GUI renders a header even for repos with zero
 * services (mirrors `DexBoard.projects`).
 *
 * `processes` is `undefined` when the server is unreachable → `available: false`,
 * but any configured procs still surface as `stopped` rows so the panel shows
 * what's defined (and offers Start-all) even with process-compose down. When the
 * server is reachable, live processes are mapped and any configured proc not in
 * the live set is appended as `stopped`. The read never throws.
 *
 * Ordering follows the **configured order** (`plugins.services.procs[]`), not
 * process-compose's `/processes` order (which is its own internal/sorted order):
 * each configured proc appears in definition order (its live status if present,
 * else a synthesized `stopped` row). Any live process NOT in the configured set
 * (e.g. an externally-managed compose file with no `procs`) is appended after, in
 * its original order.
 */
export function buildServiceList(
  processes: ProcessState[] | undefined,
  procs: readonly ServiceProc[] = [],
  projects: readonly string[] = [],
): ServiceList {
  const withProjects = (list: ServiceList): ServiceList =>
    projects.length > 0 ? { ...list, projects: [...projects] } : list;
  if (processes === undefined) {
    return withProjects({
      services: procs.map((p) => stoppedService(p.name, p.project)),
      available: false,
    });
  }
  const live = new Map(processes.map((state) => [state.name, toService(state)]));
  // Configured procs first, in definition order (live status, else `stopped`),
  // each tagged with its resolved project.
  const ordered = procs.map((p) =>
    withProject(live.get(p.name) ?? stoppedService(p.name), p.project),
  );
  // Then any live process not in the configured set, in process-compose's order.
  const configured = new Set(procs.map((p) => p.name));
  const extras = processes
    .filter((state) => !configured.has(state.name))
    .map((state) => live.get(state.name)!);
  return withProjects({ services: [...ordered, ...extras], available: true });
}
