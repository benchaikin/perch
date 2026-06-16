/**
 * Build the inner `process-compose process logs <name> -f` command (with the M1
 * provider's connection flag) — the command the `services.logs` action hands to
 * the shared terminal launcher (`spawnInTerminal` from `@perch/sdk`). The launcher
 * itself (terminal presets, template substitution, spawning) is shared in the
 * SDK; only this command shape is services-specific.
 */
import { shellQuote } from "@perch/sdk";

import { DEFAULT_ADDRESS, type ServerTarget } from "./provider.js";

/**
 * Build the inner `process-compose process logs <name> -f` command, including
 * the connection flag the M1 provider uses: `--use-uds --unix-socket <socket>`
 * when a socket is configured, else `-a <host> -p <port>` parsed from the HTTP
 * address (default `http://localhost:8080`). The process name is shell-quoted so
 * spaces/quotes in it don't break the command.
 */
export function buildLogsCommand(name: string, target: ServerTarget): string {
  const parts = ["process-compose", "process", "logs", shellQuote(name), "-f"];
  if (target.socket) {
    parts.push("--use-uds", "--unix-socket", shellQuote(target.socket));
  } else {
    const url = new URL(target.address ?? DEFAULT_ADDRESS);
    const host = url.hostname || "localhost";
    const port = url.port || "8080";
    parts.push("-a", shellQuote(host), "-p", shellQuote(port));
  }
  return parts.join(" ");
}
