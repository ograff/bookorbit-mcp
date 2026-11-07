import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { BookOrbitClient } from "./client/bookorbit.js";
import type { CfAccessVerifier } from "./auth/cf-access.js";
import type { AppConfig } from "./config.js";
import { createMcpServer } from "./server-factory.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function send(res: ServerResponse, status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain" : "application/json",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function jsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
) {
  send(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

export interface HttpDeps {
  config: AppConfig;
  client: BookOrbitClient;
  /** Required when config.requireCfAccess is true. */
  verifier?: CfAccessVerifier;
  log?: (msg: string) => void;
}

/**
 * Stateless Streamable HTTP MCP server. A fresh McpServer+transport serves each request, so there
 * is no session state to lose on restart or to share across replicas. /healthz is unauthenticated
 * (kubelet probes); everything else requires a valid Cloudflare Access JWT when enabled.
 */
export function createHttpServer(deps: HttpDeps): Server {
  const { config, client } = deps;
  const log = deps.log ?? (() => undefined);
  if (config.requireCfAccess && !deps.verifier) {
    throw new Error("requireCfAccess is on but no verifier was provided");
  }

  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://x").pathname;

      if (path === "/healthz") return send(res, 200, { ok: true });

      if (config.requireCfAccess) {
        try {
          const who = await deps.verifier!(
            req.headers["cf-access-jwt-assertion"] as string | undefined,
          );
          log(`auth ok ${who.email ?? who.sub ?? "?"} ${req.method} ${path}`);
        } catch (err) {
          log(
            `auth rejected ${req.method} ${path}: ${err instanceof Error ? err.message : err}`,
          );
          return send(res, 401, { error: "unauthorized" });
        }
      }

      if (path !== "/mcp") return send(res, 404, { error: "not found" });
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return jsonRpcError(
          res,
          405,
          -32000,
          "Method not allowed (stateless server: POST only).",
        );
      }

      let body: unknown;
      try {
        body = await readJson(req);
      } catch (err) {
        return jsonRpcError(
          res,
          400,
          -32700,
          err instanceof Error ? err.message : "bad request",
        );
      }

      const mcp = createMcpServer(config, client);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log(`error: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
    }
  });
}
