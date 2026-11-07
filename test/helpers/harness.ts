import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BookOrbitClient } from "../../src/client/bookorbit.js";
import type { ToolContext } from "../../src/tools/define.js";

export type Call = { method: string; path: string; body?: unknown };

/** Mock BookOrbit: `routes` maps "METHOD /path" (no query) to a JSON body or a function. */
export function mockBookOrbit(routes: Record<string, unknown | ((c: Call) => unknown)>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^\/api\/v1/, "");
    const method = init?.method ?? "GET";
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (path === "/auth/login") return json({ accessToken: "a", refreshToken: "r" });
    const call: Call = {
      method,
      path: path + u.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const route = routes[`${method} ${path}`];
    if (route === undefined)
      return json({ message: `no mock for ${method} ${path}` }, 404);
    return json(
      typeof route === "function" ? (route as (c: Call) => unknown)(call) : route,
    );
  }) as typeof fetch;
  const client = new BookOrbitClient({
    baseUrl: "http://bo",
    username: "u",
    password: "p",
    fetchImpl,
  });
  return { client, calls };
}

export async function connect(
  register: (server: McpServer, ctx: ToolContext) => void,
  client: BookOrbitClient,
  enableDestructive = true,
) {
  const server = new McpServer({ name: "t", version: "0" });
  register(server, { client, enableDestructive });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: "c", version: "0" });
  await mcp.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await mcp.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    const text = r.content[0]!.text;
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* plain text error */
    }
    return { isError: Boolean(r.isError), data, text };
  };
  return { mcp, call };
}
