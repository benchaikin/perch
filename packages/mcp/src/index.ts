/**
 * @perch/mcp — re-export Perch's MCP-opted-in capabilities as MCP tools.
 *
 * Per the v1 spec, MCP is OFF by default: a capability is only mounted here when
 * it opts in with `expose.mcp === true`. This module builds a real MCP server
 * (stdio transport via the bin) that:
 *
 *  - connects to `perchd` over its Unix socket (reusing `@perch/cli`'s
 *    `PerchClient`),
 *  - filters `registry.list` to MCP-opted-in capabilities and exposes each as an
 *    MCP tool, and
 *  - keeps the tool set live: when the daemon hot-reloads `perch.json` it
 *    re-queries the registry and emits `tools/list_changed`.
 *
 * The capability's zod input schema is never serialized over RPC (only
 * `hasInput`), so each tool advertises a permissive free-form object schema and
 * the provided arguments are forwarded verbatim to `capability.invoke`; the
 * daemon validates them against the real schema.
 */
import { PerchClient, DaemonUnavailableError } from "@perch/cli";
import { socketPath as defaultSocketPath, type CapabilityMeta } from "@perch/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

/** Server name/version advertised to MCP clients. */
const SERVER_INFO = { name: "perch", version: "0.0.0" } as const;

/**
 * Translate a capability id into an MCP tool name. MCP tool names must avoid
 * dots (clients treat them specially), so `stack.view` → `stack_view`. The
 * mapping is reversible because Perch ids contain no underscores in the
 * `pluginId.name` separator position — we keep the original id alongside for the
 * authoritative reverse lookup, so this is purely cosmetic.
 */
export function toToolName(id: string): string {
  return id.replaceAll(".", "_");
}

/** Whether a capability opts into the MCP surface. */
export function isMcpExposed(cap: CapabilityMeta): boolean {
  return cap.expose.mcp === true;
}

/** The MCP-opted-in subset of a registry listing. */
export function mcpCapabilities(caps: CapabilityMeta[]): CapabilityMeta[] {
  return caps.filter(isMcpExposed);
}

/**
 * Build the MCP `Tool` descriptor for a capability. The input schema is
 * deliberately permissive: the real zod schema lives in the daemon and is not
 * serialized over RPC, so we accept any object and let the daemon validate.
 */
export function toToolDescriptor(cap: CapabilityMeta): Tool {
  return {
    name: toToolName(cap.id),
    description: cap.summary,
    inputSchema: {
      type: "object",
      // Free-form: capabilities with input take arbitrary properties; the
      // daemon validates against the capability's zod schema on invoke.
      properties: {},
      additionalProperties: true,
    },
  };
}

/** A running MCP server bridged to `perchd`. Call {@link PerchMcpServer.close}. */
export interface PerchMcpServer {
  /** The underlying MCP SDK server (already connected to its transport). */
  readonly server: Server;
  /** Disconnect from `perchd`, dispose subscriptions, and close the MCP server. */
  close(): Promise<void>;
}

/** Options for {@link startMcpServer}. */
export interface StartMcpServerOptions {
  /** The MCP transport to connect on (stdio for the bin; in-memory for tests). */
  transport: Transport;
  /** Override the daemon socket path (defaults to the platform paths shim). */
  socketPath?: string;
  /** Inject a pre-connected client (used in tests). Skips socket connection. */
  client?: PerchClient;
}

/**
 * Build and connect the Perch MCP server.
 *
 * Connects to `perchd` (unless a `client` is injected), registers the
 * MCP-opted-in capabilities as tools, wires live reload, and connects the MCP
 * server to the supplied transport.
 *
 * Rejects with {@link DaemonUnavailableError} when the daemon is not running.
 */
export async function startMcpServer(options: StartMcpServerOptions): Promise<PerchMcpServer> {
  const socket = options.socketPath ?? defaultSocketPath();
  const client = options.client ?? (await PerchClient.connect(socket));

  const server = new Server(SERVER_INFO, { capabilities: { tools: { listChanged: true } } });

  // Authoritative tool set, refreshed from `registry.list`. Keyed by tool name
  // so `tools/call` can map back to the capability id (and reject hidden ones).
  let toolsByName = new Map<string, CapabilityMeta>();

  const refreshTools = async (): Promise<void> => {
    const caps = mcpCapabilities(await client.registryList());
    toolsByName = new Map(caps.map((cap) => [toToolName(cap.id), cap]));
  };

  await refreshTools();

  // Re-query on every list so a client that re-lists always sees current tools,
  // even if it missed (or doesn't honor) the list_changed notification.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await refreshTools();
    return { tools: [...toolsByName.values()].map(toToolDescriptor) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const cap = toolsByName.get(name);
    if (!cap) {
      // Unknown or no-longer-exposed tool: surface as a tool error, not a crash.
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      // Forward the arguments object straight through; the daemon validates it
      // against the capability's real input schema.
      const result = await client.invoke({ id: cap.id, input: args });
      // Actions declare no output; JSON-RPC serializes their void result as null.
      const text = cap.kind === "action" && result == null ? "ok" : JSON.stringify(result, null, 2);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `${cap.id}: ${errorMessage(err)}` }],
        isError: true,
      };
    }
  });

  // Live tool list: when the daemon hot-reloads config, re-query and tell the
  // client the tool set changed. (Each `tools/list` also re-queries, so this is
  // belt-and-suspenders for clients that cache.)
  const reloadSub = client.onRegistryChanged(() => {
    void refreshTools().then(() => server.sendToolListChanged());
  });

  await server.connect(options.transport);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    reloadSub.dispose();
    await server.close();
    // Only close the client we own; an injected client is the caller's to close.
    if (options.client === undefined) client.close();
  };

  return { server, close };
}

export { DaemonUnavailableError };

/** Best-effort extraction of a human-readable message from an RPC error. */
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
