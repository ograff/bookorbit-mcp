import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpServer } from "../src/http.js";
import type { AppConfig } from "../src/config.js";
import { mockBookOrbit } from "./helpers/harness.js";

const baseConfig: AppConfig = {
  bookorbitUrl: "http://bo",
  username: "u",
  password: "p",
  port: 0,
  requireCfAccess: true,
  cfAccessTeamDomain: "acme",
  cfAccessAud: "aud",
  enableDestructive: true,
};

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function start(opts: {
  requireCfAccess: boolean;
  routes?: Record<string, unknown>;
}) {
  const mock = mockBookOrbit(
    opts.routes ?? { "GET /books/search": [{ id: 1, title: "Dune" }] },
  );
  const seen: (string | undefined)[] = [];
  const server = createHttpServer({
    config: { ...baseConfig, requireCfAccess: opts.requireCfAccess },
    client: mock.client,
    verifier: async (t) => {
      seen.push(t);
      if (t !== "good") throw new Error("bad");
      return { email: "me@example.com" };
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, mock, seen };
}

test("/healthz is open even with Access required", async () => {
  const { url } = await start({ requireCfAccess: true });
  const res = await fetch(`${url}/healthz`);
  assert.equal(res.status, 200);
});

test("/mcp without a valid JWT is 401 and never reaches BookOrbit", async () => {
  const { url, mock } = await start({ requireCfAccess: true });
  const noHeader = await fetch(`${url}/mcp`, { method: "POST", body: "{}" });
  assert.equal(noHeader.status, 401);
  const bad = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": "nope" },
    body: "{}",
  });
  assert.equal(bad.status, 401);
  assert.equal(mock.calls.length, 0);
});

test("full MCP round trip over HTTP with a valid JWT", async () => {
  const { url, mock } = await start({ requireCfAccess: true });
  const client = new Client({ name: "t", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { "Cf-Access-Jwt-Assertion": "good" } },
    }),
  );
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const name of [
    "search_books",
    "browse",
    "requests",
    "requests_admin",
    "fill_series_gaps",
    "manage_book",
    "book_dock",
    "metadata_bulk",
    "read_aloud",
    "tts",
  ]) {
    assert.ok(tools.includes(name), `missing tool ${name}`);
  }
  const res = (await client.callTool({
    name: "search_books",
    arguments: { q: "dune" },
  })) as any;
  assert.match(res.content[0].text, /Dune/);
  assert.equal(mock.calls[0]!.path, "/books/search?q=dune");
  await client.close();
});

test("Access can be turned off for local dev", async () => {
  const { url, seen } = await start({ requireCfAccess: false });
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  assert.ok((await client.listTools()).tools.length > 10);
  assert.equal(seen.length, 0);
  await client.close();
});

test("non-POST /mcp is 405 and unknown paths are 404", async () => {
  const { url } = await start({ requireCfAccess: false });
  assert.equal((await fetch(`${url}/mcp`)).status, 405);
  assert.equal((await fetch(`${url}/nope`)).status, 404);
});

test("malformed JSON is a 400, not a crash", async () => {
  const { url } = await start({ requireCfAccess: false });
  const res = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
});

test("createHttpServer refuses to start with Access required and no verifier", () => {
  assert.throws(
    () => createHttpServer({ config: baseConfig, client: mockBookOrbit({}).client }),
    /no verifier/,
  );
});
