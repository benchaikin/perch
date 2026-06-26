/**
 * Electron-free panel state + view-model derivation for the "My PRs" panel.
 *
 * This module owns ALL the data-shaping logic the GUI needs and deliberately
 * imports nothing from Electron, so it can be unit-tested with plain Node. The
 * main process subscribes to `stack.prs` over RPC and feeds the raw
 * {@link PrOverview} (plus a "daemon down" / "sync availability" signal) through
 * {@link buildPanelState}; the renderer receives the resulting {@link PanelState}
 * and draws it verbatim — no business logic lives in the renderer.
 *
 * The `PrOverview` shape is duplicated here (rather than depending on the stack
 * plugin) because the GUI is a thin client of the daemon: it only knows the wire
 * shape of `stack.prs`'s output, not the plugin's internals.
 */

import {
  buildServicesSection,
  worstServiceHealth,
  type ServiceList,
  type ServicesBulkAction,
  type ServicesSection,
} from "./services-state.js";
import {
  buildDexSection,
  worstDexHealth,
  DEX_TASKS_ID,
  type DexBoard,
  type DexSection,
} from "./dex-state.js";
import {
  buildWorktreesSection,
  worstWorktreeHealth,
  WORKTREES_LIST_ID,
  type WorktreeList,
  type WorktreesSection,
} from "./worktrees-state.js";
import { linkWorktreesAndTasks } from "./worktree-task-link.js";
import {
  deriveLandableByTaskId,
  deriveLandablePrByTaskId,
  type LandableState,
} from "./landable.js";
import { deriveAgentByTaskId, type AgentFleet, type AgentSummary } from "./agents-state.js";
import type { DexViewMode, DialogSize } from "./window-state.js";
import type { Alert } from "./ipc.js";

/** Canonical capability id of the cross-repo "My PRs" read the panel renders. */
export const STACK_PRS_ID = "stack.prs";
/** Canonical capability id of the hero Sync action. */
export const STACK_SYNC_ID = "stack.sync";
/** Canonical capability id of the per-PR resolve-conflicts action. */
export const STACK_RESOLVE_CONFLICTS_ID = "stack.resolve-conflicts";
/** Canonical capability id of the per-PR "open a free-form agent" action. */
export const STACK_OPEN_AGENT_ID = "stack.open-agent";
/** Canonical capability id of the per-PR single-PR merge action. */
export const STACK_MERGE_PR_ID = "stack.merge-pr";
/** The stack plugin's id — the key its raised alerts (and AlertWidget) carry. */
export const STACK_PLUGIN_ID = "stack";

/** Normalized CI rollup for a PR (mirrors the stack plugin's `CiStatus`). */
export type CiStatus = "pass" | "fail" | "pending" | "none";

/** GitHub review decision, passed through verbatim when present. */
export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";

/** GitHub mergeable state, passed through verbatim when present. */
export type Mergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/** One open PR as it arrives over RPC (the wire shape of `PrInfo`). */
export interface PrInfo {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  ciStatus?: CiStatus;
  reviewDecision?: ReviewDecision;
  mergeable?: Mergeable;
  /** GitHub merge-state status — `"BLOCKED"` when branch protection prevents merging. */
  mergeStateStatus?: string;
  needsRebase?: boolean;
  conflict?: boolean;
  /** Count of human-authored inline review comments to address (bots filtered). */
  humanReviewCommentCount?: number;
}

/** A group is either a standalone PR or a stack of ≥2 chained PRs. */
export type PrGroup =
  | { kind: "pr"; pr: PrInfo }
  | { kind: "stack"; layers: PrInfo[]; tracked?: boolean; needsRebase?: boolean };

/** One configured repo's PRs, grouped (the wire shape of `PrRepo`). */
export interface PrRepo {
  name: string;
  path?: string;
  groups: PrGroup[];
  error?: string;
}

/** The configured stack-display order (mirrors the stack plugin's enum). */
export type StackDirection = "bottom-to-top" | "top-to-bottom";

/** `stack.prs`'s output: every configured repo's PRs, grouped. */
export interface PrOverview {
  repos: PrRepo[];
  /**
   * How to order a stack's layers for display. `layers` always arrive bottom →
   * top; `"top-to-bottom"` reverses the rendered rows so the tip reads at the
   * top. Optional on the wire (older daemons omit it) — defaults to
   * `"bottom-to-top"` (today's behavior).
   */
  stackDirection?: StackDirection;
}

/** A status chip rendered next to a PR. `tone` drives its color. */
export interface Chip {
  /** Short glyph + label, e.g. `"✓ CI"`. */
  label: string;
  /** Color tone the renderer maps to a CSS class. */
  tone: "ok" | "warn" | "bad" | "muted";
  /** Longer description for the chip's `title`/tooltip. */
  hint: string;
  /** Optional Font Awesome icon name (e.g. `"arrows-spin"`) shown before the label. */
  icon?: string;
  /** Animate the icon (Font Awesome `fa-spin`) — e.g. CI in progress. */
  spin?: boolean;
  /**
   * When set, the chip becomes an actionable call-to-action that opens this PR
   * URL via `window.perch.openPr` — a focusable, keyboard-activatable button
   * with a click affordance. Plain (href-less) chips render as passive status
   * markers, exactly as before. Generic by design so any chip can opt in later.
   */
  href?: string;
  /**
   * Accessible name (and tooltip) for the actionable variant — the chip is a
   * colored glyph, so it needs a spoken name. Ignored when `href` is absent.
   */
  actionLabel?: string;
}

/** A single rendered PR row. */
export interface PrRow {
  number: number;
  title: string;
  /** Web URL of the PR — the renderer makes the row clickable to open it. */
  url: string;
  branch: string;
  /** The base branch this PR merges into — passed to the resolve-conflicts action. */
  baseRefName: string;
  /** The repo this PR belongs to (name) — passed to the resolve-conflicts action. */
  repo: string;
  /** Status chips (CI / review / mergeable), already mapped to glyphs + tones. */
  chips: Chip[];
  /** True when this PR's base advanced past it — render a "needs rebase" badge. */
  needsRebase: boolean;
  /** True when this PR has a merge conflict — render a "conflict" badge. */
  conflict: boolean;
  /**
   * True when this PR is in a one-click-mergeable state (see {@link prCanMerge}):
   * the per-PR Merge button shows only on a standalone PR for which this holds.
   */
  canMerge: boolean;
  /**
   * Count of human-authored inline review comments to address. The renderer
   * shows a comment-icon badge when > 0, emphasized when > 1.
   */
  humanReviewCommentCount: number;
  /** Health for the row's marker color: `"ok"` (green) or `"bad"` (error red). */
  health: Health;
}

/** A PR/stack marker's health, in ascending severity:
 *  - `"ok"`   (green) — clean, nothing to do.
 *  - `"warn"` (amber) — has human review comments to address, but nothing
 *    blocking (CI green, mergeable, not changes-requested).
 *  - `"bad"`  (error red) — CI failing, merge conflict, needs rebase, or
 *    changes requested; matching the conflict / CI-fail chips. */
export type Health = "ok" | "warn" | "bad";

/** A rendered group: either a single PR row or a nested stack of rows. */
export type GroupRow =
  | { kind: "pr"; pr: PrRow }
  | {
      kind: "stack";
      /**
       * The rendered layer rows, already ordered for display per the configured
       * {@link StackDirection}: `"bottom-to-top"` keeps them base-first (the
       * trunk-adjacent base #1 reads at the top), `"top-to-bottom"` reverses
       * them so the tip reads at the top. The renderer numbers them 1..N in
       * array order, so the reversal flips both the visual order and numbering.
       */
      rows: PrRow[];
      /** Whether the Sync action should show for this stack (gh-stack tracked). */
      tracked: boolean;
      /** Stack-level "needs rebase" flag (any layer). */
      needsRebase: boolean;
      /** Whole-stack health for the linking bar color (`"bad"` if any layer is). */
      health: Health;
      /** The repo name to sync (Sync invokes `stack.sync` with this repo). */
      repo: string;
    };

/** One repo section in the rendered panel. */
export interface RepoSection {
  name: string;
  /** Inline note shown under the header when the repo's lookup failed. */
  error?: string;
  /** Standalone PR rows + nested stack groups, in overview order. */
  groups: GroupRow[];
}

/** A transient status toast (e.g. the outcome of a Sync). */
export interface Notice {
  tone: "ok" | "warn" | "bad";
  text: string;
}

/**
 * A small status badge shown on a plugin's tab so its state stays glanceable
 * while the tab is inactive. `count` (when present) is a number to display
 * (e.g. open PR count); omit it for a bare status dot. `tone` drives the
 * badge/dot color. `"muted"` means "nothing notable" (grey).
 */
export interface TabBadge {
  /** A number to display (e.g. open PR count). Omit for a bare status dot. */
  count?: number;
  /** Health tone driving the badge/dot color. */
  tone: Health | "muted";
}

/**
 * One plugin tab in the panel's tab strip. Derived from {@link PanelState}'s
 * sections (registry-driven), so a new plugin showing up adds a tab with no
 * renderer changes. `icon` is a Font Awesome glyph name (rendered `fa-<icon>`).
 */
export interface PanelTab {
  /** Stable key for selection — the plugin's primary capability id. */
  id: string;
  /** Short label shown in the header title for the active tab. */
  label: string;
  /** Font Awesome glyph name (e.g. `"code-pull-request"`). */
  icon: string;
  /** Optional status badge; absent when there's nothing to signal. */
  badge?: TabBadge;
}

/** Tab id for the cross-repo "My PRs" view (the stack plugin's tab). */
export const STACK_TAB_ID = STACK_PRS_ID;
/** Tab id for the "Services" view (the services plugin's tab). */
export const SERVICES_TAB_ID = "services.list";
/**
 * Tab id for the "Dashboard" view — the alerts host. Not a plugin capability id
 * (alerts span every plugin), so it carries its own constant. Always visible: the
 * pane owns its own `alerts.list` poll and shows a clean empty state when none are
 * raised, so the tab is a stable home for them rather than appearing only on alert.
 */
export const DASHBOARD_TAB_ID = "dashboard";

/** The complete state the renderer needs to draw the panel. */
export interface PanelState {
  /** Overall connection/data status. */
  status: "ok" | "loading" | "empty" | "daemon-down" | "error";
  /** Human-readable message for non-`ok` states (e.g. "perchd not running"). */
  message?: string;
  /** Repo sections, in overview order. */
  repos: RepoSection[];
  /** Whether the Sync action exists in the registry (gates the Sync buttons). */
  syncAvailable: boolean;
  /** Repos with a sync currently in flight — their Sync button shows progress. */
  syncing: string[];
  /**
   * Whether the resolve-conflicts action exists in the registry (gates the
   * per-PR "Resolve conflicts" button on conflicting rows).
   */
  resolveConflictsAvailable: boolean;
  /**
   * Branch names with a resolve-conflicts spawn in flight — their button shows a
   * spinner and disables, so a double-click can't double-spawn.
   */
  resolvingConflicts: string[];
  /**
   * Whether the open-agent action exists in the registry (gates the per-PR "Open
   * agent" button, shown on every row regardless of conflict state).
   */
  openAgentAvailable: boolean;
  /**
   * Branch names with an open-agent spawn in flight — their button shows a
   * spinner and disables, so a double-click can't double-spawn.
   */
  openingAgents: string[];
  /**
   * Whether the merge-pr action exists in the registry (gates the per-PR "Merge"
   * button, shown only on a standalone PR that is {@link prCanMerge}).
   */
  mergePrAvailable: boolean;
  /**
   * Branch names with a merge in flight — their button shows a spinner and
   * disables, so a double-click can't double-merge.
   */
  mergingPrs: string[];
  /** A transient status toast, when one is active. */
  notice?: Notice;
  /**
   * The process-compose "Services" section. `visible` is false (the renderer
   * omits the section) when process-compose is unreachable or reports no
   * services, so the panel is unchanged for users without it.
   */
  services: ServicesSection;
  /**
   * The dex task board section. `visible` is false (renderer omits it) only when
   * the dex plugin is absent, so the panel is unchanged for users without it; an
   * installed plugin with zero tasks still shows an (empty) section.
   */
  dex: DexSection;
  /**
   * The git "Worktrees" section. `visible` is false (renderer omits it) when the
   * worktrees plugin is absent or reports none.
   */
  worktrees: WorktreesSection;
  /**
   * The plugin tabs to draw in the tab strip, in display order (PRs first,
   * Services, Dex, Worktrees — each when visible). The renderer shows one tab's
   * content at a time and uses each tab's badge to keep the others glanceable.
   */
  tabs: PanelTab[];
  /**
   * The last-selected tab id, persisted across panel opens/restarts. Attached by
   * the main process (not derived here); the renderer uses it to seed the active
   * tab on first render, then owns the selection. Undefined when none is saved.
   */
  savedActiveTab?: string;
  /**
   * The persisted Dex view mode (tree/graph), restored across panel opens/restarts.
   * Attached by the main process (not derived here); the renderer uses it to seed
   * the Dex view on first render, then owns the selection. Undefined when none is saved.
   */
  savedDexViewMode?: DexViewMode;
  /**
   * The persisted New-task dialog size, restored across panel opens/restarts.
   * Attached by the main process (not derived here); the renderer seeds the
   * dialog's size from it on mount (clamped to the viewport), then the resize
   * grabber owns it. Undefined when none is saved (the dialog keeps its CSS default).
   */
  savedNewTaskDialogSize?: DialogSize;
  /**
   * Each work-item's "landable" signal, keyed by dex task id — derived by
   * joining the worktree↔task link to the PR overview by head branch (see
   * `landable.ts`). The foundation for a later merge-queue view; nothing renders
   * it yet. A task absent from the map has no matching PR (state `none`).
   */
  landableByTaskId: Map<string, LandableState>;
  /**
   * Each work-item's live agent (Claude Code session), keyed by dex task id —
   * derived by joining the worktree↔task link to the `agents.list` fleet (see
   * `agents-state.ts`). Matched by `agent.taskId` primarily, falling back to
   * `cwd === worktree.path`; the most-recent session wins a tie. The data
   * foundation for a later fleet view; nothing renders it yet. A task absent from
   * the map has no matching session.
   */
  agentByTaskId: Map<string, AgentSummary>;
}

/** Inputs to {@link buildPanelState}. */
export interface BuildInput {
  /** The latest `stack.prs` data, or `undefined` if none has arrived yet. */
  overview?: PrOverview;
  /** False when the daemon socket is unreachable. */
  daemonUp: boolean;
  /** Whether `stack.sync` is present in `registry.list`. */
  syncAvailable: boolean;
  /** Whether `stack.resolve-conflicts` is present in `registry.list`. */
  resolveConflictsAvailable?: boolean;
  /** Whether `stack.open-agent` is present in `registry.list`. */
  openAgentAvailable?: boolean;
  /** Whether `stack.merge-pr` is present in `registry.list`. */
  mergePrAvailable?: boolean;
  /** A transient error message (e.g. an invoke failed). */
  error?: string;
  /** Repos with an in-flight sync. */
  syncing?: string[];
  /** Branches with an in-flight resolve-conflicts spawn. */
  resolvingConflicts?: string[];
  /** Branches with an in-flight open-agent spawn. */
  openingAgents?: string[];
  /** Branches with an in-flight merge. */
  mergingPrs?: string[];
  /** A transient status toast. */
  notice?: Notice;
  /** The latest `services.list` data, or `undefined` if none has arrived yet. */
  servicesList?: ServiceList;
  /** The latest `dex.tasks` data, or `undefined` if none has arrived yet. */
  dexBoard?: DexBoard;
  /**
   * Whether `dex.tasks` is present in `registry.list`. Drives the Dex section's
   * visibility independently of whether a board has arrived — an installed plugin
   * with zero tasks still shows its (empty) section.
   */
  dexPresent?: boolean;
  /** The latest `worktrees.list` data, or `undefined` if none has arrived yet. */
  worktreesList?: WorktreeList;
  /** The latest `agents.list` fleet, or `undefined` if none has arrived yet. */
  agentFleet?: AgentFleet;
  /**
   * The active alerts the daemon currently has raised (the same set the Dashboard
   * pane polls via `alerts.list`), or `undefined` if none has arrived yet. Feeds
   * only the Dashboard tab's count badge — the pane still owns the alert list it
   * renders.
   */
  alerts?: Alert[];
  /** Service names with an in-flight start/stop/restart — their buttons spin. */
  servicesActing?: string[];
  /**
   * The whole-stack action in flight per scope (a repo `project`, or the pane
   * sentinel for the flat list), so one group's bulk action spins only that
   * group's controls. Keyed by `project ?? SERVICES_PANE_SCOPE`.
   */
  servicesBulkActing?: ReadonlyMap<string, ServicesBulkAction>;
}

/**
 * Count the work-items whose landable state is awaiting *your* decision — the
 * states where the next move is yours: `needs-review` (CI green, not yet
 * approved) and `ready` (CI green AND approved, safe to land). The blocked /
 * in-flight states (`ci-running`, `ci-failed`, `changes-requested`) are waiting
 * on CI or the author, not on you; `merged`/`none` are nothing to act on.
 *
 * Drives the menu-bar tray badge (see `main.ts`): an at-a-glance count of how
 * many finished agent PRs need you to review or land them. Pure — same map →
 * same count — so it's unit-testable without Electron.
 */
export function landableDecisionCount(
  landableByTaskId: ReadonlyMap<string, LandableState>,
): number {
  let n = 0;
  for (const state of landableByTaskId.values()) {
    if (state === "needs-review" || state === "ready") n += 1;
  }
  return n;
}

/** Map a normalized CI status to a status chip. */
export function ciChip(ci: CiStatus): Chip {
  switch (ci) {
    case "pass":
      return { label: "✓ CI", tone: "ok", hint: "CI passing" };
    case "fail":
      return { label: "✗ CI", tone: "bad", hint: "CI failing" };
    case "pending":
      return { label: "CI", tone: "warn", hint: "CI running", icon: "arrows-spin", spin: true };
    case "none":
      return { label: "· CI", tone: "muted", hint: "No CI reported" };
  }
}

/** Map a GitHub review decision to a status chip, or `undefined` if absent. */
export function reviewChip(review: ReviewDecision | undefined): Chip | undefined {
  switch (review) {
    case "APPROVED":
      return { label: "✓ rev", tone: "ok", hint: "Approved" };
    case "CHANGES_REQUESTED":
      return { label: "✗ rev", tone: "bad", hint: "Changes requested" };
    case "REVIEW_REQUIRED":
      return { label: "○ rev", tone: "warn", hint: "Review pending" };
    case undefined:
      return undefined;
  }
}

/** Map a GitHub mergeable state to a status chip, or `undefined` if absent/clean. */
export function mergeableChip(mergeable: Mergeable | undefined): Chip | undefined {
  switch (mergeable) {
    case "CONFLICTING":
      return { label: "⚠ merge", tone: "bad", hint: "Merge conflict" };
    case "UNKNOWN":
      return { label: "? merge", tone: "muted", hint: "Mergeability unknown" };
    case "MERGEABLE":
    case undefined:
      // Clean / mergeable is the happy path — no chip needed (reduces clutter).
      return undefined;
  }
}

/** Returns a chip when branch protection is blocking the merge, otherwise `undefined`. */
export function mergeBlockedChip(mergeStateStatus: string | undefined): Chip | undefined {
  return mergeStateStatus === "BLOCKED"
    ? { label: "✗ frozen", tone: "bad", hint: "Merging blocked: protected ref" }
    : undefined;
}

/**
 * A PR is `"bad"` (red) when something blocks the merge: CI failing, a merge
 * conflict, a needed rebase, or changes requested. Absent any of those, it's
 * `"warn"` (amber) when there are human review comments to address, else `"ok"`
 * (green). Blocking problems outrank comments — a PR with both reads red.
 */
export function prHealth(pr: PrInfo): Health {
  const blocked =
    pr.mergeStateStatus === "BLOCKED" ||
    pr.ciStatus === "fail" ||
    (pr.conflict ?? false) ||
    (pr.needsRebase ?? false) ||
    pr.reviewDecision === "CHANGES_REQUESTED";
  if (blocked) return "bad";
  return (pr.humanReviewCommentCount ?? 0) > 0 ? "warn" : "ok";
}

/**
 * Whether a PR is in a one-click-mergeable state for the per-PR Merge button:
 * GitHub reports it `MERGEABLE`, CI isn't failing or pending (green, or no checks
 * configured), there's no conflict or needed rebase, and reviewers haven't
 * requested changes. This is the UX gate that decides whether to *offer* the
 * button — `gh pr merge` re-checks mergeability server-side at merge time
 * (pending checks, branch protection, required reviews), so it stays the merge
 * authority and a stale panel can't force a bad merge.
 */
export function prCanMerge(pr: PrInfo): boolean {
  return (
    pr.mergeStateStatus !== "BLOCKED" &&
    pr.mergeable === "MERGEABLE" &&
    pr.ciStatus !== "fail" &&
    pr.ciStatus !== "pending" &&
    !(pr.conflict ?? false) &&
    !(pr.needsRebase ?? false) &&
    pr.reviewDecision !== "CHANGES_REQUESTED"
  );
}

/**
 * The actionable PR states the dashboard raises as alerts. Each maps to a stable
 * alert id suffix (`stack:<repo>:<branch>:<condition>`) and to a labelled widget
 * with the relevant action buttons:
 * - `needs-rebase`   — the PR's base advanced past it (offer Sync).
 * - `ci-failing`     — CI reported a failure (offer Open PR).
 * - `review-comments`— a reviewer left inline comments to address (offer Open PR).
 * - `ready-to-merge` — CI green AND approved, mergeable (offer Merge).
 */
export type StackAlertCondition =
  | "needs-rebase"
  | "ci-failing"
  | "review-comments"
  | "ready-to-merge";

/**
 * The opaque payload a `stack` alert carries to its renderer widget — everything
 * the {@link StackAlertCondition} widget needs to label the alert and wire its
 * action buttons (Sync/Merge/Open PR) without re-reading the overview. Defined
 * here (the Electron-free shape layer) so both the main-process deriver and the
 * renderer widget share one definition.
 */
export interface StackAlertPayload {
  /** Which actionable state this alert represents. */
  condition: StackAlertCondition;
  /** The repo (name) the PR lives in — selects the target for Sync/Merge. */
  repo: string;
  /** The PR's head branch — the alert id key + the Merge/Sync in-flight key. */
  branch: string;
  /** The PR number, shown in the widget and passed to Merge. */
  number: number;
  /** The PR title, shown in the widget. */
  title: string;
  /** The PR's web URL — the Open PR button + the widget's click target. */
  url: string;
}

/** A desired alert: its stable id and the payload its widget renders. */
export interface StackAlertSpec {
  /** `stack:<repo>:<branch>:<condition>` — stable across polls so re-raises dedupe. */
  id: string;
  /** The plugin-defined detail the renderer's `stack` widget reads. */
  payload: StackAlertPayload;
}

/**
 * The actionable conditions a PR is currently in, in display order (most blocking
 * first). Empty when the PR is clean / has nothing to act on. `ready-to-merge` is
 * mutually exclusive with the blocking states by construction ({@link prCanMerge}
 * already excludes a failing CI / needed rebase / requested changes).
 */
export function prAlertConditions(pr: PrInfo): StackAlertCondition[] {
  const conditions: StackAlertCondition[] = [];
  if (pr.needsRebase ?? false) conditions.push("needs-rebase");
  if (pr.ciStatus === "fail") conditions.push("ci-failing");
  if ((pr.humanReviewCommentCount ?? 0) > 0) conditions.push("review-comments");
  if (prCanMerge(pr) && pr.reviewDecision === "APPROVED") conditions.push("ready-to-merge");
  return conditions;
}

/**
 * Derive the full set of `stack` alerts the dashboard should currently have
 * raised, one per (PR, actionable condition), across every repo + stack layer in
 * the overview. Pure: same overview → same specs, so the main process can diff it
 * against the last-raised set to reconcile the daemon's alert store (raise the
 * new, clear the resolved). Returns `[]` for an absent overview.
 */
export function deriveStackAlerts(overview: PrOverview | undefined): StackAlertSpec[] {
  if (!overview) return [];
  const specs: StackAlertSpec[] = [];
  for (const repo of overview.repos) {
    for (const group of repo.groups) {
      const prs = group.kind === "pr" ? [group.pr] : group.layers;
      for (const pr of prs) {
        for (const condition of prAlertConditions(pr)) {
          specs.push({
            id: `stack:${repo.name}:${pr.headRefName}:${condition}`,
            payload: {
              condition,
              repo: repo.name,
              branch: pr.headRefName,
              number: pr.number,
              title: pr.title,
              url: pr.url,
            },
          });
        }
      }
    }
  }
  return specs;
}

/** Derive a single rendered PR row from a raw {@link PrInfo} in repo `repoName`. */
export function toPrRow(pr: PrInfo, repoName: string): PrRow {
  const chips: Chip[] = [ciChip(pr.ciStatus ?? "none")];
  const review = reviewChip(pr.reviewDecision);
  if (review) {
    // The "needs review" chip is a call to action: make it click-to-open so the
    // reviewer can jump straight to the PR. Other review chips stay passive.
    if (pr.reviewDecision === "REVIEW_REQUIRED") {
      review.href = pr.url;
      review.actionLabel = "Open PR for review";
      review.hint = "Open PR for review";
    }
    chips.push(review);
  }
  const merge = mergeableChip(pr.mergeable);
  if (merge) chips.push(merge);
  const frozen = mergeBlockedChip(pr.mergeStateStatus);
  if (frozen) chips.push(frozen);
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    branch: pr.headRefName,
    baseRefName: pr.baseRefName,
    repo: repoName,
    chips,
    needsRebase: pr.needsRebase ?? false,
    conflict: pr.conflict ?? false,
    canMerge: prCanMerge(pr),
    humanReviewCommentCount: pr.humanReviewCommentCount ?? 0,
    health: prHealth(pr),
  };
}

/**
 * Derive a rendered group row from a raw {@link PrGroup} in repo `repoName`,
 * applying the configured {@link StackDirection} to the layer order.
 */
function toGroupRow(group: PrGroup, repoName: string, direction: StackDirection): GroupRow {
  if (group.kind === "pr") {
    return { kind: "pr", pr: toPrRow(group.pr, repoName) };
  }
  // Stack layers always arrive bottom → top. For "bottom-to-top" (default) keep
  // that order so the base (#1) reads at the top, ascending to the tip; for
  // "top-to-bottom" reverse so the tip reads at the top. The renderer numbers
  // rows 1..N in array order, so reversing flips both row order and numbering.
  const ordered = direction === "top-to-bottom" ? [...group.layers].reverse() : group.layers;
  const rows = ordered.map((pr) => toPrRow(pr, repoName));
  const needsRebase = group.needsRebase ?? false;
  // Whole-stack health takes the worst layer (bad > warn > ok); a needed rebase
  // forces bad. Amber surfaces "some layer has comments to address" on the bar.
  const health: Health =
    needsRebase || rows.some((r) => r.health === "bad")
      ? "bad"
      : rows.some((r) => r.health === "warn")
        ? "warn"
        : "ok";
  return {
    kind: "stack",
    rows,
    tracked: group.tracked ?? false,
    needsRebase,
    health,
    repo: repoName,
  };
}

/** Total PR count across a repo's groups (a stack counts as its layers). */
function repoPrCount(repo: PrRepo): number {
  let n = 0;
  for (const g of repo.groups) n += g.kind === "stack" ? g.layers.length : 1;
  return n;
}

/** Total rendered PR rows across all repo sections (a stack counts its layers). */
function panelPrCount(repos: RepoSection[]): number {
  let n = 0;
  for (const repo of repos) {
    for (const group of repo.groups) n += group.kind === "pr" ? 1 : group.rows.length;
  }
  return n;
}

/** Worst (most severe) health across all rendered PR rows: bad > warn > ok. */
function worstRepoHealth(repos: RepoSection[]): Health {
  const rank: Record<Health, number> = { ok: 0, warn: 1, bad: 2 };
  let worst: Health = "ok";
  for (const repo of repos) {
    for (const group of repo.groups) {
      const rows = group.kind === "pr" ? [group.pr] : group.rows;
      for (const r of rows) if (rank[r.health] > rank[worst]) worst = r.health;
    }
  }
  return worst;
}

/** The derived sections a tab spec inspects to decide visibility + its badge. */
interface TabContext {
  repos: RepoSection[];
  services: ServicesSection;
  dex: DexSection;
  worktrees: WorktreesSection;
  alerts: Alert[];
}

/**
 * One plugin's tab, declared once. `visible` gates whether the tab shows for the
 * current state; `badge` computes its glanceable status. Adding a plugin tab is
 * a single entry here — the renderer draws whatever `buildTabs` returns.
 */
interface TabSpec {
  id: string;
  label: string;
  icon: string;
  visible: (ctx: TabContext) => boolean;
  badge: (ctx: TabContext) => TabBadge | undefined;
}

/**
 * The ordered tab registry: Dashboard first (always) as the alerts home, then
 * PRs (always), then Services and Dex when their sections are visible. Each spec
 * owns its badge logic — Dashboard shows the active-alert count (a bare muted dot
 * when there are none); PRs shows the open-PR count tinted by worst PR health (a
 * bare muted dot when there are none); Services a bare status dot; Dex the
 * ready+blocked count tinted by worst dex health (blocked → red), or a bare dot
 * when nothing's waiting.
 */
const TAB_SPECS: readonly TabSpec[] = [
  {
    id: DASHBOARD_TAB_ID,
    label: "Dashboard",
    icon: "bell",
    // Always available — it's the home for plugin alerts. The pane renders the
    // alert list from its own `alerts.list` poll; the badge shows the active
    // count (tinted `warn`, since an alert is always something to act on), or a
    // bare muted dot when there are none.
    visible: () => true,
    badge: ({ alerts }) =>
      alerts.length > 0 ? { count: alerts.length, tone: "warn" } : { tone: "muted" },
  },
  {
    id: STACK_TAB_ID,
    label: "PRs",
    icon: "code-pull-request",
    visible: () => true,
    badge: ({ repos }) => {
      const count = panelPrCount(repos);
      return count > 0 ? { count, tone: worstRepoHealth(repos) } : { tone: "muted" };
    },
  },
  {
    id: SERVICES_TAB_ID,
    label: "Services",
    icon: "gears",
    visible: ({ services }) => services.visible,
    badge: ({ services }) => ({ tone: worstServiceHealth(services) }),
  },
  {
    id: DEX_TASKS_ID,
    label: "Dex",
    icon: "list-check",
    visible: ({ dex }) => dex.visible,
    badge: ({ dex }) => {
      const open = dex.counts.ready + dex.counts.blocked;
      return { count: open > 0 ? open : undefined, tone: worstDexHealth(dex) };
    },
  },
  {
    id: WORKTREES_LIST_ID,
    label: "Worktrees",
    icon: "code-branch",
    visible: ({ worktrees }) => worktrees.visible,
    // The worktree count, tinted by the worst state (conflict/prunable → red,
    // diverged → amber, else neutral).
    badge: ({ worktrees }) => ({
      count: worktrees.counts.total,
      tone: worstWorktreeHealth(worktrees),
    }),
  },
];

/** Build the visible tabs (in registry order) from the derived sections. */
function buildTabs(ctx: TabContext): PanelTab[] {
  return TAB_SPECS.filter((spec) => spec.visible(ctx)).map((spec) => ({
    id: spec.id,
    label: spec.label,
    icon: spec.icon,
    badge: spec.badge(ctx),
  }));
}

/**
 * Build the full {@link PanelState} from raw inputs. Pure: same inputs → same
 * output, no side effects. The renderer draws whatever this returns.
 */
export function buildPanelState(input: BuildInput): PanelState {
  const { overview, daemonUp, syncAvailable, error } = input;
  // The dex board and worktrees list both feed the panel; join them once here so
  // each section can carry the cross-reference (a worktree's task, a task's live
  // worktree). The link tolerates either board being absent (empty maps).
  const dexBoard = daemonUp ? input.dexBoard : undefined;
  const worktreesList = daemonUp ? input.worktreesList : undefined;
  const link = linkWorktreesAndTasks(worktreesList, dexBoard);

  // Join the worktree↔task link to the PR overview (by head branch) to derive
  // each work-item's landable signal. Pure + tolerant: a missing overview / no
  // matching PR yields an empty (or partial) map. Nothing renders it yet — it's
  // computed here so a later merge-queue view can consume it off PanelState.
  const landableByTaskId = deriveLandableByTaskId(link, daemonUp ? overview : undefined);

  // The matched PR's `{ number, url }` per task, from the identical branch→PR
  // join — lines up 1:1 with `landableByTaskId` so each landable row can render
  // an actionable `#<number>` chip. Kept a separate map to leave the landable
  // join's shape (and the tray-badge count) untouched.
  const landablePrByTaskId = deriveLandablePrByTaskId(link, daemonUp ? overview : undefined);

  // Join the worktree↔task link to the agent fleet to attach each work-item's
  // live Claude Code session, keyed by task id. Pure + tolerant: a missing/empty
  // fleet (e.g. the agents plugin disabled) or no matching session yields an
  // empty (or partial) map. Nothing renders it yet — it's computed here so a
  // later fleet view can consume it off PanelState.
  const agentByTaskId = deriveAgentByTaskId(link, daemonUp ? input.agentFleet : undefined);

  // Sync progress, the transient toast, and the Services section ride along on
  // every state (the section is self-hiding when process-compose is absent).
  const live = {
    syncing: input.syncing ?? [],
    // Gated like `syncAvailable`: false while the daemon is down, else whatever
    // the registry probe found. The in-flight branch set rides along too.
    resolveConflictsAvailable: daemonUp ? !!input.resolveConflictsAvailable : false,
    resolvingConflicts: input.resolvingConflicts ?? [],
    openAgentAvailable: daemonUp ? !!input.openAgentAvailable : false,
    openingAgents: input.openingAgents ?? [],
    mergePrAvailable: daemonUp ? !!input.mergePrAvailable : false,
    mergingPrs: input.mergingPrs ?? [],
    notice: input.notice,
    landableByTaskId,
    agentByTaskId,
    services: buildServicesSection(
      daemonUp ? input.servicesList : undefined,
      input.servicesActing,
      input.servicesBulkActing,
    ),
    dex: buildDexSection(
      dexBoard,
      daemonUp && !!input.dexPresent,
      link.worktreeByTaskId,
      landableByTaskId,
      agentByTaskId,
      landablePrByTaskId,
    ),
    worktrees: buildWorktreesSection(worktreesList, link.taskByWorktreePath),
  };

  // The active alerts feed only the Dashboard tab's count badge. Gated on
  // `daemonUp` so a stale set can't outlive the daemon (its alerts are in-memory
  // and lost on restart) — daemon down → a bare muted dot.
  const alerts = daemonUp ? input.alerts ?? [] : [];

  if (!daemonUp) {
    return {
      status: "daemon-down",
      message: "perchd not running — start it with `perchd`",
      repos: [],
      syncAvailable: false,
      ...live,
      tabs: buildTabs({
        repos: [],
        services: live.services,
        dex: live.dex,
        worktrees: live.worktrees,
        alerts,
      }),
    };
  }

  if (error) {
    return {
      status: "error",
      message: error,
      repos: [],
      syncAvailable,
      ...live,
      tabs: buildTabs({
        repos: [],
        services: live.services,
        dex: live.dex,
        worktrees: live.worktrees,
        alerts,
      }),
    };
  }

  if (!overview) {
    return {
      status: "loading",
      message: "Loading…",
      repos: [],
      syncAvailable,
      ...live,
      tabs: buildTabs({
        repos: [],
        services: live.services,
        dex: live.dex,
        worktrees: live.worktrees,
        alerts,
      }),
    };
  }

  // Presentation-only stack ordering; default to today's base-first behavior
  // when the daemon omits it (older daemons / no config).
  const direction: StackDirection = overview.stackDirection ?? "bottom-to-top";
  const repos: RepoSection[] = overview.repos.map((repo) => ({
    name: repo.name,
    error: repo.error,
    groups: repo.groups.map((g) => toGroupRow(g, repo.name, direction)),
  }));

  // "Empty" when every repo has neither PRs nor an error to surface.
  const anyContent = overview.repos.some((r) => repoPrCount(r) > 0 || r.error);
  const tabs = buildTabs({
    repos,
    services: live.services,
    dex: live.dex,
    worktrees: live.worktrees,
    alerts,
  });
  if (!anyContent) {
    return { status: "empty", message: "No open PRs", repos, syncAvailable, ...live, tabs };
  }

  return { status: "ok", repos, syncAvailable, ...live, tabs };
}
