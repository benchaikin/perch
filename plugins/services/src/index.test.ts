/**
 * Action-capability tests for the services plugin (Dev services M2).
 *
 * Each `services.<action>` builds a real {@link ServicesProvider} from `ctx`, so
 * there's no `FetchJson` seam to inject through the capability. Instead we stand
 * up a tiny in-process HTTP server, point the capability at it via the `address`
 * config, and assert on the requests it receives — exercising the full path
 * including `defaultFetchJson`. (The endpoint/method-per-kind unit coverage with
 * an injected `FetchJson` lives in `provider.test.ts`.)
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { test } from "node:test";

import { type CapabilityContext } from "@perch/sdk";

import plugin, { __setLogsSpawn, resolveComposeFile } from "./index.js";
import { generatedComposePath, type SyncComposeResult } from "./compose.js";

/** One request the fake process-compose server saw. */
interface SeenRequest {
  method: string;
  url: string;
}

/**
 * Start a fake process-compose server. `processNames` is the `data` array
 * `GET /processes` returns; every other request 200s. Resolves with its base
 * `address`, the recorded requests, and a `close`.
 */
async function fakeServer(
  processNames: string[] = [],
): Promise<{ address: string; seen: SeenRequest[]; close: () => Promise<void> }> {
  const seen: SeenRequest[] = [];
  const server: Server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "" });
    if (req.url === "/processes") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: processNames.map((name) => ({ name, status: "Running" })) }));
      return;
    }
    res.writeHead(200);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    address: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A `CapabilityContext` pointing the provider at the fake server. */
function ctx(address: string): CapabilityContext {
  return { config: { address }, log: () => {} };
}

for (const [id, kind, method] of [
  ["restart", "restart", "POST"],
  ["start", "start", "POST"],
  ["stop", "stop", "PATCH"], // process-compose stop is PATCH, not POST
] as const) {
  test(`services.${id} is an MCP-exposed action hitting ${method} /process/${kind}/{name}`, async () => {
    const cap = plugin.capabilities[id]!;
    assert.equal(cap.kind, "action");
    assert.equal(cap.expose?.mcp, true);

    const server = await fakeServer();
    try {
      const result = (await cap.run({ input: { name: "api" }, ctx: ctx(server.address) })) as {
        ok: boolean;
        message: string;
      };
      assert.equal(result.ok, true);
      assert.deepEqual(server.seen, [{ method, url: `/process/${kind}/api` }]);
    } finally {
      await server.close();
    }
  });
}

test("a single action returns ok:false when the server rejects (non-2xx)", async () => {
  const server: Server = createServer((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const result = (await plugin.capabilities.restart!.run({
      input: { name: "api" },
      ctx: ctx(`http://127.0.0.1:${port}`),
    })) as { ok: boolean; message: string };
    assert.equal(result.ok, false);
    assert.match(result.message, /Failed to restart api/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("services.restartAll enumerates processes and restarts each", async () => {
  const cap = plugin.capabilities.restartAll!;
  assert.equal(cap.kind, "action");
  assert.equal(cap.expose?.mcp, true);

  const server = await fakeServer(["api", "db"]);
  try {
    const result = (await cap.run({ input: {}, ctx: ctx(server.address) })) as {
      ok: boolean;
      message: string;
    };
    assert.equal(result.ok, true);
    assert.match(result.message, /Restarted 2\/2 services/);
    // One enumeration + one restart per process.
    assert.deepEqual(
      server.seen
        .filter((r) => r.method === "POST")
        .map((r) => r.url)
        .sort(),
      ["/process/restart/api", "/process/restart/db"],
    );
    assert.ok(server.seen.some((r) => r.url === "/processes"));
  } finally {
    await server.close();
  }
});

test("services.restartAll reports unreachable when the server is down", async () => {
  // An address that nothing is listening on → processes() is undefined.
  const result = (await plugin.capabilities.restartAll!.run({
    input: {},
    ctx: ctx("http://127.0.0.1:1"),
  })) as { ok: boolean; message: string };
  assert.equal(result.ok, false);
  assert.match(result.message, /unreachable/);
});

test("resolveComposeFile: procs (non-empty) take precedence over composeFile", () => {
  const calls: Array<{ procs: unknown }> = [];
  const fakeSync = ((procs: unknown): SyncComposeResult => {
    calls.push({ procs });
    return { path: generatedComposePath(), content: "", changed: false };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  const file = resolveComposeFile(
    { composeFile: "/user/process-compose.yaml", procs: [{ name: "api", command: "run" }] },
    () => {},
    fakeSync,
  );
  // The generated file is targeted, NOT the user's composeFile.
  assert.equal(file, generatedComposePath());
  assert.equal(calls.length, 1);
});

test("resolveComposeFile: falls back to composeFile when procs is unset/empty", () => {
  const neverSync = (() => assert.fail("must not generate when procs is unset")) as never;
  assert.equal(
    resolveComposeFile({ composeFile: "/user/pc.yaml" }, () => {}, neverSync),
    "/user/pc.yaml",
  );
  assert.equal(
    resolveComposeFile({ composeFile: "/user/pc.yaml", procs: [] }, () => {}, neverSync),
    "/user/pc.yaml",
  );
});

test("services.logs is a CLI-only action that spawns the templated logs command", () => {
  const cap = plugin.capabilities.logs!;
  assert.equal(cap.kind, "action");
  // CLI-on by default, MCP-off (interactive, fire-and-forget terminal launch).
  assert.notEqual(cap.expose?.mcp, true);

  const calls: Array<{ command: string; args: readonly string[] }> = [];
  __setLogsSpawn(((command: string, args: readonly string[]) => {
    calls.push({ command, args });
    return { on: () => {}, unref: () => {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
  try {
    const result = cap.run({
      input: { name: "api" },
      ctx: { config: { socket: "/tmp/pc.sock", logTerminal: "OPEN {cmd}" }, log: () => {} },
    }) as { ok: boolean; message: string };
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, "sh");
    assert.deepEqual(calls[0]!.args, [
      "-c",
      "OPEN process-compose process logs 'api' -f --use-uds --unix-socket '/tmp/pc.sock'",
    ]);
  } finally {
    __setLogsSpawn(undefined);
  }
});
