import { test } from "node:test";
import assert from "node:assert/strict";
import { registerRequestTools } from "../src/tools/requests.js";
import { connect, mockBookOrbit } from "./helpers/harness.js";

const item = (id: number, extra = {}) => ({
  id,
  title: "T" + id,
  authors: ["A"],
  mediaKind: "ebook",
  status: "pending",
  secret: "x",
  ...extra,
});

test("requests.list is 1-based and reports nextPage", async () => {
  const mock = mockBookOrbit({ "GET /book-requests": { items: [item(1)], total: 45 } });
  const { call } = await connect(registerRequestTools, mock.client);
  const r = await call("requests", { action: "list", status: "pending" });
  assert.equal(r.data.nextPage, 2);
  assert.equal(r.data.items[0].secret, undefined);
  assert.match(mock.calls[0]!.path, /page=1&limit=20/);
});

test("requests.create posts only provided fields", async () => {
  const mock = mockBookOrbit({
    "POST /book-requests": { request: item(7), subscribed: true },
  });
  const { call } = await connect(registerRequestTools, mock.client);
  const r = await call("requests", {
    action: "create",
    title: "Leviathan Wakes",
    mediaKind: "ebook",
    seriesName: "The Expanse",
    seriesIndex: 1,
  });
  assert.deepEqual(mock.calls[0]!.body, {
    title: "Leviathan Wakes",
    mediaKind: "ebook",
    seriesName: "The Expanse",
    seriesIndex: 1,
  });
  assert.equal(r.data.subscribedToExisting, true);
});

test("requests.create_pair maps library ids onto each half", async () => {
  const mock = mockBookOrbit({
    "POST /book-requests/pairs": {
      ebook: { request: item(1), subscribed: false },
      audiobook: { request: item(2, { mediaKind: "audiobook" }), subscribed: false },
    },
  });
  const { call } = await connect(registerRequestTools, mock.client);
  await call("requests", { action: "create_pair", title: "X", ebookLibraryId: 3 });
  assert.deepEqual(mock.calls[0]!.body, {
    title: "X",
    ebook: { targetLibraryId: 3 },
    audiobook: {},
  });
});

test("requests.cancel is a dry run without confirm", async () => {
  const mock = mockBookOrbit({ "POST /book-requests/4/cancel": item(4) });
  const { call } = await connect(registerRequestTools, mock.client);
  const dry = await call("requests", { action: "cancel", id: 4 });
  assert.equal(dry.data.dryRun, true);
  assert.equal(mock.calls.length, 0);
  await call("requests", { action: "cancel", id: 4, confirm: true });
  assert.equal(mock.calls.length, 1);
});

test("check_availability zips results back to the queried titles", async () => {
  const mock = mockBookOrbit({
    "POST /book-requests/availability": [
      {
        ownedBookId: 5,
        existingRequestId: null,
        existingRequestStatus: null,
        alreadySubscribed: false,
      },
    ],
  });
  const { call } = await connect(registerRequestTools, mock.client);
  const r = await call("requests", {
    action: "check_availability",
    items: [{ title: "Dune", mediaKind: "ebook" }],
  });
  assert.equal(r.data.items[0].title, "Dune");
  assert.equal(r.data.items[0].ownedBookId, 5);
});

test("requests_admin bulk approve and reject gating", async () => {
  const mock = mockBookOrbit({
    "POST /admin/book-requests/approve": {
      updated: [item(1, { status: "approved" })],
      failed: [],
    },
    "POST /admin/book-requests/reject": { updated: [], failed: [] },
  });
  const { call } = await connect(registerRequestTools, mock.client);
  const a = await call("requests_admin", { action: "approve", ids: [1] });
  assert.equal(a.data.updated[0].status, "approved");
  const dry = await call("requests_admin", { action: "reject", ids: [1] });
  assert.equal(dry.data.dryRun, true);
  assert.equal(mock.calls.length, 1);
});

test("requests_admin.grab forwards release identity", async () => {
  const mock = mockBookOrbit({ "POST /admin/book-requests/9/grab": { ok: true } });
  const { call } = await connect(registerRequestTools, mock.client);
  await call("requests_admin", { action: "grab", id: 9, indexerId: 3, releaseGuid: "g" });
  assert.deepEqual(mock.calls[0]!.body, { indexerId: 3, releaseGuid: "g" });
});
