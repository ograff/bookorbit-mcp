// Regressions for bugs found by running the tools against a live BookOrbit 3.6.0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerLibraryTools } from "../src/tools/library.js";
import { registerRequestTools } from "../src/tools/requests.js";
import { registerDiscoveryTools } from "../src/tools/discovery.js";
import { registerSeriesGapTools } from "../src/tools/series-gaps.js";
import { connect, mockBookOrbit } from "./helpers/harness.js";

const destRequired = () =>
  new Response(
    JSON.stringify({
      statusCode: 400,
      message:
        "Pick a destination library: your own requests are approved without a second pair of eyes",
      errorCode: "SUBMIT_DESTINATION_REQUIRED",
    }),
    { status: 400 },
  );
const reqItem = (id: number) => ({
  id,
  title: "T",
  mediaKind: "ebook",
  status: "approved",
});

test("an empty (204) API response still yields a valid tool result", async () => {
  // manage_book delete returned an empty body, which produced `text: undefined` and an
  // invalid MCP result *after* the delete had already succeeded.
  const mock = mockBookOrbit({
    "GET /books/7": { id: 7, title: "Gone", libraryName: "L", files: [] },
    "DELETE /books": () => new Response(null, { status: 204 }),
  });
  const { call } = await connect(registerLibraryTools, mock.client);
  const r = await call("manage_book", { action: "delete", bookIds: [7], confirm: true });
  assert.equal(r.isError, false);
  assert.deepEqual(r.data, { ok: true });
});

test("requests.create retries with the configured default destination", async () => {
  let posts = 0;
  const mock = mockBookOrbit({
    "POST /book-requests": () =>
      posts++ === 0 ? destRequired() : { request: reqItem(5), subscribed: false },
    "GET /book-requests/default-destinations": {
      ebook: { libraryId: 3, libraryName: "Main", folderId: 9 },
      audiobook: { libraryId: null, libraryName: null, folderId: null },
    },
  });
  const { call } = await connect(registerRequestTools, mock.client);
  const r = await call("requests", { action: "create", title: "X", mediaKind: "ebook" });
  assert.equal(r.isError, false);
  const posted = mock.calls.filter((c) => c.method === "POST");
  assert.equal(posted.length, 2);
  assert.equal((posted[0]!.body as any).targetLibraryId, undefined);
  assert.equal((posted[1]!.body as any).targetLibraryId, 3);
  assert.equal((posted[1]!.body as any).targetFolderId, 9);
});

test("an explicit targetLibraryId is never overridden by defaults", async () => {
  const mock = mockBookOrbit({
    "POST /book-requests": { request: reqItem(5), subscribed: false },
  });
  const { call } = await connect(registerRequestTools, mock.client);
  await call("requests", {
    action: "create",
    title: "X",
    mediaKind: "ebook",
    targetLibraryId: 4,
  });
  assert.equal(mock.calls.length, 1);
  assert.equal((mock.calls[0]!.body as any).targetLibraryId, 4);
});

test("no default configured: the error says to pass targetLibraryId", async () => {
  const mock = mockBookOrbit({
    "POST /book-requests": () => destRequired(),
    "GET /book-requests/default-destinations": {
      ebook: { libraryId: null, libraryName: null, folderId: null },
      audiobook: { libraryId: null, libraryName: null, folderId: null },
    },
  });
  const { call } = await connect(registerRequestTools, mock.client);
  const r = await call("requests", { action: "create", title: "X", mediaKind: "ebook" });
  assert.equal(r.isError, true);
  assert.match(r.text, /SUBMIT_DESTINATION_REQUIRED/);
  assert.match(r.text, /targetLibraryId/);
  assert.match(r.text, /manage_library list/);
});

test("create_pair fills each half from its own default", async () => {
  let posts = 0;
  const mock = mockBookOrbit({
    "POST /book-requests/pairs": () =>
      posts++ === 0
        ? destRequired()
        : {
            ebook: { request: reqItem(1), subscribed: false },
            audiobook: { request: reqItem(2), subscribed: false },
          },
    "GET /book-requests/default-destinations": {
      ebook: { libraryId: 3, folderId: null },
      audiobook: { libraryId: 4, folderId: 8 },
    },
  });
  const { call } = await connect(registerRequestTools, mock.client);
  const r = await call("requests", { action: "create_pair", title: "X" });
  assert.equal(r.isError, false);
  const second = mock.calls.filter((c) => c.method === "POST")[1]!.body as any;
  assert.deepEqual(second.ebook, { targetLibraryId: 3 });
  assert.deepEqual(second.audiobook, { targetLibraryId: 4, targetFolderId: 8 });
});

test("other request errors are not retried or rewritten", async () => {
  const mock = mockBookOrbit({
    "POST /book-requests": () =>
      new Response(JSON.stringify({ message: "nope", errorCode: "OTHER" }), {
        status: 403,
      }),
  });
  const { call } = await connect(registerRequestTools, mock.client);
  const r = await call("requests", { action: "create", title: "X", mediaKind: "ebook" });
  assert.equal(r.isError, true);
  assert.match(r.text, /403: nope \[OTHER\]/);
  assert.equal(mock.calls.length, 1);
});

test("read status is flattened to a string in search results and book detail", async () => {
  const status = {
    status: "reading",
    source: "manual",
    startedAt: "2026-11-07T00:00:00.000Z",
  };
  const mock = mockBookOrbit({
    "GET /books/search": [{ id: 1, title: "A", readStatus: status, formats: ["epub"] }],
    "GET /books/1": { id: 1, title: "A", readStatus: status, authors: [], files: [] },
  });
  const { call } = await connect(registerDiscoveryTools, mock.client);
  assert.equal(
    (await call("search_books", { q: "A" })).data.items[0].readStatus,
    "reading",
  );
  assert.equal((await call("get_book", { bookId: 1 })).data.readStatus, "reading");
});

test("fill_series_gaps creation also falls back to default destinations", async () => {
  let posts = 0;
  const sse = () =>
    new Response(
      `data: ${JSON.stringify({
        provider: "hardcover",
        providerId: "h3",
        title: "Third",
        authors: ["Testy McTestface"],
        seriesName: "Test Saga",
        seriesIndex: "3",
      })}\n\n`,
      { status: 200 },
    );
  const mock = mockBookOrbit({
    "GET /series": { items: [{ id: 7, name: "Test Saga" }], total: 1 },
    "GET /series/7/books": {
      items: [],
      total: 0,
      seriesInfo: {
        id: 7,
        name: "Test Saga",
        authors: ["Testy McTestface"],
        bookCount: 2,
        expectedBookCount: null,
        possibleGaps: [3],
      },
    },
    "GET /metadata-fetch/stream": sse,
    "POST /book-requests/availability": [
      { ownedBookId: null, existingRequestId: null, existingRequestStatus: null },
    ],
    "POST /book-requests": () =>
      posts++ === 0 ? destRequired() : { request: reqItem(9), subscribed: false },
    "GET /book-requests/default-destinations": {
      ebook: { libraryId: 2, folderId: 5 },
      audiobook: { libraryId: null, folderId: null },
    },
  });
  const { call } = await connect(registerSeriesGapTools, mock.client);
  const r = await call("fill_series_gaps", { series: 7, dryRun: false });
  assert.equal(r.isError, false);
  assert.equal(r.data.created[0].requestId, 9);
  const last = mock.calls.filter((c) => c.path === "/book-requests").at(-1)!.body as any;
  assert.equal(last.targetLibraryId, 2);
  assert.equal(last.targetFolderId, 5);
});
