import { test } from "node:test";
import assert from "node:assert/strict";
import { registerLibraryTools } from "../src/tools/library.js";
import { connect, mockBookOrbit } from "./helpers/harness.js";

const detail = (id: number) => ({
  id,
  title: "Book " + id,
  libraryName: "Main",
  files: [{ id: 1, format: "epub" }],
  authors: [],
});

test("manage_book.update sends only provided fields and honors null to clear", async () => {
  const mock = mockBookOrbit({ "PATCH /books/5/metadata": detail(5) });
  const { call } = await connect(registerLibraryTools, mock.client);
  await call("manage_book", {
    action: "update",
    bookId: 5,
    seriesIndex: "2",
    subtitle: null,
  });
  assert.deepEqual(mock.calls[0]!.body, { seriesIndex: "2", subtitle: null });
});

test("manage_book.update with no fields is rejected", async () => {
  const mock = mockBookOrbit({});
  const { call } = await connect(registerLibraryTools, mock.client);
  const r = await call("manage_book", { action: "update", bookId: 5 });
  assert.equal(r.isError, true);
  assert.equal(mock.calls.length, 0);
});

test("manage_book.delete dry-run names the books and deletes nothing", async () => {
  const mock = mockBookOrbit({
    "GET /books/1": detail(1),
    "GET /books/2": detail(2),
    "DELETE /books": { total: 2 },
  });
  const { call } = await connect(registerLibraryTools, mock.client);
  const dry = await call("manage_book", { action: "delete", bookIds: [1, 2] });
  assert.equal(dry.data.dryRun, true);
  assert.match(dry.data.wouldDo.warning, /files from disk/);
  assert.deepEqual(
    dry.data.wouldDo.books.map((b: any) => b.title),
    ["Book 1", "Book 2"],
  );
  assert.equal(
    mock.calls.some((c) => c.method === "DELETE"),
    false,
  );
  await call("manage_book", { action: "delete", bookIds: [1, 2], confirm: true });
  const del = mock.calls.find((c) => c.method === "DELETE")!;
  assert.deepEqual(del.body, { bookIds: [1, 2] });
});

test("manage_book.delete cannot target a query selection, only explicit ids", async () => {
  const mock = mockBookOrbit({});
  const { call } = await connect(registerLibraryTools, mock.client);
  const r = await call("manage_book", {
    action: "delete",
    query: { libraryId: 1 },
    confirm: true,
  });
  assert.equal(r.isError, true);
  assert.equal(mock.calls.length, 0);
});

test("manage_book.delete caps at 50 ids", async () => {
  const mock = mockBookOrbit({});
  const { call } = await connect(registerLibraryTools, mock.client);
  const r = await call("manage_book", {
    action: "delete",
    bookIds: Array.from({ length: 51 }, (_, i) => i + 1),
    confirm: true,
  });
  assert.equal(r.isError, true);
});

test("manage_collection.create defaults the icon; delete is gated", async () => {
  const mock = mockBookOrbit({
    "POST /collections": { id: 1 },
    "GET /collections/3": { id: 3, name: "Old" },
    "DELETE /collections/3": {},
  });
  const { call } = await connect(registerLibraryTools, mock.client);
  await call("manage_collection", { action: "create", name: "To buy" });
  assert.deepEqual(mock.calls[0]!.body, { name: "To buy", icon: "📚" });
  const dry = await call("manage_collection", { action: "delete", id: 3 });
  assert.match(dry.data.wouldDo, /"Old"/);
  assert.equal(
    mock.calls.some((c) => c.method === "DELETE"),
    false,
  );
});

test("manage_library.list exposes folder ids for move_books", async () => {
  const mock = mockBookOrbit({
    "GET /libraries": [
      { id: 2, name: "Main", folders: [{ id: 9, path: "/books" }], junk: 1 },
    ],
  });
  const { call } = await connect(registerLibraryTools, mock.client);
  const r = await call("manage_library", { action: "list" });
  assert.deepEqual(r.data.items[0].folders, [{ id: 9, path: "/books" }]);
});

test("move_books.preview wraps the selection; execute is a gated dry run first", async () => {
  const preview = {
    totalSelected: 2,
    readyCount: 2,
    alreadyInTargetCount: 0,
    collisionCount: 0,
  };
  const mock = mockBookOrbit({ "POST /books/move/preview": preview });
  const { call } = await connect(registerLibraryTools, mock.client);
  const args = { bookIds: [1, 2], targetLibraryId: 3, targetFolderId: 7 };
  await call("move_books", { action: "preview", ...args });
  assert.deepEqual(mock.calls[0]!.body, {
    selection: { bookIds: [1, 2] },
    targetLibraryId: 3,
    targetFolderId: 7,
  });
  const dry = await call("move_books", {
    action: "execute",
    ...args,
    collisionPolicy: "skip",
  });
  assert.equal(dry.data.dryRun, true);
  assert.equal(dry.data.wouldDo.readyCount, 2);
  assert.equal(
    mock.calls.some((c) => c.path === "/books/move"),
    false,
  );
});

test("move_books.execute reads the progress stream to the final summary", async () => {
  const events = [
    { bookId: 1, status: "moved" },
    { bookId: 2, status: "failed", reason: "locked" },
    { done: true, moved: 1, failed: 1 },
  ];
  const mock = mockBookOrbit({
    "POST /books/move/preview": { totalSelected: 2, readyCount: 2 },
    "POST /books/move": () =>
      new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
        status: 200,
      }),
  });
  const { call } = await connect(registerLibraryTools, mock.client);
  const r = await call("move_books", {
    action: "execute",
    bookIds: [1, 2],
    targetLibraryId: 3,
    targetFolderId: 7,
    collisionPolicy: "suggested",
    confirm: true,
  });
  assert.equal(r.data.status, "finished");
  assert.equal(r.data.summary.moved, 1);
  assert.deepEqual(r.data.notMoved, [{ bookId: 2, status: "failed", reason: "locked" }]);
  const post = mock.calls.find((c) => c.path === "/books/move")!;
  assert.equal((post.body as any).collisionPolicy, "suggested");
});

test("duplicates.scan defaults similarity to 90; groups are 1-based", async () => {
  const mock = mockBookOrbit({
    "POST /book-duplicates/scans": { id: 4 },
    "GET /book-duplicates/scans/4/groups": { items: [] },
  });
  const { call } = await connect(registerLibraryTools, mock.client);
  await call("duplicates", { action: "scan" });
  assert.deepEqual(mock.calls[0]!.body, { similarityPercent: 90 });
  await call("duplicates", { action: "groups", scanId: 4 });
  assert.match(mock.calls[1]!.path, /page=1&pageSize=10/);
});
