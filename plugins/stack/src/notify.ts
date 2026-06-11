/**
 * `stack.prs` change notifications (v1.5).
 *
 * Pure diff of two {@link PrOverview} snapshots into a list of notable PR
 * transitions, wired into the `stack.prs` read's `notify` hook. The daemon calls
 * the hook after each poll with the previous cached overview (`prev`) and the
 * fresh one (`next`); we flatten both to a PR-by-number map and emit one
 * {@link Notification} per notable change.
 *
 * Each notification carries a stable `dedupeKey` for its transition (e.g.
 * `12:ci:pass`) so the daemon suppresses re-announcing the same transition on
 * every subsequent poll while the state holds.
 */
import type { Notification } from "@perch/sdk";

import type { PrInfo, PrOverview, PrRepo } from "./prs.js";

/** A PR paired with the name of the repo it lives in (for notification bodies). */
interface FlatPr {
  pr: PrInfo;
  repo: string;
}

/** Flatten every repo+group of an overview into a `PR number → {pr, repo}` map. */
function flatten(overview: PrOverview): Map<number, FlatPr> {
  const out = new Map<number, FlatPr>();
  for (const repo of overview.repos) {
    collectRepo(repo, out);
  }
  return out;
}

/** Collect a single repo's PRs (standalone + stack layers) into `out`. */
function collectRepo(repo: PrRepo, out: Map<number, FlatPr>): void {
  for (const group of repo.groups) {
    if (group.kind === "pr") {
      out.set(group.pr.number, { pr: group.pr, repo: repo.name });
    } else {
      for (const pr of group.layers) {
        out.set(pr.number, { pr, repo: repo.name });
      }
    }
  }
}

/** `#<number> <title> (<repo>)` — the body shared by every notification. */
function body(flat: FlatPr): string {
  return `#${flat.pr.number} ${flat.pr.title} (${flat.repo})`;
}

/** A CI status that has settled (the build is done, one way or another). */
function isSettled(status: PrInfo["ciStatus"]): boolean {
  return status === "pass" || status === "fail" || status === "none";
}

/**
 * Diff `prev` vs `next` overviews into notifications for notable PR transitions.
 *
 * Returns `[]` when `prev` is `undefined` (the first poll — nothing to diff
 * against, so an initial load doesn't spam). Otherwise emits, per PR:
 * - CI into pass/fail; CI into pending from a settled state (a build started).
 * - Review into APPROVED / CHANGES_REQUESTED.
 * - `conflict` onset (false → true, incl. mergeable → CONFLICTING).
 * - `needsRebase` onset (false → true).
 * - A PR present only in `next` (opened) or only in `prev` (closed/merged).
 */
export function prNotifications(prev: PrOverview | undefined, next: PrOverview): Notification[] {
  if (prev === undefined) return [];

  const before = flatten(prev);
  const after = flatten(next);
  const notes: Notification[] = [];

  for (const [number, flat] of after) {
    const prevFlat = before.get(number);
    if (prevFlat === undefined) {
      // Opened: present in `next` but not `prev`.
      notes.push({
        title: "New PR",
        body: body(flat),
        level: "info",
        dedupeKey: `${number}:opened`,
        openUrl: flat.pr.url,
      });
      continue;
    }
    diffPr(number, prevFlat, flat, notes);
  }

  for (const [number, flat] of before) {
    if (after.has(number)) continue;
    // Closed/merged: present in `prev` but not `next`.
    notes.push({
      title: "PR closed",
      body: body(flat),
      level: "info",
      dedupeKey: `${number}:closed`,
      openUrl: flat.pr.url,
    });
  }

  return notes;
}

/** Emit notifications for a PR that exists in both snapshots. */
function diffPr(number: number, prev: FlatPr, next: FlatPr, notes: Notification[]): void {
  const a = prev.pr;
  const b = next.pr;

  // CI transitions.
  if (b.ciStatus !== a.ciStatus) {
    if (b.ciStatus === "pass") {
      notes.push({
        title: "CI passed",
        body: body(next),
        level: "success",
        dedupeKey: `${number}:ci:pass`,
        openUrl: b.url,
      });
    } else if (b.ciStatus === "fail") {
      notes.push({
        title: "CI failed",
        body: body(next),
        level: "error",
        dedupeKey: `${number}:ci:fail`,
        openUrl: b.url,
      });
    } else if (b.ciStatus === "pending" && isSettled(a.ciStatus)) {
      notes.push({
        title: "CI running",
        body: body(next),
        level: "info",
        dedupeKey: `${number}:ci:pending`,
        openUrl: b.url,
      });
    }
  }

  // Review transitions.
  if (b.reviewDecision !== a.reviewDecision) {
    if (b.reviewDecision === "APPROVED") {
      notes.push({
        title: "Approved",
        body: body(next),
        level: "success",
        dedupeKey: `${number}:review:approved`,
        openUrl: b.url,
      });
    } else if (b.reviewDecision === "CHANGES_REQUESTED") {
      notes.push({
        title: "Changes requested",
        body: body(next),
        level: "warning",
        dedupeKey: `${number}:review:changes`,
        openUrl: b.url,
      });
    }
  }

  // Merge conflict onset (false → true, incl. mergeable flipping to CONFLICTING).
  if (b.conflict && !a.conflict) {
    notes.push({
      title: "Merge conflict",
      body: body(next),
      level: "warning",
      dedupeKey: `${number}:conflict`,
      openUrl: b.url,
    });
  }

  // Needs-rebase onset (false → true).
  if (b.needsRebase && !a.needsRebase) {
    notes.push({
      title: "Needs rebase",
      body: body(next),
      level: "warning",
      dedupeKey: `${number}:rebase`,
      openUrl: b.url,
    });
  }
}
