/**
 * @perch/mcp — MCP server scaffold.
 *
 * Per the v1 spec this is built but mounts nothing: MCP is off by default and
 * a capability must opt in (`expose: { mcp: true }`). It stays dark until a
 * consumer needs it (a no-shell client, zero-config typed discovery, or a
 * unified cross-plugin tool surface).
 */
export async function startMcpServer(): Promise<void> {
  // TODO(post-v1): mount capabilities whose `expose.mcp` is true as MCP tools.
  throw new Error("@perch/mcp: no capabilities opt into MCP in v1");
}
