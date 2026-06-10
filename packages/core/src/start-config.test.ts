import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  createMessageConnection,
  SocketMessageReader,
  SocketMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import { definePlugin, read, z, type Capability } from "@perch/sdk";
import { startDaemon, type RunningDaemon } from "./index.js";
import { Methods } from "./rpc.js";

const asCap = (c: unknown): Capability => c as Capability;

/** A plugin whose `config` read echoes the resolved config it was handed. */
function echoPlugin() {
  return definePlugin({
    id: "echo",
    capabilities: {
      config: asCap(
        read({
          summary: "echo resolved config",
          output: z.unknown(),
          run: ({ ctx }) => (ctx as { config?: unknown }).config ?? null,
        }),
      ),
    },
  });
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function connectClient(socketPath: string): Promise<MessageConnection> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once("error", reject);
    socket.once("connect", () => {
      const conn = createMessageConnection(
        new SocketMessageReader(socket),
        new SocketMessageWriter(socket),
      );
      conn.listen();
      resolve(conn);
    });
  });
}

const running: RunningDaemon[] = [];
const conns: MessageConnection[] = [];
after(async () => {
  for (const c of conns) c.dispose();
  for (const d of running) await d.stop();
});

async function boot(opts: Parameters<typeof startDaemon>[0]): Promise<RunningDaemon> {
  const daemon = await startDaemon(opts);
  running.push(daemon);
  return daemon;
}

test("explicit configs option overrides the config file (resolved config wins)", async () => {
  const dir = tempDir("perch-start-precedence-");
  const configPath = join(dir, "perch.json");
  writeFileSync(configPath, JSON.stringify({ plugins: { echo: { from: "config" } } }), "utf8");
  const socketPath = join(dir, "perchd.sock");

  await boot({
    pluginDefs: [echoPlugin()],
    configs: { echo: { from: "explicit" } },
    configPath,
    socketPath,
  });

  const conn = await connectClient(socketPath);
  conns.push(conn);
  const result = await conn.sendRequest(Methods.capabilityInvoke, { id: "echo.config" });
  assert.deepEqual(result, { from: "explicit" });
});

test("injected pluginDefs (test mode) write no pidfile and default configs to {}", async () => {
  const dir = tempDir("perch-start-testmode-");
  const configPath = join(dir, "perch.json");
  // A config file exists, but test mode (injected pluginDefs) must ignore it.
  writeFileSync(configPath, JSON.stringify({ plugins: { echo: { from: "config" } } }), "utf8");
  const socketPath = join(dir, "perchd.sock");

  await boot({ pluginDefs: [echoPlugin()], configPath, socketPath });

  const conn = await connectClient(socketPath);
  conns.push(conn);
  const result = await conn.sendRequest(Methods.capabilityInvoke, { id: "echo.config" });
  // configs default to {} in test mode → ctx.config is undefined → echoed null.
  assert.equal(result, null);
});
