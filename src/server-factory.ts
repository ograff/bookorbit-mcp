import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BookOrbitClient } from "./client/bookorbit.js";
import type { AppConfig } from "./config.js";
import { registerAllTools } from "./tools/index.js";

/** Build an MCP server wired to a (shared) BookOrbit client. */
export function createMcpServer(config: AppConfig, client: BookOrbitClient): McpServer {
  const server = new McpServer({ name: "bookorbit-mcp", version: "0.2.0" });
  registerAllTools(server, { client, enableDestructive: config.enableDestructive });
  return server;
}

export function createClient(config: AppConfig): BookOrbitClient {
  return new BookOrbitClient({
    baseUrl: config.bookorbitUrl,
    username: config.username,
    password: config.password,
  });
}
