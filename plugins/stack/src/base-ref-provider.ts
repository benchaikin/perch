/**
 * `baseRefProvider` — the cross-machine / fallback `StackProvider` (spec §8.1,
 * §8 "cross-machine stacks").
 *
 * `gh stack`'s local tracking lives in `.git/gh-stack` on one machine. A stack
 * created by `gh stack submit`/`link` also exists as a server-side object on
 * GitHub (the primary cross-machine path, served by `ghStackProvider`). But a
 * stack that was NEVER submitted/linked — or one built with an external tool
 * (jj, Sapling, git-town) — has no gh-stack view at all. This provider
 * reconstructs the graph for those cases from first principles: the open PRs
 * themselves form the chain, since each PR's base IS the branch below it.
 *
 * Reconstruction is READ-ONLY. The mutating methods throw — you cannot
 * sync/submit/merge a stack that gh-stack isn't tracking; adopt it first
 * (`gh stack link`/`init --adopt`). `needsRebase` cannot be determined without
 * gh-stack's tracking, so it is reported `false` (documented limitation).
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  Algorithm (linear-stack assumption, matching gh-stack's model):
 *   1. List open PRs: number, title, url, statusCheckRollup, reviewDecision,
 *      mergeable, headRefName, baseRefName.
 *   2. Index by head branch (`prByHead`) and by base branch (`prByBase`).
 *   3. Anchor on the current branch (`git rev-parse --abbrev-ref HEAD`). Walk
 *      DOWN (follow `base` while it is another PR's head) to collect ancestors,
 *      and UP (follow the PR whose base is this head) to collect descendants.
 *      The chain bottoms out when a base is not any open PR's head (trunk).
 *   4. If the current branch has no PR, fall back to the single maximal chain
 *      if exactly one exists; otherwise we cannot disambiguate → empty graph.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { execFile } from "node:child_process";

import { chainContaining } from "./chains.js";
import { rollupToCiStatus } from "./gh-provider.js";
import type { StackGraph, StackLayer } from "./graph.js";
import { StackGraph as StackGraphSchema } from "./graph.js";
import type { Exec, ExecOptions, StackProvider, SyncResult } from "./provider.js";

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

/** Project one PR row onto a normalized {@link StackLayer}. */
function prToLayer(pr: PrRow): StackLayer {
  const review = pr.reviewDecision ?? "";
  const mergeable = pr.mergeable ?? "";
  return StackGraphSchema.shape.layers.element.parse({
    branch: pr.headRefName,
    prNumber: pr.number,
    title: pr.title,
    ciStatus: rollupToCiStatus(pr.statusCheckRollup),
    reviewDecision: (REVIEW_DECISIONS as readonly string[]).includes(review) ? review : undefined,
    mergeable: (MERGEABLE_STATES as readonly string[]).includes(mergeable) ? mergeable : undefined,
    // Not determinable without gh-stack tracking — see file header.
    needsRebase: false,
    conflict: mergeable === "CONFLICTING" ? true : undefined,
    url: pr.url,
  });
}

/** Build the ordered (bottom → top) PR chain that contains `anchorHead`. */
function prChainContaining(
  anchorHead: string,
  prByHead: Map<string, PrRow>,
  prByBase: Map<string, PrRow>,
): PrRow[] {
  return chainContaining(
    anchorHead,
    prByHead,
    prByBase,
    (pr) => pr.headRefName,
    (pr) => pr.baseRefName,
  );
}

export interface BaseRefProviderOptions {
  /** Injected command runner; defaults to a real `child_process` spawn. */
  exec?: Exec;
  /** Working directory for every `gh`/`git` call — the targeted repo's path.
   *  When set, the repo is targeted by cwd and the `-R` flag is dropped. */
  cwd?: string;
}

const NOT_SUPPORTED =
  "not supported on a reconstructed (base-ref) stack — adopt it first with `gh stack link`/`init --adopt`";

/**
 * Build the fallback provider that reconstructs a stack from open-PR base→head
 * chaining. Only `view` is meaningful; mutations throw.
 */
export function baseRefProvider(options: BaseRefProviderOptions = {}): StackProvider {
  const exec = options.exec ?? defaultExec;
  const cwd = options.cwd;
  const execOpts: ExecOptions | undefined = cwd ? { cwd } : undefined;
  const repoArgs = (repo: string | undefined, rest: string[]): string[] =>
    repo && !cwd ? ["-R", repo, ...rest] : rest;

  return {
    async view(repo?: string): Promise<StackGraph> {
      const prOut = await exec(
        "gh",
        repoArgs(repo, [
          "pr",
          "list",
          "--state",
          "open",
          "--json",
          "number,title,url,statusCheckRollup,reviewDecision,mergeable,headRefName,baseRefName",
        ]),
        execOpts,
      );

      const prsRaw: unknown = JSON.parse(prOut.trim() || "[]");
      const prByHead = new Map<string, PrRow>();
      const prByBase = new Map<string, PrRow>();
      if (Array.isArray(prsRaw)) {
        for (const row of prsRaw as PrRow[]) {
          if (row && typeof row.headRefName === "string") {
            prByHead.set(row.headRefName, row);
            if (typeof row.baseRefName === "string") prByBase.set(row.baseRefName, row);
          }
        }
      }

      if (prByHead.size === 0) {
        return StackGraphSchema.parse({ repo, layers: [] });
      }

      // Anchor on the current branch when it has a PR.
      let anchorHead: string | undefined;
      try {
        anchorHead = (await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], execOpts)).trim();
      } catch {
        anchorHead = undefined;
      }

      let chain: PrRow[] = [];
      if (anchorHead && prByHead.has(anchorHead)) {
        chain = prChainContaining(anchorHead, prByHead, prByBase);
      } else {
        // No PR for the current branch: use the single maximal chain if exactly
        // one root exists (a PR whose base is not any open PR's head = trunk).
        const roots = [...prByHead.values()].filter(
          (pr) => !pr.baseRefName || !prByHead.has(pr.baseRefName),
        );
        if (roots.length === 1) {
          chain = prChainContaining(roots[0]!.headRefName!, prByHead, prByBase);
        }
        // Otherwise ambiguous → leave empty rather than guess.
      }

      const layers = chain.map(prToLayer);
      return StackGraphSchema.parse({ repo, layers });
    },

    // ── Reconstructed stacks are read-only (see file header). ──
    sync(): Promise<SyncResult> {
      return Promise.reject(new Error(`sync ${NOT_SUPPORTED}`));
    },
    submit(): Promise<void> {
      return Promise.reject(new Error(`submit ${NOT_SUPPORTED}`));
    },
    push(): Promise<void> {
      return Promise.reject(new Error(`push ${NOT_SUPPORTED}`));
    },
    add(): Promise<void> {
      return Promise.reject(new Error(`add ${NOT_SUPPORTED}`));
    },
    merge(): Promise<void> {
      return Promise.reject(new Error(`merge ${NOT_SUPPORTED}`));
    },
    // The per-PR merge runs through `ghStackProvider` (it keys off a PR number,
    // not stack tracking), so this fallback never serves it — present only to
    // satisfy the interface.
    mergePr(): Promise<void> {
      return Promise.reject(new Error(`merge-pr ${NOT_SUPPORTED}`));
    },
    checkout(): Promise<void> {
      return Promise.reject(new Error(`checkout ${NOT_SUPPORTED}`));
    },
    link(): Promise<void> {
      return Promise.reject(new Error(`link ${NOT_SUPPORTED}`));
    },
    unstack(): Promise<void> {
      return Promise.reject(new Error(`unstack ${NOT_SUPPORTED}`));
    },
    version(): Promise<string> {
      return Promise.resolve("base-ref-fallback");
    },
  };
}
