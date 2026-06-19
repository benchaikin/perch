/**
 * The `dex.complete` action's machinery: mark a dex task done in whichever
 * monitored repo's store holds it, so work finished outside the worktree/PR flow
 * — a task done by hand, an obsolete-but-finished item, an epic whose children
 * all landed — can be closed from the board without dropping to the `dex` CLI.
 * Daemon-side; the GUI detail screen drives it with an inline confirm (an
 * optional completion result), mirroring the Edit editor.
 *
 * The impure edge — the `dex` CLI — is the same {@link Exec} seam `spawn`/`delete`
 * use, and store resolution reuses delete's {@link locateTaskStore} (probe each
 * store via `dex show`, first match wins), so complete targets the same store
 * delete and spawn would. Unlike the auto-land path (land.ts), a manual
 * completion has no merge commit to link, so it runs `--no-commit`; and it never
 * passes `--force`, so dex's own incomplete-subtask validation surfaces verbatim.
 */
import { DexRunner, isValidTaskId, storagePathOf } from "./spawn.js";
import { locateTaskStore } from "./delete.js";
import type { Exec } from "./provider.js";

/**
 * The result text recorded when the user completes a task without supplying one.
 * `dex complete` REQUIRES a non-empty `--result`, so we default a sensible string
 * rather than let the CLI fail on a missing flag.
 */
export const DEFAULT_COMPLETE_RESULT = "Marked complete manually in Perch";

/**
 * The `dex.complete` action input: a task id, an optional explicit repo override,
 * and an optional completion result. A blank/omitted `result` falls back to
 * {@link DEFAULT_COMPLETE_RESULT} — the CLI never sees an empty `--result`.
 */
export interface CompleteInput {
  /** The dex task id (lowercase-alphanumeric, matching the spawn/branch convention). */
  id: string;
  /** Explicit repo path override; else the id is probed across the configured stores. */
  repo?: string;
  /** The completion result/note; blank or omitted defaults to {@link DEFAULT_COMPLETE_RESULT}. */
  result?: string;
}

/** The `dex.complete` action result, surfaced to every projected surface. */
export interface CompleteResult {
  ok: boolean;
  message: string;
}

/** Dependencies for {@link runComplete} — the seams the action injects, tests stub. */
export interface CompleteDeps {
  exec: Exec;
  dexBin: string;
  /** The monitored project roots, in `global.repos` order (each carries a `.dex/`). */
  repos: string[];
  log?: (message: string) => void;
}

/**
 * Mark a dex task complete in the store that holds it. An explicit `input.repo`
 * short-circuits the per-store probe (that repo's store, or the default store as a
 * fallback); otherwise {@link locateTaskStore} finds the owning store (identical to
 * delete/edit). Runs `dex complete <id> --result "<text>" --no-commit` through the
 * {@link DexRunner}, defaulting an empty result so the CLI never fails on a missing
 * `--result`.
 *
 * Never throws: a bad id, a task no store knows, or a CLI failure (including dex's
 * own incomplete-subtask validation, which we deliberately let surface by NOT
 * passing `--force`) all return a clear `{ ok:false, message }`.
 */
export async function runComplete(
  input: CompleteInput,
  deps: CompleteDeps,
): Promise<CompleteResult> {
  const id = input.id.trim();
  if (!isValidTaskId(id)) {
    return {
      ok: false,
      message: `dex id "${input.id}" is not lowercase-alphanumeric; no such task could exist.`,
    };
  }

  const result = input.result?.trim() ? input.result : DEFAULT_COMPLETE_RESULT;

  const dex = new DexRunner(deps.dexBin, deps.exec);

  // Resolve which store holds the task (same shape as runDelete/runEdit).
  let storagePath: string | undefined;
  if (input.repo) {
    const inRepo = await dex.show(id, storagePathOf(input.repo));
    if (inRepo) {
      storagePath = storagePathOf(input.repo);
    } else {
      // Not in the named repo's store — fall back to the cwd-resolved store.
      const inDefault = await dex.show(id);
      if (!inDefault) return { ok: false, message: `dex task "${id}" not found.` };
      storagePath = undefined;
    }
  } else {
    const located = await locateTaskStore(dex, id, deps.repos);
    if (!located) {
      return {
        ok: false,
        message: `dex task "${id}" not found in any configured repo's store.`,
      };
    }
    storagePath = located.storagePath;
  }

  try {
    await dex.complete(id, result, storagePath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `couldn't complete dex task "${id}": ${detail}` };
  }

  deps.log?.(`completed dex task ${id}${storagePath ? ` in ${storagePath}` : ""}`);
  return { ok: true, message: `Completed dex task ${id}.` };
}
