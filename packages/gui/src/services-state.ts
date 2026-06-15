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

/** A lifecycle action that can be invoked on a service row (M2). */
export type ServiceAction = "start" | "stop" | "restart";

/** One action button on a service row: which action it triggers + its label. */
export interface ServiceButton {
  action: ServiceAction;
  label: string;
}

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
  /** Context-appropriate action buttons for this status (M2). */
  buttons: ServiceButton[];
  /**
   * Whether to offer the fire-and-forget **Logs** button (M3) — open a terminal
   * tailing this process. Always true (every row gets it, independent of
   * lifecycle status); modeled as a flag so the renderer + tests stay declarative.
   */
  logs: boolean;
  /** True while an action for this service is in flight — disable + spin. */
  inFlight: boolean;
}

/** A top-level (whole-stack) action the Services header offers. */
export type ServicesBulkAction = "startAll" | "stopAll" | "restartAll";

/** One top-level control button rendered in the Services section header. */
export interface ServicesControl {
  action: ServicesBulkAction;
  label: string;
}

/**
 * The rendered Services section. `visible` is false only when there's nothing to
 * show — no list yet, or no processes live *and* none configured — so users
 * without process-compose see the unchanged My-PRs panel. When process-compose
 * is down but procs are configured, the rows surface as `stopped` and the header
 * offers **Start all** to bring the stack up. `controls` is the top-level button
 * set; `bulkActing` names the whole-stack action currently in flight (its button
 * spins and the cluster disables), if any.
 */
export interface ServicesSection {
  visible: boolean;
  rows: ServiceRow[];
  controls: ServicesControl[];
  bulkActing?: ServicesBulkAction;
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

/**
 * The action buttons to render for a service in `status`, in display order.
 * Pure (no DOM) so it unit-tests directly:
 * - **Restart** whenever there's a process to bounce — running, starting,
 *   crashed, completed, or stopped (process-compose can re-launch a stopped one).
 * - **Stop** only while it's up or coming up (running / starting).
 * - **Start** only when it's down with nothing running (stopped / crashed /
 *   completed).
 *
 * Restart leads (it's the common recovery action); Stop/Start follows.
 */
export function serviceButtons(status: ServiceStatus): ServiceButton[] {
  const buttons: ServiceButton[] = [{ action: "restart", label: "Restart" }];
  if (status === "running" || status === "starting") {
    buttons.push({ action: "stop", label: "Stop" });
  } else {
    // stopped / crashed / completed — nothing is running, offer Start.
    buttons.push({ action: "start", label: "Start" });
  }
  return buttons;
}

/**
 * Derive a single rendered row from a raw {@link Service}. `inFlight` names the
 * services with an action currently running — their buttons render disabled +
 * spinning until the next `services.list` update reflects the new status.
 */
export function toServiceRow(svc: Service, inFlight: ReadonlySet<string>): ServiceRow {
  return {
    name: svc.name,
    status: svc.status,
    statusLabel: svc.status,
    health: serviceHealth(svc.status),
    detail: detailOf(svc),
    buttons: serviceButtons(svc.status),
    logs: true,
    inFlight: inFlight.has(svc.name),
  };
}

/**
 * The top-level controls for a section, given server reachability. When the
 * server is **up** the full Start/Stop/Restart-all trio applies; when it's
 * **down** (rows are configured-but-stopped procs) only **Start all** makes
 * sense — it brings process-compose up on demand.
 */
function servicesControls(available: boolean): ServicesControl[] {
  if (!available) return [{ action: "startAll", label: "Start all" }];
  return [
    { action: "startAll", label: "Start all" },
    { action: "stopAll", label: "Stop all" },
    { action: "restartAll", label: "Restart all" },
  ];
}

/**
 * The worst (most severe) health across a section's rows, for the Services
 * tab's status dot: `bad` if any row is crashed, else `warn` if any is
 * starting, else `ok` if any is running/completed, else `muted` (every row
 * stopped, or no rows). Severity order: bad > warn > ok > muted.
 */
export function worstServiceHealth(section: ServicesSection): ServiceHealth {
  let worst: ServiceHealth = "muted";
  const rank: Record<ServiceHealth, number> = { muted: 0, ok: 1, warn: 2, bad: 3 };
  for (const row of section.rows) {
    if (rank[row.health] > rank[worst]) worst = row.health;
  }
  return worst;
}

/**
 * Build the Services section from the latest `services.list` output. Hidden
 * (`visible: false`) only when the list is absent or has no rows — note an
 * unreachable server can still carry configured procs as `stopped` rows, so the
 * section shows (with **Start all**) even when process-compose is down. `acting`
 * is the set of service names with an in-flight per-row action; `bulkActing` is
 * the whole-stack action currently running, if any.
 */
export function buildServicesSection(
  list: ServiceList | undefined,
  acting: readonly string[] = [],
  bulkActing?: ServicesBulkAction,
): ServicesSection {
  if (!list || list.services.length === 0) {
    return { visible: false, rows: [], controls: [] };
  }
  const inFlight = new Set(acting);
  return {
    visible: true,
    rows: list.services.map((svc) => toServiceRow(svc, inFlight)),
    controls: servicesControls(list.available),
    bulkActing,
  };
}
