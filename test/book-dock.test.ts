import { test } from "node:test";
import assert from "node:assert/strict";
import { registerBookDockTools } from "../src/tools/book-dock.js";
import { connect, mockBookOrbit } from "./helpers/harness.js";

const file = (id: number) => ({
  id,
  fileName: `f${id}.epub`,
  format: "epub",
  status: "ready",
  selectedMetadata: { title: "T" + id, authors: ["A"] },
  internal: "x",
});

test("list_files is 1-based, trimmed, and reports nextPage", async () => {
  const mock = mockBookOrbit({ "GET /book-dock/files": { items: [file(1)], total: 45 } });
  const { call } = await connect(registerBookDockTools, mock.client);
  const r = await call("book_dock", { action: "list_files", readyToFile: true });
  assert.equal(r.data.nextPage, 2);
  assert.deepEqual(r.data.items[0], {
    id: 1,
    fileName: "f1.epub",
    format: "epub",
    status: "ready",
    title: "T1",
    authors: ["A"],
  });
  assert.match(mock.calls[0]!.path, /page=1&limit=20/);
});

test("edit_file nests metadata under selectedMetadata and drops undefined", async () => {
  const mock = mockBookOrbit({ "PATCH /book-dock/files/3": file(3) });
  const { call } = await connect(registerBookDockTools, mock.client);
  await call("book_dock", {
    action: "edit_file",
    id: 3,
    title: "New",
    seriesIndex: null,
    targetLibraryId: 2,
  });
  assert.deepEqual(mock.calls[0]!.body, {
    selectedMetadata: { title: "New", seriesIndex: null },
    targetLibraryId: 2,
  });
});

test("edit_file with nothing to change is rejected", async () => {
  const mock = mockBookOrbit({});
  const { call } = await connect(registerBookDockTools, mock.client);
  const r = await call("book_dock", { action: "edit_file", id: 3 });
  assert.equal(r.isError, true);
  assert.equal(mock.calls.length, 0);
});

test("bulk actions require exactly one selection mode", async () => {
  const mock = mockBookOrbit({ "POST /book-dock/files/apply-fetched": {} });
  const { call } = await connect(registerBookDockTools, mock.client);
  assert.equal((await call("book_dock", { action: "apply_fetched" })).isError, true);
  assert.equal(
    (await call("book_dock", { action: "apply_fetched", fileIds: [1], allReady: true }))
      .isError,
    true,
  );
  assert.equal(mock.calls.length, 0);
  await call("book_dock", { action: "apply_fetched", allReady: true, excludedIds: [9] });
  assert.deepEqual(mock.calls[0]!.body, {
    selectAll: true,
    readyToFile: true,
    excludedIds: [9],
  });
});

test("bulk_edit derives enabledFields from the provided fields", async () => {
  const mock = mockBookOrbit({ "POST /book-dock/files/bulk-edit": {} });
  const { call } = await connect(registerBookDockTools, mock.client);
  await call("book_dock", {
    action: "bulk_edit",
    fileIds: [1, 2],
    seriesName: "S",
    mergeArrays: true,
  });
  assert.deepEqual(mock.calls[0]!.body, {
    fileIds: [1, 2],
    fields: { seriesName: "S" },
    enabledFields: ["seriesName"],
    mergeArrays: true,
  });
});

test("finalize is a dry run that embeds the preview; confirm executes", async () => {
  const mock = mockBookOrbit({
    "POST /book-dock/finalize/preview": { willFile: 2 },
    "POST /book-dock/finalize": { filed: 2 },
  });
  const { call } = await connect(registerBookDockTools, mock.client);
  const args = {
    action: "finalize",
    allReady: true,
    defaultLibraryId: 2,
    defaultFolderId: 7,
  };
  const dry = await call("book_dock", args);
  assert.equal(dry.data.dryRun, true);
  assert.deepEqual(dry.data.wouldDo.preview, { willFile: 2 });
  assert.equal(
    mock.calls.some((c) => c.path === "/book-dock/finalize"),
    false,
  );
  const done = await call("book_dock", { ...args, confirm: true });
  assert.deepEqual(done.data, { filed: 2 });
  assert.deepEqual(mock.calls.at(-1)!.body, {
    selectAll: true,
    readyToFile: true,
    defaultLibraryId: 2,
    defaultFolderId: 7,
  });
});

test("finalize rejects a half-specified destination", async () => {
  const mock = mockBookOrbit({ "POST /book-dock/finalize/preview": {} });
  const { call } = await connect(registerBookDockTools, mock.client);
  const r = await call("book_dock", {
    action: "finalize",
    allReady: true,
    defaultLibraryId: 2,
    confirm: true,
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /together/);
});

test("discard only takes explicit ids, is gated, and lists files in the dry run", async () => {
  const mock = mockBookOrbit({
    "GET /book-dock/files/4": file(4),
    "POST /book-dock/files/discard": {},
  });
  const { call } = await connect(registerBookDockTools, mock.client);
  assert.equal(
    (await call("book_dock", { action: "discard", allReady: true, confirm: true }))
      .isError,
    true,
  );
  const dry = await call("book_dock", { action: "discard", fileIds: [4] });
  assert.equal(dry.data.wouldDo.files[0].title, "T4");
  assert.equal(
    mock.calls.some((c) => c.method === "POST"),
    false,
  );
  await call("book_dock", { action: "discard", fileIds: [4], confirm: true });
  assert.deepEqual(mock.calls.at(-1)!.body, { fileIds: [4] });
});

test("destructive actions are refused when ENABLE_DESTRUCTIVE=false", async () => {
  const mock = mockBookOrbit({});
  const { call } = await connect(registerBookDockTools, mock.client, false);
  const r = await call("book_dock", { action: "discard", fileIds: [1], confirm: true });
  assert.equal(r.isError, true);
  assert.equal(mock.calls.length, 0);
});
