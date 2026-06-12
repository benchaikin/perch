/**
 * Electron-free view-model derivation for the panel's "Services" section.
 *
 * Mirrors `panel-state.ts` but for the `services.list` read: the main process
 * subscribes over RPC and feeds the raw {@link ServiceList} through
 * {@link buildServicesSection}; the renderer draws the returned
 * {@link ServicesSection} verbatim. Kept separate from `buildPanelState` so the
 * My-PRs view-model + its tests stay untouched.
 *
 * The `ServiceList` shape is duplicated here (rather than depending on the
 * services plugin) because the GUI is a thin client of the daemon — it only
 * knows the wire shape of `services.list`'s output, not the plugin's internals.
 */

/** Canonical capability id of the live process-list read the section renders. */
export const SERVICES_LIST_ID = "services.list";

/** Normalized service lifecycle (mirrors the services plugin's `ServiceStatus`). */
export type ServiceStatus = "running" | "starting" | "stopped" | "crashed" | "completed";

/** One supervised process as it arrives over RPC (the wire shape of `Service`). */
export interface Service {
  name: string;
  status: ServiceStatus;
  pid?: number;
  uptime?: number;
  restartCount?: number;
  exitCode?: number;
}

/** `services.list`'s output: the process list + server reachability. */
export interface ServiceList {
  services: Service[];
  available: boolean;
}

/** A rendered service row's marker health → CSS dot color. */
export type ServiceHealth = "ok" | "warn" | "bad" | "muted";

/** One rendered service row. */
export interface ServiceRow {
  name: string;
  status: ServiceStatus;
  /** Human label for the status (e.g. "running", "crashed"). */
  statusLabel: string;
  /** Marker color: running=green(ok), starting=amber(warn), crashed=red(bad). */
  health: ServiceHealth;
  /** A short detail suffix (e.g. "exit 1", "pid 4242"), when relevant. */
  detail?: string;
}

/**
 * The rendered Services section. `visible` is false when the process-compose
 * server is unreachable or reports no services — the renderer then omits the
 * whole section so users without process-compose see the unchanged My-PRs panel.
 */
export interface ServicesSection {
  visible: boolean;
  rows: ServiceRow[];
}

/** Map a normalized status to its marker health (color). */
export function serviceHealth(status: ServiceStatus): ServiceHealth {
  switch (status) {
    case "running":
      return "ok";
    case "completed":
      return "ok";
    case "starting":
      return "warn";
    case "crashed":
      return "bad";
    case "stopped":
      return "muted";
  }
}

/** A short detail suffix for a row: the exit code if crashed, else the pid. */
function detailOf(svc: Service): string | undefined {
  if (svc.status === "crashed" && svc.exitCode !== undefined) return `exit ${svc.exitCode}`;
  if (svc.pid !== undefined && (svc.status === "running" || svc.status === "starting")) {
    return `pid ${svc.pid}`;
  }
  return undefined;
}

/** Derive a single rendered row from a raw {@link Service}. */
export function toServiceRow(svc: Service): ServiceRow {
  return {
    name: svc.name,
    status: svc.status,
    statusLabel: svc.status,
    health: serviceHealth(svc.status),
    detail: detailOf(svc),
  };
}

/**
 * Build the Services section from the latest `services.list` output. The section
 * is hidden (`visible: false`) when the list is absent, the server is
 * unreachable (`available: false`), or there are no services — so the panel is
 * unchanged for users without process-compose.
 */
export function buildServicesSection(list: ServiceList | undefined): ServicesSection {
  if (!list || !list.available || list.services.length === 0) {
    return { visible: false, rows: [] };
  }
  return { visible: true, rows: list.services.map(toServiceRow) };
}
