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
import type { DexEditRequest, PerchBridge } from "../ipc.js";

/** Bridge spies the pane drives (copyText from the tree; dexEdit/dexSpawn from the detail). */
let copyTextCalls: string[];
let dexEditCalls: DexEditRequest[];
let dexSpawnCalls: string[];

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
    return Promise.resolve();
  },
} as unknown as PerchBridge;

beforeEach(() => {
  copyTextCalls = [];
  dexEditCalls = [];
  dexSpawnCalls = [];
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
    <DexPane
      section={section([{ ...initial, displayStatus: "in-progress", health: "warn" }])} />,
  );

  const after = container.querySelector(".dex-edit-description") as HTMLTextAreaElement;
  assert.equal(after, desc, "the same textarea node survives the re-render (not rebuilt)");
  assert.equal(document.activeElement, after, "focus survives the background push");
  assert.equal(after.value, "half-typed thought", "the in-progress draft is not clobbered");
  assert.equal(after.selectionStart, 4, "the caret position survives");
  assert.equal(after.selectionEnd, 4, "the caret position survives");
});
