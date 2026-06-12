/**
 * `services.list` output shape + the process-compose status → enum mapping
 * (Dev services M1).
 *
 * The plugin normalizes process-compose's broad status vocabulary onto a small,
 * stable enum the panel + agents reason about. Kept Electron-free and provider-
 * free so it unit-tests as a pure function over a `ProcessState[]` fixture.
 */
import { z } from "@perch/sdk";

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
});
export type Service = z.infer<typeof Service>;

/** Output of the `services.list` read: the process list + server reachability. */
export const ServiceList = z.object({
  /** One entry per supervised process (empty when unavailable). */
  services: z.array(Service),
  /** False when the process-compose server is unreachable. */
  available: z.boolean(),
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
 * Build the `services.list` output from a raw process list. `processes` is
 * `undefined` when the server is unreachable → `available: false` + empty list
 * (the read never throws). An empty-but-reachable server is `available: true`.
 */
export function buildServiceList(processes: ProcessState[] | undefined): ServiceList {
  if (processes === undefined) {
    return { services: [], available: false };
  }
  return { services: processes.map(toService), available: true };
}
