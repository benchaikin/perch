/**
 * @perch/plugin-services — the process-compose front-end plugin (Dev services M1).
 *
 * Connects Perch to a running `process-compose` server over its REST API
 * (preferring a Unix socket) and surfaces live per-process status as the
 * subscribable `services.list` read plus the `services.start`/`stop`/`restart`/
 * `restartAll` actions (Dev services M2). M1 was read-only + crash
 * notifications; log streaming lands in M3.
 */
import { action, definePlugin, read, z } from "@perch/sdk";

import { crashNotifications } from "./notify.js";
import { buildServiceList, ServiceList } from "./services.js";
import { ServicesProvider } from "./provider.js";

export type { FetchJson, ProcessState, ServerTarget } from "./provider.js";
export { defaultFetchJson, DEFAULT_ADDRESS, ServicesProvider } from "./provider.js";
export { buildServiceList, mapStatus, Service, ServiceList, ServiceStatus } from "./services.js";
export { crashNotifications } from "./notify.js";

/**
 * Per-plugin config (`plugins.services`). Connection target: prefer `socket`
 * (process-compose `--use-uds`), else `address` (default `http://localhost:8080`).
 * `composeFile` + `autostart` drive a best-effort `process-compose up -D` when
 * the server is unreachable.
 */
const ServicesConfig = z.object({
  /** Path to the process-compose config file (for `autostart`). */
  composeFile: z.string().optional(),
  /** Unix domain socket path (process-compose `--use-uds`). Preferred when set. */
  socket: z.string().optional(),
  /** HTTP base address (default `http://localhost:8080`). Used when `socket` is unset. */
  address: z.string().optional(),
  /** Spawn `process-compose up -D` when the server is unreachable. */
  autostart: z.boolean().optional(),
});
type ServicesConfig = z.infer<typeof ServicesConfig>;

/**
 * Narrow a capability's `ctx.config` (typed `unknown` by the SDK) to the parsed
 * {@link ServicesConfig}. Malformed/absent config → an empty object (the
 * provider then uses its `localhost:8080` default).
 */
function configOf(config: unknown): ServicesConfig {
  const parsed = ServicesConfig.safeParse(config);
  return parsed.success ? parsed.data : {};
}

/** A {@link ServicesProvider} built from a capability's `ctx` (config + log). */
function providerOf(ctx: { config: unknown; log: (message: string) => void }): ServicesProvider {
  const cfg = configOf(ctx.config);
  return new ServicesProvider({
    socket: cfg.socket,
    address: cfg.address,
    composeFile: cfg.composeFile,
    autostart: cfg.autostart,
    log: ctx.log,
  });
}

/** Outcome a service action returns to clients (small, like `stack.sync`). */
const ActionResult = z.object({ ok: z.boolean(), message: z.string() });
type ActionResult = z.infer<typeof ActionResult>;

/** Input shared by the single-service actions: the process name to target. */
const ServiceActionInput = z.object({ name: z.string() });

export default definePlugin({
  id: "services",
  name: "Services",
  config: ServicesConfig,
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
      refresh: { every: "5s", on: ["focus"] },
      view: { kind: "list", title: "Services" },
      expose: { mcp: true },
      run: async ({ ctx }) => buildServiceList(await providerOf(ctx).processes()),
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

    /**
     * Best-effort restart of every supervised process: enumerate the current
     * list (`processes()`) and `restart` each. Reports how many of N succeeded;
     * an unreachable server yields `ok: false` with nothing to restart. Useful as
     * a single agent tool to bounce the whole stack after a config change.
     */
    restartAll: action<Record<string, never> | undefined, unknown, ActionResult>({
      summary: "Restart every process-compose service (best-effort)",
      input: z.object({}).default({}),
      expose: { mcp: true },
      run: async ({ ctx }) => {
        const provider = providerOf(ctx);
        const processes = await provider.processes();
        if (processes === undefined) {
          return { ok: false, message: "process-compose is unreachable." };
        }
        const names = processes.map((p) => p.name);
        const results = await Promise.all(names.map((name) => provider.action(name, "restart")));
        const restarted = results.filter(Boolean).length;
        return {
          ok: restarted === names.length,
          message: `Restarted ${restarted}/${names.length} service${
            names.length === 1 ? "" : "s"
          }.`,
        };
      },
    }),
  },
});
