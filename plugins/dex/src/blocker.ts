/**
 * The `dex.add-blocker` / `dex.remove-blocker` actions' machinery: wire (or unwire)
 * a dependency edge between two tasks in the same store, so the GUI's drag-and-drop
 * — drop task A onto task B ⇒ B is blocked-by A — can CREATE blocker edges that
 * previously could only be set on the `dex` CLI. Daemon-side; the GUI drag handlers
 * are a separate surface.
 *
 * The impure edge — the `dex` CLI — is the same {@link Exec} seam `spawn`/`delete`
 * use, so the store resolution + edit orchestration unit-tests with a stub and never
 * shells out. Store resolution mirrors `delete`'s probe shape (`dex show` per store,
 * first match wins), and additionally requires BOTH tasks to live in the SAME store
 * — a dependency can only link tasks in one project, so a cross-store drop is a clean
 * failure rather than an edit against the wrong store.
 */
import { DexRunner, isValidTaskId, storagePathOf } from "./spawn.js";
import type { Exec } from "./provider.js";

/**
 * The blocker-edit action input: the blocked task (the one that gains/loses a
 * blocker) and the blocker it waits on. Drop A onto B ⇒ `{ blockedId: B,
 * blockerId: A }`. An optional explicit repo override short-circuits the per-store
 * probe.
 */
export interface BlockerInput {
  /** The task that becomes (or stops being) blocked — the one `dex edit` targets. */
  blockedId: string;
  /** The task it depends on (must complete first); added/removed as a blocker. */
  blockerId: string;
  /** Explicit repo path override; else both ids are probed across the configured stores. */
  repo?: string;
}

/** The blocker-edit action result, surfaced to every projected surface. */
export interface BlockerResult {
  ok: boolean;
  message: string;
}

/** Dependencies for the blocker actions — the seams the action injects, tests stub. */
export interface BlockerDeps {
  exec: Exec;
  dexBin: string;
  /** The monitored project roots, in `global.repos` order (each carries a `.dex/`). */
  repos: string[];
  log?: (message: string) => void;
}

/**
 * Prefer a rejected `dex` call's stderr (the human-readable "Cannot add blocker …
 * would create a cycle" line) over the generic "Command failed" `Error.message`,
 * so the GUI surfaces dex's own cycle/validation reason rather than an opaque exit.
 */
function execErrorDetail(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { stderr?: unknown; message?: unknown };
    if (typeof e.stderr === "string" && e.stderr.trim()) return e.stderr.trim();
    if (typeof e.message === "string" && e.message) return e.message;
  }
  return String(err);
}

/**
 * Resolve the single store that holds BOTH tasks of a blocker edge — the store the
 * edit targets. With an explicit `repo`, that repo's store is tried first (then the
 * cwd-resolved store as a fallback, mirroring `delete`); otherwise the configured
 * stores are probed in order. The first store that knows the BLOCKED task wins, and
 * the BLOCKER must live there too — a dependency can't span projects. Returns
 * `{ storagePath }` (undefined ⇒ the cwd-resolved store) or an `error` describing the
 * miss (unknown blocked id, or the two tasks in different stores).
 */
export async function resolveBlockerStore(
  dex: DexRunner,
  blockedId: string,
  blockerId: string,
  input: { repo?: string },
  repos: string[],
): Promise<{ storagePath: string | undefined } | { error: string }> {
  // Stores to probe, in order. Explicit repo (then the default store), else the
  // configured stores (then the default store when none are configured).
  const candidates: Array<string | undefined> = input.repo
    ? [storagePathOf(input.repo), undefined]
    : repos.length > 0
      ? repos.map(storagePathOf)
      : [undefined];

  for (const storagePath of candidates) {
    const blocked = await dex.show(blockedId, storagePath);
    if (!blocked) continue;
    // The blocked task lives here; the blocker must share its store.
    const blocker = await dex.show(blockerId, storagePath);
    if (!blocker) {
      return {
        error:
          `dex tasks "${blockedId}" and "${blockerId}" aren't in the same store; ` +
          `a dependency can only link tasks in the same project.`,
      };
    }
    return { storagePath };
  }
  return { error: `dex task "${blockedId}" not found in any configured repo's store.` };
}

/**
 * Add or remove a blocker edge between two tasks. Validates both ids, rejects a
 * self-dependency (a task can't block itself) before any seam, resolves the store
 * that holds both via {@link resolveBlockerStore}, then runs `dex edit <blockedId>
 * --add-blocker|--remove-blocker <blockerId>` through the {@link DexRunner}.
 *
 * Never throws: a bad id, a self-drop, a task no store knows, a cross-store pair, or
 * a CLI failure (including dex's own cycle rejection, surfaced via its stderr) all
 * return a clear `{ ok:false, message }`.
 */
async function runBlocker(
  op: "add" | "remove",
  input: BlockerInput,
  deps: BlockerDeps,
): Promise<BlockerResult> {
  const blockedId = input.blockedId.trim();
  const blockerId = input.blockerId.trim();

  if (!isValidTaskId(blockedId) || !isValidTaskId(blockerId)) {
    return {
      ok: false,
      message: `dex ids "${input.blockedId}" / "${input.blockerId}" must be lowercase-alphanumeric; no such tasks could exist.`,
    };
  }
  if (blockedId === blockerId) {
    return { ok: false, message: "A task can't block itself." };
  }

  const dex = new DexRunner(deps.dexBin, deps.exec);
  const resolved = await resolveBlockerStore(dex, blockedId, blockerId, input, deps.repos);
  if ("error" in resolved) return { ok: false, message: resolved.error };

  try {
    await dex.editBlocker(op, blockedId, blockerId, resolved.storagePath);
  } catch (err) {
    const verb = op === "add" ? "add" : "remove";
    return { ok: false, message: `couldn't ${verb} blocker: ${execErrorDetail(err)}` };
  }

  deps.log?.(
    `${op === "add" ? "added" : "removed"} blocker ${blockerId} ` +
      `${op === "add" ? "→" : "✕"} ${blockedId}` +
      (resolved.storagePath ? ` in ${resolved.storagePath}` : ""),
  );
  return {
    ok: true,
    message:
      op === "add"
        ? `${blockedId} is now blocked by ${blockerId}.`
        : `${blockedId} is no longer blocked by ${blockerId}.`,
  };
}

/** Wire a dependency: `blockedId` now waits on `blockerId`. */
export function runAddBlocker(input: BlockerInput, deps: BlockerDeps): Promise<BlockerResult> {
  return runBlocker("add", input, deps);
}

/** Unwire a dependency: `blockedId` no longer waits on `blockerId`. */
export function runRemoveBlocker(input: BlockerInput, deps: BlockerDeps): Promise<BlockerResult> {
  return runBlocker("remove", input, deps);
}
