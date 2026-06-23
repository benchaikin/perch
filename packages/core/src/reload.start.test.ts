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
import { definePlugin, read, z, type Capability, type PluginDef } from "@perch/sdk";
import { startDaemon, type RunningDaemon } from "./index.js";
import { Methods, Notifications, type RegistryChangedNotification } from "./rpc.js";

const asCap = (c: unknown): Capability => c as Capability;

function plugin(id: string): PluginDef {
  return definePlugin({
    id,
    capabilities: {
      view: asCap(
        read({
          summary: "view",
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

/** Injectable loader: serve test plugins by id. */
const loadPlugins = async (ids: string[]): Promise<PluginDef[]> => ids.map((id) => plugin(id));

test("reload() applies a config change and pushes registry.changed to clients", async () => {
  const dir = tempDir("perch-reload-notify-");
  const configPath = join(dir, "perch.yaml");
  const socketPath = join(dir, "perchd.sock");
  writeFileSync(configPath, JSON.stringify({ plugins: { a: {} } }), "utf8");

  const daemon = await boot({
    pluginDefs: [plugin("a")],
    configs: { a: {} },
    configPath,
    socketPath,
    watch: false, // deterministic: drive reload() by hand
    loadPlugins,
  });

  const conn = await connectClient(socketPath);
  conns.push(conn);

  const received: RegistryChangedNotification[] = [];
  conn.onNotification(Notifications.registryChanged, (p: RegistryChangedNotification) => {
    received.push(p);
  });

  // Before: only plugin a is present.
  let list = (await conn.sendRequest(Methods.registryList, {})) as Array<{ pluginId: string }>;
  assert.deepEqual([...new Set(list.map((c) => c.pluginId))].sort(), ["a"]);

  // Enable b, disable a.
  writeFileSync(configPath, JSON.stringify({ plugins: { b: {} } }), "utf8");
  await daemon.reload();

  // Allow the notification to flush over the socket.
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(received.length, 1, "exactly one registry.changed");
  assert.deepEqual(received[0], { added: ["b"], removed: ["a"], updated: [] });

  list = (await conn.sendRequest(Methods.registryList, {})) as Array<{ pluginId: string }>;
  assert.deepEqual([...new Set(list.map((c) => c.pluginId))].sort(), ["b"]);
});

test("reload() with invalid config keeps the current state and fires no notification", async () => {
  const dir = tempDir("perch-reload-invalid-");
  const configPath = join(dir, "perch.yaml");
  const socketPath = join(dir, "perchd.sock");
  writeFileSync(configPath, JSON.stringify({ plugins: { a: {} } }), "utf8");

  const daemon = await boot({
    pluginDefs: [plugin("a")],
    configs: { a: {} },
    configPath,
    socketPath,
    watch: false,
    loadPlugins,
  });

  const conn = await connectClient(socketPath);
  conns.push(conn);
  let notified = 0;
  conn.onNotification(Notifications.registryChanged, () => {
    notified += 1;
  });

  // Garbage JSON: reload must be a no-op (current config preserved).
  writeFileSync(configPath, "{ not valid json", "utf8");
  await daemon.reload();
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(notified, 0, "no registry.changed on invalid config");
  const list = (await conn.sendRequest(Methods.registryList, {})) as Array<{ pluginId: string }>;
  assert.deepEqual([...new Set(list.map((c) => c.pluginId))].sort(), ["a"], "state preserved");
});

test("real fs watcher: editing perch.yaml triggers a reload notification", async () => {
  const dir = tempDir("perch-reload-watch-");
  const configPath = join(dir, "perch.yaml");
  const socketPath = join(dir, "perchd.sock");
  writeFileSync(configPath, JSON.stringify({ plugins: { a: {} } }), "utf8");

  await boot({
    pluginDefs: [plugin("a")],
    configs: { a: {} },
    configPath,
    socketPath,
    watch: true, // exercise the real ConfigWatcher
    reloadDebounceMs: 60,
    loadPlugins,
  });

  const conn = await connectClient(socketPath);
  conns.push(conn);
  const changed = new Promise<RegistryChangedNotification>((resolve) => {
    conn.onNotification(Notifications.registryChanged, (p: RegistryChangedNotification) =>
      resolve(p),
    );
  });

  // Mutate the file; the watcher should debounce and reload.
  writeFileSync(configPath, JSON.stringify({ plugins: { a: {}, b: {} } }), "utf8");

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("watcher did not fire within timeout")), 5000),
  );
  const payload = await Promise.race([changed, timeout]);
  assert.deepEqual(payload.added, ["b"]);
});
