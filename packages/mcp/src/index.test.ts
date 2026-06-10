import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { after, test } from "node:test";
import { definePlugin, read, action, z, type Capability } from "@perch/sdk";
import { startDaemon, type CapabilityMeta, type RunningDaemon } from "@perch/core";
import { PerchClient } from "@perch/cli";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  isMcpExposed,
  mcpCapabilities,
  startMcpServer,
  toToolDescriptor,
  toToolName,
} from "./index.js";

// The M0 SDK skeleton needs a cast to widen a concrete capability to
// `Capability` (see core's registry.test.ts).
const asCap = (c: unknown): Capability => c as Capability;

function meta(partial: Partial<CapabilityMeta> & Pick<CapabilityMeta, "id">): CapabilityMeta {
  return {
    pluginId: partial.id.split(".")[0] ?? "p",
    name: partial.id.split(".")[1] ?? "c",
    kind: "read",
    summary: "s",
    hasInput: false,
    hasOutput: false,
    expose: { cli: true, gui: false, mcp: false },
    ...partial,
  };
}

test("toToolName maps dots to underscores", () => {
  assert.equal(toToolName("stack.view"), "stack_view");
  assert.equal(toToolName("demo.echo"), "demo_echo");
});

test("isMcpExposed / mcpCapabilities filter by expose.mcp", () => {
  const on = meta({ id: "a.on", expose: { cli: true, gui: false, mcp: true } });
  const off = meta({ id: "a.off", expose: { cli: true, gui: false, mcp: false } });
  assert.equal(isMcpExposed(on), true);
  assert.equal(isMcpExposed(off), false);
  assert.deepEqual(
    mcpCapabilities([on, off]).map((c) => c.id),
    ["a.on"],
  );
});

test("toToolDescriptor uses id→name, summary, and a permissive input schema", () => {
  const d = toToolDescriptor(meta({ id: "stack.view", summary: "the stack" }));
  assert.equal(d.name, "stack_view");
  assert.equal(d.description, "the stack");
  assert.equal(d.inputSchema.type, "object");
  assert.equal(d.inputSchema.additionalProperties, true);
});

// Integration: a real daemon with one MCP-opted-in read and one action, plus a
// non-MCP read that must NOT surface; an MCP client over the in-memory transport
// lists and calls the tools and asserts the proxied results.
const fixture = definePlugin({
  id: "demo",
  capabilities: {
    echo: asCap(
      read({
        summary: "echo input back, doubled",
        input: z.object({ n: z.number() }),
        output: z.object({ doubled: z.number() }),
        expose: { mcp: true },
        run: ({ input }) => ({ doubled: input.n * 2 }),
      }),
    ),
    ping: asCap(
      action({
        summary: "an action with no output",
        expose: { mcp: true },
        run: () => {},
      }),
    ),
    secret: asCap(
      read({
        summary: "not exposed to MCP",
        run: () => ({ hidden: true }),
      }),
    ),
  },
});

function tempSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "perch-mcp-test-"));
  return join(dir, "perchd.sock");
}

test("integration: MCP client lists and calls proxied capabilities", async () => {
  const socketPath = tempSocketPath();
  const daemon: RunningDaemon = await startDaemon({ pluginDefs: [fixture], socketPath });
  const perch = await PerchClient.connect(socketPath);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = await startMcpServer({ transport: serverTransport, client: perch });

  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  after(async () => {
    await client.close();
    await mcp.close();
    perch.close();
    await daemon.stop();
  });

  // tools/list reflects only the MCP-opted-in capabilities.
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["demo_echo", "demo_ping"]);
  const echoTool = tools.find((t) => t.name === "demo_echo");
  assert.equal(echoTool?.description, "echo input back, doubled");

  // tools/call on a read forwards input and returns JSON text content.
  const readResult = await client.callTool({ name: "demo_echo", arguments: { n: 21 } });
  const readContent = readResult.content as Array<{ type: string; text: string }>;
  assert.equal(readContent[0]?.type, "text");
  assert.deepEqual(JSON.parse(readContent[0]!.text), { doubled: 42 });

  // tools/call on an action returns "ok".
  const actionResult = await client.callTool({ name: "demo_ping", arguments: {} });
  const actionContent = actionResult.content as Array<{ type: string; text: string }>;
  assert.equal(actionContent[0]?.text, "ok");

  // Invalid input is rejected by the daemon's schema and surfaced as a tool error.
  const bad = await client.callTool({ name: "demo_echo", arguments: { n: "no" } });
  assert.equal(bad.isError, true);
});
