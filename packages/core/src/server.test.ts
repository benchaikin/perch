import assert from "node:assert/strict";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { after, test } from "node:test";
import {
  createMessageConnection,
  SocketMessageReader,
  SocketMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import { definePlugin, read, action, z, type Capability } from "@perch/sdk";
import { startDaemon, type RunningDaemon } from "./index.js";
import { Methods, Notifications, type UpdateNotification } from "./rpc.js";

function tempSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "perchd-test-"));
  return join(dir, "perchd.sock");
}

/** Open a real vscode-jsonrpc client connection to the daemon's socket. */
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

// See registry.test.ts: the M0 SDK skeleton needs a cast to widen a concrete
// capability to `Capability`. (M2 fleshes out the SDK.)
const asCap = (c: unknown): Capability => c as Capability;

const demo = definePlugin({
  id: "demo",
  capabilities: {
    echo: asCap(
      read({
        summary: "echo input back, doubled",
        input: z.object({ n: z.number() }),
        output: z.object({ doubled: z.number() }),
        refresh: { every: "60s" },
        run: ({ input }) => ({ doubled: input.n * 2 }),
      }),
    ),
    noop: asCap(
      action({
        summary: "does nothing",
        run: () => {},
      }),
    ),
  },
});

test("integration: registry.list, capability.invoke, subscribe over a real socket", async (t) => {
  const socketPath = tempSocketPath();
  const daemon: RunningDaemon = await startDaemon({ pluginDefs: [demo], socketPath });
  const client: MessageConnection = await connectClient(socketPath);

  after(async () => {
    client.dispose();
    await daemon.stop();
  });

  assert.equal(daemon.socketPath, socketPath);

  await t.test("registry.list returns capability metadata", async () => {
    const list = (await client.sendRequest(Methods.registryList)) as Array<{
      id: string;
      kind: string;
      hasInput: boolean;
    }>;
    const ids = list.map((m) => m.id).sort();
    assert.deepEqual(ids, ["demo.echo", "demo.noop"]);
    const echo = list.find((m) => m.id === "demo.echo");
    assert.equal(echo?.kind, "read");
    assert.equal(echo?.hasInput, true);
  });

  await t.test("capability.invoke validates input and returns output", async () => {
    const result = (await client.sendRequest(Methods.capabilityInvoke, {
      id: "demo.echo",
      input: { n: 21 },
    })) as { doubled: number };
    assert.deepEqual(result, { doubled: 42 });
  });

  await t.test("capability.invoke rejects invalid input via schema", async () => {
    await assert.rejects(
      client.sendRequest(Methods.capabilityInvoke, { id: "demo.echo", input: { n: "no" } }),
    );
  });

  await t.test("capability.subscribe returns current value and emits updates", async () => {
    const updates: UpdateNotification[] = [];
    client.onNotification(Notifications.capabilityUpdate, (n: UpdateNotification) => {
      updates.push(n);
    });

    const sub = (await client.sendRequest(Methods.capabilitySubscribe, {
      id: "demo.echo",
      input: { n: 5 },
    })) as { id: string; inputKey: string; current: { doubled: number } };

    assert.equal(sub.id, "demo.echo");
    assert.deepEqual(sub.current, { doubled: 10 });

    // The initial fetch emits one update synchronously over the bus.
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(updates.some((u) => u.id === "demo.echo"));

    await client.sendRequest(Methods.capabilityUnsubscribe, { id: "demo.echo", input: { n: 5 } });
  });
});
