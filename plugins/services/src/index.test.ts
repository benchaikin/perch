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

import plugin from "./index.js";

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

for (const [id, kind] of [
  ["restart", "restart"],
  ["start", "start"],
  ["stop", "stop"],
] as const) {
  test(`services.${id} is an MCP-exposed action hitting POST /process/${kind}/{name}`, async () => {
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
      assert.deepEqual(server.seen, [{ method: "POST", url: `/process/${kind}/api` }]);
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
