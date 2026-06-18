/**
 * Behavioral tests for the React Dex pane's tree view (T8a), rendered into a real
 * jsdom DOM via @testing-library/react against a fake `window.perch` bridge.
 * They cover the contract the tree branch of the old imperative `dexSectionEl`
 * owned: the tree renders rows (identity dot, name, id chip, blocker/landable/
 * agent markers) from a pushed {@link DexSection}; the collapse chevron hides +
 * shows an epic's descendants (collapse state is component state, not a global);
 * the id chip copies via `window.perch.copyText` without also opening the row;
 * and selecting a row navigates to the detail seam.
 */
import "./test-dom.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { DexPane } from "./dex-pane.js";
import { dexHealth, type DexRow, type DexSection } from "../dex-state.js";
import type { DexDeleteRequest, DexEditRequest, DexNewRequest, PerchBridge } from "../ipc.js";
import type { DexViewMode } from "../window-state.js";

/** Bridge spies the pane drives: copyText + dexEdit from the tree/detail; the
 *  spawn/delete actions; dexNew from the composer; setDexViewMode from the toggle. */
let copyTextCalls: string[];
let dexEditCalls: DexEditRequest[];
let dexSpawnCalls: string[];
let dexSpawnReadyCalls: number;
let dexDeleteCalls: DexDeleteRequest[];
let dexNewCalls: DexNewRequest[];
let setDexViewModeCalls: DexViewMode[];
/**
 * Pending resolvers for the in-flight action promises — the spawn/delete bridge
 * calls stay pending until {@link settleActions} resolves them, so a test can
 * observe the optimistic in-flight state before the round-trip completes.
 */
let actionResolvers: Array<() => void>;
/** Captured resolver for the in-flight `dexNew` promise, so a test controls when
 *  the author-agent launch settles (drives the optimistic spinner + close-on-success). */
let dexNewResolve: (() => void) | undefined;

/** A fresh promise whose resolver is parked for the test to settle on demand. */
function pending(): Promise<void> {
  return new Promise<void>((resolve) => actionResolvers.push(resolve));
}

/** Resolve every in-flight action promise and flush the resulting state updates. */
async function settleActions(): Promise<void> {
  await act(async () => {
    for (const resolve of actionResolvers.splice(0)) resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const bridge = {
  copyText(text: string) {
    copyTextCalls.push(text);
  },
  dexEdit(request: DexEditRequest) {
    dexEditCalls.push(request);
    return Promise.resolve();
  },
  dexSpawn(id: string) {
    dexSpawnCalls.push(id);
    return pending();
  },
  dexSpawnReady() {
    dexSpawnReadyCalls += 1;
    return pending();
  },
  dexDelete(request: DexDeleteRequest) {
    dexDeleteCalls.push(request);
    return pending();
  },
  dexNew(request: DexNewRequest) {
    dexNewCalls.push(request);
    return new Promise<void>((resolve) => {
      dexNewResolve = resolve;
    });
  },
  setDexViewMode(mode: DexViewMode) {
    setDexViewModeCalls.push(mode);
  },
} as unknown as PerchBridge;

beforeEach(() => {
  copyTextCalls = [];
  dexEditCalls = [];
  dexSpawnCalls = [];
  dexSpawnReadyCalls = 0;
  dexDeleteCalls = [];
  actionResolvers = [];
  dexNewCalls = [];
  dexNewResolve = undefined;
  setDexViewModeCalls = [];
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

test("a hidden section (no dex plugin) renders nothing", () => {
  const { container } = render(<DexPane section={{ ...section([]), visible: false }} />);
  assert.equal(container.firstChild, null);
});

test("an installed-but-empty board shows the empty state", () => {
  const { container } = render(<DexPane section={section([])} />);
  const msg = container.querySelector(".message");
  assert.ok(msg, "expected an empty-state message");
  assert.match(msg!.textContent ?? "", /No open tasks/);
});

test("the tree renders a row's name, identity dot, and click-to-copy id chip", () => {
  const { container } = render(
    <DexPane section={section([row({ id: "abc123", name: "Wire the thing" })])} />,
  );
  const r = container.querySelector(".dex-row");
  assert.ok(r, "expected a task row");
  assert.match(r!.textContent ?? "", /Wire the thing/);
  // An open (ready, unblocked) task leads with the solid identity dot…
  assert.ok(r!.querySelector(".dex-task-dot"), "an open task shows the identity dot");
  // …followed by the click-to-copy id chip carrying the open identity accent.
  const chip = r!.querySelector(".dex-id");
  assert.ok(chip, "expected the id chip");
  assert.equal(chip!.textContent, "abc123");
  assert.equal(chip!.getAttribute("title"), "Copy task id");
  assert.ok(
    chip!.classList.contains("dex-open"),
    "an open task's chip carries the identity accent",
  );
});

test("a blocked task's chip drops the open identity accent and shows a blocker chip", () => {
  const { container } = render(
    <DexPane
      section={section([row({ id: "blk", name: "Blocked", status: "blocked", blockedByCount: 2 })])}
    />,
  );
  const r = container.querySelector(".dex-row")!;
  assert.equal(r.querySelector(".dex-task-dot"), null, "a blocked task has no identity dot");
  assert.equal(
    r.querySelector(".dex-id")!.classList.contains("dex-open"),
    false,
    "a blocked task's chip is not open-accented",
  );
  const blocked = r.querySelector(".chip.bad");
  assert.ok(blocked, "expected a blocker-count chip");
  assert.equal(blocked!.textContent, "blocked ×2");
});

test("clicking the id chip copies the id and does not also open the row's detail", () => {
  const { container } = render(
    <DexPane section={section([row({ id: "copyme", name: "Copy me" })])} />,
  );
  fireEvent.click(container.querySelector(".dex-id")!);
  assert.deepEqual(copyTextCalls, ["copyme"]);
  // stopPropagation: the row's open-detail click must not also fire.
  assert.equal(container.querySelector(".dex-detail"), null, "copying must not open the detail");
  // Inline confirmation replaces the id text.
  assert.equal(container.querySelector(".dex-id")!.textContent, "copied ✓");
});

test("the landable + live-agent markers render for the rows that carry them", () => {
  const rows = [
    row({ id: "land", name: "Landable", landable: "needs-review" }),
    row({
      id: "agent",
      name: "Has agent",
      agent: { sessionId: "s1", state: "running", lastActivity: 1, message: "thinking" },
    }),
    row({ id: "plain", name: "Plain" }),
  ];
  const { container } = render(<DexPane section={section(rows)} />);

  const landable = container.querySelector(".dex-landable");
  assert.ok(landable, "expected a landable chip on the landable row");
  assert.match(landable!.textContent ?? "", /needs review/);

  const agent = container.querySelector(".dex-agent");
  assert.ok(agent, "expected a live-agent marker on the agent row");
  assert.match(agent!.textContent ?? "", /running/);
  // The latest message enriches the tooltip.
  assert.match(agent!.getAttribute("title") ?? "", /Agent running: thinking/);

  // Exactly one of each — the plain row carries neither.
  assert.equal(container.querySelectorAll(".dex-landable").length, 1);
  assert.equal(container.querySelectorAll(".dex-agent").length, 1);
});

test("an unmapped landable state falls back to a neutral chip with the raw label", () => {
  const { container } = render(
    <DexPane
      section={section([
        row({ id: "x", name: "Future", landable: "build-gated" as DexRow["landable"] }),
      ])}
    />,
  );
  const chip = container.querySelector(".dex-landable");
  assert.ok(chip, "an unknown landable state still renders a chip");
  assert.match(chip!.textContent ?? "", /build-gated/);
  assert.ok(chip!.classList.contains("muted"), "the fallback chip uses the neutral tone");
});

test("the collapse chevron hides an epic's descendants, and re-expands them", () => {
  const rows = [
    row({ id: "epic", name: "Epic", isEpic: true, depth: 0 }),
    row({ id: "child", name: "Child task", depth: 1 }),
  ];
  const { container } = render(<DexPane section={section(rows)} />);
  // Both the epic and its child render initially.
  assert.equal(container.querySelectorAll(".dex-row").length, 2);

  const chevron = container.querySelector(".dex-chevron") as HTMLButtonElement;
  assert.ok(chevron, "an epic row has a collapse chevron");
  assert.equal(chevron.title, "Collapse");

  // Collapsing hides the descendant (only the epic remains).
  fireEvent.click(chevron);
  assert.equal(container.querySelectorAll(".dex-row").length, 1);
  assert.match(container.querySelector(".dex-row")!.textContent ?? "", /Epic/);
  assert.equal((container.querySelector(".dex-chevron") as HTMLButtonElement).title, "Expand");

  // Expanding brings the child back.
  fireEvent.click(container.querySelector(".dex-chevron")!);
  assert.equal(container.querySelectorAll(".dex-row").length, 2);
});

test("a leaf row gets an aligning spacer, not a chevron", () => {
  const { container } = render(<DexPane section={section([row({ id: "leaf", name: "Leaf" })])} />);
  const r = container.querySelector(".dex-row")!;
  assert.equal(r.querySelector(".dex-chevron"), null, "a leaf has no chevron");
  assert.ok(r.querySelector(".dex-chevron-spacer"), "a leaf gets an aligning spacer");
});

test("the collapse-all header folds every epic, then unfolds them", () => {
  const rows = [
    row({ id: "e1", name: "Epic 1", isEpic: true, depth: 0 }),
    row({ id: "e1c", name: "E1 child", depth: 1 }),
    row({ id: "e2", name: "Epic 2", isEpic: true, depth: 0 }),
    row({ id: "e2c", name: "E2 child", depth: 1 }),
  ];
  const { container } = render(<DexPane section={section(rows)} />);
  const toggleAll = container.querySelector(".dex-toggle-all") as HTMLButtonElement;
  assert.ok(toggleAll, "expected the collapse-all toggle when there are epics");
  assert.equal(toggleAll.title, "Collapse all");
  assert.equal(container.querySelectorAll(".dex-row").length, 4);

  // Collapse all → both children hidden, only the two epics remain.
  fireEvent.click(toggleAll);
  assert.equal(container.querySelectorAll(".dex-row").length, 2);
  assert.equal(
    (container.querySelector(".dex-toggle-all") as HTMLButtonElement).title,
    "Expand all",
  );

  // Expand all → children return.
  fireEvent.click(container.querySelector(".dex-toggle-all")!);
  assert.equal(container.querySelectorAll(".dex-row").length, 4);
});

test("no collapse-all header renders when there are no epics", () => {
  const { container } = render(
    <DexPane section={section([row({ id: "a", name: "A" }), row({ id: "b", name: "B" })])} />,
  );
  assert.equal(container.querySelector(".dex-toggle-all"), null);
});

test("clicking a row selects it and navigates to the detail seam; back returns", () => {
  const { container } = render(
    <DexPane section={section([row({ id: "sel", name: "Select me" })])} />,
  );
  // Click the row body (not a chip/button) to open the detail.
  fireEvent.click(container.querySelector(".dex-row")!);
  const detail = container.querySelector(".dex-detail");
  assert.ok(detail, "selecting a row shows the detail seam");
  assert.match(detail!.querySelector(".dex-detail-title")!.textContent ?? "", /Select me/);
  // The tree is replaced by the detail while a task is selected.
  assert.equal(container.querySelector(".dex-row"), null);

  // Back clears the selection and returns to the tree.
  fireEvent.click(container.querySelector(".dex-back")!);
  assert.ok(container.querySelector(".dex-row"), "back returns to the tree");
  assert.equal(container.querySelector(".dex-detail"), null);
});

test("a selection whose task disappears falls back to the tree", () => {
  const { container, rerender } = render(
    <DexPane section={section([row({ id: "gone", name: "Going away" })])} />,
  );
  fireEvent.click(container.querySelector(".dex-row")!);
  assert.ok(container.querySelector(".dex-detail"), "row is selected");

  // The task completes/removed and a new board lands without it.
  rerender(<DexPane section={section([row({ id: "other", name: "Other" })])} />);
  assert.equal(container.querySelector(".dex-detail"), null, "the stale selection is dropped");
  assert.match(container.querySelector(".dex-row")!.textContent ?? "", /Other/);
});

// ---------------------------------------------------------------------------
// Task detail view + inline editor
// ---------------------------------------------------------------------------

/** Render the pane and open the given task's detail (click its row). */
function openDetail(...rows: DexRow[]): HTMLElement {
  const { container } = render(<DexPane section={section(rows)} />);
  fireEvent.click(container.querySelector(".dex-row")!);
  return container;
}

test("the detail view renders the task's meta, description, and result", () => {
  const c = openDetail(
    row({
      id: "det1",
      name: "Detailed",
      description: "The full ticket body.",
      status: "done",
      result: "Shipped it.",
      project: "perch",
    }),
  );
  // Meta row: the click-to-copy id chip, the status chip, and the project chip.
  const meta = c.querySelector(".dex-detail-meta")!;
  assert.ok(meta, "expected a meta row");
  assert.equal(meta.querySelector(".dex-id")!.textContent, "det1");
  assert.match(meta.textContent ?? "", /Done/);
  assert.match(meta.textContent ?? "", /perch/);
  // Body + result blocks.
  const bodies = c.querySelectorAll(".dex-detail-body");
  assert.equal(bodies.length, 2, "description + result each render a body block");
  assert.equal(bodies[0]!.textContent, "The full ticket body.");
  assert.match(c.querySelector(".dex-detail-label")!.textContent ?? "", /Result/);
  assert.equal(bodies[1]!.textContent, "Shipped it.");
});

test("a ready, unworked task shows the detail-page spawn button; it spawns", () => {
  const c = openDetail(row({ id: "rdy", name: "Ready one", status: "ready" }));
  const spawn = c.querySelector(".dex-detail-spawn") as HTMLButtonElement;
  assert.ok(spawn, "a ready task shows the detail spawn button");
  fireEvent.click(spawn);
  assert.deepEqual(dexSpawnCalls, ["rdy"]);
});

test("a blocked task shows no spawn button on the detail page", () => {
  const c = openDetail(row({ id: "blk", name: "Blocked", status: "blocked", blockedByCount: 1 }));
  assert.equal(c.querySelector(".dex-detail-spawn"), null);
});

test("the Edit button opens the inline editor seeded from the row", () => {
  const c = openDetail(row({ id: "e1", name: "Edit me", description: "old body" }));
  // Read mode: no inputs yet.
  assert.equal(c.querySelector(".dex-edit-name"), null);
  fireEvent.click(c.querySelector(".dex-edit-btn")!);
  const name = c.querySelector(".dex-edit-name") as HTMLInputElement;
  const desc = c.querySelector(".dex-edit-description") as HTMLTextAreaElement;
  assert.ok(name && desc, "the editor shows a name input and description textarea");
  assert.equal(name.value, "Edit me", "name seeded from the row");
  assert.equal(desc.value, "old body", "description seeded from the row");
  // The read-only title is gone; Save/Cancel replace the Edit button.
  assert.equal(c.querySelector(".dex-detail-title"), null);
  assert.ok(c.querySelector(".dex-edit-save"), "Save control present");
  assert.equal(c.querySelector(".dex-edit-btn"), null, "Edit button hidden in edit mode");
});

test("Save sends only the changed fields via dexEdit and leaves edit mode", async () => {
  const c = openDetail(row({ id: "e2", name: "Before", description: "before body" }));
  fireEvent.click(c.querySelector(".dex-edit-btn")!);
  fireEvent.change(c.querySelector(".dex-edit-name")!, { target: { value: "After" } });
  // Description left untouched, so only the name is sent.
  await act(async () => {
    fireEvent.click(c.querySelector(".dex-edit-save")!);
  });
  assert.deepEqual(dexEditCalls, [{ id: "e2", name: "After" }]);
  // Edit mode closes back to the read-only view.
  assert.equal(c.querySelector(".dex-edit-name"), null, "editor closed after save");
  assert.ok(c.querySelector(".dex-detail-title"), "back to the read-only detail");
});

test("an empty description is sent as a deliberate clear", async () => {
  const c = openDetail(row({ id: "e3", name: "Keep", description: "wipe me" }));
  fireEvent.click(c.querySelector(".dex-edit-btn")!);
  fireEvent.change(c.querySelector(".dex-edit-description")!, { target: { value: "" } });
  await act(async () => {
    fireEvent.click(c.querySelector(".dex-edit-save")!);
  });
  assert.deepEqual(dexEditCalls, [{ id: "e3", description: "" }]);
});

test("a no-op save (nothing changed) closes edit mode without calling dexEdit", () => {
  const c = openDetail(row({ id: "e4", name: "Same", description: "same" }));
  fireEvent.click(c.querySelector(".dex-edit-btn")!);
  fireEvent.click(c.querySelector(".dex-edit-save")!);
  assert.deepEqual(dexEditCalls, [], "nothing changed → no daemon round-trip");
  assert.equal(c.querySelector(".dex-edit-name"), null, "still leaves edit mode");
});

test("a blank name flags the field invalid and does not save", () => {
  const c = openDetail(row({ id: "e5", name: "Has name" }));
  fireEvent.click(c.querySelector(".dex-edit-btn")!);
  fireEvent.change(c.querySelector(".dex-edit-name")!, { target: { value: "   " } });
  fireEvent.click(c.querySelector(".dex-edit-save")!);
  assert.deepEqual(dexEditCalls, [], "a blank name is not persisted");
  const name = c.querySelector(".dex-edit-name") as HTMLInputElement;
  assert.ok(name, "stays in edit mode");
  assert.ok(name.classList.contains("invalid"), "the name field is flagged invalid");
});

test("Cancel discards the draft and returns to the read-only detail", () => {
  const c = openDetail(row({ id: "e6", name: "Original", description: "orig" }));
  fireEvent.click(c.querySelector(".dex-edit-btn")!);
  fireEvent.change(c.querySelector(".dex-edit-name")!, { target: { value: "Edited away" } });
  fireEvent.click(c.querySelector(".dex-edit-cancel")!);
  assert.deepEqual(dexEditCalls, [], "cancel never saves");
  // Re-opening shows the original, not the discarded draft.
  fireEvent.click(c.querySelector(".dex-edit-btn")!);
  assert.equal((c.querySelector(".dex-edit-name") as HTMLInputElement).value, "Original");
});

test("the description keeps focus + caret + draft across a background state push", () => {
  // HEADLINE: typing in the editor survives a board poll's re-render with NO
  // data-focus-key hack — the editor stays mounted, so the textarea isn't rebuilt.
  const initial = row({ id: "focus", name: "Focus task", description: "" });
  const { container, rerender } = render(<DexPane section={section([initial])} />);
  fireEvent.click(container.querySelector(".dex-row")!);
  fireEvent.click(container.querySelector(".dex-edit-btn")!);

  const desc = container.querySelector(".dex-edit-description") as HTMLTextAreaElement;
  desc.focus();
  fireEvent.change(desc, { target: { value: "half-typed thought" } });
  // Put the caret mid-string, as if still typing.
  desc.setSelectionRange(4, 4);
  assert.equal(document.activeElement, desc, "the textarea is focused before the push");

  // A background board poll lands a fresh PanelState — same task, but a NEW row
  // object (and an unrelated field changed) to mimic a real push.
  rerender(
    <DexPane section={section([{ ...initial, displayStatus: "in-progress", health: "warn" }])} />,
  );

  const after = container.querySelector(".dex-edit-description") as HTMLTextAreaElement;
  assert.equal(after, desc, "the same textarea node survives the re-render (not rebuilt)");
  assert.equal(document.activeElement, after, "focus survives the background push");
  assert.equal(after.value, "half-typed thought", "the in-progress draft is not clobbered");
  assert.equal(after.selectionStart, 4, "the caret position survives");
  assert.equal(after.selectionEnd, 4, "the caret position survives");
});

// ---------------------------------------------------------------------------
// Actions: spawn (row + detail), spawn-all-ready, delete — each with the
// optimistic in-flight state that replaces dex.ts's module-global Sets.
// ---------------------------------------------------------------------------

test("the per-row spawn button calls dexSpawn and optimistically disables + spins", async () => {
  const { container } = render(
    <DexPane section={section([row({ id: "rdy", name: "Ready task" })])} />,
  );
  const btn = container.querySelector(".dex-row .dex-spawn") as HTMLButtonElement;
  assert.ok(btn, "a ready, unblocked, unworked row gets a start button");
  assert.equal(btn.disabled, false);
  assert.equal(btn.title, "Start an agent for this task");
  assert.ok(btn.querySelector(".fa-play"), "the idle button shows the play glyph");

  fireEvent.click(btn);
  assert.deepEqual(dexSpawnCalls, ["rdy"], "the click fires dexSpawn for the row's id");
  // stopPropagation: spawning must not also open the row's detail.
  assert.equal(container.querySelector(".dex-detail"), null, "spawning must not open the detail");
  // Optimistic in-flight: disabled + spinner immediately, before the round-trip.
  const spinning = container.querySelector(".dex-row .dex-spawn") as HTMLButtonElement;
  assert.equal(spinning.disabled, true, "the in-flight button is disabled");
  assert.equal(spinning.title, "Starting agent…");
  assert.ok(spinning.querySelector(".fa-spin"), "the in-flight button shows a spinner");

  // The optimistic state clears once the spawn resolves (the next board state then
  // reflects the started task).
  await settleActions();
  const settled = container.querySelector(".dex-row .dex-spawn") as HTMLButtonElement;
  assert.equal(settled.disabled, false, "the spinner clears when the spawn resolves");
  assert.ok(settled.querySelector(".fa-play"), "the button returns to the play glyph");
});

test("the detail-page spawn button spells out the action and runs the same spawn", () => {
  const { container } = render(
    <DexPane section={section([row({ id: "deet", name: "Detail task" })])} />,
  );
  fireEvent.click(container.querySelector(".dex-row")!); // open the detail
  const btn = container.querySelector(".dex-detail-spawn") as HTMLButtonElement;
  assert.ok(btn, "a ready task's detail page carries the labeled spawn twin");
  assert.match(btn.textContent ?? "", /Start agent/);

  fireEvent.click(btn);
  assert.deepEqual(dexSpawnCalls, ["deet"], "the detail button shares the dexSpawn path");
  const spinning = container.querySelector(".dex-detail-spawn") as HTMLButtonElement;
  assert.equal(spinning.disabled, true);
  assert.match(spinning.textContent ?? "", /Starting…/, "it shows the optimistic Starting… label");
});

test("a non-spawnable row (live agent) shows no spawn button but still a delete control", () => {
  const { container } = render(
    <DexPane
      section={section([
        row({
          id: "live",
          name: "Already running",
          agent: { sessionId: "s1", state: "running", lastActivity: 1 },
        }),
      ])}
    />,
  );
  assert.equal(container.querySelector(".dex-spawn"), null, "a worked task isn't spawnable");
  assert.ok(container.querySelector(".dex-delete-btn"), "but every row keeps a delete control");
});

test("the spawn-all-ready button calls dexSpawnReady and shows the Spawning… state", async () => {
  const { container } = render(
    <DexPane
      section={section([
        row({ id: "r1", name: "Ready one" }),
        row({ id: "r2", name: "Ready two" }),
        row({ id: "blk", name: "Blocked", status: "blocked", blockedByCount: 1 }),
      ])}
    />,
  );
  const btn = container.querySelector(".dex-spawn-all") as HTMLButtonElement;
  assert.ok(btn, "the header carries a spawn-all-ready button when tasks are ready");
  // The label carries the ready count (the two ready rows, not the blocked one).
  assert.equal(btn.title, "Spawn agents for 2 ready tasks");

  fireEvent.click(btn);
  assert.equal(dexSpawnReadyCalls, 1, "the click fires dexSpawnReady");
  const spinning = container.querySelector(".dex-spawn-all") as HTMLButtonElement;
  assert.equal(spinning.disabled, true);
  assert.equal(spinning.title, "Spawning 2 ready tasks…");
  assert.ok(spinning.querySelector(".fa-spin"), "the in-flight fleet launch shows a spinner");

  await settleActions();
  const settled = container.querySelector(".dex-spawn-all") as HTMLButtonElement;
  assert.equal(settled.disabled, false, "the spinner clears when the fleet launch resolves");
});

test("the spawn-all-ready button is absent when nothing is ready", () => {
  const { container } = render(
    <DexPane
      section={section([row({ id: "blk", name: "Blocked", status: "blocked", blockedByCount: 1 })])}
    />,
  );
  assert.equal(container.querySelector(".dex-spawn-all"), null, "no ready tasks → no fleet launch");
});

test("the row delete control calls dexDelete and optimistically disables + spins", async () => {
  const { container } = render(
    <DexPane section={section([row({ id: "del", name: "Delete me" })])} />,
  );
  const btn = container.querySelector(".dex-delete-btn") as HTMLButtonElement;
  assert.ok(btn, "every row gets a delete control");
  assert.equal(btn.title, "Delete task");

  fireEvent.click(btn);
  // The renderer just fires the action — the confirm dialog is raised in main.
  assert.deepEqual(
    dexDeleteCalls,
    [{ id: "del", name: "Delete me", warning: undefined }],
    "the click hands the task (id, name, warning) to main",
  );
  // stopPropagation: deleting must not also open the row's detail.
  assert.equal(container.querySelector(".dex-detail"), null, "deleting must not open the detail");
  const spinning = container.querySelector(".dex-delete-btn") as HTMLButtonElement;
  assert.equal(spinning.disabled, true, "the in-flight delete is disabled");
  assert.equal(spinning.title, "Deleting…");
  assert.ok(spinning.querySelector(".fa-spin"), "the in-flight delete shows a spinner");

  // The optimistic state clears when the delete resolves (confirm, decline, or error).
  await settleActions();
  const settled = container.querySelector(".dex-delete-btn") as HTMLButtonElement;
  assert.equal(settled.disabled, false, "the spinner clears when the delete resolves");
});

test("delete carries a warning for an epic (cascading subtasks) and a worked task", () => {
  const { container, rerender } = render(
    <DexPane section={section([row({ id: "epic", name: "Big epic", isEpic: true })])} />,
  );
  fireEvent.click(container.querySelector(".dex-delete-btn")!);
  assert.match(
    dexDeleteCalls[0]!.warning ?? "",
    /subtasks will also be deleted/,
    "an epic's delete warns its subtasks cascade",
  );

  dexDeleteCalls = [];
  rerender(
    <DexPane
      section={section([
        row({
          id: "worked",
          name: "Has a worktree",
          agent: { sessionId: "s1", state: "running", lastActivity: 1 },
        }),
      ])}
    />,
  );
  fireEvent.click(container.querySelector(".dex-delete-btn")!);
  assert.match(
    dexDeleteCalls[0]!.warning ?? "",
    /live worktree\/agent that won't be removed/,
    "a worked task's delete warns the live worktree/agent is orphaned",
  );
});

test("the optimistic in-flight state clears when a push drops the deleted row", async () => {
  const { container, rerender } = render(
    <DexPane section={section([row({ id: "going", name: "Going away" })])} />,
  );
  fireEvent.click(container.querySelector(".dex-delete-btn")!);
  assert.deepEqual(
    dexDeleteCalls.map((r) => r.id),
    ["going"],
  );

  // Main confirms + deletes; the next pushed state no longer lists the task, and
  // the in-flight resolver settles. The pane reconciles to the tree without it —
  // no orphaned spinner.
  rerender(<DexPane section={section([row({ id: "stays", name: "Stays" })])} />);
  await settleActions();
  assert.equal(container.querySelectorAll(".dex-row").length, 1);
  assert.match(container.querySelector(".dex-row")!.textContent ?? "", /Stays/);
});

// ---------------------------------------------------------------------------
// New-task-from-description composer (T8f)
// ---------------------------------------------------------------------------

/** Arm the composer (click the + control) and return its textarea + submit. */
function armComposer(container: HTMLElement): {
  textarea: HTMLTextAreaElement;
  submit: HTMLButtonElement;
} {
  fireEvent.click(container.querySelector(".dex-new")!);
  const composer = container.querySelector(".dex-new-composer");
  assert.ok(composer, "the + control arms the inline composer");
  return {
    textarea: composer!.querySelector(".dex-new-input") as HTMLTextAreaElement,
    submit: composer!.querySelector(".dex-new-submit") as HTMLButtonElement,
  };
}

test("the + control arms the composer; submit calls dexNew with the trimmed description", () => {
  const { container } = render(<DexPane section={section([row({ id: "a", name: "A" })])} />);
  const { textarea, submit } = armComposer(container);

  // An empty draft is a no-op: submit is disabled.
  assert.equal(submit.disabled, true, "an empty draft disables submit");

  // Type a description (with surrounding whitespace to prove it's trimmed on submit).
  fireEvent.change(textarea, { target: { value: "  build the thing  " } });
  assert.equal(submit.disabled, false, "a non-empty draft enables submit");

  fireEvent.click(submit);
  assert.equal(dexNewCalls.length, 1, "submit calls dexNew once");
  assert.equal(dexNewCalls[0]!.description, "build the thing", "the description is trimmed");
});

test("the + control also arms the composer on an empty board (author the first task)", () => {
  const { container } = render(<DexPane section={section([])} />);
  // The empty board still shows the header + its New-task control.
  assert.ok(container.querySelector(".dex-new"), "the empty board still offers the + control");
  assert.match(container.querySelector(".message")!.textContent ?? "", /No open tasks/);
  const { textarea } = armComposer(container);
  fireEvent.change(textarea, { target: { value: "first task" } });
  fireEvent.click(container.querySelector(".dex-new-submit")!);
  assert.equal(dexNewCalls.length, 1, "the first task can be authored from an empty board");
});

test("an empty / whitespace-only description is a no-op (no dexNew call)", () => {
  const { container } = render(<DexPane section={section([row({ id: "a", name: "A" })])} />);
  const { textarea, submit } = armComposer(container);

  fireEvent.change(textarea, { target: { value: "   \n  " } });
  assert.equal(submit.disabled, true, "a whitespace-only draft keeps submit disabled");
  // Enter on the textarea must also no-op for a whitespace-only draft.
  fireEvent.keyDown(textarea, { key: "Enter" });
  assert.equal(dexNewCalls.length, 0, "a whitespace-only Enter does not call dexNew");
});

test("Enter submits, and a submit shows an in-flight spinner + disables the controls", () => {
  const { container } = render(<DexPane section={section([row({ id: "a", name: "A" })])} />);
  const { textarea } = armComposer(container);

  fireEvent.change(textarea, { target: { value: "go" } });
  fireEvent.keyDown(textarea, { key: "Enter" });
  assert.equal(dexNewCalls.length, 1, "Enter submits");

  // Optimistic feedback: while the (still-pending) launch is in flight the submit
  // spins and the textarea + cancel disable, so a double-submit can't fire.
  const composer = container.querySelector(".dex-new-composer")!;
  assert.ok(composer.querySelector(".dex-new-submit .fa-spin"), "submit spins while in flight");
  assert.equal((composer.querySelector(".dex-new-input") as HTMLTextAreaElement).disabled, true);
  assert.equal((composer.querySelector(".dex-new-cancel") as HTMLButtonElement).disabled, true);
});

test("a successful submit closes the composer (the new task arrives via the next push)", async () => {
  const { container } = render(<DexPane section={section([row({ id: "a", name: "A" })])} />);
  const { textarea, submit } = armComposer(container);
  fireEvent.change(textarea, { target: { value: "go" } });
  fireEvent.click(submit);
  assert.ok(container.querySelector(".dex-new-composer"), "composer stays open while in flight");

  // The author-agent launch settles → the composer closes (and its draft is gone).
  await act(async () => {
    dexNewResolve!();
  });
  assert.equal(container.querySelector(".dex-new-composer"), null, "success closes the composer");
});

test("the composer keeps focus + caret + draft across a background state push", () => {
  const { container, rerender } = render(
    <DexPane section={section([row({ id: "a", name: "A" })])} />,
  );
  const { textarea } = armComposer(container);
  // Arming grabs focus once (no data-focus-key needed — the node stays mounted).
  assert.equal(document.activeElement, textarea, "arming focuses the textarea");

  fireEvent.change(textarea, { target: { value: "half typed" } });
  // Caret parked in the middle of the draft.
  textarea.setSelectionRange(4, 4);

  // A background board poll pushes a fresh PanelState (new section reference, an
  // extra task) — the periodic re-render the old code fought with data-focus-key.
  rerender(
    <DexPane section={section([row({ id: "a", name: "A" }), row({ id: "b", name: "B" })])} />,
  );

  const after = container.querySelector(".dex-new-input") as HTMLTextAreaElement;
  assert.equal(after, textarea, "the textarea node is not remounted by the push");
  assert.equal(document.activeElement, after, "focus survives the push");
  assert.equal(after.value, "half typed", "the draft survives the push");
  assert.equal(after.selectionStart, 4, "the caret survives the push");
  assert.equal(after.selectionEnd, 4);
  // The composer carries no data-focus-key — React keeps the node mounted instead.
  assert.equal(
    after.getAttribute("data-focus-key"),
    null,
    "focus survival is structural, not via data-focus-key",
  );
});

test("the cancel (✗) control closes the composer and discards the draft", () => {
  const { container } = render(<DexPane section={section([row({ id: "a", name: "A" })])} />);
  const { textarea } = armComposer(container);
  fireEvent.change(textarea, { target: { value: "throwaway" } });

  fireEvent.click(container.querySelector(".dex-new-cancel")!);
  assert.equal(container.querySelector(".dex-new-composer"), null, "cancel closes the composer");

  // Re-arming starts from a blank draft (the previous one was discarded).
  const reopened = armComposer(container);
  assert.equal(reopened.textarea.value, "", "re-arming starts from a blank draft");
});

// ---------------------------------------------------------------------------
// View-mode toggle (tree ↔ graph) + the dependency-graph view
// ---------------------------------------------------------------------------

test("the toggle defaults to tree view and offers to switch to the graph", () => {
  const { container } = render(<DexPane section={section([row({ id: "a", name: "A" })])} />);
  const toggle = container.querySelector(".dex-view-toggle") as HTMLButtonElement;
  assert.ok(toggle, "expected the view-mode toggle in the header");
  // In tree view the button offers the graph; the tree rows (not graph rows) show.
  assert.equal(toggle.title, "Switch to graph view");
  assert.ok(container.querySelector(".dex-row"), "tree rows render by default");
  assert.equal(container.querySelector(".dex-graph-row"), null, "no graph rows in tree view");
});

test("clicking the toggle switches tree↔graph and persists each flip", () => {
  const { container } = render(<DexPane section={section([row({ id: "a", name: "A" })])} />);
  const toggle = (): HTMLButtonElement =>
    container.querySelector(".dex-view-toggle") as HTMLButtonElement;

  // Tree → graph: the graph branch renders and the new mode is persisted.
  fireEvent.click(toggle());
  assert.equal(toggle().title, "Switch to tree view", "the toggle now offers the tree");
  assert.ok(container.querySelector(".dex-graph-row"), "graph rows render after the switch");
  assert.deepEqual(setDexViewModeCalls, ["graph"]);

  // Graph → tree: back to the tree, persisting again.
  fireEvent.click(toggle());
  assert.equal(toggle().title, "Switch to graph view");
  assert.equal(container.querySelector(".dex-graph-row"), null, "tree rows return");
  assert.deepEqual(setDexViewModeCalls, ["graph", "tree"]);
});

test("the view mode seeds from savedViewMode, then the toggle owns it", () => {
  const { container } = render(
    <DexPane section={section([row({ id: "a", name: "A" })])} savedViewMode="graph" />,
  );
  // Seeded into graph view from the persisted mode — no flash of the tree.
  assert.ok(container.querySelector(".dex-graph-row"), "seeds into graph from savedViewMode");
  assert.equal(
    (container.querySelector(".dex-view-toggle") as HTMLButtonElement).title,
    "Switch to tree view",
  );

  // Once toggled, the component owns the mode (overrides the seed).
  fireEvent.click(container.querySelector(".dex-view-toggle")!);
  assert.equal(container.querySelector(".dex-graph-row"), null, "the toggle now owns the mode");
  assert.ok(container.querySelector(".dex-row"), "switched to the tree");
  assert.deepEqual(setDexViewModeCalls, ["tree"]);
});

test("graph mode renders the dependency forest: roots, with blocked tasks nested under blockers", () => {
  const rows = [
    row({ id: "root", name: "Unblocked root" }),
    row({
      id: "dep",
      name: "Blocked dependent",
      status: "blocked",
      blockedByCount: 1,
      blockedBy: ["root"],
    }),
  ];
  const { container } = render(<DexPane section={section(rows)} savedViewMode="graph" />);

  const graphRows = container.querySelectorAll(".dex-graph-row");
  assert.equal(graphRows.length, 2, "the root plus its one nested dependent");
  // The unblocked task is a top-level root (not nested).
  assert.match(graphRows[0]!.textContent ?? "", /Unblocked root/);
  assert.equal(graphRows[0]!.classList.contains("dex-graph-nested"), false, "a root is not nested");
  // The blocked task nests under its blocker.
  assert.match(graphRows[1]!.textContent ?? "", /Blocked dependent/);
  assert.ok(
    graphRows[1]!.classList.contains("dex-graph-nested"),
    "a dependent nests under its blocker",
  );
  // The nested row still carries the shared row vocabulary (here, its blocker chip).
  assert.match(graphRows[1]!.textContent ?? "", /blocked ×1/);
});

test("a graph node opens the task detail when clicked", () => {
  const { container } = render(
    <DexPane section={section([row({ id: "g", name: "Graph node" })])} savedViewMode="graph" />,
  );
  fireEvent.click(container.querySelector(".dex-graph-row")!);
  const detail = container.querySelector(".dex-detail");
  assert.ok(detail, "clicking a graph node opens its detail");
  assert.match(detail!.querySelector(".dex-detail-title")!.textContent ?? "", /Graph node/);
});

test("a graph node's id chip copies without opening the detail", () => {
  const { container } = render(
    <DexPane section={section([row({ id: "gcopy", name: "Copy" })])} savedViewMode="graph" />,
  );
  fireEvent.click(container.querySelector(".dex-graph-row .dex-id")!);
  assert.deepEqual(copyTextCalls, ["gcopy"]);
  assert.equal(container.querySelector(".dex-detail"), null, "copying must not open the detail");
});

test("graph mode hides the collapse-all control even when epics exist", () => {
  const rows = [
    row({ id: "epic", name: "Epic", isEpic: true, depth: 0 }),
    row({ id: "child", name: "Child", depth: 1 }),
  ];
  const { container } = render(<DexPane section={section(rows)} savedViewMode="graph" />);
  // The collapse-all toggle is a tree-only affordance — the graph has no
  // collapsible epics — but the view toggle stays put.
  assert.equal(container.querySelector(".dex-toggle-all"), null, "no collapse-all in graph mode");
  assert.ok(container.querySelector(".dex-view-toggle"), "the view toggle remains in graph mode");
});
