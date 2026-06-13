/**
 * Electron-free logic for the Settings window's managed-process list.
 *
 * The services plugin's user-declared processes live at
 * `config.plugins.services.procs`: an array of `{ name, command, cwd? }` the
 * daemon launches (and the panel's Services section + service list reflect).
 * The Settings window's Services tab lets the user add / remove these; this
 * module computes the resulting array (and validates an add) so the pure
 * transforms are unit-testable without a display.
 *
 * All mutators are pure: they take the current array and return a new one,
 * normalizing along the way (trim fields, drop blank `cwd`, de-duplicate by
 * `name` — first occurrence wins so order is stable).
 */
import type { PerchConfig } from "@perch/core";

/**
 * One managed process, matching the services plugin's `Proc` config shape:
 * `name` + `command` are required, `cwd` is optional (defaults to the daemon's
 * working dir). This is the exact object the CRUD writes into
 * `plugins.services.procs`.
 */
export interface Proc {
  /** Display name + the unique key the daemon supervises the process under. */
  name: string;
  /** The shell command to run. */
  command: string;
  /** Optional working directory; omitted when blank. */
  cwd?: string;
}

/** Raised by {@link addProc} when a candidate proc fails validation. */
export class ProcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcValidationError";
  }
}

/** Shape of the services plugin's config section we care about. */
interface ServicesConfig {
  procs?: unknown;
}

/**
 * Read `plugins.services.procs` out of a parsed config as a clean `Proc[]`,
 * keeping only well-formed entries (a string `name` + `command`) and
 * normalizing them (trim, drop blank `cwd`, de-dupe by name).
 */
export function procsFromConfig(config: PerchConfig): Proc[] {
  const services = (config.plugins?.services ?? undefined) as ServicesConfig | undefined;
  const procs = services?.procs;
  if (!Array.isArray(procs)) return [];
  const parsed: Proc[] = [];
  for (const raw of procs) {
    if (raw == null || typeof raw !== "object") continue;
    const { name, command, cwd } = raw as Record<string, unknown>;
    if (typeof name !== "string" || typeof command !== "string") continue;
    parsed.push(cleanProc({ name, command, cwd: typeof cwd === "string" ? cwd : undefined }));
  }
  return normalize(parsed);
}

/** Trim a proc's fields and drop a blank `cwd` (so it's omitted, not stored ""). */
function cleanProc(proc: Proc): Proc {
  const name = proc.name.trim();
  const command = proc.command.trim();
  const cwd = proc.cwd?.trim();
  return cwd ? { name, command, cwd } : { name, command };
}

/**
 * De-duplicate by `name` while preserving order (first occurrence wins) and drop
 * entries with a blank name or command (post-trim).
 */
function normalize(procs: Proc[]): Proc[] {
  const seen = new Set<string>();
  const out: Proc[] = [];
  for (const proc of procs) {
    const clean = cleanProc(proc);
    if (!clean.name || !clean.command || seen.has(clean.name)) continue;
    seen.add(clean.name);
    out.push(clean);
  }
  return out;
}

/**
 * Append a new proc to the array, returning the new array. Validates that the
 * (trimmed) `name` and `command` are non-empty and the name is unique; throws a
 * {@link ProcValidationError} otherwise (the caller surfaces it inline). The
 * stored proc has trimmed fields and omits a blank `cwd`.
 */
export function addProc(procs: Proc[], candidate: Proc): Proc[] {
  const clean = cleanProc(candidate);
  if (!clean.name) throw new ProcValidationError("Name is required.");
  if (!clean.command) throw new ProcValidationError("Command is required.");
  const existing = normalize(procs);
  if (existing.some((p) => p.name === clean.name)) {
    throw new ProcValidationError(`A service named "${clean.name}" already exists.`);
  }
  return [...existing, clean];
}

/** Remove the proc with the given `name` from the array (no-op if absent). */
export function removeProc(procs: Proc[], name: string): Proc[] {
  const target = name.trim();
  return normalize(procs.filter((p) => p.name.trim() !== target));
}
