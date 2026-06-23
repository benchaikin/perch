import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
import { Methods, type ConfigGetResult, type ValidateRepoPathResult } from "./rpc.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "perchd-config-rpc-test-"));
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

test("integration: config.get / config.update / config.validateRepoPath over a socket", async (t) => {
  const dir = tempDir();
  const socketPath = join(dir, "perchd.sock");
  const configPath = join(dir, "perch.yaml");
  writeFileSync(configPath, JSON.stringify({ plugins: { stack: { repos: ["/a"] } } }), "utf8");

  // pluginDefs + watch:false keeps the test deterministic (no fs-watch reload).
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

  await t.test("config.get returns the current config", async () => {
    const cfg = (await client.sendRequest(Methods.configGet)) as ConfigGetResult;
    assert.deepEqual(cfg, { plugins: { stack: { repos: ["/a"] } } });
  });

  await t.test("config.update merges, persists, and returns the new config", async () => {
    const next = (await client.sendRequest(Methods.configUpdate, {
      patch: { plugins: { stack: { repos: ["/a", "/b"] } } },
    })) as ConfigGetResult;
    assert.deepEqual(next, { plugins: { stack: { repos: ["/a", "/b"] } } });

    // The written file is what a subsequent config.get reads back.
    const refetched = (await client.sendRequest(Methods.configGet)) as ConfigGetResult;
    assert.deepEqual(refetched, next);
  });

  await t.test("config.validateRepoPath checks a real git repo dir", async () => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const ok = (await client.sendRequest(Methods.configValidateRepoPath, {
      path: repo,
    })) as ValidateRepoPathResult;
    assert.deepEqual(ok, { ok: true });

    const bad = (await client.sendRequest(Methods.configValidateRepoPath, {
      path: join(dir, "not-a-repo"),
    })) as ValidateRepoPathResult;
    assert.equal(bad.ok, false);
  });
});
