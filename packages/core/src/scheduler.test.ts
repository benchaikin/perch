import assert from "node:assert/strict";
import { test } from "node:test";
import { definePlugin, read, z, type Capability, type Notification } from "@perch/sdk";
import { Cache } from "./cache.js";
import { createEventBus } from "./event-bus.js";
import type { InvokerDeps } from "./invoker.js";
import { NotificationService, type DeliveredNotification } from "./notifications.js";
import { Registry, type RegisteredCapability } from "./registry.js";
import { Scheduler } from "./scheduler.js";

const asCap = (c: unknown): Capability => c as Capability;

/** Build invoker deps + a registry for a single plugin. */
function harness(plugin: ReturnType<typeof definePlugin>): {
  registry: Registry;
  deps: InvokerDeps;
} {
  const registry = new Registry();
  registry.register(plugin);
  const deps: InvokerDeps = {
    cache: new Cache(),
    configs: {},
    plugins: new Map([[plugin.id, plugin]]),
    signal: new AbortController().signal,
  };
  return { registry, deps };
}

/** Wait until `predicate` holds or `timeoutMs` elapses; resolves either way. */
async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("scheduler runs notify after each poll: prev undefined → none, then changed → one", async () => {
  // `run` returns an increasing counter; `notify` announces only when it changed.
  let counter = 0;
  const seenPrev: Array<number | undefined> = [];
  const plugin = definePlugin({
    id: "demo",
    capabilities: {
      ticker: asCap(
        read({
          summary: "increasing counter",
          output: z.object({ n: z.number() }),
          refresh: { every: "10ms" },
          run: () => ({ n: ++counter }),
          notify: ({ prev, next }): Notification[] => {
            seenPrev.push(prev?.n);
            if (prev === undefined) return [];
            if (prev.n === next.n) return [];
            return [{ title: `changed to ${next.n}`, dedupeKey: `n-${next.n}` }];
          },
        }),
      ),
    },
  });

  const { registry, deps } = harness(plugin);
  const delivered: DeliveredNotification[] = [];
  const notifications = new NotificationService();
  notifications.addSink({ deliver: (n) => delivered.push(n) });
  const scheduler = new Scheduler(deps, createEventBus(), notifications);

  const entry = registry.get("demo.ticker") as RegisteredCapability;
  scheduler.armPersistent(entry, undefined);

  // Wait for at least two polls to have happened.
  await waitFor(() => seenPrev.length >= 2);
  scheduler.stop();
  notifications.stop();

  // First poll saw no prior value.
  assert.equal(seenPrev[0], undefined);
  // A later poll saw the previous value and produced a notification.
  assert.ok(delivered.length >= 1, "expected at least one notification");
  assert.equal(delivered[0]!.source, "demo.ticker");
  assert.match(delivered[0]!.title, /^changed to /);
});

test("a throwing notify hook does not break polling", async () => {
  let polls = 0;
  const plugin = definePlugin({
    id: "demo",
    capabilities: {
      boom: asCap(
        read({
          summary: "throws in notify",
          output: z.object({ n: z.number() }),
          refresh: { every: "10ms" },
          run: () => ({ n: ++polls }),
          notify: () => {
            throw new Error("notify exploded");
          },
        }),
      ),
    },
  });

  const { registry, deps } = harness(plugin);
  const notifications = new NotificationService();
  const scheduler = new Scheduler(deps, createEventBus(), notifications);
  const entry = registry.get("demo.boom") as RegisteredCapability;
  scheduler.armPersistent(entry, undefined);

  // Polling must keep running despite the throwing notify hook.
  await waitFor(() => polls >= 2);
  scheduler.stop();
  notifications.stop();
  assert.ok(polls >= 2, "polling continued past a throwing notify hook");
});

test("a poll slower than its interval never overlaps with the next poll", async () => {
  // `run` takes ~40ms while the interval is only 10ms. With setInterval this
  // would queue overlapping invocations; with self-rescheduling setTimeout each
  // poll finishes before the next is armed, so concurrency stays at one.
  let inFlight = 0;
  let maxInFlight = 0;
  let completed = 0;
  const plugin = definePlugin({
    id: "demo",
    capabilities: {
      slow: asCap(
        read({
          summary: "slow read",
          output: z.object({ n: z.number() }),
          refresh: { every: "10ms" },
          run: async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 40));
            inFlight -= 1;
            completed += 1;
            return { n: completed };
          },
        }),
      ),
    },
  });

  const { registry, deps } = harness(plugin);
  const scheduler = new Scheduler(deps, createEventBus(), new NotificationService());
  const entry = registry.get("demo.slow") as RegisteredCapability;
  scheduler.armPersistent(entry, undefined);

  await waitFor(() => completed >= 3, 2_000);
  scheduler.stop();

  assert.ok(completed >= 3, "expected several polls to complete");
  assert.equal(maxInFlight, 1, "polls must never overlap");
});

test("stop() prevents an in-flight slow poll from rescheduling", async () => {
  let started = 0;
  const plugin = definePlugin({
    id: "demo",
    capabilities: {
      slow: asCap(
        read({
          summary: "slow read",
          output: z.object({ n: z.number() }),
          refresh: { every: "10ms" },
          run: async () => {
            started += 1;
            await new Promise((r) => setTimeout(r, 30));
            return { n: started };
          },
        }),
      ),
    },
  });

  const { registry, deps } = harness(plugin);
  const scheduler = new Scheduler(deps, createEventBus(), new NotificationService());
  const entry = registry.get("demo.slow") as RegisteredCapability;
  scheduler.armPersistent(entry, undefined);

  // Stop while the first poll is mid-flight.
  await waitFor(() => started >= 1);
  scheduler.stop();
  const afterStop = started;

  // Give the in-flight poll time to finish and (wrongly) re-arm if it could.
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(started, afterStop, "no further polls after stop()");
});

test("armNotifyReads arms a persistent poller for a notify-read with no subscriber", () => {
  const plugin = definePlugin({
    id: "demo",
    capabilities: {
      watched: asCap(
        read({
          summary: "has notify",
          output: z.object({ n: z.number() }),
          refresh: { every: "1h" },
          run: () => ({ n: 1 }),
          notify: () => [],
        }),
      ),
      plain: asCap(
        read({
          summary: "no notify",
          refresh: { every: "1h" },
          run: () => ({ n: 2 }),
        }),
      ),
    },
  });

  const { registry, deps } = harness(plugin);
  const scheduler = new Scheduler(deps, createEventBus(), new NotificationService());

  const armed = scheduler.armNotifyReads(registry.all());
  assert.equal(armed, 1);
  // The notify-read has a persistent poller without any client subscription.
  assert.equal(scheduler.hasPersistentPoller("demo.watched", "null"), true);
  // The plain read has none.
  assert.equal(scheduler.hasPoller("demo.plain", "null"), false);
  scheduler.stop();
});

test("a persistent poller survives unsubscribe of a client sharing its key", () => {
  const plugin = definePlugin({
    id: "demo",
    capabilities: {
      watched: asCap(
        read({
          summary: "has notify",
          output: z.object({ n: z.number() }),
          refresh: { every: "1h" },
          run: () => ({ n: 1 }),
          notify: () => [],
        }),
      ),
    },
  });

  const { registry, deps } = harness(plugin);
  const scheduler = new Scheduler(deps, createEventBus(), new NotificationService());
  const entry = registry.get("demo.watched") as RegisteredCapability;

  scheduler.armPersistent(entry, undefined);
  const key = scheduler.subscribe(entry, undefined); // client joins, shares the poller
  scheduler.unsubscribe(entry.id, key); // client leaves

  // Persistent interest keeps the poller armed.
  assert.equal(scheduler.hasPoller(entry.id, key), true);
  assert.equal(scheduler.hasPersistentPoller(entry.id, key), true);
  scheduler.stop();
});
