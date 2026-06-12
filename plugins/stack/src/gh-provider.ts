/**
 * `ghStackProvider` — the primary `StackProvider`, wrapping the `gh stack`
 * CLI extension (verified against gh-stack **v0.0.5**).
 *
 * `view` composes two commands and joins them by branch:
 *   1. `gh stack view --json`  — the ordered stack chain + its self-computed
 *      "needs rebase" state.
 *   2. `gh pr list --json number,statusCheckRollup,reviewDecision,mergeable,headRefName,baseRefName`
 *      — per-PR status, joined onto each layer by `headRefName === branch`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  `gh stack view --json` shape — CONFIRMED against gh-stack v0.0.5. The real
 *  payload is an object: `{ trunk, currentBranch, branches: [{ name, base,
 *  isCurrent, isMerged, isQueued, needsRebase }] }`. The parser stays tolerant
 *  (it predates confirmation and still accepts the variants below), so a future
 *  gh-stack format change is a one-file fix in `parseStackView`:
 *
 *  A1. CONFIRMED: object with layers under `branches`. (Also accepts a
 *      top-level array or `layers`/`stack`/`entries` wrappers, defensively.)
 *  A2. CONFIRMED: branches are listed bottom → top (trunk-adjacent first).
 *  A3. CONFIRMED: branch is under `name`. (Also accepts `branch`/`headRefName`/
 *      `ref`.)
 *  A4. CONFIRMED: `needsRebase` is a boolean. (Also accepts `needs_rebase`/
 *      `rebaseNeeded`, or a `status`/`state` string matching /needs rebase/i.)
 *      Read from gh per the spec rather than recomputed.
 *  A5. CONFIRMED: a pre-submit layer carries NO inline PR fields (PR number/
 *      title come from the `gh pr list` join). The parser also accepts inline
 *      `prNumber`/`number`/`pr.number` + `title`/`pr.title` if a future version
 *      adds them. gh-stack also emits `base` (a SHA), `isCurrent`, `isMerged`,
 *      `isQueued` per layer and top-level `trunk`/`currentBranch`, which we
 *      currently ignore (candidates for richer status later).
 *
 *  `gh pr list --json` field names are stable GitHub CLI output and are NOT
 *  guessed: number, statusCheckRollup, reviewDecision, mergeable, headRefName,
 *  baseRefName.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { execFile } from "node:child_process";

import type { CiStatus, StackGraph, StackLayer } from "./graph.js";
import { StackGraph as StackGraphSchema } from "./graph.js";
import type { Exec, ExecOptions, MergeOptions, StackProvider, SyncResult } from "./provider.js";

/**
 * Default runner: spawn a real process and resolve its stdout. On a non-zero
 * exit it rejects with the underlying error; for `gh stack sync` we still want
 * the process output (a conflict exits non-zero but is not a failure), so the
 * error carries `stdout`/`stderr` which {@link readExecError} reads back.
 *
 * `opts.cwd` targets a specific repo: with it set, `gh` infers the repo from
 * that directory's git remote, which is how per-repo targeting works.
 */
const defaultExec: Exec = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, cwd: opts?.cwd },
      (err, stdout, stderr) => {
        if (err) {
          // Preserve captured output on the error so a non-zero exit (e.g. a
          // sync conflict) can be inspected rather than swallowed.
          (err as ExecError).stdout = stdout;
          (err as ExecError).stderr = stderr;
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });

/** A child-process error, possibly carrying captured stdio + exit code. */
type ExecError = Error & {
  code?: number | string;
  stdout?: string;
  stderr?: string;
};

/**
 * Extract a best-effort combined-output string from a rejected `exec` error.
 * Tolerant: tests reject with a plain `Error` whose `message` is the output,
 * while the real `defaultExec` attaches `stdout`/`stderr`.
 */
function readExecError(err: unknown): { output: string; code: number | string | undefined } {
  if (err && typeof err === "object") {
    const e = err as ExecError;
    const parts = [e.stdout ?? "", e.stderr ?? "", e.message ?? ""].filter(
      (p) => typeof p === "string" && p.length > 0,
    );
    return { output: parts.join("\n"), code: e.code };
  }
  return { output: String(err), code: undefined };
}

/**
 * Conflict-detection heuristic for `gh stack sync` (best-effort — gh-stack's
 * exact conflict output is NOT pinned, see assumptions below). We treat the
 * sync as "needs manual resolution" when its combined output matches any of
 * these markers, which cover both gh-stack's own phrasing and the underlying
 * `git rebase` conflict text it surfaces.
 */
const CONFLICT_MARKERS = [
  /conflict/i,
  /needs?[ _-]?(manual[ _-]?)?resolution/i,
  /resolve .*conflicts?/i,
  /merge conflict/i,
  /rebase .*(stopped|paused|halted)/i,
  /could not apply/i,
  /fix conflicts and (then )?run/i,
];

function looksLikeConflict(output: string): boolean {
  return CONFLICT_MARKERS.some((re) => re.test(output));
}

/**
 * Best-effort extraction of the branches that still need manual resolution
 * from sync output. Matches common git/gh phrasings; returns `undefined` when
 * nothing identifiable is found (the boolean `conflict` flag is authoritative).
 */
function extractNeedsResolution(output: string): string[] | undefined {
  const branches = new Set<string>();
  // "CONFLICT (content): Merge conflict in <path>" doesn't name a branch, but
  // gh-stack tends to log the layer it stopped on, e.g.
  // "rebasing feat-foo ... conflict" / "could not rebase 'feat-foo'".
  const patterns = [
    /(?:rebas(?:e|ing)|could not (?:apply|rebase)|conflict (?:on|in branch))[^\S\r\n]*['"`]?([\w./-]+)['"`]?/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(output)) !== null) {
      const name = m[1];
      if (name && !/^(content|the|in|on|branch)$/i.test(name)) {
        branches.add(name);
      }
    }
  }
  return branches.size > 0 ? [...branches] : undefined;
}

/** A single check from `statusCheckRollup`. */
type RollupCheck = {
  // CheckRun: status COMPLETED/IN_PROGRESS/QUEUED + conclusion SUCCESS/FAILURE/…
  status?: string | null;
  conclusion?: string | null;
  // StatusContext: state SUCCESS/FAILURE/PENDING/ERROR
  state?: string | null;
};

/** Raw `gh pr list` row (only the fields we request). */
type PrRow = {
  number?: number;
  title?: string;
  url?: string;
  statusCheckRollup?: RollupCheck[] | null;
  reviewDecision?: string | null;
  mergeable?: string | null;
  headRefName?: string;
  baseRefName?: string;
};

/** Collapse a `statusCheckRollup` array into a normalized {@link CiStatus}. */
export function rollupToCiStatus(rollup: RollupCheck[] | null | undefined): CiStatus {
  if (!rollup || rollup.length === 0) {
    return "none";
  }
  let sawPending = false;
  for (const check of rollup) {
    const conclusion = (check.conclusion ?? "").toUpperCase();
    const state = (check.state ?? "").toUpperCase();
    const status = (check.status ?? "").toUpperCase();

    if (
      conclusion === "FAILURE" ||
      conclusion === "TIMED_OUT" ||
      conclusion === "CANCELLED" ||
      conclusion === "STARTUP_FAILURE" ||
      conclusion === "ACTION_REQUIRED" ||
      state === "FAILURE" ||
      state === "ERROR"
    ) {
      return "fail";
    }
    // Two rollup shapes need different "in progress" tests:
    //  - CheckRun: has a `status`; it's pending until `status === "COMPLETED"`
    //    (QUEUED / IN_PROGRESS / WAITING / REQUESTED), regardless of conclusion.
    //  - StatusContext: has only a `state`; pending only when `state === "PENDING"`.
    // A passing StatusContext is `{ state: "SUCCESS" }` (empty status+conclusion),
    // so we must NOT treat an empty status as pending — that would peg a green
    // commit-status PR to the spinner forever.
    if (state === "PENDING" || (status !== "" && status !== "COMPLETED")) {
      sawPending = true;
    }
  }
  return sawPending ? "pending" : "pass";
}

const nullToUndefined = <T>(value: T | null | undefined): T | undefined =>
  value == null ? undefined : value;

/** One inline review comment's author, as returned by the GitHub comments API. */
export interface ReviewCommentAuthor {
  /** GitHub login, e.g. `"alice"` or `"github-actions[bot]"`. */
  login?: string | null;
  /** GitHub account type — `"Bot"` for GitHub Apps, `"User"` otherwise. */
  type?: string | null;
}

/**
 * Is this inline-review-comment author a human (i.e. should it count)?
 *
 * Excludes GitHub Apps / bots — author `type === "Bot"` or a login ending in
 * `[bot]` (github-actions[bot], dependabot[bot], copilot-pull-request-reviewer
 * [bot], …) — and any login on the configured `ignore` list (the escape hatch
 * for AI reviewers posting as ordinary accounts). An author with no resolvable
 * login is treated as non-human (we can't vouch for it). Comparison is
 * case-insensitive on the login.
 */
export function isHumanReviewComment(
  author: ReviewCommentAuthor | null | undefined,
  ignore: readonly string[] = [],
): boolean {
  const login = author?.login;
  if (typeof login !== "string" || login.length === 0) return false;
  if (author?.type === "Bot") return false;
  const lower = login.toLowerCase();
  if (lower.endsWith("[bot]")) return false;
  return !ignore.some((name) => name.toLowerCase() === lower);
}

/**
 * Count the inline review-thread comments authored by humans, applying the
 * bot/`[bot]`/ignore-list filter via {@link isHumanReviewComment}. Tolerant of
 * a non-array input (→ 0) so a malformed/empty `gh` payload degrades cleanly.
 */
export function countHumanReviewComments(
  comments: readonly { user?: ReviewCommentAuthor | null }[] | null | undefined,
  ignore: readonly string[] = [],
): number {
  if (!Array.isArray(comments)) return 0;
  let n = 0;
  for (const comment of comments) {
    if (isHumanReviewComment(comment?.user, ignore)) n += 1;
  }
  return n;
}

/**
 * Fetch the count of human-authored inline review comments for one PR,
 * best-effort. Shells `gh api repos/{owner}/{repo}/pulls/{number}/comments`
 * (the "pull request review comments" endpoint — comments on specific lines,
 * NOT top-level conversation comments), paginated, and counts humans after the
 * bot/ignore-list filter. ANY failure (no remote, 404, auth, bad JSON) yields 0
 * so a single PR/repo can never break the overview. Runs in the PR's repo cwd
 * (`execOpts`) so `gh` resolves `{owner}/{repo}` from that repo's remote.
 */
export async function fetchHumanReviewCommentCount(
  exec: Exec,
  prNumber: number,
  ignore: readonly string[],
  execOpts: ExecOptions | undefined,
  repo?: string,
): Promise<number> {
  try {
    const path = `repos/${repo ?? "{owner}/{repo}"}/pulls/${prNumber}/comments`;
    const out = await exec(
      "gh",
      ["api", "--paginate", path, "--jq", "[.[] | {login: .user.login, type: .user.type}]"],
      execOpts,
    );
    // `--jq` over `--paginate` emits one JSON array per page; concatenate them.
    const authors: { login?: string | null; type?: string | null }[] = [];
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const page: unknown = JSON.parse(trimmed);
      if (Array.isArray(page)) authors.push(...(page as ReviewCommentAuthor[]));
    }
    return countHumanReviewComments(
      authors.map((user) => ({ user })),
      ignore,
    );
  } catch {
    return 0;
  }
}

/** First defined string property among `keys` on `obj`. */
function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) {
      return v;
    }
  }
  return undefined;
}

/** First defined number property among `keys` on `obj`. */
function firstNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      return v;
    }
  }
  return undefined;
}

/** Read a layer's "needs rebase" flag tolerantly (assumption A4). */
function readNeedsRebase(layer: Record<string, unknown>): boolean {
  for (const key of ["needsRebase", "needs_rebase", "rebaseNeeded"]) {
    if (typeof layer[key] === "boolean") {
      return layer[key] as boolean;
    }
  }
  const status = firstString(layer, ["status", "state"]);
  if (status && /needs?[ _-]?rebase/i.test(status)) {
    return true;
  }
  return false;
}

/** Normalized projection of one `gh stack view` layer (pre-join). */
type ParsedLayer = {
  branch: string;
  prNumber?: number;
  title?: string;
  needsRebase: boolean;
};

/**
 * Parse `gh stack view --json` stdout into ordered, normalized layers.
 * Tolerant per assumptions A1–A5; isolates EVERY guess about the shape.
 */
export function parseStackView(stdout: string): ParsedLayer[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const parsed: unknown = JSON.parse(trimmed);

  // A1: array at top level, or under a known wrapper key.
  let rawLayers: unknown;
  if (Array.isArray(parsed)) {
    rawLayers = parsed;
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    rawLayers = obj.layers ?? obj.stack ?? obj.branches ?? obj.entries;
  }
  if (!Array.isArray(rawLayers)) {
    return [];
  }

  const layers: ParsedLayer[] = [];
  for (const entry of rawLayers) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const layer = entry as Record<string, unknown>;
    const branch = firstString(layer, ["branch", "name", "headRefName", "ref"]);
    if (!branch) {
      continue; // a layer with no resolvable branch is unusable for the join.
    }

    // A5: PR number / title may be inline or nested under `pr`.
    const pr = (layer.pr && typeof layer.pr === "object" ? layer.pr : {}) as Record<
      string,
      unknown
    >;
    const prNumber =
      firstNumber(layer, ["prNumber", "pr", "number"]) ?? firstNumber(pr, ["number"]);
    const title = firstString(layer, ["title"]) ?? firstString(pr, ["title"]);

    layers.push({ branch, prNumber, title, needsRebase: readNeedsRebase(layer) });
  }
  return layers; // A2: assumed bottom → top.
}

export interface GhStackProviderOptions {
  /** Injected command runner; defaults to a real `child_process` spawn. */
  exec?: Exec;
  /** Working directory for every `gh`/`git` call — the targeted repo's path.
   *  When set, it is the targeting mechanism (gh infers the repo from its
   *  remote) and the `-R owner/repo` plumbing for `gh pr list` is dropped. */
  cwd?: string;
}

/** Build the primary gh-stack-backed provider. */
export function ghStackProvider(options: GhStackProviderOptions = {}): StackProvider {
  const exec = options.exec ?? defaultExec;
  const cwd = options.cwd;
  const execOpts: ExecOptions | undefined = cwd ? { cwd } : undefined;

  /**
   * `gh` args with a `-R owner/repo` prefix when a repo is given AND no `cwd`
   * is set. With a `cwd`, the repo is targeted by the working directory, so the
   * `-R` flag is dropped (gh infers the repo from the cwd's remote).
   */
  const repoArgs = (repo: string | undefined, rest: string[]): string[] =>
    repo && !cwd ? ["-R", repo, ...rest] : rest;

  return {
    async view(repo?: string): Promise<StackGraph> {
      // `gh stack view` determines whether a stack exists (its failure means
      // "no local stack" → the caller falls back). The `gh pr list` join is
      // best-effort enrichment: a repo with no remote / no PRs (a local stack
      // not yet submitted) should still render its branch structure, just
      // without CI/review status — so a failed PR lookup degrades to "[]".
      const [stackOut, prOut] = await Promise.all([
        exec("gh", ["stack", "view", "--json"], execOpts),
        exec(
          "gh",
          repoArgs(repo, [
            "pr",
            "list",
            "--json",
            "number,title,url,statusCheckRollup,reviewDecision,mergeable,headRefName,baseRefName",
          ]),
          execOpts,
        ).catch(() => "[]"),
      ]);

      const parsedLayers = parseStackView(stackOut);

      // Index PRs by head branch for the join.
      const prsRaw: unknown = JSON.parse(prOut.trim() || "[]");
      const prByBranch = new Map<string, PrRow>();
      if (Array.isArray(prsRaw)) {
        for (const row of prsRaw as PrRow[]) {
          if (row && typeof row.headRefName === "string") {
            prByBranch.set(row.headRefName, row);
          }
        }
      }

      const layers: StackLayer[] = parsedLayers.map((layer) => {
        const pr = prByBranch.get(layer.branch);
        const reviewDecision = nullToUndefined(pr?.reviewDecision);
        const mergeable = nullToUndefined(pr?.mergeable);
        return {
          branch: layer.branch,
          prNumber: layer.prNumber ?? pr?.number,
          title: layer.title ?? pr?.title,
          ciStatus: rollupToCiStatus(pr?.statusCheckRollup),
          // Pass review/mergeable through verbatim only when they match the
          // documented GitHub enums; otherwise leave undefined (tolerant).
          reviewDecision:
            reviewDecision === "APPROVED" ||
            reviewDecision === "CHANGES_REQUESTED" ||
            reviewDecision === "REVIEW_REQUIRED"
              ? reviewDecision
              : undefined,
          mergeable:
            mergeable === "MERGEABLE" || mergeable === "CONFLICTING" || mergeable === "UNKNOWN"
              ? mergeable
              : undefined,
          needsRebase: layer.needsRebase,
          conflict: mergeable === "CONFLICTING" ? true : undefined,
          url: pr?.url,
        };
      });

      // Validate against the schema so the read's `output` contract holds and
      // defaults (ciStatus/needsRebase) are applied.
      return StackGraphSchema.parse({ repo, layers } satisfies StackGraph);
    },

    /**
     * Hero action: `gh stack sync` (cascading rebase onto trunk). Never throws
     * on conflict — a non-zero exit whose output looks like a conflict is
     * mapped to a `SyncResult` with `conflict: true` so callers can render a
     * "resolve manually, then continue" state. A non-zero exit that does NOT
     * look like a conflict is a genuine command failure and is re-thrown.
     */
    async sync(repo?: string): Promise<SyncResult> {
      try {
        const output = await exec("gh", repoArgs(repo, ["stack", "sync"]), execOpts);
        return { conflict: false, output };
      } catch (err) {
        const { output } = readExecError(err);
        if (looksLikeConflict(output)) {
          return { conflict: true, needsResolution: extractNeedsResolution(output), output };
        }
        throw err; // genuine failure (auth, not a stack, gh missing, …).
      }
    },
    async submit(repo?: string): Promise<void> {
      await exec("gh", repoArgs(repo, ["stack", "submit"]), execOpts);
    },
    async push(repo?: string): Promise<void> {
      await exec("gh", repoArgs(repo, ["stack", "push"]), execOpts);
    },
    async add(name?: string): Promise<void> {
      await exec("gh", ["stack", "add", ...(name ? [name] : [])], execOpts);
    },
    async merge(opts: MergeOptions): Promise<void> {
      await exec("gh", repoArgs(opts.repo, ["stack", "merge"]), execOpts);
    },
    async checkout(ref: string | number): Promise<void> {
      await exec("gh", ["stack", "checkout", String(ref)], execOpts);
    },
    async link(refs: Array<string | number>): Promise<void> {
      await exec("gh", ["stack", "link", ...refs.map((r) => String(r))], execOpts);
    },
    async unstack(): Promise<void> {
      await exec("gh", ["stack", "unstack"], execOpts);
    },

    async version(): Promise<string> {
      const out = await exec("gh", ["stack", "version"], execOpts);
      return out.trim();
    },
  };
}
