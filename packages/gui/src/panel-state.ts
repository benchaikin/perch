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

/** Canonical capability id of the cross-repo "My PRs" read the panel renders. */
export const STACK_PRS_ID = "stack.prs";
/** Canonical capability id of the hero Sync action. */
export const STACK_SYNC_ID = "stack.sync";

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
}

/** A single rendered PR row. */
export interface PrRow {
  number: number;
  title: string;
  /** Web URL of the PR — the renderer makes the row clickable to open it. */
  url: string;
  branch: string;
  /** Status chips (CI / review / mergeable), already mapped to glyphs + tones. */
  chips: Chip[];
  /** True when this PR's base advanced past it — render a "needs rebase" badge. */
  needsRebase: boolean;
  /** True when this PR has a merge conflict — render a "conflict" badge. */
  conflict: boolean;
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
  /** A transient status toast, when one is active. */
  notice?: Notice;
  /**
   * The process-compose "Services" section. `visible` is false (the renderer
   * omits the section) when process-compose is unreachable or reports no
   * services, so the panel is unchanged for users without it.
   */
  services: ServicesSection;
  /**
   * The plugin tabs to draw in the tab strip, in display order (PRs first,
   * Services when visible). The renderer shows one tab's content at a time and
   * uses each tab's badge to keep the others glanceable.
   */
  tabs: PanelTab[];
}

/** Inputs to {@link buildPanelState}. */
export interface BuildInput {
  /** The latest `stack.prs` data, or `undefined` if none has arrived yet. */
  overview?: PrOverview;
  /** False when the daemon socket is unreachable. */
  daemonUp: boolean;
  /** Whether `stack.sync` is present in `registry.list`. */
  syncAvailable: boolean;
  /** A transient error message (e.g. an invoke failed). */
  error?: string;
  /** Repos with an in-flight sync. */
  syncing?: string[];
  /** A transient status toast. */
  notice?: Notice;
  /** The latest `services.list` data, or `undefined` if none has arrived yet. */
  servicesList?: ServiceList;
  /** Service names with an in-flight start/stop/restart — their buttons spin. */
  servicesActing?: string[];
  /** The whole-stack action in flight (Start/Stop/Restart all), if any. */
  servicesBulkActing?: ServicesBulkAction;
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

/**
 * A PR is `"bad"` (red) when something blocks the merge: CI failing, a merge
 * conflict, a needed rebase, or changes requested. Absent any of those, it's
 * `"warn"` (amber) when there are human review comments to address, else `"ok"`
 * (green). Blocking problems outrank comments — a PR with both reads red.
 */
export function prHealth(pr: PrInfo): Health {
  const blocked =
    pr.ciStatus === "fail" ||
    (pr.conflict ?? false) ||
    (pr.needsRebase ?? false) ||
    pr.reviewDecision === "CHANGES_REQUESTED";
  if (blocked) return "bad";
  return (pr.humanReviewCommentCount ?? 0) > 0 ? "warn" : "ok";
}

/** Derive a single rendered PR row from a raw {@link PrInfo}. */
export function toPrRow(pr: PrInfo): PrRow {
  const chips: Chip[] = [ciChip(pr.ciStatus ?? "none")];
  const review = reviewChip(pr.reviewDecision);
  if (review) chips.push(review);
  const merge = mergeableChip(pr.mergeable);
  if (merge) chips.push(merge);
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    branch: pr.headRefName,
    chips,
    needsRebase: pr.needsRebase ?? false,
    conflict: pr.conflict ?? false,
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
    return { kind: "pr", pr: toPrRow(group.pr) };
  }
  // Stack layers always arrive bottom → top. For "bottom-to-top" (default) keep
  // that order so the base (#1) reads at the top, ascending to the tip; for
  // "top-to-bottom" reverse so the tip reads at the top. The renderer numbers
  // rows 1..N in array order, so reversing flips both row order and numbering.
  const ordered = direction === "top-to-bottom" ? [...group.layers].reverse() : group.layers;
  const rows = ordered.map(toPrRow);
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

/**
 * Build the plugin tab list from the derived sections. PRs is always first; the
 * Services tab is appended only when its section is visible. The PRs badge shows
 * the open-PR count tinted by the worst PR health, falling back to a bare muted
 * dot when there are none (empty / loading / daemon-down). The Services badge is
 * a bare status dot tinted by the worst service health. Registry-driven by
 * intent: a future plugin's tab slots in after these without renderer changes.
 */
function buildTabs(repos: RepoSection[], services: ServicesSection): PanelTab[] {
  const count = panelPrCount(repos);
  const tabs: PanelTab[] = [
    {
      id: STACK_TAB_ID,
      label: "PRs",
      icon: "code-pull-request",
      badge: count > 0 ? { count, tone: worstRepoHealth(repos) } : { tone: "muted" },
    },
  ];
  if (services.visible) {
    tabs.push({
      id: SERVICES_TAB_ID,
      label: "Services",
      icon: "gears",
      badge: { tone: worstServiceHealth(services) },
    });
  }
  return tabs;
}

/**
 * Build the full {@link PanelState} from raw inputs. Pure: same inputs → same
 * output, no side effects. The renderer draws whatever this returns.
 */
export function buildPanelState(input: BuildInput): PanelState {
  const { overview, daemonUp, syncAvailable, error } = input;
  // Sync progress, the transient toast, and the Services section ride along on
  // every state (the section is self-hiding when process-compose is absent).
  const live = {
    syncing: input.syncing ?? [],
    notice: input.notice,
    services: buildServicesSection(
      daemonUp ? input.servicesList : undefined,
      input.servicesActing,
      input.servicesBulkActing,
    ),
  };

  if (!daemonUp) {
    return {
      status: "daemon-down",
      message: "perchd not running — start it with `perchd`",
      repos: [],
      syncAvailable: false,
      ...live,
      tabs: buildTabs([], live.services),
    };
  }

  if (error) {
    return {
      status: "error",
      message: error,
      repos: [],
      syncAvailable,
      ...live,
      tabs: buildTabs([], live.services),
    };
  }

  if (!overview) {
    return {
      status: "loading",
      message: "Loading…",
      repos: [],
      syncAvailable,
      ...live,
      tabs: buildTabs([], live.services),
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
  const tabs = buildTabs(repos, live.services);
  if (!anyContent) {
    return { status: "empty", message: "No open PRs", repos, syncAvailable, ...live, tabs };
  }

  return { status: "ok", repos, syncAvailable, ...live, tabs };
}
