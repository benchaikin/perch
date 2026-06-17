/**
 * The `StackProvider` adapter (spec §8.1).
 *
 * All stack operations sit behind this one swappable interface, insulating us
 * from `gh stack` being a moving target and enabling a Graphite/`ghstack`
 * backend later. M4 implements `view` only; the mutating methods are declared
 * here so the contract is complete, and the M4 `ghStackProvider` throws
 * "not implemented (M6)" for them.
 */
import type { StackGraph } from "./graph.js";

/**
 * Result of a `sync` (the hero action). A cascading rebase can succeed
 * cleanly or stop on a conflict that needs manual resolution; this result
 * distinguishes those without throwing, so callers (CLI/GUI) can render a
 * "resolve then continue" state rather than a hard failure.
 */
export interface SyncResult {
  /** True if the cascading rebase left unresolved conflicts. */
  conflict: boolean;
  /** Branches that need manual resolution, if any (best-effort, may be empty). */
  needsResolution?: string[];
  /** Combined stdout+stderr of `gh stack sync`, for surfacing progress/details. */
  output: string;
}

/** Options for `merge` — implemented in M6, shape stubbed here. */
export interface MergeOptions {
  repo?: string;
}

/**
 * A single-PR merge strategy passed to `gh pr merge` (`--squash`/`--merge`/
 * `--rebase`). Squash is the default — it keeps trunk history linear, matching
 * the most common repo setting.
 */
export type MergeMethod = "squash" | "merge" | "rebase";

/**
 * Options for {@link StackProvider.mergePr} — a single PR merge by number,
 * distinct from the stack-wide {@link StackProvider.merge}. `repo` resolves to a
 * `-R owner/repo` flag (or the targeting cwd); `method` defaults to `"squash"`.
 */
export interface MergePrOptions {
  /** The PR number to merge. */
  number: number;
  /** Configured repo selector — `-R owner/repo`, or targeted by cwd. */
  repo?: string;
  /** Merge strategy; defaults to `"squash"`. */
  method?: MergeMethod;
}

/**
 * A stack backend. `view` is the only method implemented in M4; the rest are
 * the M6 action wrappers, declared now so the interface is the full §8.1
 * contract.
 */
export interface StackProvider {
  /** The current stack as a normalized graph. */
  view(repo?: string): Promise<StackGraph>;

  // ── M6 action wrappers (not implemented in M4) ──
  sync(repo?: string): Promise<SyncResult>;
  submit(repo?: string): Promise<void>;
  push(repo?: string): Promise<void>;
  add(name?: string): Promise<void>;
  merge(opts: MergeOptions): Promise<void>;
  /**
   * Merge ONE PR by number (`gh pr merge`), the per-PR complement of the
   * stack-wide {@link merge}. Throws on a non-zero exit so the caller can
   * surface GitHub's rejection (not mergeable, pending checks, branch
   * protection) verbatim. gh re-checks mergeability server-side at merge time.
   */
  mergePr(opts: MergePrOptions): Promise<void>;
  checkout(ref: string | number): Promise<void>;
  link(refs: Array<string | number>): Promise<void>;
  unstack(): Promise<void>;

  /** The underlying gh-stack version (e.g. "0.0.5"). */
  version(): Promise<string>;
}

/** Options for an {@link Exec} invocation. */
export interface ExecOptions {
  /** Working directory to run the command in. This is how a specific repo is
   *  targeted: `gh stack`/`gh pr list` read the repo from their cwd's git
   *  remote, so running with `cwd` set scopes the command to that repo. */
  cwd?: string;
}

/**
 * Injected command runner: runs `cmd` with `args` (optionally in `opts.cwd`)
 * and resolves its stdout. The real implementation spawns a child process;
 * tests pass a fixture-backed stub so the suite never shells out. All `gh`/`git`
 * invocations go through this. The third argument is optional so existing fake
 * execs (which ignore it) stay compatible.
 */
export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<string>;
