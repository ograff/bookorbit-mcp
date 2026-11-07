import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./define.js";
import { registerDiscoveryTools } from "./discovery.js";
import { registerBookDockTools } from "./book-dock.js";
import { registerLibraryTools } from "./library.js";
import { registerMetadataTools } from "./metadata.js";
import { registerRequestTools } from "./requests.js";
import { registerSeriesGapTools } from "./series-gaps.js";

export function registerAllTools(server: McpServer, ctx: ToolContext) {
  registerDiscoveryTools(server, ctx);
  registerRequestTools(server, ctx);
  registerSeriesGapTools(server, ctx);
  registerLibraryTools(server, ctx);
  registerBookDockTools(server, ctx);
  registerMetadataTools(server, ctx);
}
