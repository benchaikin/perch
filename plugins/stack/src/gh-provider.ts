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
 *  ASSUMPTIONS about `gh stack view --json` (NOT yet pinned against a real
 *  stack — see spec §12 carried-forward note). The parser is tolerant of all
 *  of these; confirming the real shape is a one-file fix in `parseStackView`:
 *
 *  A1. The payload is EITHER a top-level JSON array of layers OR an object with
 *      the layers under one of: `layers`, `stack`, `branches`, `entries`.
 *  A2. Layers are listed bottom → top (trunk-adjacent first). If gh emits them
 *      top → bottom we will need to reverse — flagged, easy to flip.
 *  A3. Each layer carries its branch under one of: `branch`, `name`,
 *      `headRefName`, `ref`.
 *  A4. A layer's "needs rebase" is exposed as a boolean under `needsRebase`,
 *      `needs_rebase`, or `rebaseNeeded`, OR as a string `status`/`state`
 *      whose value matches /needs?[ _-]?rebase/i (gh prints "⚠ Needs rebase").
 *      We READ this from gh per the spec rather than recomputing it.
 *  A5. A layer MAY carry its PR number under `prNumber`, `pr`, `number`, or a
 *      nested `pr.number`; and a title under `title` / `pr.title`. These are
 *      optional — we fall back to the `gh pr list` join for status anyway.
 *
 *  `gh pr list --json` field names are stable GitHub CLI output and are NOT
 *  guessed: number, statusCheckRollup, reviewDecision, mergeable, headRefName,
 *  baseRefName.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { execFile } from "node:child_process";

import type { CiStatus, StackGraph, StackLayer } from "./graph.js";
import { StackGraph as StackGraphSchema } from "./graph.js";
import type { Exec, StackProvider, SyncResult } from "./provider.js";

/** Default runner: spawn a real process and resolve its stdout. */
const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });

const NOT_IMPLEMENTED = (method: string): never => {
  throw new Error(`StackProvider.${method} is not implemented (M6)`);
};

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
    if (
      state === "PENDING" ||
      status === "QUEUED" ||
      status === "IN_PROGRESS" ||
      status === "PENDING" ||
      status === "WAITING" ||
      (status !== "COMPLETED" && conclusion === "")
    ) {
      sawPending = true;
    }
  }
  return sawPending ? "pending" : "pass";
}

const nullToUndefined = <T>(value: T | null | undefined): T | undefined =>
  value == null ? undefined : value;

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
}

/** Build the primary gh-stack-backed provider. */
export function ghStackProvider(options: GhStackProviderOptions = {}): StackProvider {
  const exec = options.exec ?? defaultExec;

  /** `gh` args with a `-R owner/repo` prefix when a repo is given. */
  const repoArgs = (repo: string | undefined, rest: string[]): string[] =>
    repo ? ["-R", repo, ...rest] : rest;

  return {
    async view(repo?: string): Promise<StackGraph> {
      const [stackOut, prOut] = await Promise.all([
        exec("gh", ["stack", "view", "--json"]),
        exec(
          "gh",
          repoArgs(repo, [
            "pr",
            "list",
            "--json",
            "number,title,url,statusCheckRollup,reviewDecision,mergeable,headRefName,baseRefName",
          ]),
        ),
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

    async sync(): Promise<SyncResult> {
      return NOT_IMPLEMENTED("sync");
    },
    async submit(): Promise<void> {
      NOT_IMPLEMENTED("submit");
    },
    async push(): Promise<void> {
      NOT_IMPLEMENTED("push");
    },
    async add(): Promise<void> {
      NOT_IMPLEMENTED("add");
    },
    async merge(): Promise<void> {
      NOT_IMPLEMENTED("merge");
    },
    async checkout(): Promise<void> {
      NOT_IMPLEMENTED("checkout");
    },
    async link(): Promise<void> {
      NOT_IMPLEMENTED("link");
    },
    async unstack(): Promise<void> {
      NOT_IMPLEMENTED("unstack");
    },

    async version(): Promise<string> {
      const out = await exec("gh", ["stack", "version"]);
      return out.trim();
    },
  };
}
