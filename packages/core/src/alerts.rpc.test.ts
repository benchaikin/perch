import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  createMessageConnection,
  SocketMessageReader,
  SocketMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import { definePlugin } from "@perch/sdk";
import { startDaemon, type RunningDaemon } from "./index.js";
import { getConfig } from "./config-store.js";
import {
  Methods,
  type AlertClearResult,
  type AlertListResult,
  type AlertRaiseResult,
  type ConfigGetResult,
} from "./rpc.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "perchd-alerts-rpc-test-"));
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

const empty = definePlugin({ id: "noop", capabilities: {} });

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 2));

test("integration: alerts.raise / list / clear / dismiss over a socket", async (t) => {
  const dir = tempDir();
  const socketPath = join(dir, "perchd.sock");
  const configPath = join(dir, "perch.yaml");

  const daemon: RunningDaemon = await startDaemon({
    pluginDefs: [empty],
    socketPath,
    configPath,
    watch: false,
  });
  const client = await connectClient(socketPath);

  after(async () => {
    client.dispose();
    await daemon.stop();
  });

  await t.test("raise stamps raisedAt and returns the stored alert", async () => {
    const alert = (await client.sendRequest(Methods.alertsRaise, {
      id: "a",
      pluginId: "noop",
      payload: { detail: 1 },
    })) as AlertRaiseResult;
    assert.equal(alert.id, "a");
    assert.equal(alert.pluginId, "noop");
    assert.deepEqual(alert.payload, { detail: 1 });
    assert.equal(typeof alert.raisedAt, "number");
  });

  await t.test("list returns non-dismissed alerts newest first", async () => {
    await tick();
    await client.sendRequest(Methods.alertsRaise, { id: "b", pluginId: "noop" });

    const list = (await client.sendRequest(Methods.alertsList)) as AlertListResult;
    assert.deepEqual(
      list.map((a) => a.id),
      ["b", "a"],
    );
  });

  await t.test("clear removes an active alert and reports it", async () => {
    const cleared = (await client.sendRequest(Methods.alertsClear, {
      id: "a",
    })) as AlertClearResult;
    assert.deepEqual(cleared, { cleared: true });

    const missing = (await client.sendRequest(Methods.alertsClear, {
      id: "a",
    })) as AlertClearResult;
    assert.deepEqual(missing, { cleared: false });

    const list = (await client.sendRequest(Methods.alertsList)) as AlertListResult;
    assert.deepEqual(
      list.map((a) => a.id),
      ["b"],
    );
  });

  await t.test("dismiss drops the active alert and persists the id", async () => {
    await client.sendRequest(Methods.alertsDismiss, { id: "b" });

    const list = (await client.sendRequest(Methods.alertsList)) as AlertListResult;
    assert.deepEqual(list, []);

    // Persisted to perch.yaml so it survives a restart.
    const config = (await getConfig(configPath)) as ConfigGetResult;
    assert.deepEqual(config.dismissedAlerts, ["b"]);
  });

  await t.test("a re-raised, dismissed alert stays filtered from list", async () => {
    await client.sendRequest(Methods.alertsRaise, { id: "b", pluginId: "noop" });
    const list = (await client.sendRequest(Methods.alertsList)) as AlertListResult;
    assert.deepEqual(list, []);
  });
});
