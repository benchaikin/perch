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
import { definePlugin, read, z, type Capability, type Notification } from "@perch/sdk";
import { startDaemon, type RunningDaemon } from "./index.js";
import { Methods, Notifications, type NotificationPayload } from "./rpc.js";

const asCap = (c: unknown): Capability => c as Capability;

function tempSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "perchd-notify-test-"));
  return join(dir, "perchd.sock");
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

// A notify-read that announces on every poll where a previous value exists, so
// persistent polling drives a `notification` push without any explicit change.
const watcher = definePlugin({
  id: "watch",
  capabilities: {
    pulse: asCap(
      read({
        summary: "emits a notification on each poll after the first",
        output: z.object({ n: z.number() }),
        refresh: { every: "10ms" },
        run: (() => {
          let n = 0;
          return () => ({ n: ++n });
        })(),
        notify: ({ prev, next }): Notification[] => {
          if (prev === undefined) return [];
          return [{ title: `pulse ${next.n}`, level: "info" }];
        },
      }),
    ),
  },
});

test("notifications: client subscribes and receives a pushed notification", async () => {
  const socketPath = tempSocketPath();
  const daemon: RunningDaemon = await startDaemon({
    pluginDefs: [watcher],
    socketPath,
    watch: false,
  });
  const client: MessageConnection = await connectClient(socketPath);

  after(async () => {
    client.dispose();
    await daemon.stop();
  });

  const received: NotificationPayload[] = [];
  client.onNotification(Notifications.notification, (n: NotificationPayload) => {
    received.push(n);
  });

  await client.sendRequest(Methods.notificationsSubscribe);

  // Persistent polling (armed at boot for the notify-read) drives the hook.
  await waitFor(() => received.length >= 1, 2_000);

  assert.ok(received.length >= 1, "expected a notification push");
  const first = received[0]!;
  assert.equal(first.source, "watch.pulse");
  assert.match(first.title, /^pulse /);
  assert.equal(typeof first.id, "string");
  assert.equal(typeof first.timestamp, "number");

  // After unsubscribe, no further notifications arrive.
  await client.sendRequest(Methods.notificationsUnsubscribe);
  const countAtUnsub = received.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(received.length, countAtUnsub, "no notifications after unsubscribe");
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5));
  }
}
