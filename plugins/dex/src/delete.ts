/**
 * The `dex.delete` action's machinery: remove a dex task from whichever monitored
 * repo's store holds it, so a mistaken/duplicate/abandoned task can be cleared
 * from the board without dropping to the `dex` CLI. Daemon-side; the GUI trash
 * control is a separate surface that gates the (destructive, irreversible) delete
 * behind a confirmation.
 *
 * The impure edge — the `dex` CLI — is the same {@link Exec} seam `spawn` uses, so
 * the store-resolution + delete orchestration unit-tests with a stub and never
 * shells out. Store resolution reuses `spawn`'s probe shape (`dex show` per store,
 * first match wins), so delete and spawn locate a task's store identically.
 */
import { DexRunner, isValidTaskId, storagePathOf } from "./spawn.js";
import type { Exec } from "./provider.js";

/** The `dex.delete` action input: a task id, with an optional explicit repo override. */
export interface DeleteInput {
  /** The dex task id (lowercase-alphanumeric, matching the spawn/branch convention). */
  id: string;
  /** Explicit repo path override; else the id is probed across the configured stores. */
  repo?: string;
}

/** The `dex.delete` action result, surfaced to every projected surface. */
export interface DeleteResult {
  ok: boolean;
  message: string;
}

/** Dependencies for {@link runDelete} — the seams the action injects, tests stub. */
export interface DeleteDeps {
  exec: Exec;
  dexBin: string;
  /** The monitored project roots, in `global.repos` order (each carries a `.dex/`). */
  repos: string[];
  log?: (message: string) => void;
}

/**
 * Locate which configured repo's dex store holds `id`, returning the
 * `--storage-path` to target (`<repo>/.dex`). Probes each store via `dex show`;
 * the first store that knows the id wins (mirroring {@link findTask}'s shape). When
 * no repos are configured, falls back to the daemon's cwd-resolved store
 * (`storagePath: undefined` — no `--storage-path`). `undefined` when no store has
 * the id.
 */
export async function locateTaskStore(
  dex: DexRunner,
  id: string,
  repos: string[],
): Promise<{ storagePath: string | undefined } | undefined> {
  for (const repo of repos) {
    const store = storagePathOf(repo);
    const task = await dex.show(id, store);
    if (task) return { storagePath: store };
  }
  // No monitored repos: fall back to the cwd-resolved store (no storagePath).
  if (repos.length === 0) {
    const task = await dex.show(id);
    if (task) return { storagePath: undefined };
  }
  return undefined;
}

/**
 * Delete a dex task from the store that holds it. An explicit `input.repo`
 * short-circuits the per-store probe (that repo's store, or the default store as a
 * fallback); otherwise {@link locateTaskStore} finds the owning store. Runs `dex
 * delete <id> --force --storage-path <store>` through the {@link DexRunner}.
 *
 * Never throws: a bad id, a task no store knows, or a CLI failure all return a
 * clear `{ ok:false, message }`. The delete is `--force` (non-interactive +
 * cascades subtasks, matching `dex rm -f`) — the human confirmation lives in the
 * GUI, which also warns when the task has a live worktree/agent the daemon board
 * can't see.
 */
export async function runDelete(input: DeleteInput, deps: DeleteDeps): Promise<DeleteResult> {
  const id = input.id.trim();
  if (!isValidTaskId(id)) {
    return {
      ok: false,
      message: `dex id "${input.id}" is not lowercase-alphanumeric; no such task could exist.`,
    };
  }

  const dex = new DexRunner(deps.dexBin, deps.exec);

  // Resolve which store holds the task.
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
    await dex.delete(id, storagePath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `couldn't delete dex task "${id}": ${detail}` };
  }

  deps.log?.(`deleted dex task ${id}${storagePath ? ` from ${storagePath}` : ""}`);
  return { ok: true, message: `Deleted dex task ${id}.` };
}
