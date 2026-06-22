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

test("integration: a successful action pokes the reads it invalidates", async () => {
  // `counter` returns an increasing value, so any re-poll produces a fresh,
  // distinguishable update. Its interval is long enough never to fire during the
  // test, so a second update can only come from the action's `invalidates` poke.
  let counter = 0;
  const poking = definePlugin({
    id: "poking",
    capabilities: {
      counter: asCap(
        read({
          summary: "increasing counter",
          output: z.object({ n: z.number() }),
          refresh: { every: "1h" },
          run: () => ({ n: ++counter }),
        }),
      ),
      bump: asCap(
        action({
          summary: "bump the counter read",
          invalidates: ["poking.counter"],
          run: () => ({ ok: true }),
        }),
      ),
    },
  });

  const socketPath = tempSocketPath();
  const daemon: RunningDaemon = await startDaemon({ pluginDefs: [poking], socketPath });
  const client: MessageConnection = await connectClient(socketPath);

  after(async () => {
    client.dispose();
    await daemon.stop();
  });

  const updates: UpdateNotification[] = [];
  client.onNotification(Notifications.capabilityUpdate, (n: UpdateNotification) => {
    updates.push(n);
  });

  const sub = (await client.sendRequest(Methods.capabilitySubscribe, {
    id: "poking.counter",
  })) as { current: { n: number } };
  assert.deepEqual(sub.current, { n: 1 });

  // Invoking the action should poke `poking.counter`, producing a fresh update.
  await client.sendRequest(Methods.capabilityInvoke, { id: "poking.bump" });

  await waitFor(() => updates.some((u) => (u.data as { n: number }).n >= 2));
  assert.ok(
    updates.some((u) => u.id === "poking.counter" && (u.data as { n: number }).n >= 2),
    "the action's invalidates poked the counter read",
  );

  await client.sendRequest(Methods.capabilityUnsubscribe, { id: "poking.counter" });
});

/** Wait until `predicate` holds or `timeoutMs` elapses; resolves either way. */
async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5));
  }
}
