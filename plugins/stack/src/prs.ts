/**
 * `stack.prs` — the cross-repo "My PRs" read (v1.2).
 *
 * For each configured repo (or `process.cwd()` when none are configured), lists
 * the current user's open PRs, groups stacked PRs together (via the shared
 * `base.ref → head.ref` chaining), and optionally enriches a stack group with
 * gh-stack's authoritative ordering + needs-rebase when the repo has local
 * gh-stack tracking.
 *
 * Resilient by design: each repo is fetched independently and best-effort, so
 * one repo's failure (a 504, no remote, auth) sets that repo's `error` and
 * leaves the rest of the overview intact.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import { z } from "@perch/sdk";

import { allChains } from "./chains.js";
import { rollupToCiStatus, parseStackView } from "./gh-provider.js";
import { CiStatus } from "./graph.js";
import type { Exec, ExecOptions } from "./provider.js";

/** One open PR authored by the current user. */
export const PrInfo = z.object({
  /** PR number. */
  number: z.number().int(),
  /** PR title. */
  title: z.string(),
  /** Web URL of the PR. */
  url: z.string(),
  /** Head branch (this PR's branch). */
  headRefName: z.string(),
  /** Base branch (what this PR merges into). */
  baseRefName: z.string(),
  /** Normalized CI rollup; `none` when there are no checks. */
  ciStatus: CiStatus.default("none"),
  /** GitHub review decision, passed through verbatim when present. */
  reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).optional(),
  /** GitHub mergeable state, passed through verbatim when present. */
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]).optional(),
  /** Base advanced past this PR — a rebase is needed (only known when tracked). */
  needsRebase: z.boolean().default(false),
  /** This PR currently has a merge conflict against its base. */
  conflict: z.boolean().default(false),
});
export type PrInfo = z.infer<typeof PrInfo>;

/**
 * A group is either a single standalone PR or a stack of ≥2 chained PRs.
 * `layers` are ordered bottom → top (trunk-adjacent first).
 */
export const PrGroup = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pr"), pr: PrInfo }),
  z.object({
    kind: z.literal("stack"),
    layers: z.array(PrInfo).min(2),
    /** True when gh-stack locally tracks this stack (enables the Sync action). */
    tracked: z.boolean().default(false),
    /** Stack-level: any layer needs a rebase. */
    needsRebase: z.boolean().default(false),
  }),
]);
export type PrGroup = z.infer<typeof PrGroup>;

/** One configured repo's PRs, grouped. */
export const PrRepo = z.object({
  /** Display name — the basename of the repo's path. */
  name: z.string(),
  /** The local path, when repos are configured. */
  path: z.string().optional(),
  /** Standalone PRs + stack groups for this repo. */
  groups: z.array(PrGroup),
  /** Set (with `groups: []`) when this repo's PR lookup failed. */
  error: z.string().optional(),
});
export type PrRepo = z.infer<typeof PrRepo>;

/**
 * The configured stack-display order. `bottom-to-top` (default) reads the
 * trunk-adjacent base #1 at the top; `top-to-bottom` reverses the rendered
 * rows. Always presentation-only — `layers` stay bottom → top in the data.
 */
export const StackDirection = z.enum(["bottom-to-top", "top-to-bottom"]);
export type StackDirection = z.infer<typeof StackDirection>;

/** Output of the `stack.prs` read: every configured repo's PRs, grouped. */
export const PrOverview = z.object({
  repos: z.array(PrRepo),
  /**
   * The resolved {@link StackDirection} from config — the GUI applies it for
   * display only. `layers` are ALWAYS bottom → top in the data regardless.
   */
  stackDirection: StackDirection.default("bottom-to-top"),
});
export type PrOverview = z.infer<typeof PrOverview>;

const defaultExec: Exec = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, cwd: opts?.cwd },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });

/** Raw `gh pr list` row (only the fields we request). */
type PrRow = {
  number?: number;
  title?: string;
  url?: string;
  statusCheckRollup?: Parameters<typeof rollupToCiStatus>[0];
  reviewDecision?: string | null;
  mergeable?: string | null;
  headRefName?: string;
  baseRefName?: string;
};

const REVIEW_DECISIONS = ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"] as const;
const MERGEABLE_STATES = ["MERGEABLE", "CONFLICTING", "UNKNOWN"] as const;

/** Project one `gh pr list` row onto a normalized {@link PrInfo}. */
function rowToPrInfo(row: PrRow): PrInfo {
  const review = row.reviewDecision ?? "";
  const mergeable = row.mergeable ?? "";
  return PrInfo.parse({
    number: row.number,
    title: row.title,
    url: row.url,
    headRefName: row.headRefName,
    baseRefName: row.baseRefName,
    ciStatus: rollupToCiStatus(row.statusCheckRollup),
    reviewDecision: (REVIEW_DECISIONS as readonly string[]).includes(review) ? review : undefined,
    mergeable: (MERGEABLE_STATES as readonly string[]).includes(mergeable) ? mergeable : undefined,
    needsRebase: false,
    conflict: mergeable === "CONFLICTING",
  });
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

export interface PrOverviewOptions {
  /** Configured repo paths; empty/undefined → a single repo at `cwd`. */
  repos?: string[];
  /** Resolved display order, surfaced verbatim on the overview (default
   *  `"bottom-to-top"`). Presentation-only — never reorders `layers`. */
  stackDirection?: StackDirection;
  /** Working directory used as the single repo when no `repos` are configured. */
  cwd?: string;
  /** Injected command runner (tests inject a fixture). */
  exec?: Exec;
  /** Injected predicate for "this path has local gh-stack tracking". */
  hasGhStack?: (cwd: string | undefined) => boolean;
  /** Optional log sink. */
  log?: (message: string) => void;
}

/** A repo to fetch: its display name and the cwd to run `gh`/`git` in. */
interface RepoTarget {
  name: string;
  /** The local path, when repos are configured (`undefined` → `process.cwd()`). */
  path?: string;
  /** The cwd to run commands in. */
  cwd?: string;
}

/** Resolve the list of repos to fetch from config (back-compat: cwd as one repo). */
function resolveTargets(repos: string[] | undefined, cwd: string | undefined): RepoTarget[] {
  if (repos && repos.length > 0) {
    return repos.map((path) => ({ name: basename(path), path, cwd: path }));
  }
  // No repos configured → operate on the single cwd (the daemon's launch dir).
  const single = cwd ?? process.cwd();
  return [{ name: basename(single), cwd }];
}

/** Default tracking check: a `.git/gh-stack` directory/file exists under `cwd`. */
function defaultHasGhStack(cwd: string | undefined): boolean {
  const root = cwd ?? process.cwd();
  return existsSync(join(root, ".git", "gh-stack"));
}

/**
 * Enrich a repo's groups with gh-stack tracking. For a repo with local
 * `.git/gh-stack` tracking, runs `gh stack view --json` and, for the stack group
 * whose branches match gh-stack's chain, applies gh-stack's authoritative
 * ordering + `needsRebase` and marks it `tracked`. Best-effort: any failure
 * leaves the base-ref grouping untouched.
 */
async function enrichWithGhStack(
  groups: PrGroup[],
  exec: Exec,
  execOpts: ExecOptions | undefined,
  log: ((m: string) => void) | undefined,
): Promise<PrGroup[]> {
  let parsed;
  try {
    const stackOut = await exec("gh", ["stack", "view", "--json"], execOpts);
    parsed = parseStackView(stackOut);
  } catch (err) {
    log?.(`gh stack view failed; skipping enrichment: ${errorMessage(err)}`);
    return groups;
  }
  if (parsed.length === 0) return groups;

  const order = new Map<string, number>();
  const needsRebaseByBranch = new Map<string, boolean>();
  parsed.forEach((layer, i) => {
    order.set(layer.branch, i);
    needsRebaseByBranch.set(layer.branch, layer.needsRebase);
  });
  const trackedBranches = new Set(order.keys());

  return groups.map((group) => {
    if (group.kind !== "stack") return group;
    // Match a stack group to gh-stack's chain when they overlap on branches.
    const overlaps = group.layers.some((pr) => trackedBranches.has(pr.headRefName));
    if (!overlaps) return group;

    const layers = [...group.layers]
      .map((pr) => ({
        ...pr,
        needsRebase: needsRebaseByBranch.get(pr.headRefName) ?? pr.needsRebase,
      }))
      // Authoritative ordering: known branches by gh-stack order, then the rest.
      .sort((a, b) => {
        const ia = order.get(a.headRefName) ?? Number.MAX_SAFE_INTEGER;
        const ib = order.get(b.headRefName) ?? Number.MAX_SAFE_INTEGER;
        return ia - ib;
      });

    return {
      kind: "stack" as const,
      layers,
      tracked: true,
      needsRebase: layers.some((pr) => pr.needsRebase),
    };
  });
}

/** Group a repo's PRs into standalone PRs + stack groups (bottom → top). */
function groupPrs(prs: PrInfo[]): PrGroup[] {
  const chains = allChains(
    prs,
    (pr) => pr.headRefName,
    (pr) => pr.baseRefName,
  );
  return chains.map((chain) =>
    chain.length >= 2
      ? {
          kind: "stack" as const,
          layers: chain,
          tracked: false,
          needsRebase: chain.some((pr) => pr.needsRebase),
        }
      : { kind: "pr" as const, pr: chain[0]! },
  );
}

/** Fetch + group one repo's open PRs, best-effort (errors → `error` set). */
async function overviewForRepo(
  target: RepoTarget,
  exec: Exec,
  hasGhStack: (cwd: string | undefined) => boolean,
  log: ((m: string) => void) | undefined,
): Promise<PrRepo> {
  const execOpts: ExecOptions | undefined = target.cwd ? { cwd: target.cwd } : undefined;
  let prsRaw: unknown;
  try {
    const prOut = await exec(
      "gh",
      [
        "pr",
        "list",
        "--author",
        "@me",
        "--state",
        "open",
        "--json",
        "number,title,url,headRefName,baseRefName,statusCheckRollup,reviewDecision,mergeable",
      ],
      execOpts,
    );
    prsRaw = JSON.parse(prOut.trim() || "[]");
  } catch (err) {
    return { name: target.name, path: target.path, groups: [], error: errorMessage(err) };
  }

  const prs: PrInfo[] = [];
  if (Array.isArray(prsRaw)) {
    for (const row of prsRaw as PrRow[]) {
      if (row && typeof row.headRefName === "string" && typeof row.number === "number") {
        prs.push(rowToPrInfo(row));
      }
    }
  }

  let groups = groupPrs(prs);

  // gh-stack enrichment: only when this repo locally tracks a stack.
  if (groups.some((g) => g.kind === "stack") && hasGhStack(target.cwd)) {
    groups = await enrichWithGhStack(groups, exec, execOpts, log);
  }

  return { name: target.name, path: target.path, groups };
}

/** Build the cross-repo {@link PrOverview}. */
export async function buildPrOverview(options: PrOverviewOptions = {}): Promise<PrOverview> {
  const exec = options.exec ?? defaultExec;
  const hasGhStack = options.hasGhStack ?? defaultHasGhStack;
  const targets = resolveTargets(options.repos, options.cwd);

  const repos = await Promise.all(
    targets.map((target) => overviewForRepo(target, exec, hasGhStack, options.log)),
  );
  return PrOverview.parse({ repos, stackDirection: options.stackDirection });
}
