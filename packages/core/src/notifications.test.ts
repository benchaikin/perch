import assert from "node:assert/strict";
import { test } from "node:test";
import type { Notification } from "@perch/sdk";
import {
  NotificationService,
  type DeliveredNotification,
  type NotificationSink,
} from "./notifications.js";

/** A sink that records everything delivered to it. */
function recordingSink(): NotificationSink & { items: DeliveredNotification[] } {
  const items: DeliveredNotification[] = [];
  return { items, deliver: (n) => items.push(n) };
}

/** A clock whose value the test controls. */
function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test("emit stamps id, source, and timestamp", () => {
  const clock = fakeClock(42_000);
  const svc = new NotificationService({ now: clock.now });
  const sink = recordingSink();
  svc.addSink(sink);

  const note: Notification = { title: "hello", body: "world", level: "warning" };
  svc.emit("demo.read", [note]);

  assert.equal(sink.items.length, 1);
  const got = sink.items[0]!;
  assert.equal(got.title, "hello");
  assert.equal(got.body, "world");
  assert.equal(got.level, "warning");
  assert.equal(got.source, "demo.read");
  assert.equal(got.timestamp, 42_000);
  assert.equal(typeof got.id, "string");
  svc.stop();
});

test("routes to every registered sink", () => {
  const svc = new NotificationService();
  const a = recordingSink();
  const b = recordingSink();
  svc.addSink(a);
  svc.addSink(b);

  svc.emit("src", [{ title: "x" }]);

  assert.equal(a.items.length, 1);
  assert.equal(b.items.length, 1);
  svc.stop();
});

test("dedupe: same key within TTL is suppressed; different keys / no key pass", () => {
  const clock = fakeClock();
  const svc = new NotificationService({ dedupeTtlMs: 5_000, now: clock.now });
  const sink = recordingSink();
  svc.addSink(sink);

  svc.emit("src", [{ title: "a", dedupeKey: "k1" }]);
  // Same key, still within TTL → suppressed.
  clock.advance(1_000);
  svc.emit("src", [{ title: "a-again", dedupeKey: "k1" }]);
  // Different key → passes.
  svc.emit("src", [{ title: "b", dedupeKey: "k2" }]);
  // No key → always passes (twice).
  svc.emit("src", [{ title: "c" }]);
  svc.emit("src", [{ title: "c" }]);

  const titles = sink.items.map((n) => n.title);
  assert.deepEqual(titles, ["a", "b", "c", "c"]);
  svc.stop();
});

test("dedupe: same key passes again after the TTL window elapses", () => {
  const clock = fakeClock();
  const svc = new NotificationService({ dedupeTtlMs: 5_000, now: clock.now });
  const sink = recordingSink();
  svc.addSink(sink);

  svc.emit("src", [{ title: "first", dedupeKey: "k" }]);
  clock.advance(5_000); // exactly TTL → no longer within the window
  svc.emit("src", [{ title: "second", dedupeKey: "k" }]);

  assert.deepEqual(
    sink.items.map((n) => n.title),
    ["first", "second"],
  );
  svc.stop();
});

test("dedupe disabled with ttl=0: repeats always pass", () => {
  const svc = new NotificationService({ dedupeTtlMs: 0 });
  const sink = recordingSink();
  svc.addSink(sink);

  svc.emit("src", [{ title: "x", dedupeKey: "k" }]);
  svc.emit("src", [{ title: "x", dedupeKey: "k" }]);

  assert.equal(sink.items.length, 2);
  svc.stop();
});

test("a throwing sink does not block other sinks", () => {
  const svc = new NotificationService();
  const bad: NotificationSink = {
    deliver: () => {
      throw new Error("boom");
    },
  };
  const good = recordingSink();
  svc.addSink(bad);
  svc.addSink(good);

  assert.doesNotThrow(() => svc.emit("src", [{ title: "x" }]));
  assert.equal(good.items.length, 1);
  svc.stop();
});
