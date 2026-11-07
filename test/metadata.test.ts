import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApplyBody, registerMetadataTools } from "../src/tools/metadata.js";
import { connect, mockBookOrbit } from "./helpers/harness.js";

const cand = {
  provider: "hardcover",
  providerId: "h1",
  title: "Leviathan Wakes",
  subtitle: "Book 1",
  authors: ["James S. A. Corey"],
  seriesName: "The Expanse",
  seriesIndex: "1",
  isbn13: "9780316129084",
  genres: [],
  publishedYear: 2011,
};

test("buildApplyBody writes only the chosen fields and reports missing data", () => {
  const { body, skipped } = buildApplyBody(cand as any, [
    "title",
    "series",
    "providerId",
    "genres",
    "pageCount",
  ]);
  assert.deepEqual(body, {
    title: "Leviathan Wakes",
    seriesName: "The Expanse",
    seriesIndex: "1",
    hardcoverId: "h1",
  });
  assert.deepEqual(skipped.sort(), ["genres", "pageCount"]);
});

test("buildApplyBody maps provider keys to id fields", () => {
  assert.deepEqual(
    buildApplyBody({ provider: "openLibrary", providerId: "OL1" } as any, ["providerId"])
      .body,
    {
      openLibraryId: "OL1",
    },
  );
  assert.deepEqual(
    buildApplyBody({ provider: "weird", providerId: "x" } as any, ["providerId"]).skipped,
    ["providerId"],
  );
});

test("metadata_lookup returns numbered, trimmed candidates and ignores status events", async () => {
  const mock = mockBookOrbit({
    "GET /metadata-fetch/stream": () =>
      new Response(
        `event: provider-status\ndata: {"p":1}\n\n` +
          `data: ${JSON.stringify({ ...cand, description: "x".repeat(500) })}\n\n`,
        { status: 200 },
      ),
  });
  const { call } = await connect(registerMetadataTools, mock.client);
  const r = await call("metadata_lookup", { title: "Leviathan Wakes" });
  assert.equal(r.data.total, 1);
  assert.equal(r.data.candidates[0].n, 1);
  assert.equal(r.data.candidates[0].description.length, 200);
  assert.match(mock.calls[0]!.path, /title=Leviathan\+Wakes/);
});

test("metadata_lookup with no search terms is an error", async () => {
  const mock = mockBookOrbit({});
  const { call } = await connect(registerMetadataTools, mock.client);
  const r = await call("metadata_lookup", {});
  assert.equal(r.isError, true);
  assert.equal(mock.calls.length, 0);
});

test("apply re-looks-up the record and PATCHes only chosen fields", async () => {
  const mock = mockBookOrbit({
    "GET /metadata-fetch/lookup": cand,
    "PATCH /books/7/metadata": {
      id: 7,
      title: "Leviathan Wakes",
      authors: [],
      files: [],
    },
  });
  const { call } = await connect(registerMetadataTools, mock.client);
  const r = await call("book_metadata", {
    action: "apply",
    bookId: 7,
    provider: "hardcover",
    providerId: "h1",
    fields: ["title", "isbn13"],
  });
  assert.deepEqual(r.data.applied, ["title", "isbn13"]);
  assert.deepEqual(mock.calls[1]!.body, {
    title: "Leviathan Wakes",
    isbn13: "9780316129084",
  });
  assert.match(mock.calls[0]!.path, /provider=hardcover&id=h1/);
});

test("apply fails clearly when the record is gone or has no data", async () => {
  const mock = mockBookOrbit({ "GET /metadata-fetch/lookup": null });
  const { call } = await connect(registerMetadataTools, mock.client);
  const r = await call("book_metadata", {
    action: "apply",
    bookId: 1,
    provider: "p",
    providerId: "x",
    fields: ["title"],
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /no record x/);
});

test("lock_fields merges with existing locks; unlock removes only the named ones", async () => {
  const mock = mockBookOrbit({
    "GET /books/3": { id: 3, lockedFields: ["title"] },
    "PATCH /books/3/metadata-locks": {},
  });
  const { call } = await connect(registerMetadataTools, mock.client);
  const l = await call("book_metadata", {
    action: "lock_fields",
    bookId: 3,
    fields: ["authors", "title"],
  });
  assert.deepEqual(l.data.lockedFields, ["title", "authors"]);
  assert.deepEqual(mock.calls[1]!.body, { lockedFields: ["title", "authors"] });
  const u = await call("book_metadata", {
    action: "unlock_fields",
    bookId: 3,
    fields: ["title"],
  });
  assert.deepEqual(u.data.lockedFields, []);
});

test("lock_fields rejects unknown field names", async () => {
  const mock = mockBookOrbit({});
  const { call } = await connect(registerMetadataTools, mock.client);
  const r = await call("book_metadata", {
    action: "lock_fields",
    bookId: 3,
    fields: ["nonsense"],
  });
  assert.equal(r.isError, true);
});

test("set_custom sends customMetadata through the metadata endpoint", async () => {
  const mock = mockBookOrbit({
    "PATCH /books/3/metadata": { id: 3, customMetadata: [{ fieldId: 2, value: "x" }] },
  });
  const { call } = await connect(registerMetadataTools, mock.client);
  await call("book_metadata", {
    action: "set_custom",
    bookId: 3,
    values: [{ fieldId: 2, value: "x" }],
  });
  assert.deepEqual(mock.calls[0]!.body, { customMetadata: [{ fieldId: 2, value: "x" }] });
});

test("refresh_preview passes preview=true and does not write", async () => {
  const mock = mockBookOrbit({ "POST /books/3/refresh-metadata": { changes: [] } });
  const { call } = await connect(registerMetadataTools, mock.client);
  await call("book_metadata", { action: "refresh_preview", bookId: 3 });
  assert.match(mock.calls[0]!.path, /preview=true/);
});

test("metadata_bulk preview_count defaults to the configured conditions", async () => {
  const mock = mockBookOrbit({
    "GET /book-metadata-fetch/config": {
      enabled: true,
      conditions: { scoreThreshold: { enabled: true } },
    },
    "POST /book-metadata-fetch/preview-count": { count: 12 },
  });
  const { call } = await connect(registerMetadataTools, mock.client);
  const r = await call("metadata_bulk", { action: "preview_count", libraryId: 2 });
  assert.equal(r.data.count, 12);
  assert.deepEqual(mock.calls[1]!.body, {
    conditions: { scoreThreshold: { enabled: true } },
    libraryId: 2,
  });
});

test("metadata_bulk cancel is gated and shows the queue", async () => {
  const mock = mockBookOrbit({
    "GET /book-metadata-fetch/status": { queued: 40 },
    "POST /book-metadata-fetch/cancel": { cancelled: true },
  });
  const { call } = await connect(registerMetadataTools, mock.client);
  const dry = await call("metadata_bulk", { action: "cancel" });
  assert.equal(dry.data.dryRun, true);
  assert.equal(dry.data.wouldDo.queue.queued, 40);
  assert.equal(
    mock.calls.some((c) => c.method === "POST"),
    false,
  );
  const done = await call("metadata_bulk", { action: "cancel", confirm: true });
  assert.deepEqual(done.data, { cancelled: true });
});
