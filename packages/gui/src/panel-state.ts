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

/** `stack.prs`'s output: every configured repo's PRs, grouped. */
export interface PrOverview {
  repos: PrRepo[];
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
}

/** A rendered group: either a single PR row or a nested stack of rows. */
export type GroupRow =
  | { kind: "pr"; pr: PrRow }
  | {
      kind: "stack";
      /** Layers base-first (the trunk-adjacent base #1 reads at the top). */
      rows: PrRow[];
      /** Whether the Sync action should show for this stack (gh-stack tracked). */
      tracked: boolean;
      /** Stack-level "needs rebase" flag (any layer). */
      needsRebase: boolean;
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
  };
}

/** Derive a rendered group row from a raw {@link PrGroup} in repo `repoName`. */
function toGroupRow(group: PrGroup, repoName: string): GroupRow {
  if (group.kind === "pr") {
    return { kind: "pr", pr: toPrRow(group.pr) };
  }
  // Stack layers arrive bottom → top; keep that order so the base (#1) reads at
  // the top of the group, ascending to the tip.
  const rows = group.layers.map(toPrRow);
  return {
    kind: "stack",
    rows,
    tracked: group.tracked ?? false,
    needsRebase: group.needsRebase ?? false,
    repo: repoName,
  };
}

/** Total PR count across a repo's groups (a stack counts as its layers). */
function repoPrCount(repo: PrRepo): number {
  let n = 0;
  for (const g of repo.groups) n += g.kind === "stack" ? g.layers.length : 1;
  return n;
}

/**
 * Build the full {@link PanelState} from raw inputs. Pure: same inputs → same
 * output, no side effects. The renderer draws whatever this returns.
 */
export function buildPanelState(input: BuildInput): PanelState {
  const { overview, daemonUp, syncAvailable, error } = input;
  // Sync progress + the transient toast ride along on every state.
  const live = { syncing: input.syncing ?? [], notice: input.notice };

  if (!daemonUp) {
    return {
      status: "daemon-down",
      message: "perchd not running — start it with `perchd`",
      repos: [],
      syncAvailable: false,
      ...live,
    };
  }

  if (error) {
    return { status: "error", message: error, repos: [], syncAvailable, ...live };
  }

  if (!overview) {
    return { status: "loading", message: "Loading…", repos: [], syncAvailable, ...live };
  }

  const repos: RepoSection[] = overview.repos.map((repo) => ({
    name: repo.name,
    error: repo.error,
    groups: repo.groups.map((g) => toGroupRow(g, repo.name)),
  }));

  // "Empty" when every repo has neither PRs nor an error to surface.
  const anyContent = overview.repos.some((r) => repoPrCount(r) > 0 || r.error);
  if (!anyContent) {
    return { status: "empty", message: "No open PRs", repos, syncAvailable, ...live };
  }

  return { status: "ok", repos, syncAvailable, ...live };
}
