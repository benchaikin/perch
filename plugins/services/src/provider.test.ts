import assert from "node:assert/strict";
import { test } from "node:test";

import { buildServiceList } from "./services.js";
import { ServicesProvider, type FetchJson } from "./provider.js";

/** A FetchJson that records its calls and returns canned responses per path. */
function stubFetch(
  responses: Partial<Record<string, { status: number; body: unknown } | "throw">>,
): { fetchJson: FetchJson; calls: Array<{ method: string; path: string; socket?: string }> } {
  const calls: Array<{ method: string; path: string; socket?: string }> = [];
  const fetchJson: FetchJson = async ({ target, method, path }) => {
    calls.push({ method, path, socket: target.socket });
    const res = responses[path];
    if (res === "throw") throw new Error("ECONNREFUSED");
    if (!res) return { status: 404, body: undefined };
    return res;
  };
  return { fetchJson, calls };
}

test("processes(): parses the `data` array from a 200 response", async () => {
  const { fetchJson } = stubFetch({
    "/processes": {
      status: 200,
      body: { data: [{ name: "api", status: "Running", pid: 7 }] },
    },
  });
  const provider = new ServicesProvider({ socket: "/tmp/pc.sock", fetchJson });
  const result = buildServiceList(await provider.processes());
  assert.equal(result.available, true);
  assert.equal(result.services[0]!.name, "api");
  assert.equal(result.services[0]!.status, "running");
});

test("processes(): a transport error → undefined → available:false", async () => {
  const { fetchJson } = stubFetch({ "/processes": "throw" });
  const provider = new ServicesProvider({ address: "http://localhost:8080", fetchJson });
  const result = buildServiceList(await provider.processes());
  assert.deepEqual(result, { services: [], available: false });
});

test("processes(): a non-2xx response → undefined → available:false", async () => {
  const { fetchJson } = stubFetch({ "/processes": { status: 503, body: undefined } });
  const provider = new ServicesProvider({ fetchJson });
  assert.equal(await provider.processes(), undefined);
});

test("prefers the unix socket target when `socket` is set", async () => {
  const { fetchJson, calls } = stubFetch({
    "/processes": { status: 200, body: { data: [] } },
  });
  const provider = new ServicesProvider({
    socket: "/tmp/pc.sock",
    address: "http://localhost:9999",
    fetchJson,
  });
  await provider.processes();
  assert.equal(calls[0]!.socket, "/tmp/pc.sock");
});

test("health(): true on 2xx, false on non-2xx, false on throw", async () => {
  const up = new ServicesProvider({
    fetchJson: stubFetch({ "/live": { status: 200, body: undefined } }).fetchJson,
  });
  assert.equal(await up.health(), true);

  const down = new ServicesProvider({
    fetchJson: stubFetch({ "/live": { status: 503, body: undefined } }).fetchJson,
  });
  assert.equal(await down.health(), false);

  const gone = new ServicesProvider({
    fetchJson: stubFetch({ "/live": "throw" }).fetchJson,
  });
  assert.equal(await gone.health(), false);
});

test("autostart: spawns `process-compose up -D` at most once when unreachable", async () => {
  const { fetchJson } = stubFetch({ "/processes": "throw" });
  const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
  const fakeSpawn = ((cmd: string, args: string[]) => {
    spawnCalls.push({ cmd, args });
    return { on() {}, unref() {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  const provider = new ServicesProvider({
    socket: "/tmp/pc.sock",
    composeFile: "/tmp/process-compose.yaml",
    autostart: true,
    fetchJson,
    spawn: fakeSpawn,
  });

  await provider.processes();
  await provider.processes();

  assert.equal(spawnCalls.length, 1, "autostart attempted at most once");
  assert.equal(spawnCalls[0]!.cmd, "process-compose");
  assert.deepEqual(spawnCalls[0]!.args.slice(0, 2), ["up", "-D"]);
  assert.ok(spawnCalls[0]!.args.includes("/tmp/process-compose.yaml"));
});

test("autostart: a spawn that throws never escapes the read", async () => {
  const { fetchJson } = stubFetch({ "/processes": "throw" });
  const throwingSpawn = (() => {
    throw new Error("process-compose: command not found");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  const provider = new ServicesProvider({
    autostart: true,
    fetchJson,
    spawn: throwingSpawn,
  });
  // Must resolve to undefined, not reject.
  assert.equal(await provider.processes(), undefined);
});
