import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDiscoveryTools } from "../src/tools/discovery.js";
import { connect, mockBookOrbit } from "./helpers/harness.js";

test("search_books trims results", async () => {
  const mock = mockBookOrbit({
    "GET /books/search": [
      {
        id: 1,
        title: "Dune",
        seriesName: "Dune",
        libraryId: 2,
        libraryName: "Main",
        junk: "x",
      },
    ],
  });
  const { call } = await connect(registerDiscoveryTools, mock.client);
  const r = await call("search_books", { q: "dune", limit: 3 });
  assert.deepEqual(r.data.items, [
    { id: 1, title: "Dune", seriesName: "Dune", libraryId: 2, libraryName: "Main" },
  ]);
  assert.equal(mock.calls[0]!.path, "/books/search?q=dune&limit=3");
});

test("browse series paginates with nextPage and exposes gap preview", async () => {
  const mock = mockBookOrbit({
    "GET /series": {
      items: [
        {
          id: 9,
          name: "S",
          bookCount: 2,
          gapCount: 3,
          gaps: [2],
          authors: ["A"],
          libraryNames: ["L"],
        },
      ],
      total: 60,
      page: 0,
      size: 25,
    },
  });
  const { call } = await connect(registerDiscoveryTools, mock.client);
  const r = await call("browse", { action: "series", completionStatus: "has_gaps" });
  assert.equal(r.data.nextPage, 1);
  assert.equal(r.data.items[0].gapCount, 3);
  assert.match(mock.calls[0]!.path, /completionStatus=has_gaps/);
});

test("browse rejects unknown fields for an action", async () => {
  const mock = mockBookOrbit({});
  const { call } = await connect(registerDiscoveryTools, mock.client);
  const r = await call("browse", { action: "libraries", id: 3 });
  assert.equal(r.isError, true);
});
