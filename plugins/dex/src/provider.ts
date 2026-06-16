/**
 * Thin runner around the `dex` CLI. The {@link Exec} seam (mirroring the stack
 * plugin's `gh-provider`) is injected so the daemon spawns a real process while
 * tests pass a stub and assert the composed command without shelling out.
 *
 * dex resolves its task store from cwd (walking up to the nearest `.dex/`, like
 * git) unless given an explicit `--storage-path`. Monitoring a specific project
 * therefore means either running with that directory as `cwd`, or pointing
 * `--storage-path` at its `<dir>/.dex/tasks.jsonl`.
 */
import { execFile } from "node:child_process";

/** Run a command and resolve its stdout; rejects (with captured stdout) on a non-zero exit. */
export type Exec = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<string>;

type ExecError = Error & { stdout?: string; stderr?: string };

/** The real `execFile`-backed runner, shared by the provider and the spawn action. */
export const defaultExec: Exec = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, cwd: opts?.cwd },
      (err, stdout, stderr) => {
        if (err) {
          (err as ExecError).stdout = stdout;
          (err as ExecError).stderr = stderr;
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });

/** Options for a single `dex list` invocation. */
export interface ListOptions {
  /** Explicit task-store file; when set, targets that store regardless of cwd. */
  storagePath?: string;
  /** Working directory dex resolves its `.dex/` store from when no storagePath. */
  cwd?: string;
  /** Include completed tasks (`dex list --all`); default false. */
  showCompleted?: boolean;
}

export interface DexProviderDeps {
  exec?: Exec;
}

/** Runs `dex list --json` against one or more stores and returns parsed JSON. */
export class DexProvider {
  private readonly exec: Exec;

  constructor(
    private readonly dexBin: string,
    deps: DexProviderDeps = {},
  ) {
    this.exec = deps.exec ?? defaultExec;
  }

  /**
   * Run `dex list --json` for one store and return the parsed JSON array (or
   * `[]` if the output isn't an array). `--storage-path` is a global option, so
   * it precedes the `list` subcommand: `dex [--storage-path P] list --json [--all]`.
   */
  async listRaw(opts: ListOptions = {}): Promise<unknown[]> {
    const args: string[] = [];
    if (opts.storagePath) args.push("--storage-path", opts.storagePath);
    args.push("list", "--json");
    if (opts.showCompleted) args.push("--all");
    const stdout = await this.exec(this.dexBin, args, { cwd: opts.cwd });
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [];
  }
}
