/**
 * Electron-free panel state + view-model derivation.
 *
 * This module owns ALL the data-shaping logic the GUI needs and deliberately
 * imports nothing from Electron, so it can be unit-tested with plain Node. The
 * main process subscribes to `stack.view` over RPC and feeds the raw
 * {@link StackGraph} (plus a "daemon down" / "sync availability" signal) through
 * {@link buildPanelState}; the renderer receives the resulting {@link PanelState}
 * and draws it verbatim — no business logic lives in the renderer.
 *
 * The {@link StackGraph} shape is duplicated here (rather than depending on the
 * stack plugin) because the GUI is a thin client of the daemon: it only knows
 * the wire shape of `stack.view`'s output, not the plugin's internals.
 */

/** Canonical capability id of the stack read the panel renders. */
export const STACK_VIEW_ID = "stack.view";
/** Canonical capability id of the hero Sync action (added by M6). */
export const STACK_SYNC_ID = "stack.sync";

/** Normalized CI rollup for a layer (mirrors the stack plugin's `CiStatus`). */
export type CiStatus = "pass" | "fail" | "pending" | "none";

/** GitHub review decision, passed through verbatim when present. */
export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";

/** GitHub mergeable state, passed through verbatim when present. */
export type Mergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/** One layer of the stack as it arrives over RPC (the wire shape of a layer). */
export interface StackLayer {
  branch: string;
  prNumber?: number;
  title?: string;
  ciStatus?: CiStatus;
  reviewDecision?: ReviewDecision;
  mergeable?: Mergeable;
  needsRebase?: boolean;
  conflict?: boolean;
  url?: string;
}

/** `stack.view`'s output: an ordered linear chain, bottom → top. */
export interface StackGraph {
  repo?: string;
  layers: StackLayer[];
}

/** A status chip rendered next to a layer. `tone` drives its color. */
export interface Chip {
  /** Short glyph + label, e.g. `"✓ CI"`. */
  label: string;
  /** Color tone the renderer maps to a CSS class. */
  tone: "ok" | "warn" | "bad" | "muted";
  /** Longer description for the chip's `title`/tooltip. */
  hint: string;
}

/** A single rendered row of the stack panel. */
export interface LayerRow {
  branch: string;
  prNumber?: number;
  title?: string;
  /** Web URL of the PR, if known (renderer may make the row clickable). */
  url?: string;
  /** Status chips (CI / review / mergeable), already mapped to glyphs + tones. */
  chips: Chip[];
  /** True when this layer's base advanced past it — render a "needs rebase" badge. */
  needsRebase: boolean;
  /** True when this layer has a merge conflict — render a "conflict" badge. */
  conflict: boolean;
}

/** The complete state the renderer needs to draw the panel. */
export interface PanelState {
  /** Overall connection/data status. */
  status: "ok" | "empty" | "daemon-down" | "error";
  /** Human-readable message for non-`ok` states (e.g. "perchd not running"). */
  message?: string;
  /** Repo label for the header, when known. */
  repo?: string;
  /** Rendered rows (top of the stack first, so the tip reads at the top). */
  rows: LayerRow[];
  /** Whether the Sync button should be enabled (the action exists in the registry). */
  syncAvailable: boolean;
}

/** Inputs to {@link buildPanelState}. */
export interface BuildInput {
  /** The latest `stack.view` data, or `undefined` if none has arrived yet. */
  graph?: StackGraph;
  /** False when the daemon socket is unreachable. */
  daemonUp: boolean;
  /** Whether `stack.sync` is present in `registry.list` (M6 ships it). */
  syncAvailable: boolean;
  /** A transient error message (e.g. an invoke failed). */
  error?: string;
}

/** Map a normalized CI status to a status chip. */
export function ciChip(ci: CiStatus): Chip {
  switch (ci) {
    case "pass":
      return { label: "✓ CI", tone: "ok", hint: "CI passing" };
    case "fail":
      return { label: "✗ CI", tone: "bad", hint: "CI failing" };
    case "pending":
      return { label: "⋯ CI", tone: "warn", hint: "CI running" };
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

/** Derive a single rendered row from a raw stack layer. */
export function toLayerRow(layer: StackLayer): LayerRow {
  const chips: Chip[] = [ciChip(layer.ciStatus ?? "none")];
  const review = reviewChip(layer.reviewDecision);
  if (review) chips.push(review);
  const merge = mergeableChip(layer.mergeable);
  if (merge) chips.push(merge);
  return {
    branch: layer.branch,
    prNumber: layer.prNumber,
    title: layer.title,
    url: layer.url,
    chips,
    needsRebase: layer.needsRebase ?? false,
    conflict: layer.conflict ?? false,
  };
}

/**
 * Build the full {@link PanelState} from raw inputs. Pure: same inputs → same
 * output, no side effects. The renderer draws whatever this returns.
 *
 * Layers are reversed so the tip (top of the stack) renders at the top of the
 * panel, matching the target UI where the most-recent work reads first.
 */
export function buildPanelState(input: BuildInput): PanelState {
  const { graph, daemonUp, syncAvailable, error } = input;

  if (!daemonUp) {
    return {
      status: "daemon-down",
      message: "perchd not running — start it with `perchd`",
      rows: [],
      syncAvailable: false,
    };
  }

  if (error) {
    return { status: "error", message: error, rows: [], syncAvailable };
  }

  if (!graph) {
    return { status: "empty", message: "Loading stack…", rows: [], syncAvailable };
  }

  if (graph.layers.length === 0) {
    return {
      status: "empty",
      message: "No stack here — nothing to show",
      repo: graph.repo,
      rows: [],
      syncAvailable,
    };
  }

  const rows = [...graph.layers].reverse().map(toLayerRow);
  return { status: "ok", repo: graph.repo, rows, syncAvailable };
}
