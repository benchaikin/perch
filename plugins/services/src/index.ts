/**
 * @perch/plugin-services — the process-compose front-end plugin (Dev services M1).
 *
 * Connects Perch to a running `process-compose` server over its REST API
 * (preferring a Unix socket) and surfaces live per-process status as the
 * subscribable `services.list` read plus the `services.start`/`stop`/`restart`
 * actions and the whole-stack `services.startAll`/`stopAll`/`restartAll` (Dev
 * services M2). M1 was read-only + crash notifications; log streaming lands in
 * M3. `startAll` also brings process-compose up on demand when it's down.
 */
import type { spawn as nodeSpawn } from "node:child_process";
import { basename } from "node:path";

import {
  action,
  definePlugin,
  read,
  reposOf,
  spawnInTerminal,
  terminalConfigOf,
  z,
} from "@perch/sdk";

import { syncCompose, type Proc } from "./compose.js";
import { buildLogsCommand } from "./logs.js";
import { crashNotifications } from "./notify.js";
import {
  buildServiceList,
  mapStatus,
  resolveProject,
  ServiceList,
  type ServiceStatus,
} from "./services.js";
import { ServicesProvider, type ServerTarget } from "./provider.js";

export type { FetchJson, ProcessState, ServerTarget } from "./provider.js";
export { defaultFetchJson, DEFAULT_ADDRESS, ServicesProvider } from "./provider.js";
export {
  buildServiceList,
  mapStatus,
  resolveProject,
  Service,
  ServiceList,
  ServiceStatus,
} from "./services.js";
export type { ServiceProc } from "./services.js";
export { crashNotifications } from "./notify.js";
export { buildLogsCommand } from "./logs.js";
export {
  buildComposeDoc,
  generatedComposePath,
  GENERATED_COMPOSE_FILENAME,
  syncCompose,
} from "./compose.js";
export type { Proc, Reloader, SyncComposeDeps, SyncComposeResult } from "./compose.js";

/**
 * Test seam for the `services.logs` action's spawn. `ctx` carries no spawn, so
 * tests override this module-level injection point to assert the final spawned
 * command/args without launching a real terminal. Defaults to the real
 * `child_process.spawn` (used by {@link spawnLogsTerminal}).
 */
let logsSpawn: typeof nodeSpawn | undefined;

/** Inject a `spawn` stub for `services.logs` (tests only); pass `undefined` to reset. */
export function __setLogsSpawn(spawnFn: typeof nodeSpawn | undefined): void {
  logsSpawn = spawnFn;
}

/**
 * Test seam for the spawn the provider uses to bring process-compose **up**
 * (autostart / `services.startAll` when the server is down). `ctx` carries no
 * spawn, so tests override this to assert (or no-op) the `process-compose up -D`
 * launch instead of spawning the real binary. Defaults to the real spawn.
 */
let providerSpawn: typeof nodeSpawn | undefined;

/** Inject a `spawn` stub for the provider's server-up launch (tests only). */
export function __setProviderSpawn(spawnFn: typeof nodeSpawn | undefined): void {
  providerSpawn = spawnFn;
}

/**
 * One Perch-owned process definition (`plugins.services.procs[]`): a `name` +
 * `command`, with an optional `cwd`. Perch generates the process-compose file
 * from these — see {@link syncCompose}. The GUI CRUD over services must mirror
 * this exact shape under the `procs` config key.
 */
const Proc = z.object({
  /** Process name (the key in the generated compose file). */
  name: z.string(),
  /** Shell command process-compose runs for this process. */
  command: z.string(),
  /** Optional working directory (`working_dir` in the compose file). */
  cwd: z.string().optional(),
  /**
   * Optional repo this process belongs to (a configured `global.repos`
   * basename), driving the Services tab's per-repo grouping. Purely a GUI
   * association — it never affects the generated compose file; when unset the
   * repo is inferred from `cwd`. The Services settings tab gains a matching repo
   * field in a follow-up (this is the GUI-CRUD-mirrored shape).
   */
  repo: z.string().optional(),
});

/**
 * Per-plugin config (`plugins.services`). Connection target: prefer `socket`
 * (process-compose `--use-uds`), else `address` (default `http://localhost:8080`).
 *
 * Service definitions come from either `procs` (Perch owns them — we generate a
 * process-compose file from them) or an external `composeFile` the user manages.
 * When `procs` is non-empty it takes precedence: the generated file is targeted
 * instead of `composeFile`. `autostart` drives a best-effort `process-compose up
 * -D` against the resolved file when the server is unreachable.
 */
const ServicesConfig = z.object({
  /** Path to an externally-managed process-compose config file (for `autostart`). */
  composeFile: z.string().optional(),
  /**
   * Perch-owned process definitions. When non-empty, Perch generates a
   * process-compose file from these and targets it (overriding `composeFile`).
   */
  procs: z.array(Proc).optional(),
  /** Unix domain socket path (process-compose `--use-uds`). Preferred when set. */
  socket: z.string().optional(),
  /** HTTP base address (default `http://localhost:8080`). Used when `socket` is unset. */
  address: z.string().optional(),
  /** Spawn `process-compose up -D` when the server is unreachable. */
  autostart: z.boolean().optional(),
  /**
   * @deprecated The terminal preference moved to the global `General` settings
   * (`global.terminal`). Kept here only as a back-compat fallback: when no global
   * terminal is set, `services.logs` still honors a legacy `terminalApp` /
   * `logTerminal` under `plugins.services`. No longer shown in the Services tab.
   */
  terminalApp: z.string().optional(),
  /** @deprecated See {@link terminalApp} — legacy fallback for the global terminal. */
  logTerminal: z.string().optional(),
});
export type ServicesConfig = z.infer<typeof ServicesConfig>;

/**
 * Narrow a capability's `ctx.config` (typed `unknown` by the SDK) to the parsed
 * {@link ServicesConfig}. Malformed/absent config → an empty object (the
 * provider then uses its `localhost:8080` default).
 */
function configOf(config: unknown): ServicesConfig {
  const parsed = ServicesConfig.safeParse(config);
  return parsed.success ? parsed.data : {};
}

/** The connection {@link ServerTarget} a config resolves to (socket preferred). */
function targetOf(cfg: ServicesConfig): ServerTarget {
  return cfg.socket ? { socket: cfg.socket } : { address: cfg.address };
}

/**
 * Resolve the compose file `autostart` targets. When `procs` is non-empty, Perch
 * owns the definitions: (re)generate the managed file — best-effort + idempotent,
 * only rewriting/live-reloading when its content changed — and target it,
 * **overriding** any `composeFile`. Otherwise fall back to the user's
 * `composeFile` (unset → process-compose's own default discovery). Returns
 * `undefined` when neither source applies.
 *
 * Called from the `services.list` read (every poll), so the generated file
 * tracks `perch.json` edits to `procs`; the change-guard in {@link syncCompose}
 * keeps repeated polls cheap (no rewrite/reload when nothing changed).
 */
export function resolveComposeFile(
  cfg: ServicesConfig,
  log: (message: string) => void,
  sync: typeof syncCompose = syncCompose,
): string | undefined {
  if (cfg.procs && cfg.procs.length > 0) {
    const result = sync(cfg.procs, { target: targetOf(cfg), log });
    return result.path;
  }
  return cfg.composeFile;
}

/** A {@link ServicesProvider} built from a capability's `ctx` (config + log). */
function providerOf(ctx: { config: unknown; log: (message: string) => void }): ServicesProvider {
  const cfg = configOf(ctx.config);
  return new ServicesProvider({
    socket: cfg.socket,
    address: cfg.address,
    composeFile: resolveComposeFile(cfg, ctx.log),
    autostart: cfg.autostart,
    log: ctx.log,
    spawn: providerSpawn,
  });
}

/** Outcome a service action returns to clients (small, like `stack.sync`). */
const ActionResult = z.object({ ok: z.boolean(), message: z.string() });
type ActionResult = z.infer<typeof ActionResult>;

/** Input shared by the single-service actions: the process name to target. */
const ServiceActionInput = z.object({ name: z.string() });

/**
 * Input for the bulk (whole-stack) actions: an optional `project` (a configured
 * repo basename) that scopes the action to just that repo's live procs, for the
 * Services tab's per-repo group controls. Omitted → the whole stack, the
 * behavior MCP/agent callers rely on.
 */
const BulkActionInput = z.object({ project: z.string().optional() }).default({});
type BulkActionInput = z.infer<typeof BulkActionInput>;

/** A process that's up or coming up — Stop applies to it; Start doesn't. */
function isRunningStatus(status: ServiceStatus): boolean {
  return status === "running" || status === "starting";
}

/**
 * Restrict a live process list to one repo's procs when `project` is set. The
 * project label is a GUI-only association resolved from config
 * ({@link resolveProject} over each proc's `repo`/`cwd`) — the same resolution the
 * `list` read uses — so we map configured proc names → project and keep only the
 * live processes whose name resolves to `project`. Unscoped (`project` undefined)
 * returns the list unchanged: the whole-stack behavior MCP/agent callers depend on.
 */
function scopeProcesses<T extends { name: string }>(
  processes: T[],
  project: string | undefined,
  ctx: { config: unknown; global?: unknown },
): T[] {
  if (project === undefined) return processes;
  const repos = reposOf(ctx.global);
  const projectByName = new Map(
    (configOf(ctx.config).procs ?? []).map((p) => [p.name, resolveProject(p, repos)] as const),
  );
  return processes.filter((p) => projectByName.get(p.name) === project);
}

/** Pluralized "Verbed n/total services." summary for the bulk actions. */
function bulkMessage(verb: string, done: number, total: number): string {
  return `${verb} ${done}/${total} service${total === 1 ? "" : "s"}.`;
}

/**
 * The window title for a service's logs terminal: `<name> logs`, trimmed to a
 * readable length, so a row of log windows is self-identifying at a glance and
 * reads naturally ("api logs"). Mirrors `dex`'s {@link agentTitle}/`newTaskTitle`
 * (40-char cap, ellipsis on the name) and stays consistent with the spawn's `label`.
 */
export function serviceLogsTitle(name: string, maxNameLength = 40): string {
  const trimmed = name.trim();
  if (!trimmed) return "logs";
  const short =
    trimmed.length > maxNameLength ? `${trimmed.slice(0, maxNameLength - 1).trimEnd()}…` : trimmed;
  return `${short} logs`;
}

export default definePlugin({
  id: "services",
  name: "Services",
  config: ServicesConfig,
  // No per-plugin settings: the terminal preference moved to the global
  // "General" tab (`global.terminal`), consumed by `services.logs` below.
  capabilities: {
    /**
     * The live process list from process-compose. Subscribable + polled (5s) and
     * refreshed on focus — mirrors `stack.prs`. Exposed on MCP so agents can read
     * "is the api up?" as a typed tool. Never throws: an unreachable server
     * yields `available: false` + an empty list.
     */
    list: read({
      summary: "Live process-compose service statuses (running/crashed/…)",
      input: z.object({}).default({}),
      output: ServiceList,
      // Background (panel-closed) polling drops to 30s — a crash notification
      // within 30s is plenty when nobody's watching the live status.
      refresh: { every: "5s", idleEvery: "30s", on: ["focus"] },
      view: { kind: "list", title: "Services" },
      expose: { mcp: true },
      // Pass the configured procs (each tagged with its resolved repo) so they
      // surface as `stopped` rows even when process-compose is down — the panel
      // stays visible to launch from — and the configured repo list so the GUI
      // groups by repo (a header per repo, including empty ones).
      run: async ({ ctx }) => {
        const cfg = configOf(ctx.config);
        const repos = reposOf(ctx.global);
        const procs = (cfg.procs ?? []).map((p) => ({
          name: p.name,
          project: resolveProject(p, repos),
        }));
        const projects = repos.map((dir) => basename(dir));
        return buildServiceList(await providerOf(ctx).processes(), procs, projects);
      },
      // Diff each poll against the previous list and fire one notification per
      // process that newly entered `crashed`. `prev`/`next` carry the schema's
      // input type (defaulted fields optional); normalize via `ServiceList.parse`
      // to the strict shape `crashNotifications` diffs over.
      notify: ({ prev, next }) =>
        crashNotifications(
          prev === undefined ? undefined : ServiceList.parse(prev),
          ServiceList.parse(next),
        ),
    }),

    // ── M2 process actions ──
    // start / stop / restart one process by name, plus a best-effort restartAll.
    // All `expose: { mcp: true }` — the control-plane payoff is that an agent can
    // recover a crashed service ("restart the api") as a typed tool, mirroring
    // the `services.list` read it pairs with. Each returns a small {ok, message}
    // like `stack.sync`; the provider never throws, so `ok: false` means the
    // server rejected the call or was unreachable (not an exception).

    /** Restart one process (`POST /process/restart/{name}`). */
    restart: action<z.infer<typeof ServiceActionInput>, unknown, ActionResult>({
      summary: "Restart a process-compose service by name",
      input: ServiceActionInput,
      expose: { mcp: true },
      run: async ({ input, ctx }) => {
        const ok = await providerOf(ctx).action(input.name, "restart");
        return {
          ok,
          message: ok ? `Restarted ${input.name}.` : `Failed to restart ${input.name}.`,
        };
      },
    }),

    /** Start one process (`POST /process/start/{name}`). */
    start: action<z.infer<typeof ServiceActionInput>, unknown, ActionResult>({
      summary: "Start a stopped process-compose service by name",
      input: ServiceActionInput,
      expose: { mcp: true },
      run: async ({ input, ctx }) => {
        const ok = await providerOf(ctx).action(input.name, "start");
        return { ok, message: ok ? `Started ${input.name}.` : `Failed to start ${input.name}.` };
      },
    }),

    /** Stop one running process (`POST /process/stop/{name}`). */
    stop: action<z.infer<typeof ServiceActionInput>, unknown, ActionResult>({
      summary: "Stop a running process-compose service by name",
      input: ServiceActionInput,
      expose: { mcp: true },
      run: async ({ input, ctx }) => {
        const ok = await providerOf(ctx).action(input.name, "stop");
        return { ok, message: ok ? `Stopped ${input.name}.` : `Failed to stop ${input.name}.` };
      },
    }),

    // ── Bulk (whole-stack) actions ──
    // start / stop / restart every process at once, for the panel's per-repo
    // group controls (and as single agent tools). Each takes an optional
    // `project` (a configured repo basename) that scopes the action to just that
    // repo's live procs; omitted, it targets the whole stack (the MCP/agent path).
    // `startAll` additionally brings process-compose **up on demand** when the
    // server is down — the path for procs that are defined but not auto-started.

    /**
     * Best-effort restart of every supervised process: enumerate the current
     * list (`processes()`) and `restart` each. Reports how many of N succeeded;
     * an unreachable server yields `ok: false` with nothing to restart. Useful as
     * a single agent tool to bounce the whole stack after a config change.
     */
    restartAll: action<BulkActionInput | undefined, unknown, ActionResult>({
      summary: "Restart every process-compose service (best-effort)",
      input: BulkActionInput,
      expose: { mcp: true },
      run: async ({ input, ctx }) => {
        const provider = providerOf(ctx);
        const processes = await provider.processes();
        if (processes === undefined) {
          return { ok: false, message: "process-compose is unreachable." };
        }
        const names = scopeProcesses(processes, input?.project, ctx).map((p) => p.name);
        const results = await Promise.all(names.map((name) => provider.action(name, "restart")));
        const restarted = results.filter(Boolean).length;
        return {
          ok: restarted === names.length,
          message: bulkMessage("Restarted", restarted, names.length),
        };
      },
    }),

    /**
     * Start the whole stack. When process-compose is **down**, bring it up on
     * demand (`process-compose up -D`, which launches the server *and* every
     * configured proc) and report success optimistically — a subsequent poll
     * reflects the live statuses. When it's already **up**, start each process
     * that isn't running/starting and report how many of N took.
     */
    startAll: action<BulkActionInput | undefined, unknown, ActionResult>({
      summary: "Start every service, bringing process-compose up if it's down",
      input: BulkActionInput,
      expose: { mcp: true },
      run: async ({ input, ctx }) => {
        const provider = providerOf(ctx);
        const processes = await provider.processes();
        if (processes === undefined) {
          // No running server to target a subset against: `up -D` brings the
          // WHOLE stack up. A scoped Start-all while the server is down still
          // starts every repo's procs (the next poll reflects them all) — there's
          // no per-repo selectivity without a server to start individual procs on.
          provider.startServer();
          return { ok: true, message: "Starting services…" };
        }
        const targets = scopeProcesses(processes, input?.project, ctx)
          .filter((p) => !isRunningStatus(mapStatus(p.status, p.exit_code)))
          .map((p) => p.name);
        if (targets.length === 0) return { ok: true, message: "All services already running." };
        const results = await Promise.all(targets.map((name) => provider.action(name, "start")));
        const started = results.filter(Boolean).length;
        return {
          ok: started === targets.length,
          message: bulkMessage("Started", started, targets.length),
        };
      },
    }),

    /**
     * Stop the whole stack: stop every running/starting process. An unreachable
     * server (nothing running) is a no-op success; with the server up, reports
     * how many of the running N stopped.
     */
    stopAll: action<BulkActionInput | undefined, unknown, ActionResult>({
      summary: "Stop every running process-compose service",
      input: BulkActionInput,
      expose: { mcp: true },
      run: async ({ input, ctx }) => {
        const provider = providerOf(ctx);
        const processes = await provider.processes();
        if (processes === undefined) {
          return { ok: true, message: "process-compose is not running." };
        }
        const targets = scopeProcesses(processes, input?.project, ctx)
          .filter((p) => isRunningStatus(mapStatus(p.status, p.exit_code)))
          .map((p) => p.name);
        if (targets.length === 0) return { ok: true, message: "No running services to stop." };
        const results = await Promise.all(targets.map((name) => provider.action(name, "stop")));
        const stopped = results.filter(Boolean).length;
        return {
          ok: stopped === targets.length,
          message: bulkMessage("Stopped", stopped, targets.length),
        };
      },
    }),

    /**
     * Jump-to-logs (M3): open the user's terminal running a live single-process
     * tail (`process-compose process logs <name> -f`) connected to the same
     * server. The terminal launch runs on the user's machine, so it happens here
     * in the daemon (which holds the socket/address/logTerminal config). The
     * inner command + its connection flag (socket vs address) and the `{cmd}`
     * substitution live in {@link buildLogsCommand}/{@link spawnLogsTerminal};
     * this action just wires `ctx.config` in and spawns best-effort.
     *
     * CLI-on (the default), MCP-off: it's an interactive, fire-and-forget
     * terminal launch — not a typed read an agent drives. Never throws; an
     * `ok: false` means the launcher couldn't be spawned.
     */
    logs: action<z.infer<typeof ServiceActionInput>, unknown, ActionResult>({
      summary: "Open a terminal live-tailing a service's logs",
      input: ServiceActionInput,
      run: ({ input, ctx }) => {
        const cfg = configOf(ctx.config);
        // Prefer the global terminal setting; fall back to the legacy
        // per-services terminalApp/logTerminal until the user sets the global one.
        const fromGlobal = terminalConfigOf(ctx.global);
        const terminal =
          fromGlobal.terminalApp || fromGlobal.logTerminal
            ? fromGlobal
            : { terminalApp: cfg.terminalApp, logTerminal: cfg.logTerminal };
        // `exec` so the terminal's shell becomes process-compose (clean Ctrl-C).
        const command = `exec ${buildLogsCommand(input.name, targetOf(cfg))}`;
        return spawnInTerminal({
          command,
          terminal,
          label: `${input.name} logs`,
          title: serviceLogsTitle(input.name),
          log: ctx.log,
          spawn: logsSpawn,
        });
      },
    }),
  },
});
