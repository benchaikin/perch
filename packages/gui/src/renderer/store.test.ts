/**
 * Unit tests for the panel-state store ({@link createPanelStore}). The store
 * only touches the typed `window.perch` bridge, so it's exercised against a fake
 * bridge — no jsdom/React needed: `useSyncExternalStore` is React's, and we test
 * the `subscribe`/`getSnapshot` contract it consumes.
 *
 * Covers the load-bearing guarantees: subscribe wires `onState`, a push updates
 * the snapshot, the snapshot is referentially stable between pushes (or
 * `useSyncExternalStore` loops), and teardown unsubscribes the bridge.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPanelStore } from "./store.js";
import type { PanelState } from "../panel-state.js";

/** A fake `window.perch` (the `onState` half) recording handler + teardown. */
function fakeBridge() {
  let handler: ((state: PanelState) => void) | undefined;
  let unsubscribeCalls = 0;
  return {
    bridge: {
      onState(h: (state: PanelState) => void): () => void {
        handler = h;
        return () => {
          unsubscribeCalls += 1;
        };
      },
    },
    /** Simulate a main→renderer push. */
    push(state: PanelState): void {
      handler?.(state);
    },
    /** Whether the bridge is currently subscribed (a handler is wired). */
    get subscribed(): boolean {
      return handler !== undefined;
    },
    get unsubscribeCalls(): number {
      return unsubscribeCalls;
    },
  };
}

/** A minimal PanelState — the store stores the reference, never inspects it. */
function panelState(status: PanelState["status"]): PanelState {
  return { status } as PanelState;
}

test("getSnapshot is undefined before the first push", () => {
  const store = createPanelStore(fakeBridge().bridge);
  assert.equal(store.getSnapshot(), undefined);
});

test("subscribe wires onState and a push updates getSnapshot", () => {
  const fake = fakeBridge();
  const store = createPanelStore(fake.bridge);
  store.subscribe(() => {});
  assert.equal(fake.subscribed, true, "subscribe should wire the bridge's onState");

  const state = panelState("ok");
  fake.push(state);
  assert.equal(store.getSnapshot(), state, "a push should become the new snapshot");
});

test("subscribers are notified on each push", () => {
  const fake = fakeBridge();
  const store = createPanelStore(fake.bridge);
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });

  fake.push(panelState("loading"));
  fake.push(panelState("ok"));
  assert.equal(notifications, 2, "each push should re-render every subscriber");
});

test("snapshot identity is stable between pushes", () => {
  const fake = fakeBridge();
  const store = createPanelStore(fake.bridge);
  store.subscribe(() => {});

  fake.push(panelState("ok"));
  const first = store.getSnapshot();
  // Repeated reads with no intervening push must return the same reference, or
  // useSyncExternalStore treats it as a change and loops.
  assert.equal(store.getSnapshot(), first, "repeated reads return the same reference");

  const next = panelState("empty");
  fake.push(next);
  assert.equal(store.getSnapshot(), next, "a new push swaps to the new reference");
  assert.notEqual(store.getSnapshot(), first, "the old snapshot is no longer returned");
});

test("teardown unsubscribes the bridge", () => {
  const fake = fakeBridge();
  const store = createPanelStore(fake.bridge);
  const unsubscribe = store.subscribe(() => {});
  assert.equal(fake.unsubscribeCalls, 0);

  unsubscribe();
  assert.equal(fake.unsubscribeCalls, 1, "the last subscriber leaving detaches the bridge");
  assert.equal(fake.subscribed, true, "(the fake keeps its handler ref; calls are counted)");
});

test("multiple subscribers share one bridge listener, detached on the last leave", () => {
  const fake = fakeBridge();
  let attachCount = 0;
  // Wrap onState to count attaches: the store should attach exactly once.
  const bridge = {
    onState(h: (state: PanelState) => void): () => void {
      attachCount += 1;
      return fake.bridge.onState(h);
    },
  };
  const store = createPanelStore(bridge);

  const unsubA = store.subscribe(() => {});
  const unsubB = store.subscribe(() => {});
  assert.equal(attachCount, 1, "the bridge is attached once for many subscribers");

  unsubA();
  assert.equal(fake.unsubscribeCalls, 0, "still subscribed while one consumer remains");
  unsubB();
  assert.equal(fake.unsubscribeCalls, 1, "detached only when the last consumer leaves");
});
