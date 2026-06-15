/**
 * Unit tests for the Electron-free panel-state derivation. This is the bulk of
 * the GUI's testable logic; the Electron wiring (tray/window/IPC) is verified by
 * manual launch (see README).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPanelState,
  ciChip,
  mergeableChip,
  reviewChip,
  toPrRow,
  type PrOverview,
} from "./panel-state.js";

test("ciChip maps each status to a tone", () => {
  assert.equal(ciChip("pass").tone, "ok");
  assert.equal(ciChip("fail").tone, "bad");
  assert.equal(ciChip("pending").tone, "warn");
  assert.equal(ciChip("none").tone, "muted");
});

test("ciChip shows a spinning arrows-spin icon while CI is building", () => {
  const pending = ciChip("pending");
  assert.equal(pending.icon, "arrows-spin");
  assert.equal(pending.spin, true);
  // Settled states stay plain text (no icon).
  assert.equal(ciChip("pass").icon, undefined);
  assert.equal(ciChip("none").icon, undefined);
});

test("reviewChip maps decisions and omits when absent", () => {
  assert.equal(reviewChip("APPROVED")?.tone, "ok");
  assert.equal(reviewChip("CHANGES_REQUESTED")?.tone, "bad");
  assert.equal(reviewChip("REVIEW_REQUIRED")?.tone, "warn");
  assert.equal(reviewChip(undefined), undefined);
});

test("mergeableChip only chips conflicting/unknown, not clean", () => {
  assert.equal(mergeableChip("CONFLICTING")?.tone, "bad");
  assert.equal(mergeableChip("UNKNOWN")?.tone, "muted");
  assert.equal(mergeableChip("MERGEABLE"), undefined);
  assert.equal(mergeableChip(undefined), undefined);
});

const basePr = {
  number: 1,
  title: "Add API",
  url: "https://github.com/o/r/pull/1",
  headRefName: "add-api",
  baseRefName: "main",
};

test("toPrRow always includes a CI chip and applies defaults", () => {
  const row = toPrRow({ ...basePr });
  assert.equal(row.branch, "add-api");
  assert.equal(row.number, 1);
  assert.equal(row.url, "https://github.com/o/r/pull/1");
  assert.equal(row.needsRebase, false);
  assert.equal(row.conflict, false);
  assert.equal(row.chips.length, 1);
  assert.equal(row.chips[0]?.label, "· CI");
});

test("toPrRow carries the human review-comment count, defaulting to 0", () => {
  assert.equal(toPrRow({ ...basePr }).humanReviewCommentCount, 0);
  assert.equal(toPrRow({ ...basePr, humanReviewCommentCount: 3 }).humanReviewCommentCount, 3);
});

test("toPrRow accumulates review + mergeable chips and badges", () => {
  const row = toPrRow({
    ...basePr,
    ciStatus: "pass",
    reviewDecision: "REVIEW_REQUIRED",
    mergeable: "CONFLICTING",
    needsRebase: true,
    conflict: true,
  });
  assert.equal(row.needsRebase, true);
  assert.equal(row.conflict, true);
  // CI + review + mergeable.
  assert.deepEqual(
    row.chips.map((c) => c.tone),
    ["ok", "warn", "bad"],
  );
});

test("PR health is bad on CI fail / conflict / needs-rebase / changes, else ok", () => {
  assert.equal(toPrRow({ ...basePr }).health, "ok");
  assert.equal(toPrRow({ ...basePr, ciStatus: "pending" }).health, "ok");
  assert.equal(toPrRow({ ...basePr, reviewDecision: "APPROVED" }).health, "ok");
  assert.equal(toPrRow({ ...basePr, ciStatus: "fail" }).health, "bad");
  assert.equal(toPrRow({ ...basePr, conflict: true }).health, "bad");
  assert.equal(toPrRow({ ...basePr, needsRebase: true }).health, "bad");
  assert.equal(toPrRow({ ...basePr, reviewDecision: "CHANGES_REQUESTED" }).health, "bad");
});

test("PR health is warn when there are review comments but nothing blocking", () => {
  // Comments to address, CI green + approved → amber, not green.
  assert.equal(
    toPrRow({ ...basePr, ciStatus: "pass", reviewDecision: "APPROVED", humanReviewCommentCount: 2 })
      .health,
    "warn",
  );
  // A blocking problem outranks comments → red, not amber.
  assert.equal(toPrRow({ ...basePr, ciStatus: "fail", humanReviewCommentCount: 2 }).health, "bad");
  assert.equal(
    toPrRow({ ...basePr, reviewDecision: "CHANGES_REQUESTED", humanReviewCommentCount: 2 }).health,
    "bad",
  );
});

test("stack health is warn when any layer (or the stack) needs attention", () => {
  const stackOverview = (tip: Partial<typeof basePr> & Record<string, unknown>): PrOverview => ({
    repos: [
      {
        name: "r",
        groups: [
          {
            kind: "stack",
            tracked: true,
            needsRebase: false,
            layers: [
              { ...basePr, number: 1, headRefName: "a", baseRefName: "main" },
              { ...basePr, number: 2, headRefName: "b", baseRefName: "a", ...tip },
            ],
          },
        ],
      },
    ],
  });
  const clean = buildPanelState({
    overview: stackOverview({}),
    daemonUp: true,
    syncAvailable: true,
  }).repos[0]!.groups[0]!;
  const dirty = buildPanelState({
    overview: stackOverview({ ciStatus: "fail" }),
    daemonUp: true,
    syncAvailable: true,
  }).repos[0]!.groups[0]!;
  const warned = buildPanelState({
    overview: stackOverview({ humanReviewCommentCount: 2 }),
    daemonUp: true,
    syncAvailable: true,
  }).repos[0]!.groups[0]!;
  if (clean.kind !== "stack" || dirty.kind !== "stack" || warned.kind !== "stack")
    throw new Error("expected stacks");
  assert.equal(clean.health, "ok");
  assert.equal(dirty.health, "bad");
  // A layer with comments (nothing blocking) takes the bar to amber.
  assert.equal(warned.health, "warn");
});

test("buildPanelState surfaces a daemon-down state without crashing", () => {
  const state = buildPanelState({ daemonUp: false, syncAvailable: false });
  assert.equal(state.status, "daemon-down");
  assert.match(state.message ?? "", /perchd not running/);
  assert.deepEqual(state.repos, []);
  assert.equal(state.syncAvailable, false);
});

test("buildPanelState shows a loading state before data arrives", () => {
  const state = buildPanelState({ daemonUp: true, syncAvailable: true });
  assert.equal(state.status, "loading");
  assert.match(state.message ?? "", /Loading/);
});

test("buildPanelState reports 'no open PRs' when every repo is empty", () => {
  const overview: PrOverview = { repos: [{ name: "main", groups: [] }] };
  const state = buildPanelState({ overview, daemonUp: true, syncAvailable: true });
  assert.equal(state.status, "empty");
  assert.match(state.message ?? "", /No open PRs/);
});

test("buildPanelState propagates a transient error over data", () => {
  const state = buildPanelState({ daemonUp: true, syncAvailable: true, error: "boom" });
  assert.equal(state.status, "error");
  assert.equal(state.message, "boom");
});

test("buildPanelState renders standalone PRs flat and stacks nested base-first", () => {
  const overview: PrOverview = {
    repos: [
      {
        name: "main",
        path: "/work/main",
        groups: [
          { kind: "pr", pr: { ...basePr, number: 9, headRefName: "solo" } },
          {
            kind: "stack",
            tracked: true,
            needsRebase: true,
            layers: [
              { ...basePr, number: 11, headRefName: "feat-a", baseRefName: "main" },
              {
                ...basePr,
                number: 12,
                headRefName: "feat-b",
                baseRefName: "feat-a",
                needsRebase: true,
              },
            ],
          },
        ],
      },
    ],
  };
  const state = buildPanelState({ overview, daemonUp: true, syncAvailable: true });
  assert.equal(state.status, "ok");
  assert.equal(state.repos.length, 1);
  const repo = state.repos[0]!;
  assert.equal(repo.name, "main");

  const solo = repo.groups[0]!;
  const stack = repo.groups[1]!;
  assert.equal(solo.kind, "pr");
  if (stack.kind !== "stack") throw new Error("expected stack");
  assert.equal(stack.tracked, true);
  assert.equal(stack.needsRebase, true);
  assert.equal(stack.repo, "main");
  // Layers render base-first (feat-a #1 before feat-b #2).
  assert.deepEqual(
    stack.rows.map((r) => r.branch),
    ["feat-a", "feat-b"],
  );
});

test("default (and omitted) stackDirection renders stack rows base-first", () => {
  const stackOverview = (stackDirection?: "bottom-to-top" | "top-to-bottom"): PrOverview => ({
    stackDirection,
    repos: [
      {
        name: "main",
        groups: [
          {
            kind: "stack",
            tracked: true,
            layers: [
              { ...basePr, number: 11, headRefName: "feat-a", baseRefName: "main" },
              { ...basePr, number: 12, headRefName: "feat-b", baseRefName: "feat-a" },
            ],
          },
        ],
      },
    ],
  });
  for (const overview of [stackOverview(), stackOverview("bottom-to-top")]) {
    const grp = buildPanelState({ overview, daemonUp: true, syncAvailable: true }).repos[0]!
      .groups[0]!;
    if (grp.kind !== "stack") throw new Error("expected stack");
    // Base-first: feat-a reads at the top (#1), feat-b below (#2).
    assert.deepEqual(
      grp.rows.map((r) => r.branch),
      ["feat-a", "feat-b"],
    );
  }
});

test("top-to-bottom stackDirection reverses stack rows tip-first", () => {
  const overview: PrOverview = {
    stackDirection: "top-to-bottom",
    repos: [
      {
        name: "main",
        groups: [
          {
            kind: "stack",
            tracked: true,
            layers: [
              { ...basePr, number: 11, headRefName: "feat-a", baseRefName: "main" },
              { ...basePr, number: 12, headRefName: "feat-b", baseRefName: "feat-a" },
            ],
          },
        ],
      },
    ],
  };
  const grp = buildPanelState({ overview, daemonUp: true, syncAvailable: true }).repos[0]!
    .groups[0]!;
  if (grp.kind !== "stack") throw new Error("expected stack");
  // Tip-first: feat-b reads at the top, feat-a below. The renderer numbers rows
  // 1..N in array order, so the reversal flips both row order and numbering.
  assert.deepEqual(
    grp.rows.map((r) => r.branch),
    ["feat-b", "feat-a"],
  );
  // The PR numbers travel with their rows (the data is not mutated).
  assert.deepEqual(
    grp.rows.map((r) => r.number),
    [12, 11],
  );
});

test("stackDirection does not affect standalone PR rows", () => {
  const overview: PrOverview = {
    stackDirection: "top-to-bottom",
    repos: [{ name: "main", groups: [{ kind: "pr", pr: { ...basePr, number: 9 } }] }],
  };
  const grp = buildPanelState({ overview, daemonUp: true, syncAvailable: true }).repos[0]!
    .groups[0]!;
  assert.equal(grp.kind, "pr");
});

test("buildPanelState marks an untracked stack so the renderer hides Sync", () => {
  const overview: PrOverview = {
    repos: [
      {
        name: "main",
        groups: [
          {
            kind: "stack",
            tracked: false,
            layers: [
              { ...basePr, number: 1, headRefName: "a", baseRefName: "main" },
              { ...basePr, number: 2, headRefName: "b", baseRefName: "a" },
            ],
          },
        ],
      },
    ],
  };
  const state = buildPanelState({ overview, daemonUp: true, syncAvailable: true });
  const grp = state.repos[0]!.groups[0]!;
  if (grp.kind !== "stack") throw new Error("expected stack");
  assert.equal(grp.tracked, false);
});

test("buildPanelState surfaces a per-repo error inline and stays ok overall", () => {
  const overview: PrOverview = {
    repos: [
      { name: "flaky", groups: [], error: "gh: 504 Gateway Timeout" },
      {
        name: "main",
        groups: [{ kind: "pr", pr: { ...basePr } }],
      },
    ],
  };
  const state = buildPanelState({ overview, daemonUp: true, syncAvailable: true });
  // A repo with an error counts as content → overall ok, not "empty".
  assert.equal(state.status, "ok");
  assert.equal(state.repos[0]!.error, "gh: 504 Gateway Timeout");
  assert.deepEqual(state.repos[0]!.groups, []);
  assert.equal(state.repos[1]!.groups.length, 1);
});

// ── Plugin tabs ──────────────────────────────────────────────────────────────

const twoPrOverview: PrOverview = {
  repos: [
    {
      name: "r",
      groups: [
        { kind: "pr", pr: { ...basePr, number: 1 } }, // clean → ok
        { kind: "pr", pr: { ...basePr, number: 2, ciStatus: "fail" } }, // → bad
      ],
    },
  ],
};

test("buildPanelState always emits a PRs tab, Services only when present", () => {
  // No services list → just the PRs tab.
  const noSvc = buildPanelState({ overview: twoPrOverview, daemonUp: true, syncAvailable: true });
  assert.deepEqual(
    noSvc.tabs.map((t) => t.id),
    ["stack.prs"],
  );
  assert.equal(noSvc.tabs[0]!.label, "PRs");

  // With a live services list → PRs first, Services second.
  const withSvc = buildPanelState({
    overview: twoPrOverview,
    daemonUp: true,
    syncAvailable: true,
    servicesList: { available: true, services: [{ name: "api", status: "running" }] },
  });
  assert.deepEqual(
    withSvc.tabs.map((t) => t.id),
    ["stack.prs", "services.list"],
  );
});

test("PRs tab badge counts open PRs and tones by worst health", () => {
  const state = buildPanelState({ overview: twoPrOverview, daemonUp: true, syncAvailable: true });
  const prs = state.tabs.find((t) => t.id === "stack.prs")!;
  assert.equal(prs.badge?.count, 2);
  assert.equal(prs.badge?.tone, "bad"); // the failing PR dominates

  // All-clean repo → ok tone.
  const clean: PrOverview = { repos: [{ name: "r", groups: [{ kind: "pr", pr: { ...basePr } }] }] };
  const okState = buildPanelState({ overview: clean, daemonUp: true, syncAvailable: true });
  assert.equal(okState.tabs[0]!.badge?.count, 1);
  assert.equal(okState.tabs[0]!.badge?.tone, "ok");
});

test("Services tab badge is a bare dot toned by worst service health", () => {
  const state = buildPanelState({
    overview: twoPrOverview,
    daemonUp: true,
    syncAvailable: true,
    servicesList: {
      available: true,
      services: [
        { name: "api", status: "running" },
        { name: "db", status: "crashed", exitCode: 1 },
      ],
    },
  });
  const svc = state.tabs.find((t) => t.id === "services.list")!;
  assert.equal(svc.label, "Services");
  assert.equal(svc.badge?.count, undefined); // bare dot, no count
  assert.equal(svc.badge?.tone, "bad");
});

test("buildPanelState: no PRs → PRs tab with a bare muted badge", () => {
  // daemon-down has no overview and no services.
  const down = buildPanelState({ daemonUp: false, syncAvailable: false });
  assert.deepEqual(
    down.tabs.map((t) => t.id),
    ["stack.prs"],
  );
  assert.equal(down.tabs[0]!.badge?.count, undefined);
  assert.equal(down.tabs[0]!.badge?.tone, "muted");

  // "empty" (repos present but no PRs) likewise shows a muted PRs badge.
  const empty = buildPanelState({
    overview: { repos: [{ name: "r", groups: [] }] },
    daemonUp: true,
    syncAvailable: true,
  });
  assert.equal(empty.status, "empty");
  assert.equal(empty.tabs[0]!.badge?.tone, "muted");
});
