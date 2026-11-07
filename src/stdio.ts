#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createClient, createMcpServer } from "./server-factory.js";

// Local/Claude Code entrypoint: no HTTP, so Cloudflare Access does not apply.
const config = loadConfig({ ...process.env, REQUIRE_CF_ACCESS: "false" });
const server = createMcpServer(config, createClient(config));
await server.connect(new StdioServerTransport());
