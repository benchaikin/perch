import assert from "node:assert/strict";
import { test } from "node:test";
import { definePlugin, read, z, type AlertOp, type Capability, type Notification } from "@perch/sdk";
import type { Alert, AlertSink, RaiseInput } from "./alerts.js";
import { Cache } from "./cache.js";
import { createEventBus } from "./event-bus.js";
import type { InvokerDeps } from "./invoker.js";
import { NotificationService, type DeliveredNotification } from "./notifications.js";
import { Registry, type RegisteredCapability } from "./registry.js";
import { Scheduler } from "./scheduler.js";

/** A recording {@link AlertSink} for asserting a read's `alerts`-hook output. */
class FakeAlertSink implements AlertSink {
  readonly raises: Alert[] = [];
  readonly cleared: string[] = [];
  raise(id: string, input: RaiseInput): Alert {
    const alert: Alert = { id, ...input };
    this.raises.push(alert);
    return alert;
  }
  clear(id: string): boolean {
    this.cleared.push(id);
    return true;
  }
}

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

test("poke forces an immediate poll outside the timer interval", async () => {
  // A long interval guarantees the timer never fires during the test — any poll
  // we observe must have come from poke().
  let polls = 0;
  const plugin = definePlugin({
    id: "demo",
    capabilities: {
      slow: asCap(
        read({
          summary: "long interval",
          output: z.object({ n: z.number() }),
          refresh: { every: "1h" },
          run: () => ({ n: ++polls }),
        }),
      ),
    },
  });

  const { registry, deps } = harness(plugin);
  const bus = createEventBus();
  const emitted: unknown[] = [];
  bus.on((e) => emitted.push(e.data));
  const scheduler = new Scheduler(deps, bus, new NotificationService());
  const entry = registry.get("demo.slow") as RegisteredCapability;
  scheduler.armPersistent(entry, undefined);

  scheduler.poke("demo.slow");
  await waitFor(() => emitted.length >= 1);
  scheduler.stop();

  assert.equal(polls, 1, "poke ran exactly one immediate poll");
  assert.deepEqual(emitted, [{ n: 1 }], "poke emitted the fresh value on the bus");
});

test("poke runs the notify hook so subscribed clients get the update", async () => {
  let counter = 0;
  const delivered: DeliveredNotification[] = [];
  const plugin = definePlugin({
    id: "demo",
    capabilities: {
      ticker: asCap(
        read({
          summary: "long interval with notify",
          output: z.object({ n: z.number() }),
          refresh: { every: "1h" },
          run: () => ({ n: ++counter }),
          notify: ({ prev, next }): Notification[] => {
            if (prev === undefined || prev.n === next.n) return [];
            return [{ title: `now ${next.n}`, dedupeKey: `n-${next.n}` }];
          },
        }),
      ),
    },
  });

  const { registry, deps } = harness(plugin);
  const bus = createEventBus();
  let emits = 0;
  bus.on(() => (emits += 1));
  const notifications = new NotificationService();
  notifications.addSink({ deliver: (n) => delivered.push(n) });
  const scheduler = new Scheduler(deps, bus, notifications);
  const entry = registry.get("demo.ticker") as RegisteredCapability;
  scheduler.armPersistent(entry, undefined);

  // First poke primes the cache (prev undefined → no notification); only after it
  // has settled (cache written, emit fired) does the second poke see the change.
  scheduler.poke("demo.ticker");
  await waitFor(() => emits >= 1);
  scheduler.poke("demo.ticker");
  await waitFor(() => delivered.length >= 1);
  scheduler.stop();
  notifications.stop();

  assert.ok(delivered.length >= 1, "poke triggered the notify hook");
  assert.equal(delivered[0]!.source, "demo.ticker");
});

test("poke is a no-op for a capability with no active poller", async () => {
  const plugin = definePlugin({
    id: "demo",
    capabilities: {
      idle: asCap(
        read({
          summary: "never subscribed",
          output: z.object({ n: z.number() }),
          refresh: { every: "1h" },
          run: () => ({ n: 1 }),
        }),
      ),
    },
  });

  const { deps } = harness(plugin);
  const bus = createEventBus();
  const emitted: unknown[] = [];
  bus.on((e) => emitted.push(e.data));
  const scheduler = new Scheduler(deps, bus, new NotificationService());

  // Nothing subscribed or armed → no poller → poke does nothing (and never throws).
  scheduler.poke("demo.idle");
  scheduler.poke("demo.unknown");
  await new Promise((r) => setTimeout(r, 20));
  scheduler.stop();

  assert.deepEqual(emitted, [], "poke without a poller emits nothing");
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

test("a persistent poller transitions between normal and idle intervals as refs change", () => {
  const plugin = definePlugin({
    id: "demo",
    capabilities: {
      watched: asCap(
        read({
          summary: "has idle interval",
          output: z.object({ n: z.number() }),
          refresh: { every: "60s", idleEvery: "300s" },
          run: () => ({ n: 1 }),
          notify: () => [],
        }),
      ),
    },
  });

  const { registry, deps } = harness(plugin);
  const scheduler = new Scheduler(deps, createEventBus(), new NotificationService());
  const entry = registry.get("demo.watched") as RegisteredCapability;

  // No client subscribed, only persistent interest → idle interval.
  scheduler.armPersistent(entry, undefined);
  assert.equal(scheduler.pollerIntervalMs(entry.id, "null"), 300_000);

  // A GUI client subscribes → switch to the fast interval immediately.
  const key = scheduler.subscribe(entry, undefined);
  assert.equal(scheduler.pollerIntervalMs(entry.id, key), 60_000);

  // The client leaves but persistent interest remains → back to idle.
  scheduler.unsubscribe(entry.id, key);
  assert.equal(scheduler.pollerIntervalMs(entry.id, key), 300_000);

  scheduler.stop();
});

test("a read without idleEvery keeps one interval regardless of subscribers", () => {
  const plugin = definePlugin({
    id: "demo",
    capabilities: {
      watched: asCap(
        read({
          summary: "no idle interval",
          output: z.object({ n: z.number() }),
          refresh: { every: "60s" },
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
  assert.equal(scheduler.pollerIntervalMs(entry.id, "null"), 60_000);
  const key = scheduler.subscribe(entry, undefined);
  assert.equal(scheduler.pollerIntervalMs(entry.id, key), 60_000);
  scheduler.unsubscribe(entry.id, key);
  assert.equal(scheduler.pollerIntervalMs(entry.id, key), 60_000);

  scheduler.stop();
});

test("scheduler applies a read's alerts-hook output to the alert sink (raise then clear)", async () => {
  // `run` toggles a flag; `alerts` raises while it's on, clears when it goes off.
  // A long interval means only the explicit `poke`s below drive polls (no timer
  // race), so each poke maps to exactly one hook run.
  let on = true;
  const plugin = definePlugin({
    id: "demo",
    capabilities: {
      cond: asCap(
        read({
          summary: "a toggling condition",
          output: z.object({ on: z.boolean() }),
          refresh: { every: "1h" },
          run: () => ({ on }),
          alerts: ({ next }): AlertOp[] =>
            next.on
              ? [{ op: "raise", id: "demo:cond", payload: { v: 1 } }]
              : [{ op: "clear", id: "demo:cond" }],
        }),
      ),
    },
  });

  const { registry, deps } = harness(plugin);
  const sink = new FakeAlertSink();
  const scheduler = new Scheduler(deps, createEventBus(), undefined, sink);
  const entry = registry.get("demo.cond") as RegisteredCapability;
  scheduler.armPersistent(entry, undefined);

  scheduler.poke("demo.cond");
  await waitFor(() => sink.raises.length >= 1);
  assert.equal(sink.raises.length, 1);
  assert.equal(sink.raises[0]!.id, "demo:cond");
  // The daemon stamps the raising plugin id + raisedAt server-side.
  assert.equal(sink.raises[0]!.pluginId, "demo");
  assert.equal(typeof sink.raises[0]!.raisedAt, "number");
  assert.deepEqual(sink.raises[0]!.payload, { v: 1 });

  on = false;
  scheduler.poke("demo.cond");
  await waitFor(() => sink.cleared.length >= 1);
  assert.deepEqual(sink.cleared, ["demo:cond"]);

  scheduler.stop();
});

test("armNotifyReads arms a persistent poller for an alert-only read (no notify hook)", () => {
  const plugin = definePlugin({
    id: "demo",
    capabilities: {
      alerting: asCap(
        read({
          summary: "alerts but no notify",
          output: z.object({ n: z.number() }),
          refresh: { every: "1h" },
          run: () => ({ n: 1 }),
          alerts: () => [],
        }),
      ),
    },
  });

  const { registry, deps } = harness(plugin);
  const scheduler = new Scheduler(deps, createEventBus(), undefined, new FakeAlertSink());
  const armed = scheduler.armNotifyReads(registry.all());
  assert.equal(armed, 1);
  assert.equal(scheduler.hasPersistentPoller("demo.alerting", "null"), true);
  scheduler.stop();
});
