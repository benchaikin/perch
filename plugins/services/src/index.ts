/**
 * @perch/plugin-services — the process-compose front-end plugin (Dev services M1).
 *
 * Connects Perch to a running `process-compose` server over its REST API
 * (preferring a Unix socket) and surfaces live per-process status as the
 * subscribable `services.list` read. M1 is read-only + crash notifications;
 * process actions (start/stop/restart) and log streaming land in M2/M3.
 */
import { definePlugin, read, z } from "@perch/sdk";

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
      run: async ({ ctx }) => {
        const cfg = configOf(ctx.config);
        const provider = new ServicesProvider({
          socket: cfg.socket,
          address: cfg.address,
          composeFile: cfg.composeFile,
          autostart: cfg.autostart,
          log: ctx.log,
        });
        return buildServiceList(await provider.processes());
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
  },
});
