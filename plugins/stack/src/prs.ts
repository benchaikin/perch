/**
 * `stack.prs` — the cross-repo "My PRs" read (v1.2).
 *
 * For each configured repo (or `process.cwd()` when none are configured), lists
 * the current user's open PRs, groups stacked PRs together (via the shared
 * `base.ref → head.ref` chaining), and optionally enriches a stack group with
 * gh-stack's authoritative ordering + needs-rebase when the repo has local
 * gh-stack tracking. Alongside those, and gated on `showReviewRequests`, it
 * lists the open PRs the user is a requested reviewer on — kept in a separate
 * `reviewRequests` field so nothing that reasons about "my PRs" sees them.
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
import {
  cachedCurrentUserLogin,
  fetchHumanReviewCommentCount,
  rollupToCiStatus,
  parseStackView,
} from "./gh-provider.js";
import { CiStatus } from "./graph.js";
import type { Exec, ExecOptions } from "./provider.js";

/** One open PR — authored by the current user, or awaiting their review. */
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
  /**
   * The PR's author login. Only populated for review-requested PRs — on your
   * own PRs it is you, so the fetch doesn't ask GitHub for it.
   */
  author: z.string().optional(),
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
  /**
   * Count of inline review-thread comments authored by humans (bots + the
   * configured ignore-list filtered out). A "things to address" signal —
   * surfaced as a panel badge and a notification when it increases. Best-effort:
   * defaults to 0 when the per-PR comment fetch fails.
   */
  humanReviewCommentCount: z.number().int().default(0),
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
  /**
   * Open PRs in this repo where the current user is a requested reviewer — the
   * other half of a day's PR work. Deliberately a sibling of `groups` rather
   * than part of it: every consumer of `groups` (stack chaining, notifications,
   * dex↔PR landable linking, dashboard alerts) assumes "PRs I own", and keeping
   * these separate makes those correct by construction. Best-effort — an empty
   * array both when there are none and when the lookup failed.
   */
  reviewRequests: z.array(PrInfo).default([]),
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
  author?: { login?: string } | null;
};

/** `--json` fields for the authored list. */
const AUTHORED_JSON_FIELDS =
  "number,title,url,headRefName,baseRefName,statusCheckRollup,reviewDecision,mergeable";

/** Same, plus `author` — on a review request the author is someone else. */
const REVIEW_REQUESTED_JSON_FIELDS = `${AUTHORED_JSON_FIELDS},author`;

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
    author: row.author?.login,
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
  /**
   * Logins to treat as non-human when counting inline review comments — the
   * escape hatch for AI reviewers (CodeRabbit/Copilot/Sonar) that post as
   * ordinary accounts rather than as a GitHub App. From `plugins.stack
   * .reviewBotIgnore`. Bots (`type === "Bot"` / `[bot]` logins) are always
   * filtered regardless of this list.
   */
  reviewBotIgnore?: string[];
  /** Resolved display order, surfaced verbatim on the overview (default
   *  `"bottom-to-top"`). Presentation-only — never reorders `layers`. */
  stackDirection?: StackDirection;
  /**
   * Also list the open PRs awaiting the user's review (`plugins.stack
   * .showReviewRequests`, default true). When false the extra per-repo
   * `gh pr list --search` is never run — no API cost for users who don't
   * want the section.
   */
  showReviewRequests?: boolean;
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

    // Apply gh-stack's authoritative needsRebase to each layer IN PLACE, then
    // reorder the same PrInfo references — deliberately NOT copying (`{...pr}`).
    // `overviewForRepo` runs the per-PR comment fetch concurrently with this
    // enrichment, mutating `humanReviewCommentCount` on these same objects; a
    // shallow copy here would freeze a pre-count snapshot and silently drop the
    // badge on a tracked stack. Mutating in place keeps both writes visible.
    for (const pr of group.layers) {
      pr.needsRebase = needsRebaseByBranch.get(pr.headRefName) ?? pr.needsRebase;
    }
    const layers = [...group.layers]
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

/** Project a `gh pr list` stdout blob onto {@link PrInfo}s, skipping junk rows. */
function parsePrRows(stdout: string): PrInfo[] {
  const raw: unknown = JSON.parse(stdout.trim() || "[]");
  if (!Array.isArray(raw)) return [];
  const prs: PrInfo[] = [];
  for (const row of raw as PrRow[]) {
    if (row && typeof row.headRefName === "string" && typeof row.number === "number") {
      prs.push(rowToPrInfo(row));
    }
  }
  return prs;
}

/**
 * List the open PRs in this repo awaiting the user's review.
 *
 * `--search` reads GitHub's search index (which trails the API by seconds —
 * harmless at a 60s poll). Deliberately best-effort and isolated: a failure
 * yields `[]` rather than propagating, so a search hiccup can never blank out
 * the repo's own PRs or set its `error`.
 *
 * Note this covers *direct* requests only. Reviews routed through a team need
 * `team-review-requested:<org>/<team>`, which needs the team name — out of scope
 * (see `docs/prs-view.md`).
 */
async function fetchReviewRequests(
  exec: Exec,
  execOpts: ExecOptions | undefined,
  log: ((m: string) => void) | undefined,
): Promise<PrInfo[]> {
  try {
    const out = await exec(
      "gh",
      [
        "pr",
        "list",
        "--search",
        "review-requested:@me",
        "--state",
        "open",
        "--json",
        REVIEW_REQUESTED_JSON_FIELDS,
      ],
      execOpts,
    );
    return parsePrRows(out);
  } catch (err) {
    log?.(`review-requested lookup failed; skipping: ${errorMessage(err)}`);
    return [];
  }
}

/** Everything {@link overviewForRepo} needs beyond the repo it is fetching. */
interface RepoFetchDeps {
  exec: Exec;
  hasGhStack: (cwd: string | undefined) => boolean;
  reviewBotIgnore: readonly string[];
  showReviewRequests: boolean;
  /** The authenticated login, resolved once per overview (best-effort). */
  me: string | undefined;
  log?: (message: string) => void;
}

/** Fetch + group one repo's open PRs, best-effort (errors → `error` set). */
async function overviewForRepo(target: RepoTarget, deps: RepoFetchDeps): Promise<PrRepo> {
  const { exec, hasGhStack, reviewBotIgnore, showReviewRequests, me, log } = deps;
  const execOpts: ExecOptions | undefined = target.cwd ? { cwd: target.cwd } : undefined;

  // Kick the review-requested search off alongside the authored list — the two
  // are independent reads of the same repo. It never rejects (see above), so an
  // early `error` return below can't leave it unhandled.
  const reviewRequestsPromise = showReviewRequests
    ? fetchReviewRequests(exec, execOpts, log)
    : Promise.resolve([]);

  let prs: PrInfo[];
  try {
    const prOut = await exec(
      "gh",
      ["pr", "list", "--author", "@me", "--state", "open", "--json", AUTHORED_JSON_FIELDS],
      execOpts,
    );
    prs = parsePrRows(prOut);
  } catch (err) {
    return {
      name: target.name,
      path: target.path,
      groups: [],
      reviewRequests: await reviewRequestsPromise,
      error: errorMessage(err),
    };
  }

  const groups = groupPrs(prs);

  // Run the two independent post-fetch enrichments concurrently. The per-PR
  // comment counts mutate individual PrInfo objects while gh-stack enrichment
  // only reorders/annotates at the group level, so they share no data and need
  // no ordering between them.
  const [, enriched] = await Promise.all([
    // Per-PR enrichment: count human inline review comments. Best-effort and
    // isolated — one PR's failed comment fetch defaults to 0 (it can't fail the
    // overview). This adds one `gh api` call per open PR; the PR set is already
    // scoped to `--author @me` so the fan-out stays small in practice. `me` (the
    // authenticated login, resolved once per overview) drops the author's own
    // comments from the tally.
    Promise.all(
      prs.map(async (pr) => {
        pr.humanReviewCommentCount = await fetchHumanReviewCommentCount(
          exec,
          pr.number,
          reviewBotIgnore,
          execOpts,
          undefined,
          me,
        );
      }),
    ),
    // gh-stack enrichment: only when this repo locally tracks a stack.
    groups.some((g) => g.kind === "stack") && hasGhStack(target.cwd)
      ? enrichWithGhStack(groups, exec, execOpts, log)
      : Promise.resolve(groups),
  ]);

  // GitHub never requests a review from a PR's own author, so these sets can't
  // overlap today — the number-keyed filter is a cheap guard against a future
  // `--search` change quietly double-listing a PR.
  const mine = new Set(prs.map((pr) => pr.number));
  const reviewRequests = (await reviewRequestsPromise).filter((pr) => !mine.has(pr.number));

  return { name: target.name, path: target.path, groups: enriched, reviewRequests };
}

/** Build the cross-repo {@link PrOverview}. */
export async function buildPrOverview(options: PrOverviewOptions = {}): Promise<PrOverview> {
  const exec = options.exec ?? defaultExec;
  const hasGhStack = options.hasGhStack ?? defaultHasGhStack;
  const reviewBotIgnore = options.reviewBotIgnore ?? [];
  const targets = resolveTargets(options.repos, options.cwd);

  // Resolve the authenticated GitHub user's login so we can exclude the author's
  // own review comments from the per-PR badge count. It's stable per host, so
  // it's cached once per daemon run rather than re-fetched on every 60s poll.
  // Best-effort: `undefined` on any gh failure → no self-exclusion (current
  // behavior), never breaks the overview.
  const me = await cachedCurrentUserLogin(exec, options.cwd ? { cwd: options.cwd } : undefined);

  const deps: RepoFetchDeps = {
    exec,
    hasGhStack,
    reviewBotIgnore,
    showReviewRequests: options.showReviewRequests ?? true,
    me,
    log: options.log,
  };
  const repos = await Promise.all(targets.map((target) => overviewForRepo(target, deps)));
  return PrOverview.parse({ repos, stackDirection: options.stackDirection });
}
