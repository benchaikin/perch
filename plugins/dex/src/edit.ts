/**
 * The `dex.edit` action's machinery: change a dex task's metadata (name,
 * description, priority) in whichever monitored repo's store holds it, so a
 * task's "ticket" can be corrected from the board without dropping to the `dex`
 * CLI. Daemon-side; the GUI detail screen drives it with an inline editor (the
 * non-activating panel can't rely on a `window.prompt`).
 *
 * The impure edge — the `dex` CLI — is the same {@link Exec} seam `spawn`/`delete`
 * use, and store resolution reuses delete's {@link locateTaskStore} (probe each
 * store via `dex show`, first match wins), so edit targets the same store delete
 * and spawn would. Only the fields the caller actually changed become `dex edit`
 * flags, so an unchanged field is never sent.
 */
import { DexRunner, isValidTaskId, storagePathOf } from "./spawn.js";
import { locateTaskStore } from "./delete.js";
import type { Exec } from "./provider.js";

/**
 * The `dex.edit` action input: a task id, an optional explicit repo override, and
 * the new values for the editable fields. A field left `undefined` is unchanged
 * (no flag sent); `description: ""` is a deliberate clear (allowed), while an
 * empty/blank `name` is rejected — a task must keep a name.
 */
export interface EditInput {
  /** The dex task id (lowercase-alphanumeric, matching the spawn/branch convention). */
  id: string;
  /** Explicit repo path override; else the id is probed across the configured stores. */
  repo?: string;
  /** New task name; omit to leave unchanged. A blank name is rejected. */
  name?: string;
  /** New description; omit to leave unchanged. `""` clears it (allowed). */
  description?: string;
  /** New priority level; omit to leave unchanged. */
  priority?: number;
}

/** The `dex.edit` action result, surfaced to every projected surface. */
export interface EditResult {
  ok: boolean;
  message: string;
}

/** Dependencies for {@link runEdit} — the seams the action injects, tests stub. */
export interface EditDeps {
  exec: Exec;
  dexBin: string;
  /** The monitored project roots, in `global.repos` order (each carries a `.dex/`). */
  repos: string[];
  log?: (message: string) => void;
}

/**
 * Reduce an {@link EditInput} to just the fields that carry a (changed) value:
 * `undefined` fields drop out, so `dex edit` only ever sees flags for what the
 * user actually edited. Returns `undefined` for the `name` slot when no name was
 * given; the caller still validates a *given* name is non-blank separately.
 */
function changedFields(input: EditInput): { name?: string; description?: string; priority?: number } {
  const fields: { name?: string; description?: string; priority?: number } = {};
  if (input.name !== undefined) fields.name = input.name;
  if (input.description !== undefined) fields.description = input.description;
  if (input.priority !== undefined) fields.priority = input.priority;
  return fields;
}

/**
 * Edit a dex task's metadata in the store that holds it. An explicit `input.repo`
 * short-circuits the per-store probe (that repo's store, or the default store as a
 * fallback); otherwise {@link locateTaskStore} finds the owning store (identical to
 * delete). Runs `dex edit <id> [--storage-path <store>] [-n ...] [-d ...] [-p ...]`,
 * passing only the flags for fields the caller changed.
 *
 * Never throws: a bad id, a blank name, a no-op (nothing changed), a task no store
 * knows, or a CLI failure all return a clear `{ ok, message }`. Unlike delete there
 * is no live-worktree guard — name/description/priority are pure metadata, safe to
 * change while an agent works the task.
 */
export async function runEdit(input: EditInput, deps: EditDeps): Promise<EditResult> {
  const id = input.id.trim();
  if (!isValidTaskId(id)) {
    return {
      ok: false,
      message: `dex id "${input.id}" is not lowercase-alphanumeric; no such task could exist.`,
    };
  }

  // A given name must be non-blank — a task must keep a name. (An empty
  // description, by contrast, is a legitimate clear and passes through.)
  if (input.name !== undefined && input.name.trim() === "") {
    return { ok: false, message: "a dex task must have a name; the name can't be empty." };
  }

  const fields = changedFields(input);
  if (Object.keys(fields).length === 0) {
    // No-op: nothing to change. Succeed quietly without touching the store.
    return { ok: true, message: `No changes to dex task ${id}.` };
  }

  const dex = new DexRunner(deps.dexBin, deps.exec);

  // Resolve which store holds the task (same shape as runDelete).
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
    await dex.edit(id, fields, storagePath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `couldn't edit dex task "${id}": ${detail}` };
  }

  deps.log?.(`edited dex task ${id}${storagePath ? ` in ${storagePath}` : ""}`);
  return { ok: true, message: `Updated dex task ${id}.` };
}
