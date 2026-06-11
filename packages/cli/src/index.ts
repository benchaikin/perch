/**
 * @perch/cli — the `perch` command.
 *
 * A thin JSON-RPC client of `perchd`. Commands are generated from the registry
 * the daemon exposes: every capability whose `expose.cli` is true becomes a
 * subcommand, grouped by plugin. A capability id `stack.view` maps to the
 * command `perch stack view`.
 *
 * Flag conventions:
 * - `--json`            machine-readable: print the raw JSON result to stdout.
 * - `--watch`           subscribe to a read and stream updates until Ctrl-C.
 * - `--socket <path>`   override the daemon socket path.
 * These three are CLI-level and never forwarded as capability input. Every
 * other `--key value` flag is collected into the input object (see ./args.ts).
 *
 * M3 implements the client + command generation.
 */
import { socketPath as defaultSocketPath, type CapabilityMeta } from "@perch/core";
import { runApp } from "./app.js";
import { parseArgs } from "./args.js";
import { DaemonUnavailableError, PerchClient } from "./client.js";
import { isConfigCommand, runConfigCommand } from "./config.js";
import { runDaemonCommand } from "./daemon.js";
import { renderResult } from "./render.js";

// Re-export the RPC client so other frontends (e.g. the M5 GUI) can reuse it
// rather than re-implementing a vscode-jsonrpc wrapper.
export { PerchClient, DaemonUnavailableError } from "./client.js";

/** Entry point: parse argv, connect to perchd, dispatch the command. */
export async function run(argv: string[]): Promise<void> {
  const { positionals, cli, input } = parseArgs(argv.slice(2));
  const socket = cli.socket ?? defaultSocketPath();

  // Built-in `daemon` command group — manages the daemon process itself, so it
  // is handled BEFORE the registry dispatch (which requires a running daemon).
  if (positionals[0] === "daemon") {
    const code = await runDaemonCommand(positionals[1], { socket: cli.socket });
    if (code !== 0) process.exitCode = code;
    return;
  }

  // Built-in `config` command group — reads/mutates `perch.json` via the config
  // RPC. Handled before the registry dispatch; it connects to the daemon itself.
  if (isConfigCommand(positionals)) {
    const code = await runConfigCommand(positionals, { socket, json: cli.json });
    if (code !== 0) process.exitCode = code;
    return;
  }

  // Built-in `app` command — launch the desktop GUI (and ensure the daemon).
  if (positionals[0] === "app") {
    const code = await runApp({ socket: cli.socket });
    if (code !== 0) process.exitCode = code;
    return;
  }

  let client: PerchClient;
  try {
    client = await PerchClient.connect(socket);
  } catch (err) {
    if (err instanceof DaemonUnavailableError) {
      console.error(`perch: ${err.message}`);
      console.error("Start it with `perchd` and try again.");
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  try {
    const caps = (await client.registryList()).filter((c) => c.expose.cli);

    // No command (or only a plugin name): list available commands.
    if (positionals.length < 2) {
      printListing(caps, positionals[0]);
      return;
    }

    const [pluginId, name, ...rest] = positionals;
    if (rest.length > 0) {
      console.error(`perch: unexpected argument ${JSON.stringify(rest[0])}`);
      process.exitCode = 1;
      return;
    }
    const id = `${pluginId}.${name}`;
    const cap = caps.find((c) => c.id === id);
    if (!cap) {
      console.error(`perch: unknown command ${JSON.stringify(`${pluginId} ${name}`)}`);
      printListing(caps);
      process.exitCode = 1;
      return;
    }

    if (cli.watch) {
      if (cap.kind !== "read") {
        console.error(`perch: --watch only works on reads, not ${cap.kind} ${JSON.stringify(id)}`);
        process.exitCode = 1;
        return;
      }
      await watch(client, cap, input, cli.json);
      return;
    }

    try {
      const result = await client.invoke({ id, input });
      if (cli.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else if (cap.kind === "action") {
        // Actions declare no output; JSON-RPC serializes their void result as null.
        console.log(result == null ? "ok" : renderResult(result));
      } else {
        console.log(renderResult(result));
      }
    } catch (err) {
      console.error(`perch: ${id}: ${errorMessage(err)}`);
      process.exitCode = 1;
    }
  } finally {
    client.close();
  }
}

/** Subscribe to a read, print the current value, then stream updates until Ctrl-C. */
async function watch(
  client: PerchClient,
  cap: CapabilityMeta,
  input: Record<string, unknown> | undefined,
  json: boolean,
): Promise<void> {
  const { id } = cap;
  const result = await client.subscribe({ id, input });
  const myKey = result.inputKey;

  const emit = (data: unknown): void => {
    if (json) {
      process.stdout.write(`${JSON.stringify(data)}\n`);
    } else {
      console.log(renderResult(data));
    }
  };

  if (result.current !== undefined) emit(result.current);

  const updateSub = client.onUpdate((note) => {
    if (note.id === id && note.inputKey === myKey) emit(note.data);
  });

  await new Promise<void>((resolve) => {
    const onSigint = (): void => {
      updateSub.dispose();
      void client.unsubscribe({ id, input }).finally(resolve);
    };
    process.once("SIGINT", onSigint);
  });
}

/** Print the available commands, optionally filtered to one plugin. */
function printListing(caps: CapabilityMeta[], pluginFilter?: string): void {
  const shown = pluginFilter ? caps.filter((c) => c.pluginId === pluginFilter) : caps;

  if (pluginFilter && shown.length === 0) {
    console.error(`perch: no commands for plugin ${JSON.stringify(pluginFilter)}`);
    process.exitCode = 1;
    return;
  }

  if (shown.length === 0) {
    console.log("perch: no commands available (no CLI-exposed capabilities loaded)");
    return;
  }

  console.log("Available commands:\n");
  const byPlugin = new Map<string, CapabilityMeta[]>();
  for (const cap of shown) {
    const list = byPlugin.get(cap.pluginId) ?? [];
    list.push(cap);
    byPlugin.set(cap.pluginId, list);
  }

  // Align the `perch <plugin> <name>` column for readable output.
  const labels = shown.map((c) => `perch ${c.pluginId} ${c.name}`);
  const width = Math.max(...labels.map((l) => l.length));

  for (const [plugin, list] of byPlugin) {
    console.log(`${plugin}:`);
    for (const cap of list) {
      const label = `perch ${plugin} ${cap.name}`.padEnd(width);
      console.log(`  ${label}  ${cap.summary}`);
    }
    console.log("");
  }
}

/** Best-effort extraction of a human-readable message from an RPC error. */
function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
