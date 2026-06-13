/**
 * Generate a process-compose config file from Perch-owned process definitions
 * (`plugins.services.procs`) and keep it in sync with a running server (Part A
 * of managed services).
 *
 * Perch owns the service definitions: each {@link Proc} (a name + command, with
 * an optional working dir) maps onto one process-compose process. We emit a
 * canonical process-compose **YAML** document — the format process-compose reads
 * natively — and write it to a managed path derived from the Perch config dir
 * (alongside `perch.json`). YAML is hand-rolled for this exact, tiny shape so the
 * plugin takes **no new dependency**; the emitter safe-quotes every scalar so an
 * arbitrary command/working_dir can't break the document.
 *
 * The file is (re)generated every poll from {@link syncCompose}, but only
 * *rewritten* when its content actually changes (idempotent). When the content
 * changed AND a server is already running, we ask process-compose to live-reload
 * it (`process-compose project update -f <file>`) so unchanged processes keep
 * running; the reload is best-effort and never throws into the read.
 *
 * The pure pieces — {@link buildComposeDoc} and the change detection in
 * {@link syncCompose} (which takes an injected reader/writer/reloader) — are
 * unit-testable without touching the real filesystem or the `process-compose`
 * binary.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { configPath } from "@perch/core";

import type { ServerTarget } from "./provider.js";

/** Name of the generated process-compose file (lives beside `perch.json`). */
export const GENERATED_COMPOSE_FILENAME = "process-compose.generated.yaml";

/** The process-compose schema version we emit. */
const COMPOSE_VERSION = "0.5";

/** One Perch-owned process definition (`plugins.services.procs[]`). */
export interface Proc {
  /** Process name — the key in the generated compose file's `processes` map. */
  name: string;
  /** Shell command process-compose runs for this process. */
  command: string;
  /** Optional working directory (`working_dir`); omitted from output when unset. */
  cwd?: string;
}

/**
 * Absolute path of the managed, generated compose file: alongside `perch.json`
 * in the Perch config dir. Derived from `@perch/core`'s {@link configPath} so it
 * tracks any platform/`XDG_CONFIG_HOME` override.
 */
export function generatedComposePath(): string {
  return join(dirname(configPath()), GENERATED_COMPOSE_FILENAME);
}

/**
 * Quote a scalar for the flow-style YAML we emit. We always double-quote and
 * escape the few characters that are special inside a YAML double-quoted scalar
 * (`\` and `"`), plus control chars — so an arbitrary command string is carried
 * verbatim and can never terminate the document early or inject structure.
 */
function quote(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  return `"${escaped}"`;
}

/**
 * Build the process-compose YAML document for `procs`. Shape:
 *
 * ```yaml
 * version: "0.5"
 * processes:
 *   <name>:
 *     command: "<command>"
 *     working_dir: "<cwd>"   # only when cwd is set
 * ```
 *
 * Empty `procs` yields a document with an empty `processes` map (`processes: {}`),
 * which process-compose accepts. Pure + deterministic (preserves `procs` order).
 */
export function buildComposeDoc(procs: readonly Proc[]): string {
  const lines: string[] = [`version: ${quote(COMPOSE_VERSION)}`];
  if (procs.length === 0) {
    lines.push("processes: {}");
    return lines.join("\n") + "\n";
  }
  lines.push("processes:");
  for (const proc of procs) {
    lines.push(`  ${quote(proc.name)}:`);
    lines.push(`    command: ${quote(proc.command)}`);
    if (proc.cwd !== undefined) {
      lines.push(`    working_dir: ${quote(proc.cwd)}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** A live-reload of the generated file against an already-running server. */
export type Reloader = (file: string, target: ServerTarget) => void;

/** Injectable seams for {@link syncCompose} (tests stub all of them). */
export interface SyncComposeDeps {
  /** Read the current file content; `undefined` when it doesn't exist yet. */
  readFile?: (path: string) => string | undefined;
  /** Write the new content to the file. */
  writeFile?: (path: string, content: string) => void;
  /** Live-reload an already-running server with the new file. */
  reload?: Reloader;
  /** Connection target for the reload (socket preferred); enables reload when set. */
  target?: ServerTarget;
  /** Optional log sink. */
  log?: (message: string) => void;
}

/** Outcome of {@link syncCompose}. */
export interface SyncComposeResult {
  /** Absolute path of the generated file. */
  path: string;
  /** The document that is now on disk. */
  content: string;
  /** Whether the file content changed (and was rewritten) this call. */
  changed: boolean;
}

/** Default file reader: returns `undefined` on any read error (e.g. ENOENT). */
function defaultReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Default file writer over `fs.writeFileSync`. */
function defaultWriteFile(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
}

/**
 * Default {@link Reloader}: best-effort `process-compose project update -f
 * <file>` against the configured connection (socket via `--use-uds
 * --unix-socket`, else nothing — TCP uses the server's default address). This
 * applies added/changed/removed processes to a running server while leaving
 * unchanged ones running. Detached + never throws (a missing binary or a server
 * that's down is fine — autostart re-spawns with the new file on the next poll).
 */
export const defaultReload: Reloader = (file, target) => {
  const args = ["project", "update", "-f", file];
  if (target.socket) args.push("--use-uds", "--unix-socket", target.socket);
  const child = spawn("process-compose", args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
};

/**
 * (Re)generate the managed compose file from `procs`, rewriting it **only when
 * the content changed** (idempotent — safe to call every poll). When it changed
 * and a connection `target` is provided, live-reload the running server so the
 * new definitions take effect without restarting unchanged processes. All side
 * effects are best-effort and guarded so this never throws into the read.
 */
export function syncCompose(procs: readonly Proc[], deps: SyncComposeDeps = {}): SyncComposeResult {
  const path = generatedComposePath();
  const content = buildComposeDoc(procs);
  const readFile = deps.readFile ?? defaultReadFile;
  const writeFile = deps.writeFile ?? defaultWriteFile;

  let changed = false;
  try {
    const current = readFile(path);
    if (current !== content) {
      writeFile(path, content);
      changed = true;
    }
  } catch (err) {
    deps.log?.(`failed to write generated compose file: ${errorMessage(err)}`);
    return { path, content, changed: false };
  }

  // Only reload when the content actually changed and a server target is known.
  if (changed && deps.target) {
    try {
      (deps.reload ?? defaultReload)(path, deps.target);
      deps.log?.("process-compose live-reload attempted (project update)");
    } catch (err) {
      deps.log?.(`process-compose live-reload failed: ${errorMessage(err)}`);
    }
  }
  return { path, content, changed };
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
