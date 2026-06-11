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

test("buildPanelState surfaces a daemon-down state without crashing", () => {
  const state = buildPanelState({ daemonUp: false, syncAvailable: false });
  assert.equal(state.status, "daemon-down");
  assert.match(state.message ?? "", /perchd not running/);
  assert.deepEqual(state.repos, []);
  assert.equal(state.syncAvailable, false);
});

test("buildPanelState shows a loading state before data arrives", () => {
  const state = buildPanelState({ daemonUp: true, syncAvailable: true });
  assert.equal(state.status, "empty");
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
