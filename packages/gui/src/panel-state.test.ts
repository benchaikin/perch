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
  deriveStackAlerts,
  landableDecisionCount,
  mergeableChip,
  mergeBlockedChip,
  prAlertConditions,
  prCanMerge,
  reviewChip,
  toPrRow,
  type PrOverview,
} from "./panel-state.js";
import type { LandableState } from "./landable.js";
import type { Alert } from "./ipc.js";

/** A minimal active alert for the Dashboard tab badge tests. */
function makeAlert(id: string): Alert {
  return { id, pluginId: "stack", raisedAt: 0, payload: {} };
}

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

test("mergeBlockedChip chips BLOCKED, omits everything else", () => {
  assert.equal(mergeBlockedChip("BLOCKED")?.tone, "bad");
  assert.equal(mergeBlockedChip("CLEAN"), undefined);
  assert.equal(mergeBlockedChip(undefined), undefined);
});

const basePr = {
  number: 1,
  title: "Add API",
  url: "https://github.com/o/r/pull/1",
  headRefName: "add-api",
  baseRefName: "main",
};

test("toPrRow always includes a CI chip and applies defaults", () => {
  const row = toPrRow({ ...basePr }, "r");
  assert.equal(row.branch, "add-api");
  assert.equal(row.number, 1);
  assert.equal(row.url, "https://github.com/o/r/pull/1");
  assert.equal(row.needsRebase, false);
  assert.equal(row.conflict, false);
  assert.equal(row.chips.length, 1);
  assert.equal(row.chips[0]?.label, "· CI");
});

test("toPrRow carries the human review-comment count, defaulting to 0", () => {
  assert.equal(toPrRow({ ...basePr }, "r").humanReviewCommentCount, 0);
  assert.equal(toPrRow({ ...basePr, humanReviewCommentCount: 3 }, "r").humanReviewCommentCount, 3);
});

test("toPrRow carries the base branch + repo for the resolve-conflicts action", () => {
  const row = toPrRow({ ...basePr }, "my-repo");
  assert.equal(row.baseRefName, "main");
  assert.equal(row.repo, "my-repo");
});

test("toPrRow accumulates review + mergeable chips and badges", () => {
  const row = toPrRow(
    {
      ...basePr,
      ciStatus: "pass",
      reviewDecision: "REVIEW_REQUIRED",
      mergeable: "CONFLICTING",
      needsRebase: true,
      conflict: true,
    },
    "r",
  );
  assert.equal(row.needsRebase, true);
  assert.equal(row.conflict, true);
  // CI + review + mergeable.
  assert.deepEqual(
    row.chips.map((c) => c.tone),
    ["ok", "warn", "bad"],
  );
});

test("toPrRow makes the needs-review chip a click-to-open link, others passive", () => {
  const reviewRow = toPrRow({ ...basePr, reviewDecision: "REVIEW_REQUIRED" }, "r");
  const reviewChipRow = reviewRow.chips.find((c) => c.label === "○ rev");
  assert.equal(reviewChipRow?.href, basePr.url);
  assert.equal(reviewChipRow?.actionLabel, "Open PR for review");
  assert.equal(reviewChipRow?.hint, "Open PR for review");

  // CI chip alongside it stays passive.
  assert.equal(reviewRow.chips.find((c) => c.label === "· CI")?.href, undefined);

  // The other review decisions do not become links.
  for (const decision of ["APPROVED", "CHANGES_REQUESTED"] as const) {
    const row = toPrRow({ ...basePr, reviewDecision: decision }, "r");
    assert.equal(
      row.chips.every((c) => c.href === undefined),
      true,
      `${decision} chips should have no href`,
    );
  }
});

test("PR health is bad on CI fail / conflict / needs-rebase / changes, else ok", () => {
  assert.equal(toPrRow({ ...basePr }, "r").health, "ok");
  assert.equal(toPrRow({ ...basePr, ciStatus: "pending" }, "r").health, "ok");
  assert.equal(toPrRow({ ...basePr, reviewDecision: "APPROVED" }, "r").health, "ok");
  assert.equal(toPrRow({ ...basePr, ciStatus: "fail" }, "r").health, "bad");
  assert.equal(toPrRow({ ...basePr, conflict: true }, "r").health, "bad");
  assert.equal(toPrRow({ ...basePr, needsRebase: true }, "r").health, "bad");
  assert.equal(toPrRow({ ...basePr, reviewDecision: "CHANGES_REQUESTED" }, "r").health, "bad");
});

test("PR health is warn when there are review comments but nothing blocking", () => {
  // Comments to address, CI green + approved → amber, not green.
  assert.equal(
    toPrRow(
      { ...basePr, ciStatus: "pass", reviewDecision: "APPROVED", humanReviewCommentCount: 2 },
      "r",
    ).health,
    "warn",
  );
  // A blocking problem outranks comments → red, not amber.
  assert.equal(
    toPrRow({ ...basePr, ciStatus: "fail", humanReviewCommentCount: 2 }, "r").health,
    "bad",
  );
  assert.equal(
    toPrRow({ ...basePr, reviewDecision: "CHANGES_REQUESTED", humanReviewCommentCount: 2 }, "r")
      .health,
    "bad",
  );
});

/** A PR that satisfies every clause of the merge gate. */
const mergeablePr = { ...basePr, mergeable: "MERGEABLE" as const, ciStatus: "pass" as const };

test("prCanMerge is true for a MERGEABLE, green, conflict-free PR", () => {
  assert.equal(prCanMerge(mergeablePr), true);
  // CI green isn't required — a PR with no checks configured still merges.
  assert.equal(prCanMerge({ ...mergeablePr, ciStatus: "none" }), true);
  // An explicit approval is fine (not required, but must not block).
  assert.equal(prCanMerge({ ...mergeablePr, reviewDecision: "APPROVED" }), true);
});

test("prCanMerge is false for each non-mergeable reason", () => {
  // Not MERGEABLE per GitHub (conflicting / unknown / absent).
  assert.equal(prCanMerge({ ...mergeablePr, mergeable: "CONFLICTING" }), false);
  assert.equal(prCanMerge({ ...mergeablePr, mergeable: "UNKNOWN" }), false);
  assert.equal(prCanMerge({ ...basePr, ciStatus: "pass" }), false); // mergeable undefined
  // Red or pending CI.
  assert.equal(prCanMerge({ ...mergeablePr, ciStatus: "fail" }), false);
  assert.equal(prCanMerge({ ...mergeablePr, ciStatus: "pending" }), false);
  // A live conflict flag or a needed rebase.
  assert.equal(prCanMerge({ ...mergeablePr, conflict: true }), false);
  assert.equal(prCanMerge({ ...mergeablePr, needsRebase: true }), false);
  // Changes requested.
  assert.equal(prCanMerge({ ...mergeablePr, reviewDecision: "CHANGES_REQUESTED" }), false);
  // Merge freeze (BLOCKED mergeStateStatus) blocks even an otherwise-green PR.
  assert.equal(prCanMerge({ ...mergeablePr, mergeStateStatus: "BLOCKED" }), false);
});

test("merge freeze (BLOCKED) marks the row bad, shows a frozen chip, and blocks merge", () => {
  const frozenPr = { ...mergeablePr, mergeStateStatus: "BLOCKED" };
  const row = toPrRow(frozenPr, "r");
  assert.equal(row.health, "bad");
  assert.equal(row.canMerge, false);
  const chip = row.chips.find((c) => c.label === "✗ frozen");
  assert.ok(chip, "frozen chip should be present");
  assert.equal(chip?.tone, "bad");
});

test("toPrRow surfaces the merge gate on the row's canMerge flag", () => {
  assert.equal(toPrRow(mergeablePr, "r").canMerge, true);
  assert.equal(toPrRow({ ...mergeablePr, ciStatus: "fail" }, "r").canMerge, false);
  // Defaults (no mergeable signal) → not offerable.
  assert.equal(toPrRow({ ...basePr }, "r").canMerge, false);
});

test("landableDecisionCount counts only needs-review + ready (your-move states)", () => {
  const map = (...states: LandableState[]): Map<string, LandableState> =>
    new Map(states.map((s, i) => [`t${i}`, s]));
  // The two "your move" states are counted; everything else is waiting on CI /
  // the author / nothing (merged, none).
  assert.equal(
    landableDecisionCount(
      map(
        "needs-review",
        "ready",
        "ci-running",
        "ci-failed",
        "changes-requested",
        "merged",
        "none",
      ),
    ),
    2,
  );
  // Empty map → 0 (no badge).
  assert.equal(landableDecisionCount(new Map()), 0);
  // Multiple of each accumulate.
  assert.equal(landableDecisionCount(map("ready", "ready", "needs-review")), 3);
  // Blocked/in-flight-only → 0 (nothing for you to act on yet).
  assert.equal(landableDecisionCount(map("ci-running", "ci-failed", "changes-requested")), 0);
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

test("prAlertConditions flags each actionable PR state", () => {
  // Clean PR: nothing actionable.
  assert.deepEqual(prAlertConditions({ ...basePr }), []);
  // Needs rebase + failing CI both fire (a PR can be in several at once).
  assert.deepEqual(prAlertConditions({ ...basePr, needsRebase: true, ciStatus: "fail" }), [
    "needs-rebase",
    "ci-failing",
  ]);
  // Reviewer left inline comments to address.
  assert.deepEqual(prAlertConditions({ ...basePr, humanReviewCommentCount: 2 }), [
    "review-comments",
  ]);
  // Mergeable + green + approved → ready to merge.
  assert.deepEqual(
    prAlertConditions({
      ...basePr,
      mergeable: "MERGEABLE",
      ciStatus: "pass",
      reviewDecision: "APPROVED",
    }),
    ["ready-to-merge"],
  );
  // Mergeable + green but NOT yet approved → not "ready" (it's awaiting review).
  assert.deepEqual(prAlertConditions({ ...basePr, mergeable: "MERGEABLE", ciStatus: "pass" }), []);
});

test("deriveStackAlerts emits one alert per (PR, condition) with stack ids", () => {
  const overview: PrOverview = {
    repos: [
      {
        name: "perch",
        groups: [
          { kind: "pr", pr: { ...basePr, headRefName: "feat/auth", needsRebase: true } },
          {
            kind: "stack",
            tracked: true,
            layers: [
              { ...basePr, number: 2, headRefName: "base", baseRefName: "main" },
              {
                ...basePr,
                number: 3,
                headRefName: "tip",
                baseRefName: "base",
                ciStatus: "fail",
                humanReviewCommentCount: 1,
              },
            ],
          },
        ],
      },
    ],
  };
  const alerts = deriveStackAlerts(overview);
  const ids = alerts.map((a) => a.id);
  assert.deepEqual(ids, [
    "stack:perch:feat/auth:needs-rebase",
    "stack:perch:tip:ci-failing",
    "stack:perch:tip:review-comments",
  ]);
  // The payload carries everything the widget needs to render + act.
  const first = alerts[0]!;
  assert.equal(first.payload.condition, "needs-rebase");
  assert.equal(first.payload.repo, "perch");
  assert.equal(first.payload.branch, "feat/auth");
  assert.equal(first.payload.url, basePr.url);
});

test("deriveStackAlerts returns [] for an absent overview", () => {
  assert.deepEqual(deriveStackAlerts(undefined), []);
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
  // No services list → just the PRs tab (with the always-present Dashboard tab first).
  const noSvc = buildPanelState({ overview: twoPrOverview, daemonUp: true, syncAvailable: true });
  assert.deepEqual(
    noSvc.tabs.map((t) => t.id),
    ["dashboard", "stack.prs"],
  );
  assert.equal(noSvc.tabs[0]!.label, "Dashboard");

  // With a live services list → Dashboard first, PRs second, Services third.
  const withSvc = buildPanelState({
    overview: twoPrOverview,
    daemonUp: true,
    syncAvailable: true,
    servicesList: { available: true, services: [{ name: "api", status: "running" }] },
  });
  assert.deepEqual(
    withSvc.tabs.map((t) => t.id),
    ["dashboard", "stack.prs", "services.list"],
  );
});

test("the Dashboard tab is always present with an alert-count badge", () => {
  // Always visible (alerts span every plugin and the pane polls for itself), even
  // with the daemon down — it's the stable home for alerts and shows its own empty
  // state. With no alerts it carries a bare muted dot.
  const up = buildPanelState({ overview: twoPrOverview, daemonUp: true, syncAvailable: true });
  const upTab = up.tabs.find((t) => t.id === "dashboard")!;
  assert.equal(upTab.label, "Dashboard");
  assert.equal(upTab.badge?.count, undefined);
  assert.equal(upTab.badge?.tone, "muted");

  const down = buildPanelState({ daemonUp: false, syncAvailable: false });
  const downTab = down.tabs.find((t) => t.id === "dashboard")!;
  assert.ok(downTab, "Dashboard tab should show even when the daemon is down");
  // Daemon down → no alerts → a bare muted dot (a stale set can't outlive the daemon).
  assert.equal(downTab.badge?.count, undefined);
  assert.equal(downTab.badge?.tone, "muted");
});

test("the Dashboard tab badge counts active alerts, toned warn", () => {
  const state = buildPanelState({
    overview: twoPrOverview,
    daemonUp: true,
    syncAvailable: true,
    alerts: [makeAlert("stack:r:b:ci-failing"), makeAlert("worktrees:wt:conflict")],
  });
  const dash = state.tabs.find((t) => t.id === "dashboard")!;
  assert.equal(dash.badge?.count, 2);
  assert.equal(dash.badge?.tone, "warn");
});

test("the Dashboard tab badge ignores alerts while the daemon is down", () => {
  const down = buildPanelState({
    daemonUp: false,
    syncAvailable: false,
    alerts: [makeAlert("stack:r:b:ci-failing")],
  });
  const dash = down.tabs.find((t) => t.id === "dashboard")!;
  assert.equal(dash.badge?.count, undefined);
  assert.equal(dash.badge?.tone, "muted");
});

test("PRs tab badge counts open PRs and tones by worst health", () => {
  const state = buildPanelState({ overview: twoPrOverview, daemonUp: true, syncAvailable: true });
  const prs = state.tabs.find((t) => t.id === "stack.prs")!;
  assert.equal(prs.badge?.count, 2);
  assert.equal(prs.badge?.tone, "bad"); // the failing PR dominates

  // All-clean repo → ok tone.
  const clean: PrOverview = { repos: [{ name: "r", groups: [{ kind: "pr", pr: { ...basePr } }] }] };
  const okState = buildPanelState({ overview: clean, daemonUp: true, syncAvailable: true });
  const okPrs = okState.tabs.find((t) => t.id === "stack.prs")!;
  assert.equal(okPrs.badge?.count, 1);
  assert.equal(okPrs.badge?.tone, "ok");
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

test("Dex tab appears via the registry when the board is non-empty", () => {
  const state = buildPanelState({
    overview: twoPrOverview,
    daemonUp: true,
    syncAvailable: true,
    dexPresent: true,
    dexBoard: {
      tasks: [
        {
          id: "e",
          name: "Epic",
          description: "",
          result: null,
          status: "ready",
          priority: 0,
          depth: 0,
          isEpic: true,
          blockedByCount: 0,
          blockedBy: [],
        },
        {
          id: "a",
          name: "Blocked",
          description: "",
          result: null,
          status: "blocked",
          priority: 0,
          depth: 1,
          isEpic: false,
          blockedByCount: 1,
          blockedBy: ["e"],
        },
        {
          id: "b",
          name: "Ready",
          description: "",
          result: null,
          status: "ready",
          priority: 0,
          depth: 1,
          isEpic: false,
          blockedByCount: 0,
          blockedBy: [],
        },
      ],
    },
  });
  assert.deepEqual(
    state.tabs.map((t) => t.id),
    ["dashboard", "stack.prs", "dex.tasks"],
  );
  const dex = state.tabs.find((t) => t.id === "dex.tasks")!;
  assert.equal(dex.label, "Dex");
  // Badge counts ready + blocked (the epic is ready too → 2 ready + 1 blocked = 3).
  assert.equal(dex.badge?.count, 3);
  assert.equal(dex.badge?.tone, "bad"); // a blocked task dominates
  // Plugin not installed (no dexPresent) → no Dex tab, even with a board.
  const noDex = buildPanelState({ overview: twoPrOverview, daemonUp: true, syncAvailable: true });
  assert.equal(
    noDex.tabs.some((t) => t.id === "dex.tasks"),
    false,
  );
});

test("Dex tab appears when the plugin is present even with zero tasks", () => {
  // Plugin installed but no board has arrived yet (subscription seeded nothing).
  const noBoard = buildPanelState({
    overview: twoPrOverview,
    daemonUp: true,
    syncAvailable: true,
    dexPresent: true,
  });
  const noBoardTab = noBoard.tabs.find((t) => t.id === "dex.tasks");
  assert.ok(noBoardTab, "Dex tab should show when the plugin is present");
  assert.equal(noBoardTab!.badge?.count, undefined); // bare dot, nothing to tally
  assert.equal(noBoardTab!.badge?.tone, "muted");

  // Plugin installed with an empty board (all tasks completed) → still visible.
  const empty = buildPanelState({
    overview: twoPrOverview,
    daemonUp: true,
    syncAvailable: true,
    dexPresent: true,
    dexBoard: { tasks: [] },
  });
  const emptyTab = empty.tabs.find((t) => t.id === "dex.tasks");
  assert.ok(emptyTab, "Dex tab should stay visible with an empty board");
  assert.equal(emptyTab!.badge?.tone, "muted");

  // Daemon down → hidden regardless of presence.
  const down = buildPanelState({ daemonUp: false, syncAvailable: false, dexPresent: true });
  assert.equal(
    down.tabs.some((t) => t.id === "dex.tasks"),
    false,
  );
});

test("buildPanelState: no PRs → PRs tab with a bare muted badge", () => {
  // daemon-down has no overview and no services.
  const down = buildPanelState({ daemonUp: false, syncAvailable: false });
  assert.deepEqual(
    down.tabs.map((t) => t.id),
    ["dashboard", "stack.prs"],
  );
  const downPrs = down.tabs.find((t) => t.id === "stack.prs")!;
  assert.equal(downPrs.badge?.count, undefined);
  assert.equal(downPrs.badge?.tone, "muted");

  // "empty" (repos present but no PRs) likewise shows a muted PRs badge.
  const empty = buildPanelState({
    overview: { repos: [{ name: "r", groups: [] }] },
    daemonUp: true,
    syncAvailable: true,
  });
  assert.equal(empty.status, "empty");
  const emptyPrs = empty.tabs.find((t) => t.id === "stack.prs")!;
  assert.equal(emptyPrs.badge?.tone, "muted");
});

test("buildPanelState joins the agent fleet onto the matching dex row", () => {
  // A dex task with a live worktree (matched by taskId) plus an agent session on
  // that task — the full join → the row carries the agent and the map is keyed.
  const state = buildPanelState({
    overview: twoPrOverview,
    daemonUp: true,
    syncAvailable: true,
    dexPresent: true,
    dexBoard: {
      tasks: [
        {
          id: "t1",
          name: "Wire the fleet view",
          description: "",
          result: null,
          status: "in-progress",
          priority: 0,
          depth: 0,
          isEpic: false,
          blockedByCount: 0,
          blockedBy: [],
        },
      ],
    },
    worktreesList: {
      worktrees: [
        {
          path: "/wt/t1",
          name: "t1",
          branch: "dex/t1-fleet",
          detached: false,
          main: false,
          dirty: false,
          dirtyCount: 0,
          conflict: false,
          locked: false,
          prunable: false,
          health: "ok",
          taskId: "t1",
        },
      ],
    },
    agentFleet: {
      agents: [{ sessionId: "s1", state: "blocked", taskId: "t1", lastActivity: 42 }],
    },
  });
  // Surfaced on the cross-reference map…
  assert.equal(state.agentByTaskId.get("t1")?.state, "blocked");
  // …and threaded onto the rendered dex row (display-only).
  const row = state.dex.rows.find((r) => r.id === "t1")!;
  assert.equal(row.agent?.state, "blocked");
  assert.equal(row.agent?.sessionId, "s1");
  // A task with no matching session stays bare.
  const bare = buildPanelState({
    overview: twoPrOverview,
    daemonUp: true,
    syncAvailable: true,
    dexPresent: true,
    dexBoard: {
      tasks: [
        {
          id: "t2",
          name: "No agent",
          description: "",
          result: null,
          status: "ready",
          priority: 0,
          depth: 0,
          isEpic: false,
          blockedByCount: 0,
          blockedBy: [],
        },
      ],
    },
  });
  assert.equal(bare.dex.rows[0]!.agent, undefined);
});
