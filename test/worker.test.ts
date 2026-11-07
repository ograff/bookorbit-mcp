import { test, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain JS Worker module, no type declarations
import worker from "../deploy/cloudflare-worker/worker.js";

const env = {
  PROXY_KEY: "k".repeat(32),
  ACCESS_CLIENT_ID: "id.access",
  ACCESS_CLIENT_SECRET: "secret",
  ORIGIN: "https://bookorbit-mcp.example.com",
};
const realFetch = globalThis.fetch;
const NativeRequest = globalThis.Request;
// Node's Request requires `duplex: "half"` to forward a streamed body; the Workers runtime does
// not. Shim it here so the Worker source can stay byte-identical to what runs on Cloudflare.
before(() => {
  globalThis.Request = class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, init?.body ? ({ duplex: "half", ...init } as RequestInit) : init);
    }
  } as typeof Request;
});
after(() => {
  globalThis.Request = NativeRequest;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function capture() {
  const seen: { url: string; method: string; headers: Headers; body: string }[] = [];
  globalThis.fetch = (async (req: Request) => {
    seen.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: await req.text(),
    });
    return new Response("upstream ok", { status: 200 });
  }) as typeof fetch;
  return seen;
}
const call = (path: string, init: RequestInit = {}, e: Record<string, unknown> = env) =>
  worker.fetch(
    new Request(`https://proxy.workers.dev${path}`, init),
    e,
  ) as Promise<Response>;

test("only /mcp is served", async () => {
  const seen = capture();
  assert.equal(
    (await call("/healthz", { headers: { "x-api-key": env.PROXY_KEY } })).status,
    404,
  );
  assert.equal(
    (await call("/", { headers: { "x-api-key": env.PROXY_KEY } })).status,
    404,
  );
  assert.equal(seen.length, 0);
});

test("a missing or wrong key is 401 and never reaches the origin", async () => {
  const seen = capture();
  assert.equal((await call("/mcp", { method: "POST", body: "{}" })).status, 401);
  assert.equal(
    (await call("/mcp", { method: "POST", body: "{}", headers: { "x-api-key": "nope" } }))
      .status,
    401,
  );
  assert.equal(seen.length, 0);
});

test("a valid key forwards with service-token headers and without x-api-key", async () => {
  const seen = capture();
  const res = await call("/mcp?x=1", {
    method: "POST",
    body: '{"jsonrpc":"2.0"}',
    headers: { "x-api-key": env.PROXY_KEY, "content-type": "application/json" },
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "upstream ok");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://bookorbit-mcp.example.com/mcp?x=1");
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.body, '{"jsonrpc":"2.0"}');
  assert.equal(seen[0]!.headers.get("cf-access-client-id"), "id.access");
  assert.equal(seen[0]!.headers.get("cf-access-client-secret"), "secret");
  assert.equal(seen[0]!.headers.get("x-api-key"), null);
  assert.equal(seen[0]!.headers.get("content-type"), "application/json");
});

test("fails closed when unconfigured, even for the literal key 'undefined'", async () => {
  const seen = capture();
  // Without the guard, enc.encode(undefined) hashes "undefined" and this key would pass.
  const res = await call(
    "/mcp",
    { method: "POST", body: "{}", headers: { "x-api-key": "undefined" } },
    { ...env, PROXY_KEY: undefined },
  );
  assert.equal(res.status, 500);
  assert.equal(seen.length, 0);
});

test("any missing variable fails closed", async () => {
  const seen = capture();
  for (const k of ["ACCESS_CLIENT_ID", "ACCESS_CLIENT_SECRET", "ORIGIN"]) {
    const res = await call(
      "/mcp",
      { method: "POST", body: "{}", headers: { "x-api-key": env.PROXY_KEY } },
      { ...env, [k]: undefined },
    );
    assert.equal(res.status, 500, k);
  }
  assert.equal(seen.length, 0);
});
