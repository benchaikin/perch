/**
 * `resolveStackView` — composes the primary and fallback providers for the
 * `stack.view` read (spec §8 "cross-machine stacks").
 *
 * Primary: `ghStackProvider` (`gh stack view --json`), which serves both
 * locally-tracked stacks and server-side stacks created by submit/link.
 * Fallback: `baseRefProvider`, which reconstructs the chain from open PRs when
 * gh-stack has nothing to show — a stack that was never submitted/linked, or
 * one managed by an external tool.
 *
 * We fall back when the primary throws (no local stack / gh-stack unavailable)
 * OR returns zero layers, but only adopt the fallback when it actually
 * reconstructs something; otherwise we keep the primary's (empty) result.
 */
import { baseRefProvider } from "./base-ref-provider.js";
import { ghStackProvider } from "./gh-provider.js";
import type { StackGraph } from "./graph.js";
import type { Exec } from "./provider.js";

export interface ResolveStackViewOptions {
  repo?: string;
  /** Working directory for every `gh`/`git` call — the targeted repo's path.
   *  When set, it (not `repo`/`-R`) is the targeting mechanism. */
  cwd?: string;
  /** Injected runner shared by both providers (tests inject a fixture). */
  exec?: Exec;
  /** Optional log sink; notes when the fallback reconstruction is used. */
  log?: (message: string) => void;
}

export async function resolveStackView(options: ResolveStackViewOptions = {}): Promise<StackGraph> {
  const { repo, cwd, exec, log } = options;

  let primary: StackGraph | undefined;
  try {
    primary = await ghStackProvider({ exec, cwd }).view(repo);
    if (primary.layers.length > 0) return primary;
  } catch {
    // gh stack view failed (commonly: no local gh-stack tracking) — reconstruct.
  }

  const reconstructed = await baseRefProvider({ exec, cwd }).view(repo);
  if (reconstructed.layers.length > 0) {
    log?.("No gh-stack view; reconstructed the stack from open PR base refs.");
    return reconstructed;
  }

  // Nothing either way: return the primary's empty graph when we have it.
  return primary ?? reconstructed;
}
