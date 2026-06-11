/**
 * `perch config` command group — built-in, NOT registry-driven.
 *
 * Reads and mutates `perch.json` via the daemon's config RPC, so (like the
 * `daemon` group) it's dispatched before the registry-driven commands. It
 * connects to the running daemon with {@link PerchClient.connect}; if no daemon
 * is listening it prints the same clear "not running" error as `run`.
 *
 * - `config get`                    — print the current `perch.json`.
 * - `config repo list` (`config repos`) — list the configured stack repos.
 * - `config repo add <path>`        — validate + append a repo path.
 * - `config repo remove <path-or-name>` — drop a repo by path or basename.
 * - `config repo set-default <path-or-name>` — move a repo to the front.
 *
 * The stack plugin reads its repos from `config.plugins.stack.repos` (an array
 * of local repo paths; a repo's display name is `basename(path)`; the first
 * entry is the default). The repo mutations compute the whole new array
 * client-side and send it through `configUpdate({ patch: { plugins: { stack:
 * { repos } } } })` (arrays replace wholesale), so the daemon validates, writes
 * atomically, and hot-reloads.
 */
import { basename, resolve } from "node:path";
import type { PerchConfig } from "@perch/core";
import { DaemonUnavailableError, PerchClient } from "./client.js";

/** Options shared by the config subcommands. */
export interface ConfigOptions {
  /** Override the socket path (defaults to the platform paths shim). */
  socket: string;
  /** Print machine-readable JSON instead of human-formatted output. */
  json: boolean;
}

/** Read the configured stack repos array from a parsed config (always a copy). */
function reposOf(config: PerchConfig): string[] {
  const stack = config.plugins?.stack as { repos?: unknown } | undefined;
  const repos = stack?.repos;
  return Array.isArray(repos) ? repos.filter((r): r is string => typeof r === "string") : [];
}

/** Find a repo entry matching `target` by absolute path OR basename. */
function findRepo(repos: string[], target: string): string | undefined {
  const abs = resolve(target);
  return repos.find((r) => r === abs || r === target || basename(r) === target);
}

/** `perch config get` — print the current `perch.json`. */
async function configGet(client: PerchClient, opts: ConfigOptions): Promise<number> {
  const config = await client.configGet();
  process.stdout.write(`${JSON.stringify(config, null, opts.json ? 0 : 2)}\n`);
  return 0;
}

/** `perch config repo list` — list configured stack repos, marking the default. */
async function repoList(client: PerchClient, opts: ConfigOptions): Promise<number> {
  const repos = reposOf(await client.configGet());

  if (opts.json) {
    const items = repos.map((path, i) => ({ name: basename(path), path, default: i === 0 }));
    process.stdout.write(`${JSON.stringify(items)}\n`);
    return 0;
  }

  if (repos.length === 0) {
    console.log("no stack repos configured");
    return 0;
  }

  const width = Math.max(...repos.map((r) => basename(r).length));
  repos.forEach((path, i) => {
    const marker = i === 0 ? " (default)" : "";
    console.log(`  ${basename(path).padEnd(width)}  ${path}${marker}`);
  });
  return 0;
}

/** `perch config repo add <path>` — validate, then append the repo path. */
async function repoAdd(
  client: PerchClient,
  opts: ConfigOptions,
  path: string | undefined,
): Promise<number> {
  if (path === undefined) {
    console.error("perch: config repo add requires a <path> argument");
    return 1;
  }
  const abs = resolve(path);

  const repos = reposOf(await client.configGet());
  if (repos.includes(abs)) {
    console.log(`${abs} is already configured`);
    return 0;
  }

  const check = await client.validateRepoPath({ path: abs });
  if (!check.ok) {
    console.error(
      `perch: ${abs} is not a usable git repo${check.reason ? `: ${check.reason}` : ""}`,
    );
    return 1;
  }

  const next = [...repos, abs];
  await client.configUpdate({ patch: { plugins: { stack: { repos: next } } } });
  console.log(`added ${basename(abs)} (${abs})`);
  return 0;
}

/** `perch config repo remove <path-or-name>` — drop the matching repo. */
async function repoRemove(
  client: PerchClient,
  opts: ConfigOptions,
  target: string | undefined,
): Promise<number> {
  if (target === undefined) {
    console.error("perch: config repo remove requires a <path-or-name> argument");
    return 1;
  }

  const repos = reposOf(await client.configGet());
  const match = findRepo(repos, target);
  if (match === undefined) {
    console.error(`perch: no configured repo matching ${JSON.stringify(target)}`);
    return 1;
  }

  const next = repos.filter((r) => r !== match);
  await client.configUpdate({ patch: { plugins: { stack: { repos: next } } } });
  console.log(`removed ${basename(match)} (${match})`);
  return 0;
}

/** `perch config repo set-default <path-or-name>` — move the match to the front. */
async function repoSetDefault(
  client: PerchClient,
  opts: ConfigOptions,
  target: string | undefined,
): Promise<number> {
  if (target === undefined) {
    console.error("perch: config repo set-default requires a <path-or-name> argument");
    return 1;
  }

  const repos = reposOf(await client.configGet());
  const match = findRepo(repos, target);
  if (match === undefined) {
    console.error(`perch: no configured repo matching ${JSON.stringify(target)}`);
    return 1;
  }

  const next = [match, ...repos.filter((r) => r !== match)];
  await client.configUpdate({ patch: { plugins: { stack: { repos: next } } } });
  console.log(`default repo is now ${basename(match)} (${match})`);
  return 0;
}

/** Dispatch a `perch config repo <sub>` command. */
async function runRepoCommand(
  client: PerchClient,
  opts: ConfigOptions,
  sub: string | undefined,
  arg: string | undefined,
): Promise<number> {
  switch (sub) {
    case "list":
    case undefined:
      return repoList(client, opts);
    case "add":
      return repoAdd(client, opts, arg);
    case "remove":
      return repoRemove(client, opts, arg);
    case "set-default":
      return repoSetDefault(client, opts, arg);
    default:
      console.error(
        `perch: unknown config repo command ${JSON.stringify(sub)}\n` +
          "usage: perch config repo <list|add|remove|set-default>",
      );
      return 1;
  }
}

/** Known top-level config subcommand names (for dispatch in `run`). */
const SUBCOMMANDS = new Set(["get", "repo", "repos"]);

/** Whether the positionals describe a `perch config <sub>` command. */
export function isConfigCommand(positionals: string[]): boolean {
  return positionals[0] === "config" && SUBCOMMANDS.has(positionals[1] ?? "");
}

/**
 * Dispatch a `perch config <sub>` command. Returns the exit code. Connects to
 * the daemon (handling not-running with a clear error), then routes to the
 * matching handler. Unknown subcommands print usage and return 1.
 */
export async function runConfigCommand(
  positionals: string[],
  opts: ConfigOptions,
): Promise<number> {
  const [, sub, ...rest] = positionals;

  let client: PerchClient;
  try {
    client = await PerchClient.connect(opts.socket);
  } catch (err) {
    if (err instanceof DaemonUnavailableError) {
      console.error(`perch: ${err.message}`);
      console.error("Start it with `perchd` and try again.");
      return 1;
    }
    throw err;
  }

  try {
    switch (sub) {
      case "get":
        return await configGet(client, opts);
      case "repos":
        return await repoList(client, opts);
      case "repo":
        return await runRepoCommand(client, opts, rest[0], rest[1]);
      default:
        console.error(
          `perch: unknown config command ${JSON.stringify(sub ?? "")}\n` +
            "usage: perch config <get|repo|repos>",
        );
        return 1;
    }
  } finally {
    client.close();
  }
}
