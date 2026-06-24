import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configDismissalStore, createAlertStore, type DismissalStore } from "./alerts.js";
import { getConfig } from "./config-store.js";

/** An in-memory {@link DismissalStore} that records every save. */
function fakeDismissals(initial: string[] = []): DismissalStore & { saved: string[][] } {
  let ids = [...initial];
  const saved: string[][] = [];
  return {
    saved,
    load: async () => [...ids],
    save: async (next) => {
      ids = [...next];
      saved.push([...next]);
    },
  };
}

function configFile(): string {
  return join(mkdtempSync(join(tmpdir(), "perch-alerts-test-")), "perch.yaml");
}

test("raise then list returns the alert", async () => {
  const store = await createAlertStore({ dismissals: fakeDismissals() });
  const alert = store.raise("a", { pluginId: "svc", raisedAt: 100, payload: { n: 1 } });

  assert.deepEqual(alert, { id: "a", pluginId: "svc", raisedAt: 100, payload: { n: 1 } });
  assert.deepEqual(store.list(), [alert]);
});

test("raise is idempotent and refreshes raisedAt/payload in place", async () => {
  const store = await createAlertStore({ dismissals: fakeDismissals() });
  store.raise("a", { pluginId: "svc", raisedAt: 100, payload: { v: 1 } });
  store.raise("a", { pluginId: "svc", raisedAt: 200, payload: { v: 2 } });

  const list = store.list();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { id: "a", pluginId: "svc", raisedAt: 200, payload: { v: 2 } });
});

test("clear removes an alert and reports presence", async () => {
  const store = await createAlertStore({ dismissals: fakeDismissals() });
  store.raise("a", { pluginId: "svc", raisedAt: 1, payload: null });

  assert.equal(store.clear("a"), true);
  assert.equal(store.clear("a"), false);
  assert.deepEqual(store.list(), []);
});

test("dismiss hides the alert from list and persists the id", async () => {
  const dismissals = fakeDismissals();
  const store = await createAlertStore({ dismissals });
  store.raise("a", { pluginId: "svc", raisedAt: 1, payload: null });
  store.raise("b", { pluginId: "svc", raisedAt: 2, payload: null });

  await store.dismiss("a");

  assert.equal(store.isDismissed("a"), true);
  assert.deepEqual(
    store.list().map((x) => x.id),
    ["b"],
  );
  assert.deepEqual(dismissals.saved, [["a"]]);
});

test("dismiss is idempotent and skips the write the second time", async () => {
  const dismissals = fakeDismissals();
  const store = await createAlertStore({ dismissals });

  await store.dismiss("a");
  await store.dismiss("a");

  assert.deepEqual(dismissals.saved, [["a"]]);
});

test("dismissing an id that is later raised keeps it filtered", async () => {
  const store = await createAlertStore({ dismissals: fakeDismissals() });

  await store.dismiss("a");
  store.raise("a", { pluginId: "svc", raisedAt: 1, payload: null });

  assert.deepEqual(store.list(), []);
  assert.equal(store.isDismissed("a"), true);
});

test("loads the persisted dismiss list on creation", async () => {
  const store = await createAlertStore({ dismissals: fakeDismissals(["a"]) });
  store.raise("a", { pluginId: "svc", raisedAt: 1, payload: null });
  store.raise("b", { pluginId: "svc", raisedAt: 2, payload: null });

  assert.equal(store.isDismissed("a"), true);
  assert.deepEqual(
    store.list().map((x) => x.id),
    ["b"],
  );
});

test("restore un-dismisses and persists; no-op when not dismissed", async () => {
  const dismissals = fakeDismissals(["a"]);
  const store = await createAlertStore({ dismissals });
  store.raise("a", { pluginId: "svc", raisedAt: 1, payload: null });

  assert.equal(await store.restore("a"), true);
  assert.equal(store.isDismissed("a"), false);
  assert.deepEqual(
    store.list().map((x) => x.id),
    ["a"],
  );
  assert.deepEqual(dismissals.saved, [[]]);

  assert.equal(await store.restore("a"), false);
  assert.deepEqual(dismissals.saved, [[]]);
});

test("config-backed dismissals round-trip through perch.yaml", async () => {
  const path = configFile();
  const dismissals = configDismissalStore(path);

  const store = await createAlertStore({ dismissals });
  await store.dismiss("services:perch:api-server:crashed");

  assert.deepEqual((await getConfig(path)).dismissedAlerts, ["services:perch:api-server:crashed"]);

  // A fresh store reads the persisted list back — survives a "restart".
  const reborn = await createAlertStore({ dismissals: configDismissalStore(path) });
  assert.equal(reborn.isDismissed("services:perch:api-server:crashed"), true);
});

test("config-backed dismissals preserve unrelated config keys", async () => {
  const path = configFile();
  writeFileSync(path, JSON.stringify({ plugins: { stack: { repos: ["/r"] } } }), "utf8");

  const store = await createAlertStore({ dismissals: configDismissalStore(path) });
  await store.dismiss("a");

  assert.deepEqual(await getConfig(path), {
    plugins: { stack: { repos: ["/r"] } },
    dismissedAlerts: ["a"],
  });
});
