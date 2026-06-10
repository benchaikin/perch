#!/usr/bin/env node
/**
 * `perch-mcp` — launch the Perch MCP server over stdio.
 *
 * An MCP client (Claude Code, Cursor, …) spawns this and speaks MCP over the
 * child's stdin/stdout. We connect to `perchd`, mount the MCP-opted-in
 * capabilities as tools, and serve until the transport closes.
 *
 * Diagnostics go to stderr only — stdout is the MCP wire and must stay clean.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DaemonUnavailableError, startMcpServer } from "./index.js";

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  try {
    const mcp = await startMcpServer({ transport });
    // Shut down cleanly when the client closes the stdio stream.
    transport.onclose = (): void => {
      void mcp.close();
    };
  } catch (err) {
    if (err instanceof DaemonUnavailableError) {
      console.error(`perch-mcp: ${err.message}`);
      console.error("Start it with `perchd` and try again.");
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

main().catch((err: unknown) => {
  console.error(`perch-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
