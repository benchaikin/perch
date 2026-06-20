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
  /** Repo (configured repo basename) this process belongs to, for grouping. */
  project?: string;
}

/** `services.list`'s output: the process list + server reachability. */
export interface ServiceList {
  services: Service[];
  available: boolean;
  /**
   * The configured repos (basenames) in config order, so the Services tab
   * renders a header for every monitored repo — including ones with zero
   * services. Absent from an older daemon (the section then renders flat).
   */
  projects?: string[];
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
  /** A short plain-text detail suffix (e.g. "exit 1"), when relevant. */
  detail?: string;
  /**
   * The raw process id, for running/starting services — rendered as a
   * click-to-copy badge (not folded into `detail`). Absent otherwise.
   */
  pid?: number;
  /** Repo (configured repo basename) this process belongs to, for grouping. */
  project?: string;
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

/** One top-level control button rendered in a Services group/section header. */
export interface ServicesControl {
  action: ServicesBulkAction;
  label: string;
}

/**
 * Scope key for the unscoped (whole-stack) bulk controls — the flat-fallback
 * pane cluster when no repo is known to group under, and the key the in-flight
 * map uses for it. A space-prefixed sentinel that can't collide with a real repo
 * basename (mirrors `dex-pane`'s `PANE_SCOPE`).
 */
export const SERVICES_PANE_SCOPE = " :pane";

/** Bucket label for rows that resolve to no configured repo (see `groupRowsByProject`). */
const UNKNOWN_PROJECT = "(unknown)";

/** One repo's service rows, grouped under a per-repo header with its own controls. */
export interface ServicesRepoGroup {
  /** Source project label (a configured repo basename) the rows belong to. */
  project: string;
  /** This project's rows, in the list's order. */
  rows: ServiceRow[];
  /**
   * This group's whole-stack controls, scoped to this repo's services. Empty for
   * the `"(unknown)"` bucket, which has no real project to target the daemon with.
   */
  controls: ServicesControl[];
  /** The whole-stack action in flight for THIS group, if any (its button spins). */
  bulkActing?: ServicesBulkAction;
}

/**
 * The rendered Services section. `visible` is false only when there's nothing to
 * show — no list yet, or no processes live *and* none configured — so users
 * without process-compose see the unchanged My-PRs panel. When process-compose
 * is down but procs are configured, the rows surface as `stopped` and the header
 * offers **Start all** to bring the stack up. `controls` is the top-level button
 * set; `bulkActing` names the whole-stack action currently in flight (its button
 * spins and the cluster disables), if any.
 *
 * `grouped` is true when there is at least one *known* repo to group under — a
 * configured repo, or a repo seen on a service. The renderer then groups `rows`
 * under collapsible per-repo headers, one per `repoGroups` entry (config order,
 * INCLUDING configured-but-empty repos as empty groups), even for a single repo
 * — the header names which project the services belong to, and each group carries
 * its OWN `controls` + `bulkActing`. It is false only when no repo is known at all
 * (an older daemon with no `projects[]` and no per-service `project`); then
 * `repoGroups` is empty and rows render flat under the section-level `controls`.
 *
 * `controls`/`bulkActing` here are the unscoped (whole-stack) cluster the
 * **flat fallback** renders; when `grouped`, the renderer ignores them in favor
 * of each group's own scoped controls.
 */
export interface ServicesSection {
  visible: boolean;
  rows: ServiceRow[];
  controls: ServicesControl[];
  bulkActing?: ServicesBulkAction;
  grouped: boolean;
  repoGroups: ServicesRepoGroup[];
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

/**
 * A short plain-text detail suffix for a row: the exit code if crashed. The pid
 * of a running/starting service is NOT here — it rides its own {@link
 * ServiceRow.pid} field so the renderer can badge it as click-to-copy.
 */
function detailOf(svc: Service): string | undefined {
  if (svc.status === "crashed" && svc.exitCode !== undefined) return `exit ${svc.exitCode}`;
  return undefined;
}

/** The process id to badge: only present while a service is up (running/starting). */
function pidOf(svc: Service): number | undefined {
  if (svc.pid !== undefined && (svc.status === "running" || svc.status === "starting")) {
    return svc.pid;
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
    pid: pidOf(svc),
    project: svc.project,
    buttons: serviceButtons(svc.status),
    logs: true,
    inFlight: inFlight.has(svc.name),
  };
}

/**
 * The repos the section groups by: the configured `projects` (config order,
 * including any with zero services) unioned with any project seen on a service
 * but not configured (a repo dropped from config but still holding a service),
 * appended in first-appearance order. When `projects` is absent (an older
 * daemon's list), it degrades to just the projects seen on services — so a list
 * with no project tags stays flat. Mirrors `dex-state`'s `configuredRepos`.
 */
function configuredRepos(list: ServiceList): string[] {
  const seen = new Set<string>();
  const repos: string[] = [];
  const add = (project: string): void => {
    if (seen.has(project)) return;
    seen.add(project);
    repos.push(project);
  };
  for (const project of list.projects ?? []) add(project);
  for (const svc of list.services) {
    if (svc.project) add(svc.project);
  }
  return repos;
}

/**
 * Group rows by `project` into one {@link ServicesRepoGroup} per repo. The order
 * is seeded from the `configured` repo list (config order) so a
 * configured-but-empty repo still yields an EMPTY group (header only), then any
 * project seen only on rows (a repo dropped from config but still holding a
 * service) is appended in first-appearance order. Within a group rows keep the
 * list's order. A row with no `project` buckets under `"(unknown)"`. Mirrors
 * `dex-state`'s `groupRowsByProject`.
 *
 * Each group carries the same `controls` (availability is global, so the trio is
 * identical per repo) plus its own in-flight `bulkActing`, keyed by project in
 * `bulkActing`. The `"(unknown)"` bucket gets NO controls — it has no real
 * project to scope the daemon action to, so we never send it as a target. An
 * EMPTY group (zero rows) likewise gets none: a configured repo with no services
 * has nothing for whole-stack Start/Stop/Restart-all to act on.
 */
function groupRowsByProject(
  rows: ServiceRow[],
  configured: readonly string[],
  controls: ServicesControl[],
  bulkActing: ReadonlyMap<string, ServicesBulkAction>,
): ServicesRepoGroup[] {
  const byProject = new Map<string, ServiceRow[]>();
  const order: string[] = [];
  const ensure = (project: string): ServiceRow[] => {
    let group = byProject.get(project);
    if (!group) {
      group = [];
      byProject.set(project, group);
      order.push(project);
    }
    return group;
  };
  for (const project of configured) ensure(project);
  for (const row of rows) ensure(row.project ?? UNKNOWN_PROJECT).push(row);
  return order.map((project) => {
    const rows = byProject.get(project)!;
    return {
      project,
      rows,
      controls: project === UNKNOWN_PROJECT || rows.length === 0 ? [] : controls,
      bulkActing: bulkActing.get(project),
    };
  });
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
 * is the set of service names with an in-flight per-row action; `bulkActing` maps
 * a scope (a repo `project`, or {@link SERVICES_PANE_SCOPE} for the flat cluster)
 * to the whole-stack action currently running for it, so each group's controls
 * spin independently.
 */
export function buildServicesSection(
  list: ServiceList | undefined,
  acting: readonly string[] = [],
  bulkActing: ReadonlyMap<string, ServicesBulkAction> = new Map(),
): ServicesSection {
  if (!list || list.services.length === 0) {
    return { visible: false, rows: [], controls: [], grouped: false, repoGroups: [] };
  }
  const inFlight = new Set(acting);
  const rows = list.services.map((svc) => toServiceRow(svc, inFlight));
  const repos = configuredRepos(list);
  // Group whenever there's at least one known repo to head the rows — including a
  // single repo (the header names the project). Flat only when no repo is known
  // (an older daemon with no `projects[]` and no per-service `project`).
  const grouped = repos.length > 0;
  const controls = servicesControls(list.available);
  return {
    visible: true,
    rows,
    controls,
    bulkActing: bulkActing.get(SERVICES_PANE_SCOPE),
    grouped,
    repoGroups: grouped ? groupRowsByProject(rows, repos, controls, bulkActing) : [],
  };
}
