import assert from "node:assert/strict";
import { test } from "node:test";

import { prNotifications } from "./notify.js";
import type { PrInfo, PrOverview } from "./prs.js";

/** Build a PrInfo with sane defaults, overriding only what a case cares about. */
function pr(over: Partial<PrInfo> & { number: number }): PrInfo {
  return {
    number: over.number,
    title: over.title ?? `PR ${over.number}`,
    url: over.url ?? `https://github.com/o/r/pull/${over.number}`,
    headRefName: over.headRefName ?? `branch-${over.number}`,
    baseRefName: over.baseRefName ?? "main",
    ciStatus: over.ciStatus ?? "none",
    reviewDecision: over.reviewDecision,
    mergeable: over.mergeable,
    needsRebase: over.needsRebase ?? false,
    conflict: over.conflict ?? false,
  };
}

/** Wrap standalone PRs into a single-repo overview. */
function overview(prs: PrInfo[], repoName = "r"): PrOverview {
  return {
    stackDirection: "bottom-to-top",
    repos: [{ name: repoName, groups: prs.map((p) => ({ kind: "pr", pr: p })) }],
  };
}

/** Find a notification by dedupeKey (asserting exactly one match). */
function byKey(notes: ReturnType<typeof prNotifications>, key: string) {
  const matches = notes.filter((n) => n.dedupeKey === key);
  assert.equal(matches.length, 1, `expected exactly one notification with key ${key}`);
  return matches[0]!;
}

test("prev undefined → no notifications (first poll)", () => {
  const next = overview([pr({ number: 1, ciStatus: "pass" })]);
  assert.deepEqual(prNotifications(undefined, next), []);
});

test("no change → no notifications", () => {
  const a = pr({ number: 1, ciStatus: "pass", reviewDecision: "APPROVED" });
  assert.deepEqual(prNotifications(overview([a]), overview([{ ...a }])), []);
});

test("CI into pass → success", () => {
  const prev = overview([pr({ number: 7, ciStatus: "pending" })]);
  const next = overview([pr({ number: 7, ciStatus: "pass" })]);
  const notes = prNotifications(prev, next);
  assert.equal(notes.length, 1);
  const n = byKey(notes, "7:ci:pass");
  assert.equal(n.title, "CI passed");
  assert.equal(n.level, "success");
  assert.equal(n.openUrl, "https://github.com/o/r/pull/7");
  assert.equal(n.body, "#7 PR 7 (r)");
});

test("CI into fail → error", () => {
  const prev = overview([pr({ number: 8, ciStatus: "pending" })]);
  const next = overview([pr({ number: 8, ciStatus: "fail" })]);
  const n = byKey(prNotifications(prev, next), "8:ci:fail");
  assert.equal(n.title, "CI failed");
  assert.equal(n.level, "error");
});

test("CI into pending from a settled state → info (build started)", () => {
  const prev = overview([pr({ number: 9, ciStatus: "pass" })]);
  const next = overview([pr({ number: 9, ciStatus: "pending" })]);
  const n = byKey(prNotifications(prev, next), "9:ci:pending");
  assert.equal(n.title, "CI running");
  assert.equal(n.level, "info");
});

test("CI none → none and unchanged emit nothing", () => {
  const noneToNone = prNotifications(
    overview([pr({ number: 1, ciStatus: "none" })]),
    overview([pr({ number: 1, ciStatus: "none" })]),
  );
  assert.deepEqual(noneToNone, []);
});

test("CI pending → pending (still building) emits nothing", () => {
  const notes = prNotifications(
    overview([pr({ number: 1, ciStatus: "pending" })]),
    overview([pr({ number: 1, ciStatus: "pending" })]),
  );
  assert.deepEqual(notes, []);
});

test("review → APPROVED → success", () => {
  const prev = overview([pr({ number: 3, reviewDecision: "REVIEW_REQUIRED" })]);
  const next = overview([pr({ number: 3, reviewDecision: "APPROVED" })]);
  const n = byKey(prNotifications(prev, next), "3:review:approved");
  assert.equal(n.title, "Approved");
  assert.equal(n.level, "success");
});

test("review → CHANGES_REQUESTED → warning", () => {
  const prev = overview([pr({ number: 4, reviewDecision: "REVIEW_REQUIRED" })]);
  const next = overview([pr({ number: 4, reviewDecision: "CHANGES_REQUESTED" })]);
  const n = byKey(prNotifications(prev, next), "4:review:changes");
  assert.equal(n.title, "Changes requested");
  assert.equal(n.level, "warning");
});

test("conflict onset (false → true) → warning", () => {
  const prev = overview([pr({ number: 5, conflict: false, mergeable: "MERGEABLE" })]);
  const next = overview([pr({ number: 5, conflict: true, mergeable: "CONFLICTING" })]);
  const n = byKey(prNotifications(prev, next), "5:conflict");
  assert.equal(n.title, "Merge conflict");
  assert.equal(n.level, "warning");
});

test("conflict already true → no repeat", () => {
  const notes = prNotifications(
    overview([pr({ number: 5, conflict: true })]),
    overview([pr({ number: 5, conflict: true })]),
  );
  assert.deepEqual(notes, []);
});

test("needsRebase onset (false → true) → warning", () => {
  const prev = overview([pr({ number: 6, needsRebase: false })]);
  const next = overview([pr({ number: 6, needsRebase: true })]);
  const n = byKey(prNotifications(prev, next), "6:rebase");
  assert.equal(n.title, "Needs rebase");
  assert.equal(n.level, "warning");
});

test("opened: present in next but not prev → info New PR", () => {
  const prev = overview([pr({ number: 1 })]);
  const next = overview([pr({ number: 1 }), pr({ number: 2, title: "Brand new" })]);
  const notes = prNotifications(prev, next);
  assert.equal(notes.length, 1);
  const n = byKey(notes, "2:opened");
  assert.equal(n.title, "New PR");
  assert.equal(n.level, "info");
  assert.equal(n.body, "#2 Brand new (r)");
  assert.equal(n.openUrl, "https://github.com/o/r/pull/2");
});

test("closed: present in prev but not next → info PR closed", () => {
  const prev = overview([pr({ number: 1 }), pr({ number: 2 })]);
  const next = overview([pr({ number: 1 })]);
  const notes = prNotifications(prev, next);
  assert.equal(notes.length, 1);
  const n = byKey(notes, "2:closed");
  assert.equal(n.title, "PR closed");
  assert.equal(n.level, "info");
});

test("multiple simultaneous transitions on one PR all emit", () => {
  const prev = overview([
    pr({ number: 12, ciStatus: "pending", reviewDecision: "REVIEW_REQUIRED", conflict: false }),
  ]);
  const next = overview([
    pr({ number: 12, ciStatus: "pass", reviewDecision: "APPROVED", conflict: true }),
  ]);
  const notes = prNotifications(prev, next);
  const keys = notes.map((n) => n.dedupeKey).sort();
  assert.deepEqual(keys, ["12:ci:pass", "12:conflict", "12:review:approved"]);
});

test("PRs are matched by number across repos and stack groups", () => {
  // PR 20 is a stack layer in repo A in prev; in next it stands alone in repo B,
  // and its CI flips to pass — matching by number alone must still fire once.
  const prev: PrOverview = {
    stackDirection: "bottom-to-top",
    repos: [
      {
        name: "a",
        groups: [
          {
            kind: "stack",
            tracked: false,
            needsRebase: false,
            layers: [
              pr({ number: 19, headRefName: "feat-a", ciStatus: "pass" }),
              pr({ number: 20, headRefName: "feat-b", baseRefName: "feat-a", ciStatus: "pending" }),
            ],
          },
        ],
      },
    ],
  };
  const next: PrOverview = {
    stackDirection: "bottom-to-top",
    repos: [
      { name: "a", groups: [{ kind: "pr", pr: pr({ number: 19, ciStatus: "pass" }) }] },
      { name: "b", groups: [{ kind: "pr", pr: pr({ number: 20, ciStatus: "pass" }) }] },
    ],
  };
  const notes = prNotifications(prev, next);
  assert.equal(notes.length, 1);
  assert.equal(byKey(notes, "20:ci:pass").title, "CI passed");
});
