/**
 * Behavioral tests for the React Dex pane's drag-and-drop dependency wiring (T8e),
 * the port of `dex.ts`'s `makeDexRowDraggable` / `dexUnblockZoneEl`. They cover the
 * contract those imperative builders owned: dropping one task row onto another adds
 * a blocker edge (`dexAddBlocker`, drop A onto B ⇒ B blocked-by A); dropping a
 * nested graph node onto the "drop here to remove this blocker" zone removes that
 * one edge (`dexRemoveBlocker`); a self-drop and a cross-project drop no-op (the
 * daemon stays the source of truth, so an invalid drop never reaches it).
 *
 * The add path is driven through the live tree (`<DexPane>`); the remove path is
 * driven through a tiny harness over the exported {@link useDexRowDrag} /
 * {@link DexUnblockZone} (nested nodes live in the graph view, T8b — not yet
 * mounted), plus a direct unit test of the {@link isValidDexDropTarget} guard.
 */
import "./test-dom.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  DexPane,
  DexProvider,
  DexUnblockZone,
  isValidDexDropTarget,
  useDexRowDrag,
} from "./dex-pane.js";
import { dexHealth, type DexRow, type DexSection } from "../dex-state.js";
import type { DexBlockerRequest, PerchBridge } from "../ipc.js";

/** Bridge spies: the edge edits a drop fires. */
let addBlockerCalls: DexBlockerRequest[];
let removeBlockerCalls: DexBlockerRequest[];

const bridge = {
  dexAddBlocker(request: DexBlockerRequest) {
    addBlockerCalls.push(request);
    return Promise.resolve();
  },
  dexRemoveBlocker(request: DexBlockerRequest) {
    removeBlockerCalls.push(request);
    return Promise.resolve();
  },
} as unknown as PerchBridge;

beforeEach(() => {
  addBlockerCalls = [];
  removeBlockerCalls = [];
  (globalThis as unknown as { window: { perch: PerchBridge } }).window.perch = bridge;
});

afterEach(() => cleanup());

/** A task row with sensible defaults; `over` sets the fields a test cares about. */
function row(over: Partial<DexRow> & Pick<DexRow, "id" | "name">): DexRow {
  const status = over.status ?? "ready";
  return {
    description: "",
    result: null,
    status,
    displayStatus: status,
    depth: 0,
    isEpic: false,
    blockedByCount: 0,
    blockedBy: [],
    health: dexHealth(status),
    ...over,
  };
}

/** A visible Dex section wrapping the given rows. */
function section(rows: DexRow[]): DexSection {
  return {
    visible: true,
    rows,
    counts: { ready: 0, blocked: 0, inProgress: 0, done: 0, total: rows.length },
  };
}

/**
 * A stand-in for the HTML5 `DataTransfer` (jsdom has none): a string store plus the
 * `dropEffect`/`effectAllowed` the handlers set, so a simulated drag carries the
 * dragged id exactly as the real one does.
 */
function dataTransfer() {
  const store: Record<string, string> = {};
  return {
    dropEffect: "",
    effectAllowed: "",
    setData(type: string, value: string) {
      store[type] = value;
    },
    getData(type: string) {
      return store[type] ?? "";
    },
  };
}

/** The rendered `.dex-row` elements, in document order. */
function dexRows(container: HTMLElement): Element[] {
  return [...container.querySelectorAll(".dex-row")];
}

/** Drive a full drag of `source` onto `target` (start → over → drop → end). */
function dragOnto(source: Element, target: Element): void {
  const dt = dataTransfer();
  fireEvent.dragStart(source, { dataTransfer: dt });
  fireEvent.dragOver(target, { dataTransfer: dt });
  fireEvent.drop(target, { dataTransfer: dt });
  fireEvent.dragEnd(source, { dataTransfer: dt });
}

test("dropping one row onto another adds a blocker edge (drop A onto B ⇒ B blocked-by A)", () => {
  const { container } = render(
    <DexPane section={section([row({ id: "a", name: "A" }), row({ id: "b", name: "B" })])} />,
  );
  const [a, b] = dexRows(container) as [Element, Element];
  dragOnto(a, b);
  assert.deepEqual(addBlockerCalls, [{ blockedId: "b", blockerId: "a" }]);
});

test("the dragged row is draggable and flags a valid hovered target", () => {
  const { container } = render(
    <DexPane section={section([row({ id: "a", name: "A" }), row({ id: "b", name: "B" })])} />,
  );
  const [a, b] = dexRows(container) as [Element, Element];
  assert.equal(a.getAttribute("draggable"), "true", "a task row is a drag source");

  const dt = dataTransfer();
  fireEvent.dragStart(a, { dataTransfer: dt });
  fireEvent.dragOver(b, { dataTransfer: dt });
  assert.ok(b.classList.contains("dex-drop-target"), "a valid hovered target lights up");
  // dragleave drops the highlight again.
  fireEvent.dragLeave(b, { dataTransfer: dt });
  assert.equal(b.classList.contains("dex-drop-target"), false, "leaving clears the highlight");
});

test("a self-drop (A onto A) is a no-op", () => {
  const { container } = render(<DexPane section={section([row({ id: "a", name: "A" })])} />);
  const a = container.querySelector(".dex-row")!;
  dragOnto(a, a);
  assert.deepEqual(addBlockerCalls, [], "dropping a task onto itself adds no edge");
});

test("a cross-project drop no-ops; a same-project drop wires the edge", () => {
  const { container } = render(
    <DexPane
      section={section([
        row({ id: "a", name: "A", project: "repo-1" }),
        row({ id: "b", name: "B", project: "repo-2" }),
        row({ id: "c", name: "C", project: "repo-1" }),
      ])}
    />,
  );
  const [a, b, c] = dexRows(container) as [Element, Element, Element];

  // a (repo-1) onto b (repo-2): a blocker edge can't cross stores — rejected.
  dragOnto(a, b);
  assert.deepEqual(addBlockerCalls, [], "a cross-project drop reaches the daemon never");

  // a (repo-1) onto c (repo-1): same store — wired.
  dragOnto(a, c);
  assert.deepEqual(addBlockerCalls, [{ blockedId: "c", blockerId: "a" }]);
});

/** A nested graph node: a draggable row that carries the blocker it sits under. */
function NestedNode({ task, blockerId }: { task: DexRow; blockerId: string }): JSX.Element {
  const drag = useDexRowDrag(task, blockerId);
  return <div className={`dex-row${drag.className}`} {...drag.props} />;
}

test("dropping a nested node on the unblock zone removes exactly that blocker edge", () => {
  const blocked = row({ id: "blocked", name: "Blocked", status: "blocked", blockedByCount: 1 });
  const { container } = render(
    <DexProvider>
      <NestedNode task={blocked} blockerId="blkr" />
      <DexUnblockZone />
    </DexProvider>,
  );
  const node = container.querySelector(".dex-row")!;
  const zone = container.querySelector(".dex-unblock-zone")!;

  // The zone is hidden until a node carrying a blocker edge is picked up.
  assert.equal(zone.classList.contains("armed"), false, "the zone is inert before a drag");

  const dt = dataTransfer();
  fireEvent.dragStart(node, { dataTransfer: dt });
  assert.ok(zone.classList.contains("armed"), "dragging a nested node arms the unblock zone");

  fireEvent.dragOver(zone, { dataTransfer: dt });
  assert.ok(zone.classList.contains("dex-drop-target"), "hovering the armed zone lights it up");

  fireEvent.drop(zone, { dataTransfer: dt });
  assert.deepEqual(removeBlockerCalls, [{ blockedId: "blocked", blockerId: "blkr" }]);
});

test("an unblocked-row drag leaves the unblock zone inert (no parent blocker to remove)", () => {
  const root = row({ id: "root", name: "Root" });
  const { container } = render(
    <DexProvider>
      <NestedNode task={root} blockerId={undefined as unknown as string} />
      <DexUnblockZone />
    </DexProvider>,
  );
  const node = container.querySelector(".dex-row")!;
  const zone = container.querySelector(".dex-unblock-zone")!;

  const dt = dataTransfer();
  fireEvent.dragStart(node, { dataTransfer: dt });
  assert.equal(
    zone.classList.contains("armed"),
    false,
    "a row with no parent blocker can't arm the remove zone",
  );
  // Even if a drop reaches the inert zone, it removes nothing.
  fireEvent.drop(zone, { dataTransfer: dt });
  assert.deepEqual(removeBlockerCalls, []);
});

test("the unblock zone keeps its byte-equivalent class + label", () => {
  const { container } = render(
    <DexProvider>
      <DexUnblockZone />
    </DexProvider>,
  );
  const zone = container.querySelector(".dex-unblock-zone");
  assert.ok(zone, "expected the unblock zone");
  assert.match(zone!.textContent ?? "", /Drop here to remove this blocker/);
});

test("isValidDexDropTarget rejects no-drag, self-drops, and cross-project drops", () => {
  const target = row({ id: "b", name: "B", project: "repo-1" });
  assert.equal(isValidDexDropTarget(undefined, target), false, "no drag in flight");
  assert.equal(
    isValidDexDropTarget({ id: "b", project: "repo-1", blockerId: undefined }, target),
    false,
    "a self-drop is invalid",
  );
  assert.equal(
    isValidDexDropTarget({ id: "a", project: "repo-2", blockerId: undefined }, target),
    false,
    "a cross-project drop is invalid",
  );
  assert.equal(
    isValidDexDropTarget({ id: "a", project: "repo-1", blockerId: undefined }, target),
    true,
    "a different task in the same project is a valid target",
  );
});
