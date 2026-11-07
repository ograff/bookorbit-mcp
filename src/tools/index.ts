import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./define.js";
import { registerDiscoveryTools } from "./discovery.js";
import { registerRequestTools } from "./requests.js";

export function registerAllTools(server: McpServer, ctx: ToolContext) {
  registerDiscoveryTools(server, ctx);
  registerRequestTools(server, ctx);
}
