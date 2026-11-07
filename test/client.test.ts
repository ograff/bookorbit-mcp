import { test } from "node:test";
import assert from "node:assert/strict";
import { BookOrbitClient, BookOrbitError } from "../src/client/bookorbit.js";

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

function mockFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, impl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const creds = (n: number) => ({ accessToken: `a${n}`, refreshToken: `r${n}` });

function client(impl: typeof fetch) {
  return new BookOrbitClient({
    baseUrl: "http://bo:3000/",
    username: "mcp",
    password: "pw",
    fetchImpl: impl,
  });
}

test("logs in as a native client and sends the bearer token", async () => {
  const { calls, impl } = mockFetch((c) =>
    c.url.endsWith("/auth/login") ? json(creds(1)) : json({ ok: true }),
  );
  assert.deepEqual(await client(impl).get("/books/1"), { ok: true });
  assert.equal(calls[0]!.url, "http://bo:3000/api/v1/auth/login");
  assert.equal(JSON.parse(calls[0]!.body!).clientKind, "native");
  assert.equal(calls[1]!.headers.Authorization, "Bearer a1");
});

test("on 401 refreshes via body token and retries once", async () => {
  let n = 0;
  const { calls, impl } = mockFetch((c) => {
    if (c.url.endsWith("/auth/login")) return json(creds(1));
    if (c.url.endsWith("/auth/refresh")) return json(creds(2));
    return c.headers.Authorization === "Bearer a2" ? json({ n: ++n }) : json({}, 401);
  });
  const c = client(impl);
  await c.get("/x"); // a1 is rejected (401), so the client refreshes to a2
  const refresh = calls.find((x) => x.url.endsWith("/auth/refresh"))!;
  assert.deepEqual(JSON.parse(refresh.body!), { refreshToken: "r1" });
  assert.equal(calls.filter((x) => x.url.endsWith("/auth/login")).length, 1);
});

test("falls back to full login when refresh fails", async () => {
  let logins = 0;
  const { impl } = mockFetch((c) => {
    if (c.url.endsWith("/auth/login")) return json(creds(++logins));
    if (c.url.endsWith("/auth/refresh")) return json({ message: "no" }, 401);
    return c.headers.Authorization === "Bearer a2" ? json({ ok: 1 }) : json({}, 401);
  });
  assert.deepEqual(await client(impl).get("/x"), { ok: 1 });
  assert.equal(logins, 2);
});

test("concurrent 401s share a single re-auth", async () => {
  let logins = 0;
  const { impl } = mockFetch(async (c) => {
    if (c.url.endsWith("/auth/login")) return json(creds(++logins));
    if (c.url.endsWith("/auth/refresh")) return json(creds(99));
    return c.headers.Authorization === "Bearer a99" ? json({ ok: 1 }) : json({}, 401);
  });
  const c = client(impl);
  await Promise.all([c.get("/a"), c.get("/b"), c.get("/c")]);
  assert.equal(logins, 1);
});

test("serializes query arrays and bodies on every verb", async () => {
  const { calls, impl } = mockFetch((c) =>
    c.url.endsWith("/auth/login") ? json(creds(1)) : json({}),
  );
  const c = client(impl);
  await c.get("/s", { libraryIds: [1, 2], q: "a b", skip: undefined });
  await c.post("/p", { a: 1 });
  await c.put("/u", { b: 2 });
  await c.patch("/m", { c: 3 });
  await c.delete("/d", { ids: [1] });
  const api = calls.slice(1);
  assert.equal(api[0]!.url, "http://bo:3000/api/v1/s?libraryIds=1&libraryIds=2&q=a+b");
  assert.deepEqual(
    api.slice(1).map((x) => [x.method, x.body]),
    [
      ["POST", '{"a":1}'],
      ["PUT", '{"b":2}'],
      ["PATCH", '{"c":3}'],
      ["DELETE", '{"ids":[1]}'],
    ],
  );
});

test("maps errors to endpoint + status + message", async () => {
  const { impl } = mockFetch((c) =>
    c.url.endsWith("/auth/login")
      ? json(creds(1))
      : json(
          {
            statusCode: 400,
            message: ["title must be a string", "mediaKind invalid"],
            errorCode: "BAD",
          },
          400,
        ),
  );
  await assert.rejects(
    client(impl).post("/book-requests", {}),
    (e: unknown) =>
      e instanceof BookOrbitError &&
      e.status === 400 &&
      e.message ===
        "BookOrbit POST /book-requests -> 400: title must be a string; mediaKind invalid [BAD]",
  );
});

test("login failure surfaces as BookOrbitError", async () => {
  const { impl } = mockFetch(() => json({ message: "Invalid credentials" }, 401));
  await assert.rejects(
    client(impl).get("/x"),
    /\/auth\/login -> 401: Invalid credentials/,
  );
});
