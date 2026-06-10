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

/** Result of a `sync` — implemented in M6, shape stubbed here. */
export interface SyncResult {
  /** True if the cascading rebase left unresolved conflicts. */
  conflict: boolean;
  /** Branches that need manual resolution, if any. */
  needsResolution?: string[];
}

/** Options for `merge` — implemented in M6, shape stubbed here. */
export interface MergeOptions {
  repo?: string;
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
  checkout(ref: string | number): Promise<void>;
  link(refs: Array<string | number>): Promise<void>;
  unstack(): Promise<void>;

  /** The underlying gh-stack version (e.g. "0.0.5"). */
  version(): Promise<string>;
}

/**
 * Injected command runner: runs `cmd` with `args` and resolves its stdout.
 * The real implementation spawns a child process; tests pass a fixture-backed
 * stub so the suite never shells out. All `gh` invocations go through this.
 */
export type Exec = (cmd: string, args: string[]) => Promise<string>;
