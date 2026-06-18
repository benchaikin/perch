/**
 * Behavioral tests for the React {@link WorktreesPane}, rendered into a real
 * jsdom DOM via @testing-library/react against a fake `window.perch` bridge.
 * They cover the contract the old imperative `worktreesSectionEl` owned: rows
 * render from a pushed {@link WorktreesSection} with their load-bearing class
 * names (branch, health dot, `main` tag, the state chips); a row click calls
 * `window.perch.worktreeOpen` with the worktree path; the linked dex task shows
 * as a status-only `worktree-task` chip (no duplicated id/name) plus the shared
 * identity dot when open; multi-repo rows group under collapsible repo headers
 * whose toggle (component state, not a global) hides the rows without opening a
 * worktree; and a hidden section renders nothing.
 */
import "./test-dom.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { WorktreesPane } from "./worktrees.js";
import type { WorktreeRepoGroup, WorktreeRow, WorktreesSection } from "../worktrees-state.js";
import type { LinkedTask } from "../worktree-task-link.js";
import type { PerchBridge } from "../ipc.js";

/** Records the path of every worktree the rows ask to open. */
let worktreeOpenCalls: string[];

const bridge = {
  worktreeOpen(path: string) {
    worktreeOpenCalls.push(path);
  },
} as unknown as PerchBridge;

beforeEach(() => {
  worktreeOpenCalls = [];
  (globalThis as unknown as { window: { perch: PerchBridge } }).window.perch = bridge;
});

afterEach(() => cleanup());

/** A worktree row with sensible defaults; override the fields a test cares about. */
function wtRow(over: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    path: "/wt/feature",
    name: "feature",
    branch: "feature",
    detached: false,
    main: false,
    dirty: false,
    dirtyCount: 0,
    conflict: false,
    locked: false,
    prunable: false,
    health: "ok",
    ...over,
  };
}

/** A linked dex task facet for the row's status chip. */
function task(over: Partial<LinkedTask> = {}): LinkedTask {
  return {
    id: "abc123",
    name: "Do the thing",
    status: "in-progress",
    blockedByCount: 0,
    ...over,
  };
}

/** A flat (single-repo) section from the given rows. */
function flatSection(rows: WorktreeRow[]): WorktreesSection {
  return {
    visible: true,
    rows,
    counts: { total: rows.length, dirty: 0, conflict: 0 },
    multiRepo: false,
    repoGroups: [],
  };
}

/** A repo group from a repo name + its rows. */
function group(repo: string, rows: WorktreeRow[]): WorktreeRepoGroup {
  return { repo, rows, health: "ok", count: rows.length, dirtyCount: 0, hasConflict: false };
}

test("renders one row per worktree with its branch, health dot, and main tag", () => {
  const { container } = render(
    <WorktreesPane
      section={flatSection([
        wtRow({ path: "/wt/main", name: "perch", branch: "main", main: true }),
        wtRow({ path: "/wt/feature", branch: "feature", health: "warn" }),
      ])}
    />,
  );

  const rows = container.querySelectorAll(".worktree-row");
  assert.equal(rows.length, 2);
  const branches = [...container.querySelectorAll(".worktree-row .branch")].map(
    (n) => n.textContent,
  );
  assert.deepEqual(branches, ["main", "feature"]);
  // The first row carries the `main` tag; the health classes ride the dots.
  assert.equal(container.querySelector(".worktree-row .chip.muted")?.textContent, "main");
  assert.ok(container.querySelector(".worktree-row .dot.ok"));
  assert.ok(container.querySelector(".worktree-row .dot.warn"));
});

test("a detached worktree falls back to the (detached) label", () => {
  const { container } = render(
    <WorktreesPane section={flatSection([wtRow({ branch: undefined, detached: true })])} />,
  );
  assert.equal(container.querySelector(".worktree-row .branch")?.textContent, "(detached)");
});

test("clicking a row opens its worktree directory via worktreeOpen(path)", () => {
  const { container } = render(
    <WorktreesPane section={flatSection([wtRow({ path: "/wt/feature" })])} />,
  );
  fireEvent.click(container.querySelector(".worktree-row")!);
  assert.deepEqual(worktreeOpenCalls, ["/wt/feature"]);
});

test("a linked open task shows the identity dot + a status-only worktree-task chip", () => {
  const { container } = render(
    <WorktreesPane
      section={flatSection([
        wtRow({ task: task({ id: "abc123", status: "in-progress", blockedByCount: 0 }) }),
      ])}
    />,
  );

  // The shared identity dot leads the chips for an open task.
  assert.ok(container.querySelector(".worktree-row .dex-task-dot"), "open task leads with its dot");
  const chip = container.querySelector(".worktree-task");
  assert.ok(chip, "the linked-task chip renders");
  // Status-only: the chip text is just the status token, not the id or name.
  assert.equal(chip.textContent, "🗒 In progress");
  assert.ok(!chip.textContent?.includes("abc123"));
  assert.ok(!chip.textContent?.includes("Do the thing"));
  // The full id + name + status live in the tooltip.
  assert.equal(chip.getAttribute("title"), "abc123 · Do the thing — In progress");
  // An open task carries its identity-color accent (in-progress → warn tone).
  assert.ok(chip.classList.contains("dex-open"));
  assert.ok(chip.classList.contains("warn"));
});

test("a blocked task chip keeps its plain status tone (no identity accent or dot)", () => {
  const { container } = render(
    <WorktreesPane
      section={flatSection([wtRow({ task: task({ status: "blocked", blockedByCount: 2 }) })])}
    />,
  );
  const chip = container.querySelector(".worktree-task")!;
  assert.equal(chip.textContent, "🗒 Blocked");
  assert.ok(chip.classList.contains("bad"), "blocked → bad tone");
  assert.ok(!chip.classList.contains("dex-open"), "a blocked task gets no identity accent");
  assert.equal(
    container.querySelector(".dex-task-dot"),
    null,
    "no identity dot for a non-open task",
  );
});

test("dirty / conflict / ahead-behind / prunable each render their chip", () => {
  const { container } = render(
    <WorktreesPane
      section={flatSection([
        wtRow({ dirty: true, dirtyCount: 3, conflict: true, ahead: 2, behind: 1, prunable: true }),
      ])}
    />,
  );
  const chips = [...container.querySelectorAll(".worktree-row .chips .chip")].map(
    (n) => n.textContent,
  );
  assert.ok(chips.includes("●3"), "dirty count chip");
  assert.ok(chips.includes("conflict"), "conflict chip");
  assert.ok(chips.includes("↑2 ↓1"), "ahead/behind chip");
  assert.ok(chips.includes("prunable"), "prunable chip");
});

test("multi-repo rows group under collapsible headers whose toggle hides the rows", () => {
  const section: WorktreesSection = {
    visible: true,
    rows: [wtRow({ path: "/a/1", repo: "alpha" }), wtRow({ path: "/b/1", repo: "beta" })],
    counts: { total: 2, dirty: 0, conflict: 0 },
    multiRepo: true,
    repoGroups: [
      group("alpha", [wtRow({ path: "/a/1", repo: "alpha" })]),
      group("beta", [wtRow({ path: "/b/1", repo: "beta" })]),
    ],
  };
  const { container } = render(<WorktreesPane section={section} />);

  const headers = container.querySelectorAll(".worktree-repo-header-btn");
  assert.equal(headers.length, 2);
  assert.equal(container.querySelectorAll(".worktree-row").length, 2);

  // Collapsing the first repo hides only its rows; the chevron flips to "right".
  fireEvent.click(headers[0]!);
  assert.equal(container.querySelectorAll(".worktree-row").length, 1);
  assert.ok(
    headers[0]!.querySelector(".fa-chevron-right"),
    "collapsed header shows a right chevron",
  );
  // Toggling a repo header never opens a worktree (click is stopped from bubbling).
  assert.equal(worktreeOpenCalls.length, 0);

  // Expanding again restores the rows.
  fireEvent.click(headers[0]!);
  assert.equal(container.querySelectorAll(".worktree-row").length, 2);
});

test("a hidden section renders nothing", () => {
  const { container } = render(
    <WorktreesPane
      section={{
        visible: false,
        rows: [],
        counts: { total: 0, dirty: 0, conflict: 0 },
        multiRepo: false,
        repoGroups: [],
      }}
    />,
  );
  assert.equal(container.querySelector(".worktrees-section"), null);
  assert.equal(container.textContent, "");
});
