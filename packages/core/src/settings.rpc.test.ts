import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
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
import { Methods, type SettingsDescribeResult } from "./rpc.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "perchd-settings-rpc-test-"));
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

// A fixture plugin that declares a settings descriptor (enum + boolean).
const stack = definePlugin({
  id: "stack",
  name: "Stack",
  settings: [
    {
      key: "stackDirection",
      type: "enum",
      label: "Stack direction",
      default: "down",
      options: [
        { value: "down", label: "Down" },
        { value: "up", label: "Up" },
      ],
    },
    { key: "showDrafts", type: "boolean", label: "Show drafts", default: false },
  ],
  capabilities: {},
});

// A plugin with no settings descriptor — must not appear in the result.
const noop = definePlugin({ id: "noop", capabilities: {} });

test("integration: settings.describe merges descriptors with current config values", async (t) => {
  const dir = tempDir();
  const socketPath = join(dir, "perchd.sock");
  const configPath = join(dir, "perch.json");
  // `stackDirection` is set (overrides default); `showDrafts` is unset (→ default).
  writeFileSync(
    configPath,
    JSON.stringify({ plugins: { stack: { stackDirection: "up" } } }),
    "utf8",
  );

  const daemon: RunningDaemon = await startDaemon({
    pluginDefs: [stack, noop],
    socketPath,
    configPath,
    watch: false,
  });
  const client = await connectClient(socketPath);

  after(async () => {
    client.dispose();
    await daemon.stop();
  });

  await t.test("returns only plugins that declare a descriptor, with id + name", async () => {
    const result = (await client.sendRequest(Methods.settingsDescribe)) as SettingsDescribeResult;
    // The stack plugin descriptor, plus the always-appended "General" descriptor.
    assert.equal(result.length, 2);
    const [entry] = result;
    assert.ok(entry);
    assert.equal(entry.pluginId, "stack");
    assert.equal(entry.name, "Stack");
    assert.equal(entry.fields.length, 2);
    // The General (global) descriptor is last and carries the terminal fields.
    const general = result.at(-1);
    assert.equal(general?.pluginId, "__global__");
    assert.ok(general?.fields.some((f) => f.key === "terminal.terminalApp"));
  });

  await t.test("set value overrides default; unset value falls back to default", async () => {
    const result = (await client.sendRequest(Methods.settingsDescribe)) as SettingsDescribeResult;
    const [entry] = result;
    assert.ok(entry);
    const fields = entry.fields;

    const direction = fields.find((f) => f.key === "stackDirection");
    assert.ok(direction);
    assert.equal(direction.type, "enum");
    assert.equal(direction.value, "up"); // from perch.json, overriding default "down"

    const drafts = fields.find((f) => f.key === "showDrafts");
    assert.ok(drafts);
    assert.equal(drafts.value, false); // unset → field default
  });
});

test("integration: settings.describe falls back to plugin id when no name is declared", async () => {
  const dir = tempDir();
  const socketPath = join(dir, "perchd.sock");
  const configPath = join(dir, "perch.json");
  writeFileSync(configPath, JSON.stringify({ plugins: {} }), "utf8");

  const unnamed = definePlugin({
    id: "widgets",
    settings: [{ key: "size", type: "number", label: "Size", default: 3 }],
    capabilities: {},
  });

  const daemon = await startDaemon({
    pluginDefs: [unnamed],
    socketPath,
    configPath,
    watch: false,
  });
  const client = await connectClient(socketPath);

  after(async () => {
    client.dispose();
    await daemon.stop();
  });

  const result = (await client.sendRequest(Methods.settingsDescribe)) as SettingsDescribeResult;
  // The widgets plugin descriptor, plus the always-appended "General" descriptor.
  assert.equal(result.length, 2);
  const [entry] = result;
  assert.ok(entry);
  assert.equal(entry.pluginId, "widgets");
  assert.equal(entry.name, "widgets"); // falls back to id
  const [field] = entry.fields;
  assert.ok(field);
  assert.equal(field.value, 3); // default (plugin unset in config)
});
