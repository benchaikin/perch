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
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type CapabilityContext } from "@perch/sdk";

import plugin, {
  __setLogsSpawn,
  __setProviderSpawn,
  resolveComposeFile,
  serviceLogsTitle,
} from "./index.js";
import { generatedComposePath, type SyncComposeResult } from "./compose.js";
import { type ServiceList } from "./services.js";

/** One request the fake process-compose server saw. */
interface SeenRequest {
  method: string;
  url: string;
}

/** A process the fake server reports: a bare name (→ Running) or name + status. */
type ProcSpec = string | { name: string; status: string };

/**
 * Start a fake process-compose server. `procs` is the `data` array
 * `GET /processes` returns (bare strings default to `Running`); every other
 * request 200s. Resolves with its base `address`, the recorded requests, and a
 * `close`.
 */
async function fakeServer(
  procs: ProcSpec[] = [],
): Promise<{ address: string; seen: SeenRequest[]; close: () => Promise<void> }> {
  const data = procs.map((p) => (typeof p === "string" ? { name: p, status: "Running" } : p));
  const seen: SeenRequest[] = [];
  const server: Server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "" });
    if (req.url === "/processes") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data }));
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

test("services.stopAll stops every running service via PATCH /process/stop/{name}", async () => {
  const cap = plugin.capabilities.stopAll!;
  assert.equal(cap.kind, "action");
  assert.equal(cap.expose?.mcp, true);

  const server = await fakeServer(["api", "db"]); // both Running
  try {
    const result = (await cap.run({ input: {}, ctx: ctx(server.address) })) as {
      ok: boolean;
      message: string;
    };
    assert.equal(result.ok, true);
    assert.match(result.message, /Stopped 2\/2 services/);
    assert.deepEqual(
      server.seen
        .filter((r) => r.method === "PATCH")
        .map((r) => r.url)
        .sort(),
      ["/process/stop/api", "/process/stop/db"],
    );
  } finally {
    await server.close();
  }
});

test("services.stopAll scoped to a project only stops that repo's procs", async () => {
  // `api` belongs to repo `ashby`, `ui` to `web` (explicit `proc.repo`). A scoped
  // stopAll targets only the named project's live procs; the others are untouched.
  const server = await fakeServer(["api", "ui"]); // both Running
  try {
    const result = (await plugin.capabilities.stopAll!.run({
      input: { project: "ashby" },
      ctx: {
        config: {
          address: server.address,
          procs: [
            { name: "api", command: "run-api", repo: "ashby" },
            { name: "ui", command: "run-ui", repo: "web" },
          ],
        },
        log: () => {},
      },
    })) as { ok: boolean; message: string };
    assert.equal(result.ok, true);
    assert.match(result.message, /Stopped 1\/1 service\b/);
    // Only ashby's `api` is stopped; web's `ui` is left running.
    assert.deepEqual(
      server.seen.filter((r) => r.method === "PATCH").map((r) => r.url),
      ["/process/stop/api"],
    );
  } finally {
    await server.close();
  }
});

test("services.startAll starts only the not-running services when the server is up", async () => {
  const server = await fakeServer([
    { name: "api", status: "Running" },
    { name: "db", status: "Stopped" },
  ]);
  try {
    const result = (await plugin.capabilities.startAll!.run({
      input: {},
      ctx: ctx(server.address),
    })) as { ok: boolean; message: string };
    assert.equal(result.ok, true);
    assert.match(result.message, /Started 1\/1 service\b/);
    // Only the stopped `db` is started; the running `api` is left alone.
    assert.deepEqual(
      server.seen.filter((r) => r.method === "POST").map((r) => r.url),
      ["/process/start/db"],
    );
  } finally {
    await server.close();
  }
});

test("services.startAll is a no-op success when everything is already running", async () => {
  const server = await fakeServer(["api", "db"]); // both Running
  try {
    const result = (await plugin.capabilities.startAll!.run({
      input: {},
      ctx: ctx(server.address),
    })) as { ok: boolean; message: string };
    assert.equal(result.ok, true);
    assert.match(result.message, /already running/);
    assert.equal(
      server.seen.filter((r) => r.method === "POST").length,
      0,
      "nothing started when all are running",
    );
  } finally {
    await server.close();
  }
});

test("services.startAll brings process-compose up when the server is down", async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  __setProviderSpawn(((command: string, args: readonly string[]) => {
    calls.push({ command, args });
    return { on: () => {}, unref: () => {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
  try {
    const result = (await plugin.capabilities.startAll!.run({
      input: {},
      ctx: ctx("http://127.0.0.1:1"), // nothing listening → processes() undefined
    })) as { ok: boolean; message: string };
    assert.equal(result.ok, true);
    assert.match(result.message, /Starting services/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, "process-compose");
    assert.deepEqual([...calls[0]!.args].slice(0, 2), ["up", "-D"]);
  } finally {
    __setProviderSpawn(undefined);
  }
});

test("services.stopAll is a no-op success when the server is down", async () => {
  const result = (await plugin.capabilities.stopAll!.run({
    input: {},
    ctx: ctx("http://127.0.0.1:1"),
  })) as { ok: boolean; message: string };
  assert.equal(result.ok, true);
  assert.match(result.message, /not running/);
});

test("services.list tags rows with their repo and surfaces the configured projects[]", async () => {
  const server = await fakeServer(["api"]); // `api` is live (Running)
  // Sandbox HOME so the generated-compose write the list read triggers can't
  // touch the real config dir (it lands under a throwaway tmp tree instead).
  const prevHome = process.env.HOME;
  const sandbox = mkdtempSync(join(tmpdir(), "perch-services-"));
  process.env.HOME = sandbox;
  try {
    const ashby = join(sandbox, "ashby");
    const web = join(sandbox, "web");
    const result = (await plugin.capabilities.list!.run({
      input: {},
      ctx: {
        config: {
          address: server.address,
          procs: [
            // `api` infers its repo from cwd; `worker` (absent → stopped) pins it explicitly.
            { name: "api", command: "run", cwd: join(ashby, "services") },
            { name: "worker", command: "run", repo: "web" },
          ],
        },
        global: { repos: [ashby, web] },
        log: () => {},
      },
    })) as ServiceList;
    assert.deepEqual(
      result.services.map((s) => [s.name, s.status, s.project]),
      [
        ["api", "running", "ashby"],
        ["worker", "stopped", "web"],
      ],
    );
    // Every configured repo surfaces (config order), so empty repos get a header.
    assert.deepEqual(result.projects, ["ashby", "web"]);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await server.close();
  }
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
    // The global terminal setting (here a Custom template) drives the launcher.
    const result = cap.run({
      input: { name: "api" },
      ctx: {
        config: { socket: "/tmp/pc.sock" },
        global: { terminal: { logTerminal: "OPEN {cmd}" } },
        log: () => {},
      },
    }) as { ok: boolean; message: string };
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, "sh");
    // The launcher interpolates a quote-free `sh <script>`; the inner logs
    // command lives in the temp script (read it back to confirm).
    const launched = calls[0]!.args[1] as string;
    const m = /OPEN sh (\/\S+\.sh)/.exec(launched);
    assert.ok(m, `expected 'OPEN sh <script>', got: ${launched}`);
    assert.match(
      readFileSync(m[1]!, "utf8"),
      /process-compose process logs 'api' -f --use-uds --unix-socket '\/tmp\/pc\.sock'/,
    );
  } finally {
    __setLogsSpawn(undefined);
  }
});

test("services.logs sets the terminal title to the service name", () => {
  const calls: Array<{ args: readonly string[] }> = [];
  __setLogsSpawn(((_command: string, args: readonly string[]) => {
    calls.push({ args });
    return { on: () => {}, unref: () => {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
  try {
    const result = plugin.capabilities.logs!.run({
      input: { name: "api" },
      // A known terminal app (not a custom template) emits the title escape.
      ctx: {
        config: { socket: "/tmp/pc.sock" },
        global: { terminal: { terminalApp: "Terminal" } },
        log: () => {},
      },
    }) as { ok: boolean };
    assert.equal(result.ok, true);
    const launched = calls[0]!.args[1] as string;
    const m = /sh (\/\S+\.sh)/.exec(launched);
    assert.ok(m, `expected an 'sh <script>' launch, got: ${launched}`);
    // The OSC 0 title escape carries the `<name> logs` title for the service.
    assert.match(readFileSync(m[1]!, "utf8"), /printf '\\033\]0;%s\\007' 'api logs'/);
  } finally {
    __setLogsSpawn(undefined);
  }
});

test("serviceLogsTitle suffixes the service name and trims long names", () => {
  assert.equal(serviceLogsTitle("api"), "api logs");
  assert.equal(serviceLogsTitle("  api  "), "api logs");
  assert.equal(serviceLogsTitle(""), "logs");
  const long = "x".repeat(50);
  const title = serviceLogsTitle(long);
  assert.ok(title.endsWith(" logs"));
  // With name-first, the ellipsis lands mid-string on the trimmed name portion.
  const name = title.slice(0, -" logs".length);
  assert.ok(name.endsWith("…"));
  assert.equal(title.length, 40 + " logs".length);
});

test("services.logs falls back to the legacy per-services terminal when no global is set", () => {
  const calls: Array<{ args: readonly string[] }> = [];
  __setLogsSpawn(((_command: string, args: readonly string[]) => {
    calls.push({ args });
    return { on: () => {}, unref: () => {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
  try {
    const result = plugin.capabilities.logs!.run({
      input: { name: "db" },
      // No ctx.global → honor the legacy plugins.services.logTerminal.
      ctx: { config: { socket: "/s.sock", logTerminal: "LEGACY {cmd}" }, log: () => {} },
    }) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.match(calls[0]!.args[1] as string, /^LEGACY sh \/\S+\.sh$/);
  } finally {
    __setLogsSpawn(undefined);
  }
});
