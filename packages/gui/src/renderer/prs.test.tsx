/**
 * Behavioral tests for the React PRs pane, rendered into a real jsdom DOM via
 * @testing-library/react against a fake `window.perch` bridge. They cover the
 * pane contract the old imperative `prs.ts` owned: which per-PR action buttons
 * show for a given row (gated by availability + standalone-vs-stacked), that a
 * button click fires the right bridge action AND is stopped from also opening
 * the PR (stopPropagation), and the loading/empty/error placeholders.
 */
import "./test-dom.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PrsPane } from "./prs.js";
import { buildPanelState } from "../panel-state.js";
import type { BuildInput, PrInfo, PanelState } from "../panel-state.js";
import type { PerchBridge } from "../ipc.js";

/** Spies for the bridge actions the pane drives. */
let openPrCalls: string[];
let resolveConflictsCalls: unknown[];
let openAgentCalls: unknown[];
let mergePrCalls: unknown[];
let syncCalls: string[];

// One stable bridge object (the actions surface reads `window.perch` lazily per
// call); its methods record into the per-test `let`s above.
const bridge = {
  openPr(url: string) {
    openPrCalls.push(url);
  },
  resolveConflicts(req: unknown) {
    resolveConflictsCalls.push(req);
    return Promise.resolve();
  },
  openAgent(req: unknown) {
    openAgentCalls.push(req);
    return Promise.resolve();
  },
  mergePr(req: unknown) {
    mergePrCalls.push(req);
    return Promise.resolve();
  },
  sync(repo: string) {
    syncCalls.push(repo);
  },
} as unknown as PerchBridge;

beforeEach(() => {
  openPrCalls = [];
  resolveConflictsCalls = [];
  openAgentCalls = [];
  mergePrCalls = [];
  syncCalls = [];
  (globalThis as unknown as { window: { perch: PerchBridge } }).window.perch = bridge;
});

afterEach(() => cleanup());

/** All four per-PR actions present, daemon up — the maximal gating context. */
const ALL_ACTIONS: Partial<BuildInput> = {
  daemonUp: true,
  syncAvailable: true,
  resolveConflictsAvailable: true,
  openAgentAvailable: true,
  mergePrAvailable: true,
};

/** A clean, one-click-mergeable PR. */
function mergeablePr(over: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 8,
    title: "Add a thing",
    url: "https://example.com/pr/8",
    headRefName: "feat/add-thing",
    baseRefName: "main",
    mergeable: "MERGEABLE",
    ciStatus: "pass",
    reviewDecision: "APPROVED",
    ...over,
  };
}

/** A conflicting PR (not mergeable). */
function conflictingPr(over: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 7,
    title: "Fix a thing",
    url: "https://example.com/pr/7",
    headRefName: "feat/fix-thing",
    baseRefName: "main",
    mergeable: "CONFLICTING",
    conflict: true,
    ...over,
  };
}

/** Build an `ok` PanelState wrapping one repo's groups. */
function stateWith(
  groups: NonNullable<BuildInput["overview"]>["repos"][number]["groups"],
  input: Partial<BuildInput> = ALL_ACTIONS,
): PanelState {
  return buildPanelState({
    daemonUp: true,
    syncAvailable: false,
    ...input,
    overview: { repos: [{ name: "acme/web", groups }] },
  });
}

test("a conflicting standalone row shows Resolve + Open agent, not Merge", () => {
  const { container } = render(
    <PrsPane state={stateWith([{ kind: "pr", pr: conflictingPr() }])} />,
  );
  assert.ok(
    container.querySelector(".resolve-conflicts-btn"),
    "expected a Resolve conflicts button",
  );
  assert.ok(container.querySelector(".open-agent-btn"), "expected an Open agent button");
  assert.equal(container.querySelector(".merge-pr-btn"), null, "a conflicting PR is not mergeable");
});

test("clicking Resolve fires the action and does not also open the PR", () => {
  const { container } = render(
    <PrsPane state={stateWith([{ kind: "pr", pr: conflictingPr() }])} />,
  );
  fireEvent.click(container.querySelector(".resolve-conflicts-btn")!);
  assert.deepEqual(resolveConflictsCalls, [
    { headRefName: "feat/fix-thing", baseRefName: "main", repo: "acme/web", number: 7 },
  ]);
  // stopPropagation: the row's open-in-browser handler must not also fire.
  assert.deepEqual(openPrCalls, []);
});

test("clicking Open agent fires the action and does not also open the PR", () => {
  const { container } = render(
    <PrsPane state={stateWith([{ kind: "pr", pr: conflictingPr() }])} />,
  );
  fireEvent.click(container.querySelector(".open-agent-btn")!);
  assert.deepEqual(openAgentCalls, [
    { headRefName: "feat/fix-thing", repo: "acme/web", number: 7 },
  ]);
  assert.deepEqual(openPrCalls, []);
});

test("a mergeable standalone row shows a Merge button that fires the merge action", () => {
  const { container } = render(<PrsPane state={stateWith([{ kind: "pr", pr: mergeablePr() }])} />);
  const merge = container.querySelector(".merge-pr-btn");
  assert.ok(merge, "expected a Merge button on a mergeable standalone PR");
  // No conflict → no Resolve button.
  assert.equal(container.querySelector(".resolve-conflicts-btn"), null);

  fireEvent.click(merge!);
  assert.deepEqual(mergePrCalls, [{ number: 8, repo: "acme/web", headRefName: "feat/add-thing" }]);
  assert.deepEqual(openPrCalls, []);
});

test("clicking a PR row (off the buttons) opens it in the browser", () => {
  const { container } = render(<PrsPane state={stateWith([{ kind: "pr", pr: mergeablePr() }])} />);
  fireEvent.click(container.querySelector(".row")!);
  assert.deepEqual(openPrCalls, ["https://example.com/pr/8"]);
});

test("a stacked layer never gets a per-layer Merge button", () => {
  const layers = [
    mergeablePr({ number: 1, headRefName: "feat/base", title: "base" }),
    mergeablePr({ number: 2, headRefName: "feat/tip", title: "tip" }),
  ];
  const { container } = render(
    <PrsPane state={stateWith([{ kind: "stack", layers, tracked: true }])} />,
  );
  // Both mergeable layers render, but neither offers a per-layer Merge.
  assert.equal(container.querySelectorAll(".row").length, 2);
  assert.equal(container.querySelector(".merge-pr-btn"), null, "stacked layers merge bottom-up");
  // The stack-wide Sync button shows for a tracked stack.
  const sync = container.querySelector(".stack-head button");
  assert.ok(sync, "expected the stack-wide Sync button");
  fireEvent.click(sync!);
  assert.deepEqual(syncCalls, ["acme/web"]);
  // Layers are numbered base-first (1..N).
  assert.deepEqual(
    [...container.querySelectorAll(".num")].map((n) => n.textContent),
    ["1", "2"],
  );
});

test("an in-flight action shows a disabled spinner button", () => {
  const state = stateWith([{ kind: "pr", pr: conflictingPr() }], {
    ...ALL_ACTIONS,
    resolvingConflicts: ["feat/fix-thing"],
  });
  const { container } = render(<PrsPane state={state} />);
  const btn = container.querySelector(".resolve-conflicts-btn") as HTMLButtonElement;
  assert.ok(btn.disabled, "an in-flight resolve button is disabled");
  assert.ok(btn.querySelector(".fa-spin"), "an in-flight resolve button shows a spinner");
});

test("the review-comment and needs-rebase badges render when warranted", () => {
  const pr = mergeablePr({ humanReviewCommentCount: 2, needsRebase: true });
  const { container } = render(<PrsPane state={stateWith([{ kind: "pr", pr }])} />);
  const comments = container.querySelector(".badge.reviewcomments");
  assert.ok(comments, "expected a review-comment badge");
  assert.ok(comments!.classList.contains("many"), "count > 1 emphasizes the badge");
  assert.equal(comments!.textContent, " 2");
  assert.ok(container.querySelector(".badge.rebase"), "expected a needs-rebase badge");
});

test("a repo header is a collapsible button that hides/shows its groups", () => {
  const { container } = render(
    <PrsPane
      state={stateWith([
        { kind: "pr", pr: mergeablePr() },
        { kind: "pr", pr: conflictingPr() },
      ])}
    />,
  );
  const header = container.querySelector(".pr-repo-header-btn") as HTMLButtonElement;
  assert.ok(header, "expected a collapsible repo header button");
  // Expanded: a down chevron, a PR-count chip, and both rows.
  assert.ok(header.querySelector(".fa-chevron-down"), "expanded header shows a down chevron");
  assert.equal(container.querySelector(".pr-repo-count")?.textContent, "2");
  assert.equal(container.querySelectorAll(".row").length, 2);

  // Collapsing hides the rows and flips the chevron to "right".
  fireEvent.click(header);
  assert.equal(container.querySelectorAll(".row").length, 0);
  assert.ok(header.querySelector(".fa-chevron-right"), "collapsed header shows a right chevron");
  // Toggling the header never opens a PR (click is stopped from bubbling).
  assert.deepEqual(openPrCalls, []);

  // Expanding restores the rows.
  fireEvent.click(header);
  assert.equal(container.querySelectorAll(".row").length, 2);
});

test("a repo's error note stays visible when the repo is collapsed", () => {
  const state = buildPanelState({
    daemonUp: true,
    syncAvailable: false,
    overview: {
      repos: [
        { name: "acme/web", error: "lookup failed", groups: [{ kind: "pr", pr: mergeablePr() }] },
      ],
    },
  });
  const { container } = render(<PrsPane state={state} />);
  const header = container.querySelector(".pr-repo-header-btn") as HTMLButtonElement;
  assert.ok(container.querySelector(".repo-error"), "expected the error note while expanded");

  fireEvent.click(header);
  // The groups hide, but the failure note must remain reachable.
  assert.equal(container.querySelectorAll(".row").length, 0);
  assert.ok(
    container.querySelector(".repo-error"),
    "the error note stays visible when the repo is collapsed",
  );
});

test("loading status renders the spinner placeholder", () => {
  const state = buildPanelState({ daemonUp: true, syncAvailable: false });
  assert.equal(state.status, "loading");
  const { container } = render(<PrsPane state={state} />);
  assert.match(container.textContent ?? "", /Loading…/);
  assert.ok(container.querySelector(".fa-spin"), "loading shows a spinner");
});

test("empty status renders a plain centered message", () => {
  const state = buildPanelState({ daemonUp: true, syncAvailable: false, overview: { repos: [] } });
  assert.equal(state.status, "empty");
  const { container } = render(<PrsPane state={state} />);
  const msg = container.querySelector(".message");
  assert.ok(msg, "expected a message element");
  assert.equal(msg!.className, "message");
  assert.match(msg!.textContent ?? "", /No open PRs/);
});

test("daemon-down status renders an error-styled message", () => {
  const state = buildPanelState({ daemonUp: false, syncAvailable: false });
  assert.equal(state.status, "daemon-down");
  const { container } = render(<PrsPane state={state} />);
  const msg = container.querySelector(".message");
  assert.ok(msg, "expected a message element");
  assert.ok(msg!.classList.contains("error"), "daemon-down is error-styled");
});
